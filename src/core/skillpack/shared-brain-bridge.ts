import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrainEngine } from '../engine.ts';
import { configDir, type GBrainConfig } from '../config.ts';
import { checkedRoot, confinedPath, sha256, privateWrite, readFileConfigState } from '../agent-install/state.ts';
import { findBridgeEntry, loadBridgeState } from './bridge-state.ts';
import { isUndefinedTableError } from '../utils.ts';
import { createSharedSkillsAdapter, type SharedSkillsToolCaller } from '../shared-skills/adapter.ts';
import { verifyLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../persistence/identity.ts';
import { renderAgentLauncher } from '../agent-install/launcher.ts';
import { resolveSourceWithTier, ALL_SOURCES } from '../source-resolver.ts';
import { resolveBrainId } from '../brain-resolver.ts';
import { acquireBootstrapLock } from '../bootstrap/lock.ts';
import { assertLegacySkillFilesystemWrite } from './writer-guard.ts';
import { readPrivateText } from '../harness/credentials.ts';
import { harnessAdapter } from '../harness/registry.ts';
import { OperationError } from '../ops/contract.ts';

async function bindBridgeTarget(engine: BrainEngine, brainId: string, adapter: string, root: string, follow: boolean): Promise<LocalRegistration> {
  const registration = JSON.parse(readPrivateText(confinedPath(configDir(), `persistence/${brainId}.cli.json`), 65536)) as LocalRegistration;
  if (registration.lane !== 'cli' || typeof registration.credential !== 'string' || !/^[a-f0-9-]{36}$/i.test(registration.id)) {
    throw new OperationError('bridge_ownership_conflict', 'The private local CLI registration is invalid.');
  }
  let verified = false;
  try { await verifyLocalWriter(engine, registration); verified = true; }
  catch (error) { if (follow) throw error; }
  const claimKey = `shared_skills.bridge_owner.v1.${registration.id}.${adapter}`;
  const target = sha256(JSON.stringify([brainId, root]));
  const refuseIndependent = () => new OperationError('independent_principal_required',
    'This local CLI principal already owns another source/destination for this harness. Reuse that bridge target; independent installations need separate private-handoff principals. Leaving does not release this binding.');
  const existing = await engine.getConfig(claimKey);
  if (existing !== null && existing !== undefined) {
    if (existing !== target) throw refuseIndependent();
    return registration;
  }
  if (!verified) throw new OperationError('bridge_ownership_conflict', 'Restore writer access to verify legacy bridge ownership before attempting cleanup.');
  const [member] = await engine.executeRaw<{ installation_id: string }>(
    "SELECT installation_id FROM shared_skill_members WHERE principal_kind='local_cli' AND principal_id=$1 AND adapter=$2", [registration.id, adapter]);
  const readReceipt = (path: string) => {
    const receipt = JSON.parse(readPrivateText(path, 4 * 1024 * 1024)) as { format_version: number; adapter: string; brain_id: string; installation_id: string };
    if (receipt.format_version !== 1 || typeof receipt.adapter !== 'string' || typeof receipt.brain_id !== 'string' || typeof receipt.installation_id !== 'string') {
      throw new OperationError('bridge_ownership_conflict', 'Preserve the invalid legacy enrollment receipt before retrying.');
    }
    return receipt;
  };
  if (member) {
    const parent = dirname(root);
    const directories = existsSync(parent) ? readdirSync(parent).filter(name => /^[a-f0-9]{32}$/.test(name)) : [];
    if (directories.length > 4096) throw new OperationError('bridge_ownership_conflict', 'The legacy bridge inventory exceeds the ownership inspection limit.');
    const matching: string[] = [];
    for (const directory of directories) {
      const candidate = confinedPath(parent, `${directory}/shared-skills/receipt.json`);
      if (!existsSync(candidate)) continue;
      const receipt = readReceipt(candidate);
      if (receipt.brain_id === brainId && receipt.adapter === adapter && receipt.installation_id === member.installation_id) matching.push(join(parent, directory));
    }
    if (matching.length !== 1) throw new OperationError('bridge_ownership_conflict',
      'Existing membership has missing or multiple bridge receipts. No enrollment or native files were changed. Preserve and resolve all old copies before using separate private-handoff principals.');
    if (matching[0] !== root) throw refuseIndependent();
  } else if (existsSync(confinedPath(root, 'shared-skills/receipt.json'))) {
    throw new OperationError('bridge_ownership_conflict', 'The existing bridge receipt does not belong to the current authenticated principal.');
  }
  await engine.executeRaw('INSERT INTO config(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING', [claimKey, target]);
  if (await engine.getConfig(claimKey) !== target) throw refuseIndependent();
  return registration;
}

export async function sharedBrainBridgePlan(options: {
  engine: BrainEngine | null;
  config: GBrainConfig | null;
  harness: string;
  dest?: string;
  statePath?: string;
}) {
  let active = !!options.config?.remote_mcp;
  let unavailable = false;
  if (!active && options.engine) {
    try {
      const [brain] = await options.engine.executeRaw<{ skill_bundles_enabled: boolean }>('SELECT skill_bundles_enabled FROM persistence_brain WHERE singleton=1');
      active = brain?.skill_bundles_enabled === true;
    } catch (error) {
      if (!isUndefinedTableError(error)) unavailable = true;
    }
  } else if (!active && (options.config?.database_url || options.config?.database_path || options.config?.engine === 'pglite')) unavailable = true;
  if (!active && !unavailable) return null;
  const migration = { owned_unchanged: [] as string[], modified: [] as string[], missing: [] as string[], ownership: 'unverified' };
  if (options.dest) {
    const entry = findBridgeEntry(loadBridgeState({ statePath: options.statePath }), { harness: options.harness, dest: options.dest });
    if (entry) {
      migration.ownership = 'ledger';
      const files = new Map(Object.values(entry.written).flatMap(record => Object.entries(record.files)));
      if (files.size > 2048) migration.modified.push('(inventory limit exceeded)');
      else for (const [relative, expected] of files) {
        try {
          const path = confinedPath(checkedRoot(options.dest), relative);
          if (!existsSync(path)) { migration.missing.push(relative); continue; }
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || sha256(readFileSync(path)) !== expected) migration.modified.push(relative);
          else migration.owned_unchanged.push(relative);
        } catch { migration.modified.push(relative); }
      }
    }
  }
  const reason = migration.modified.length ? 'legacy_skill_conflict' : migration.owned_unchanged.length
    ? 'legacy_skill_migration_required' : unavailable ? 'shared_brain_unavailable' : 'follow_approval_required';
  return {
    status: 'pending', reason, native: 'unverified', legacy_copy_written: false, migration,
    next_action: migration.modified.length
      ? 'Preserve the modified legacy skills and resolve their native shadow copies before enrolling. No copied bodies, pointers, or unrelated native skills were changed.'
      : migration.owned_unchanged.length
        ? 'Review and explicitly remove the unchanged bridge-owned copies with skillpack remove for this harness and destination, then use the shared-skills connection installer with an approved follow policy. No legacy copy was removed automatically.'
        : unavailable
          ? 'Reconnect the selected brain and verify its shared catalog before installing skills. Memory and existing native files are unchanged; unavailable is not a legacy-copy fallback.'
          : options.config?.remote_mcp
            ? 'Use the existing remote private-handoff connection installer with explicit follow approval and a skills_member_self grant for join_brain, sync_brain_skills, leave_brain and catalog reads. Do not mint against a local brain or install bundled copies.'
            : 'Use bootstrap harness with explicit shared-skills follow approval, or the installation-bound setup for a personal agent. Confirm the intended source and self-member grant; skillpack scaffold does not invent an enrollment credential or install stale bundled copies.',
  };
}

