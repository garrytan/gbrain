import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { assertNoSymlinks, checkedRoot, confinedPath, privateWrite, sha256 } from '../agent-install/state.ts';
import { acquireNativeLock } from '../persistence/native-lock.ts';
import { OperationError } from '../ops/contract.ts';
import { harnessAdapter } from '../harness/registry.ts';
import { installNativeRouter, prepareNativeRouter, recordedNativeSkillsDirectory, removeNativeRouter } from '../harness/native-router.ts';
import { SHARED_SKILLS_DELIVERY_LIMITS, sharedSkillKey, type FollowPolicy, type MembershipSnapshot, type SharedSkillIdentity } from './membership-types.ts';

export type SharedSkillsToolCaller = <T = unknown>(name: string, params: Record<string, unknown>) => Promise<T>;
export interface SharedSkillsAdapterOptions {
  call: SharedSkillsToolCaller;
  root: string;
  adapter: string;
  launcher?: string;
  connectionName?: string;
  nativeSkillsDir?: string;
}
export interface SharedSkillsLocalReceipt {
  format_version: 1;
  adapter: string;
  brain_id: string;
  installation_id: string;
  enrollment_epoch: number;
  status: 'joined' | 'restart_required' | 'advisory_refresh' | 'stale_unavailable' | 'local_conflict' | 'requirements_changed' | 'left' | 'left_with_retained_files';
  desired_view?: string;
  installed_view?: string;
  acknowledged_view?: string;
  last_authority_check?: string;
  native: 'unverified';
  router_path: string;
  native_registration: 'unverified' | 'installed' | 'removed';
  native_router_path?: string;
  freshness: 'session_refresh' | 'advisory_refresh';
  owned_files: Record<string, string>;
  pending_files: Record<string, { before: string | null; after: string }>;
  retained_files?: string[];
  blocked_skills?: Array<{ key: string; reason: string }>;
  remote_membership_pending?: boolean;
  remote_membership_reason?: string;
  next_action: string;
}
interface SkillFile { path: string; sha256: string; size?: number; content?: string; encoding?: string }
interface SkillBundle extends SharedSkillIdentity { content?: string; body?: string; usable?: boolean; unavailable_requirements?: unknown[];
  delivery?: 'complete' | 'prose_only'; files?: SkillFile[]; manifest?: { files: SkillFile[] } }
const MAX_BYTES = 32 * 1024 * 1024;