export async function installSharedBrainBridge(options: {
  engine: BrainEngine | null;
  config: GBrainConfig | null;
  harness: string;
  dest?: string;
  policy?: 'follow' | 'memory-only';
  dryRun?: boolean;
  statePath?: string;
}) {
  const plan = await sharedBrainBridgePlan(options);
  if (!plan) return options.policy ? {
    status: 'pending', reason: options.policy === 'follow' ? 'shared_content_migration_required' : 'memory_only', native: 'unverified', legacy_copy_written: false,
    migration: { owned_unchanged: [] as string[], modified: [] as string[], missing: [] as string[], ownership: 'unverified' },
    next_action: options.policy === 'follow' ? 'Activate the selected brain’s shared content through the reviewed host migration before following. No legacy body or stub was installed as a substitute.'
      : 'Memory-only was selected. No bundled skill copies or shared routers were installed.',
  } : null;
  if (options.config?.remote_mcp || !options.engine || !options.config || options.dryRun ||
    plan.migration.modified.length || plan.migration.owned_unchanged.length) return plan;
  if (!options.dest) return { ...plan, reason: 'native_destination_required', next_action: 'Specify a supported native skill destination before approving shared following. No native installation is inferred.' };
  const engine = options.engine, config = options.config;
  const pending = (reason: string, next_action: string) => ({ ...plan, reason, next_action });
  const home = dirname(configDir());
  const stored = readFileConfigState(join(configDir(), 'config.json'));
  if (resolveBrainId(null) !== 'host' || stored.kind !== 'present' || stored.config.engine !== config.engine ||
    stored.config.database_url !== config.database_url || stored.config.database_path !== config.database_path) {
    return pending('bound_connection_required', 'The selected brain depends on ambient routing. Use an installation-bound connection instead of creating a launcher that could select another brain.');
  }
  const source = await resolveSourceWithTier(engine, null);
  if (source.source_id === ALL_SOURCES) return pending('source_approval_required', 'Select one explicit source for the native shared router before approving following.');
  const dest = checkedRoot(options.dest);
  try { assertLegacySkillFilesystemWrite(dest); }
  catch { return pending('canonical_destination_refused', 'Native router installation cannot write into a managed canonical source. Choose the harness’s separate native skills directory; publish canonical skill changes through the catalog.'); }
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  const adapterId = harnessAdapter(options.harness).id;
  const key = sha256(JSON.stringify([brain.brain_id, source.source_id, adapterId, dest])).slice(0, 32);
  const root = join(configDir(), 'skillpack-shared', key);
  const receiptPath = confinedPath(root, 'installation.json');
  const priorText = existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8') : null;
  let prior: { policy?: string; launcher_hash?: string; pending_hash?: string } = {};
  if (priorText !== null) {
    try {
      prior = JSON.parse(priorText);
      if (!prior || typeof prior !== 'object' || Array.isArray(prior)) throw new Error('invalid receipt');
    }
    catch { return pending('local_conflict', 'Preserve the unreadable shared bridge receipt before retrying.'); }
  }
  const policy = options.policy ?? prior.policy;
  if (policy !== 'follow' && policy !== 'memory-only') return plan;
  if (policy === 'memory-only' && !existsSync(join(root, 'shared-skills', 'receipt.json'))) return {
    ...plan, reason: 'memory_only', next_action: 'Shared following is disabled. Memory and unrelated native skills are unchanged.',
  };
  const launcher = confinedPath(root, 'gbrain');
  const sourceCli = fileURLToPath(new URL('../../cli.ts', import.meta.url));
  const content = renderAgentLauncher({ root: home, sourceId: source.source_id, bunPath: process.execPath,
    cliPath: sourceCli.includes('$bunfs') ? undefined : sourceCli });
  const actual = existsSync(launcher) ? sha256(readFileSync(launcher)) : null;
  if (actual !== null && ![prior.launcher_hash, prior.pending_hash].includes(actual)) return pending('local_conflict', 'The installation-bound launcher was edited or is unowned. Preserve it before retrying.');
  let registration: LocalRegistration;
  try { registration = await bindBridgeTarget(engine, brain.brain_id, adapterId, root, policy === 'follow'); }
  catch (error) {
    if (error instanceof OperationError && ['independent_principal_required', 'bridge_ownership_conflict'].includes(error.code)) {
      if (policy !== 'memory-only') return pending(error.code, error.message);
      try {
        const cleanupLock = await acquireBootstrapLock(root);
        try {
          if ((existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8') : null) !== priorText) throw new Error('changed ownership receipt');
          const state = confinedPath(root, 'shared-skills');
          const cached = JSON.parse(readPrivateText(join(state, 'receipt.json'), 4 * 1024 * 1024));
          if (cached.brain_id !== brain.brain_id || cached.adapter !== adapterId || typeof cached.installation_id !== 'string') throw new Error('unbound local receipt');
          const nativePath = confinedPath(state, 'native-router.json');
          if (existsSync(nativePath)) {
            const native = JSON.parse(readPrivateText(nativePath, 65536));
            const name = `gbrain-shared-${sha256(JSON.stringify([brain.brain_id, cached.installation_id, adapterId, `bridge-${key}`])).slice(0, 24)}`;
            if (native.version !== 1 || native.name !== name || native.skills_dir !== dest || native.brain_id !== brain.brain_id ||
              native.installation_id !== cached.installation_id || native.adapter !== adapterId) throw new Error('foreign native router ownership');
          } else if (cached.native_router_path) throw new Error('missing native router ownership');
          const local = createSharedSkillsAdapter({ root: state, adapter: adapterId, call: async () => { throw error; } });
          const result = await local.leave();
          privateWrite(receiptPath, `${JSON.stringify({ ...prior, policy: 'memory-only' })}\n`);
          return { ...plan, ...result, status: 'pending', reason: error.code, remote_membership_pending: true,
            next_action: `${error.message} Only unchanged owned local files were cleaned up; edited files are retained. Shared server leave was withheld to protect the other enrollment. Native disablement remains unverified.` };
        } finally { cleanupLock.release(); }
      } catch {
        return pending('bridge_local_cleanup_conflict', 'The existing native ownership cannot be confined to this target. Preserve the files for manual cleanup; no server leave was sent and native disablement is unverified.');
      }
    }
    return pending('bridge_ownership_unavailable', 'Verify the installation’s existing private local CLI registration and bridge receipts before retrying. No target artifacts or enrollment were changed.');
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = await acquireBootstrapLock(root);
  try {
    if ((existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8') : null) !== priorText) return pending('local_conflict', 'Another installer changed the shared bridge receipt. Retry without overwriting it.');
    const current = existsSync(launcher) ? sha256(readFileSync(launcher)) : null;
    if (current !== actual) return pending('local_conflict', 'The installation-bound launcher changed while installing. Preserve it and retry.');
    privateWrite(receiptPath, `${JSON.stringify({ ...prior, policy, pending_hash: sha256(content) })}\n`);
    if (current !== sha256(content)) privateWrite(launcher, content, 0o700);
    privateWrite(receiptPath, `${JSON.stringify({ policy, launcher_hash: sha256(content) })}\n`);
    const { operationsByName } = await import('../operations.ts');
    const ctx = { engine, config, sourceId: source.source_id, remote: false, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } };
    const allowed = new Set(['join_brain', 'sync_brain_skills', 'leave_brain', 'get_skill', 'get_skill_asset']);
    const call: SharedSkillsToolCaller = async <T>(name: string, params: Record<string, unknown>): Promise<T> => {
      if (!allowed.has(name) || !operationsByName[name]) throw new Error('unsupported shared-skills operation');
      return await withVerifiedLocalRegistration(engine, registration, async () => await operationsByName[name].handler(ctx, params) as T);
    };
    const adapter = createSharedSkillsAdapter({ call, root: join(root, 'shared-skills'), adapter: adapterId,
      launcher, nativeSkillsDir: dest, connectionName: `bridge-${key}` });
    const result = policy === 'follow' ? await adapter.join({ approved: true, source_ids: [source.source_id] }) : await adapter.leave();
    if ('remote_membership_pending' in result && result.remote_membership_pending) return { ...plan, ...result, status: 'pending', reason: 'remote_membership_pending',
      next_action: 'Owned local router cleanup completed, but enrollment closure remains pending. Repair the existing local writer and retry memory-only cleanup; no new authority was created.' };
    return { ...plan, ...result, source_id: source.source_id, launcher, reason: policy === 'follow' ? 'native_activation_unverified' : 'memory_only' };
  } catch {
    return pending('shared_enrollment_unavailable', 'Memory and unrelated files are preserved. Verify local writer authority, follow policy and the owned router/cache, then retry; native activation is unverified.');
  } finally { lock.release(); }
}