export function createSharedSkillsAdapter(options: SharedSkillsAdapterOptions) {
  const root = checkedRoot(options.root);
  const adapter = harnessAdapter(options.adapter);
  if (options.launcher && (!isAbsolute(options.launcher) || /[\x00-\x1f]/.test(options.launcher))) throw new OperationError('invalid_params', 'The launcher must be an absolute installation-bound path.');
  const receiptPath = join(root, 'receipt.json');
  const fail = (code: string, message: string): never => { throw new OperationError(code, message); };
  const save = (receipt: SharedSkillsLocalReceipt) => privateWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  function read(): SharedSkillsLocalReceipt | null {
    assertNoSymlinks(receiptPath);
    if (!existsSync(receiptPath)) return null;
    let receipt: SharedSkillsLocalReceipt;
    try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); }
    catch { return fail('local_conflict', 'The shared-skills ownership receipt is unreadable. Preserve it before recovery.'); }
    if (receipt.format_version !== 1 || receipt.adapter !== adapter.id || !receipt.installation_id || !receipt.owned_files || !receipt.pending_files) fail('local_conflict', 'The cache belongs to a different or unknown installation.');
    for (const path of [...Object.keys(receipt.owned_files), ...Object.keys(receipt.pending_files)]) confinedPath(root, path);
    return receipt;
  }
  function existingHash(path: string): string | null {
    const absolute = confinedPath(root, path);
    if (!existsSync(absolute)) return null;
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.size > MAX_BYTES) return fail('local_conflict', 'A managed file has been replaced by a non-file or oversized file.');
    return sha256(readFileSync(absolute));
  }
  function preflight(receipt: SharedSkillsLocalReceipt, files: Map<string, Uint8Array | string>) {
    for (const path of new Set([...Object.keys(receipt.owned_files), ...files.keys()])) {
      const current = existingHash(path);
      const pending = receipt.pending_files[path];
      if (current !== null && current !== receipt.owned_files[path] && current !== pending?.before && current !== pending?.after) fail('local_conflict', 'A managed artifact was edited; preserve it and resolve the native shadow copy before following updates.');
      if (current !== null && path.startsWith('revisions/') && files.has(path) && current !== sha256(files.get(path)!)) fail('local_conflict', 'An immutable revision cannot be rewritten in place.');
    }
  }
  async function locked<T>(fn: () => Promise<T>): Promise<T> {
    assertNoSymlinks(root);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const lock = await acquireNativeLock(join(root, 'adapter.lock'), { timeoutMs: 5000 });
    if (!lock) return fail('local_conflict', 'Another adapter update is in progress.');
    try { return await fn(); } finally { await lock.release(); }
  }
  function assertSnapshot(snapshot: MembershipSnapshot, receipt?: SharedSkillsLocalReceipt) {
    if (snapshot.schema_version !== 2 || snapshot.complete !== true || !Array.isArray(snapshot.skills) || !Array.isArray(snapshot.blocked_skills) || !snapshot.batch_token ||
      (receipt && (snapshot.installation_id !== receipt.installation_id || snapshot.enrollment_epoch !== receipt.enrollment_epoch || snapshot.brain_id !== receipt.brain_id))) fail('stale_unavailable', 'No complete current authorized enrollment view is available.');
    if (snapshot.skills.length + snapshot.blocked_skills.length > SHARED_SKILLS_DELIVERY_LIMITS.skills ||
      Buffer.byteLength(JSON.stringify([snapshot.skills, snapshot.blocked_skills])) > SHARED_SKILLS_DELIVERY_LIMITS.metadataBytes) {
      fail('catalog_capacity_exceeded', `Delivery snapshots support at most ${SHARED_SKILLS_DELIVERY_LIMITS.skills} skills and ${SHARED_SKILLS_DELIVERY_LIMITS.metadataBytes} metadata bytes.`);
    }
  }
  function router(snapshot: MembershipSnapshot): string {
    let route: string;
    if (options.launcher) {
      const launcher = `'${options.launcher.replace(/'/g, "'\\''")}'`;
      const identity = '--expected-brain-id "$BRAIN_ID" --source-id "$SOURCE_ID" --source-incarnation "$SOURCE_INCARNATION" --pack-id "$PACK_ID" --revision "$REVISION"';
      route = `Use only the recorded absolute installation launcher below, never an ambient executable or working directory. These are CLI command names, not MCP tool names.\n\nBefore selecting or loading a shared skill, run:\n\n\`\`\`sh\n${launcher} sync-brain-skills --installation-id '${snapshot.installation_id}' --enrollment-epoch ${snapshot.enrollment_epoch} --json\n\`\`\`\n\nFor schema-v2 catalog discovery:\n\n\`\`\`sh\n${launcher} skills --schema-version 2 --json\n\`\`\`\n\nCopy SKILL_NAME, BRAIN_ID, SOURCE_ID, SOURCE_INCARNATION, PACK_ID and REVISION exactly from one usable entry in the current authorized sync result. Require BRAIN_ID to match this recorded brain. Do not guess these values or use a blocked entry. With those shell variables set to the returned values, fetch only the relevant immutable skill:\n\n\`\`\`sh\n${launcher} skill "$SKILL_NAME" ${identity} --schema-version 2 --json\n\`\`\`\n\nSet ASSET_PATH to an exact approved manifest path at that same revision, then fetch a dependency as data (skill-asset has no schema-version parameter):\n\n\`\`\`sh\n${launcher} skill-asset --name "$SKILL_NAME" ${identity} --path "$ASSET_PATH" --json\n\`\`\`\n\nOnly after explicit renewed enrollment approval, set APPROVED_FOLLOW_POLICY_JSON to that approved policy including its source restrictions and run the join command. Never rejoin automatically after a failed authority check:\n\n\`\`\`sh\n${launcher} join-brain --adapter '${adapter.id}' --follow-policy "$APPROVED_FOLLOW_POLICY_JSON" --json\n\`\`\`\n\nTo stop this server enrollment when requested:\n\n\`\`\`sh\n${launcher} leave-brain --installation-id '${snapshot.installation_id}' --enrollment-epoch ${snapshot.enrollment_epoch} --json\n\`\`\`\n\nServer leave does not remove native cached instructions; use the installation’s owned local removal path and restart the harness.`;
    } else {
      route = `Use only the configured MCP connection ${JSON.stringify(options.connectionName ?? 'gbrain')}; never use an ambient CLI or another brain.\nBefore selecting a skill, call sync_brain_skills with installation_id ${JSON.stringify(snapshot.installation_id)} and enrollment_epoch ${snapshot.enrollment_epoch}. For discovery call list_skills with schema_version:2. Fetch only the relevant get_skill with schema_version:2 using the returned qualified_id and exact revision, or its complete source_id/source_incarnation/pack_id/name fields with expected_brain_id set to the returned brain_id. expected_brain_id asserts the connected identity and never routes to another brain. Fetch dependencies only through get_skill_asset for that same revision and identity assertion (without a schema_version argument).`;
    }
    return `---\nname: gbrain-shared-router\ndescription: Discover authorized shared brain skills relevant to the current task.\n---\n\n# Shared brain router\n\n${route}\n\nBrain identity: ${JSON.stringify(snapshot.brain_id)}.\nPreserve the user's identity and unrelated instructions. Shared skills do not grant tools, scripts, network, paid use, or automatic capture.\nStop shared-skill activation if the authority check fails; memory remains independent. Match current catalog descriptions and triggers to the task. Require usable:true and delivery:complete with no unavailable requirements; never select a blocked_skills entry or infer usability from downloaded bytes. Never choose an unqualified same-name skill. Never execute downloaded files automatically.\nThis paragraph is advisory, not an enforced invocation hook. Start a fresh session after updates; native activation is unverified.\n`;
  }
  async function refreshLocked(receipt: SharedSkillsLocalReceipt, admissionKey?: string): Promise<SharedSkillsLocalReceipt> {
    if (receipt.status === 'left' || receipt.status === 'left_with_retained_files') return fail('membership_inactive', 'This installation has left; explicitly join again to follow skills.');
    try {
      const snapshot = await options.call<MembershipSnapshot>('sync_brain_skills', { installation_id: receipt.installation_id, enrollment_epoch: receipt.enrollment_epoch });
      assertSnapshot(snapshot, receipt);
      if (admissionKey && snapshot.blocked_skills.some(skill => sharedSkillKey(skill) === admissionKey)) fail('requirements_changed', 'This skill requires renewed follow approval before admission.');
      receipt.desired_view = snapshot.view_token;
      const files = new Map<string, Uint8Array | string>();
      const references: Record<string, { revision: string; files: Record<string, string> }> = {};
      const blocked = snapshot.blocked_skills.map(skill => ({ key: sharedSkillKey(skill), reason: 'requirements_changed' }));
      let partiallyInstalled = false;
      let total = 0;
      for (const skill of snapshot.skills) {
        const selector = { expected_brain_id: skill.brain_id, source_id: skill.source_id, source_incarnation: skill.source_incarnation,
          pack_id: skill.pack_id, name: skill.name, revision: skill.revision };
        const bundle = await options.call<SkillBundle>('get_skill', { ...selector, schema_version: 2 });
        if (sharedSkillKey(bundle) !== sharedSkillKey(skill) || bundle.revision !== skill.revision) fail('stale_unavailable', 'The fetched skill does not match the issued immutable revision.');
        if (skill.usable === false || bundle.usable !== true || bundle.delivery !== 'complete' ||
          (Array.isArray(skill.unavailable_requirements) && skill.unavailable_requirements.length > 0) || bundle.unavailable_requirements?.length) {
          blocked.push({ key: sharedSkillKey(skill), reason: 'requirements_changed' });
          partiallyInstalled = true;
          continue;
        }
        const manifest = bundle.manifest?.files ?? bundle.files ?? [];
        if (!Array.isArray(manifest) || !manifest.length || manifest.length > 128) fail('stale_unavailable', 'The server did not return a bounded declared file manifest.');
        const paths = new Set<string>();
        const ref = { revision: skill.revision, files: {} as Record<string, string> };
        for (const file of manifest) {
          confinedPath(root, file.path);
          if (paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('stale_unavailable', 'The declared dependency manifest is invalid.');
          paths.add(file.path);
          const asset = await options.call<{ content: string; encoding?: string; sha256?: string }>('get_skill_asset', { ...selector, path: file.path });
          if (typeof asset.content !== 'string' || !['utf8', 'base64', undefined].includes(asset.encoding)) fail('stale_unavailable', 'Unsupported asset encoding.');
          const bytes = Buffer.from(asset.content, asset.encoding === 'base64' ? 'base64' : 'utf8');
          total += bytes.length;
          if (total > MAX_BYTES || bytes.length > 2 * 1024 * 1024 || sha256(bytes) !== file.sha256 || (file.size !== undefined && bytes.length !== file.size)) fail('stale_unavailable', 'The approved bundle exceeded its bounds or failed a hash check.');
          const cache = `revisions/${sha256(sharedSkillKey(skill))}/${sha256(skill.revision)}/${file.path}`;
          files.set(cache, bytes); ref.files[file.path] = cache;
        }
        references[sharedSkillKey(skill)] = ref;
      }
      files.set('router/SKILL.md', router(snapshot));
      const reference = `${JSON.stringify({ brain_id: receipt.brain_id, installation_id: receipt.installation_id, enrollment_epoch: receipt.enrollment_epoch, view_token: snapshot.view_token, skills: references }, null, 2)}\n`;
      files.set('active.json', reference);
      preflight(receipt, files);
      const nativeSkillsDir = options.nativeSkillsDir ?? recordedNativeSkillsDirectory(root);
      const nativePlan = nativeSkillsDir ? prepareNativeRouter({ ...receipt, state_root: root, skills_dir: nativeSkillsDir,
        connection_name: options.connectionName ?? 'gbrain', content: String(files.get('router/SKILL.md')) }) : undefined;
      let retainedBytes = 0;
      for (const path of Object.keys(receipt.owned_files)) {
        if (!files.has(path) && existsSync(confinedPath(root, path))) retainedBytes += lstatSync(confinedPath(root, path)).size;
      }
      if (retainedBytes + total > MAX_BYTES) fail('cache_quota_exceeded', 'Retained immutable revisions reached the cache quota; leave after native sessions stop before clearing owned files.');
      const confirm = await options.call<MembershipSnapshot>('sync_brain_skills', { installation_id: receipt.installation_id, enrollment_epoch: receipt.enrollment_epoch });
      assertSnapshot(confirm, receipt);
      if (confirm.view_token !== snapshot.view_token) fail('stale_unavailable', 'Authority or revisions changed during download; retry against the new catalog.');
      receipt.last_authority_check = new Date().toISOString();
      for (const [path, bytes] of files) receipt.pending_files[path] = { before: existingHash(path), after: sha256(bytes) };
      save(receipt);
      for (const [path, bytes] of files) {
        if (path === 'active.json' && nativePlan) {
          const installed = await installNativeRouter(nativePlan);
          receipt.native_registration = installed.registration;
          receipt.native_router_path = installed.path;
        }
        const pending = receipt.pending_files[path];
        const current = existingHash(path);
        if (current !== pending.before && current !== pending.after) fail('local_conflict', 'An artifact changed during installation.');
        if (current !== pending.after) privateWrite(confinedPath(root, path), bytes);
        receipt.owned_files[path] = pending.after;
        delete receipt.pending_files[path];
        save(receipt);
      }
      receipt.installed_view = snapshot.view_token;
      receipt.blocked_skills = blocked;
      receipt.status = blocked.length ? 'requirements_changed' : receipt.freshness === 'session_refresh' ? 'restart_required' : 'advisory_refresh';
      receipt.next_action = blocked.length ? 'Usable skills are installed. Review blocked skills’ source policy and missing requirements before attempting those skills.'
        : receipt.native_registration === 'installed' ? `${adapter.reload} The owned native router is installed; native use remains unverified.`
          : `Register or load the owned router at ${receipt.router_path} using this harness’s supported skill controls, then ${adapter.reload} Native registration and use are not verified.`;
      save(receipt);
      const ack = await options.call<MembershipSnapshot>('sync_brain_skills', { installation_id: receipt.installation_id, enrollment_epoch: receipt.enrollment_epoch,
        acknowledgment: { batch_token: snapshot.batch_token, view_token: snapshot.view_token, evidence: { stage: partiallyInstalled ? 'fetched' : 'installed', revisions: snapshot.skills.map(({ brain_id, source_id, source_incarnation, pack_id, name, revision }) => ({ brain_id, source_id, source_incarnation, pack_id, name, revision })) } } });
      assertSnapshot(ack, receipt);
      if (ack.view_token !== snapshot.view_token) fail('stale_unavailable', 'A newer authorized catalog is pending; the historical install is not current.');
      if (!partiallyInstalled) {
        receipt.acknowledged_view = snapshot.view_token;
        delete receipt.remote_membership_pending;
        delete receipt.remote_membership_reason;
      }
      else delete receipt.acknowledged_view;
      save(receipt);
      return receipt;
    } catch (error) {
      const code = (error as { code?: string }).code;
      receipt.status = ['local_conflict', 'symlink_path', 'invalid_path', 'invalid_root'].includes(code ?? '') ? 'local_conflict' : code === 'requirements_changed' ? 'requirements_changed' : 'stale_unavailable';
      receipt.next_action = receipt.status === 'local_conflict' ? 'Preserve edited files and exclude native shadow copies before retrying.' : receipt.status === 'requirements_changed'
        ? 'Approve the missing dependency disclosure or changed requirements before managed installation.' : 'Do not activate cached shared skills. Reconnect and retry; memory access is independent.';
      save(receipt);
      throw error;
    }
  }
  return {
    status: read,
    join: (follow_policy: FollowPolicy) => locked(async () => {
      const prior = read();
      if (!prior && readdirSync(root).some(path => path !== 'adapter.lock')) fail('local_conflict', 'Refusing to adopt an unowned shared-skills directory.');
      const snapshot = await options.call<MembershipSnapshot>('join_brain', { adapter: adapter.id, follow_policy });
      assertSnapshot(snapshot);
      if (prior && (prior.brain_id !== snapshot.brain_id || prior.installation_id !== snapshot.installation_id)) fail('local_conflict', 'The cache belongs to another principal or brain.');
      const receipt: SharedSkillsLocalReceipt = { ...prior, format_version: 1, adapter: adapter.id, brain_id: snapshot.brain_id, installation_id: snapshot.installation_id,
        enrollment_epoch: snapshot.enrollment_epoch, status: 'joined', native: 'unverified', router_path: join(root, 'router', 'SKILL.md'), native_registration: 'unverified',
        freshness: ['claude-code', 'codex', 'opencode'].includes(adapter.id) ? 'session_refresh' : 'advisory_refresh',
        owned_files: prior?.owned_files ?? {}, pending_files: prior?.pending_files ?? {}, next_action: adapter.reload };
      save(receipt);
      return refreshLocked(receipt);
    }),
    refresh: () => locked(async () => {
      const receipt = read();
      if (!receipt) return fail('membership_inactive', 'Enroll before syncing this installation.');
      return refreshLocked(receipt);
    }),
    admit: (key: string) => locked(async () => {
      const receipt = read();
      if (!receipt) return fail('membership_inactive', 'Enroll before using shared skills.');
      await refreshLocked(receipt, key);
      if (receipt.blocked_skills?.some(skill => skill.key === key)) fail('requirements_changed', 'This skill is blocked by current usability or dependency requirements.');
      const reference = JSON.parse(readFileSync(confinedPath(root, 'active.json'), 'utf8'));
      if (!reference.skills[key]) return fail('skill_unavailable', 'This qualified skill is not in the current authorized view.');
      return { ...reference.skills[key], key, admission_view: reference.view_token, native_verified: false };
    }),
    leave: () => locked(async () => {
      const receipt = read();
      if (!receipt) return { status: 'left' as const, retained_files: [], native: 'unverified' as const };
      receipt.status = 'left_with_retained_files';
      receipt.remote_membership_pending = true;
      receipt.next_action = 'Local following is disabled. Complete owned-file cleanup and retry remote membership deactivation when access is available.';
      save(receipt);
      const retained: string[] = [];
      try {
        if ((await removeNativeRouter(root, receipt)).retained) { retained.push('native-router'); receipt.native_registration = 'unverified'; }
        else receipt.native_registration = 'removed';
      }
      catch { retained.push('native-router'); }
      for (const path of new Set([...Object.keys(receipt.owned_files), ...Object.keys(receipt.pending_files)])) {
        try {
          const current = existingHash(path);
          if (current === null) { delete receipt.owned_files[path]; continue; }
          if (current !== receipt.owned_files[path] && current !== receipt.pending_files[path]?.after) { retained.push(path); continue; }
          unlinkSync(confinedPath(root, path)); delete receipt.owned_files[path];
          delete receipt.pending_files[path];
        } catch { retained.push(path); }
      }
      receipt.status = retained.length ? 'left_with_retained_files' : 'left';
      receipt.retained_files = retained;
      receipt.next_action = 'Disable native cached instructions and restart the harness. Retained edits were not removed; credentials remain independently valid.';
      save(receipt);
      try {
        await options.call('leave_brain', { installation_id: receipt.installation_id, enrollment_epoch: receipt.enrollment_epoch });
        receipt.remote_membership_pending = false;
        delete receipt.remote_membership_reason;
      } catch (error) {
        receipt.remote_membership_pending = true;
        receipt.remote_membership_reason = error instanceof OperationError ? error.code : 'remote_unavailable';
        receipt.next_action += ' Remote membership deactivation is pending; retry leave when the host can acknowledge it.';
      }
      save(receipt);
      return receipt;
    }),
  };
}
