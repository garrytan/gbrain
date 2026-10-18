/**
 * Codex wiring for `gbrain setup codex`: the stdio MCP table
 * `[mcp_servers.<name>]` in `$CODEX_HOME/config.toml`, setup's hook groups in
 * `$CODEX_HOME/hooks.json` (SessionStart + UserPromptSubmit read context;
 * SessionEnd capture only when accepted) and, for each group, the
 * `[hooks.state."<hooks.json>:<event>:<index>:0"]` trust table Codex requires
 * before it runs a user hook (without it the hook is listed and silently
 * skipped).
 *
 * Ownership is a hash: every owned entry (the MCP table, each hooks.json
 * group, each trust table) is fingerprinted with `ownedEntryFingerprint`
 * (sha256 over canonical JSON of the exact parsed entry) and recorded per
 * entry in the connection receipt `.gbrain-connection-codex-<name>.json`
 * beside config.toml (the name `gbrain connect --install` uses; a receipt
 * carrying `client_id` is a hosted one and is never adopted). Setup replaces
 * or removes an entry only when its current fingerprint is one the receipt
 * recorded (compare-and-swap); an edited entry is preserved and reported.
 * Receipt schema: `setup_receipt_version: 2` = the claude-code receipt's
 * fields plus `hooks_path`, `gbrain_home_env` and the per-event `trust` map.
 *
 * Write order, each step idempotent and resumable from the receipt:
 *   1. receipt `prepared`: the consent record (three decisions) and the
 *      pending MCP and hook fingerprints, before anything else is written;
 *   2. the MCP table, then the receipt records its fingerprint;
 *   3. the hooks.json groups (inert until trusted), then the receipt records
 *      their fingerprints and the pending trust fingerprints;
 *   4. the config.toml trust tables (activation, last), stale owned trust
 *      tables removed first; then the receipt records them;
 *   5. receipt `installed`.
 * `--remove` runs the reverse: trust, hooks, MCP, receipt. A crash anywhere
 * leaves pending fingerprints the next run treats as owned, so a resume never
 * duplicates an entry, and an untrusted hook never runs.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { ownedEntryFingerprint } from '../bootstrap/adopted-connections.ts';
import { acquireBootstrapLock } from '../bootstrap/lock.ts';
import { codexConfigPath } from '../bootstrap/host-specs.ts';
import { appendCodexTomlTable, readCodexTomlTable, removeCodexTomlTable, type CodexTomlValue } from '../bootstrap/codex-toml.ts';
import {
  CODEX_SETUP_EVENTS,
  CODEX_SETUP_LANE_TOKEN,
  codexHookCensus,
  codexSetupHookGroup,
  codexSetupTrustEntry,
  writeCodexSetupHooks,
  type CodexHookGroup,
  type CodexSetupEvent,
} from '../bootstrap/codex-hooks.ts';
import { stdioServeArgv } from '../mcp-registration.ts';
import type { McpSurface } from '../../mcp/surface.ts';
import { SetupAbortInjected, type SetupConsent, type SetupStep } from './claude-code.ts';

export const CODEX_SETUP_RECEIPT_VERSION = 2;

type Hashes = Partial<Record<CodexSetupEvent, string>>;
interface TrustRecord { key: string; hash: string }
type TrustRecords = Partial<Record<CodexSetupEvent, TrustRecord>>;

export interface CodexSetupReceipt {
  harness: 'codex';
  connection: 'local-stdio';
  setup_receipt_version: typeof CODEX_SETUP_RECEIPT_VERSION;
  status: 'prepared' | 'installed' | 'removed';
  name: string;
  gbrain_home: string;
  gbrain_home_env?: string;
  launcher: string;
  source_id: string | null;
  surface: McpSurface;
  config_path: string;
  hooks_path: string;
  entry_hash: string | null;
  pending_entry_hash: string | null;
  mcp_adopted?: boolean;
  mcp_plugin?: string;
  hooks: { owned: Hashes; pending: Hashes; edited: Hashes };
  trust: { owned: TrustRecords; pending: TrustRecords; edited: TrustRecords };
  consent: SetupConsent & { recorded_at: string };
  brain_created_by_setup: boolean;
  native_harness_verified: false;
  created_at: string;
  updated_at: string;
}

export interface CodexSetupPlan {
  name: string;
  launcher: string;
  brainHome: string;
  gbrainHomeEnv?: string;
  sourceId: string | null;
  surface: McpSurface;
  events: CodexSetupEvent[];
}

export type CodexSetupStep = Omit<SetupStep, 'step'> & { step: SetupStep['step'] | 'trust' };
export interface CodexPreserved { kind: 'mcp' | 'hook' | 'trust'; event?: string; reason: 'edited' | 'adopted' | 'unlocatable' | 'conflict' }

export interface CodexInspection {
  configPath: string;
  hooksPath: string;
  receiptPath: string;
  prior: CodexSetupReceipt | null;
  hostedReceipt: { mcp_url?: string } | null;
  mcp: { state: 'absent' | 'current' | 'owned' | 'remote' | 'unowned'; url?: string };
  /** Events already wired by gbrain's bootstrap Codex lane (token-owned). */
  otherLaneEvents: string[];
  /** Owned events whose group the user edited: preserved, never rewritten. */
  edited: Hashes;
  hooksCurrent: boolean;
  trustCurrent: boolean;
}

export function codexSetupPaths(name: string): { configPath: string; hooksPath: string; receiptPath: string } {
  const configPath = codexConfigPath();
  return { configPath, hooksPath: join(dirname(configPath), 'hooks.json'), receiptPath: join(dirname(configPath), `.gbrain-connection-codex-${name}.json`) };
}

export function readCodexSetupReceipt(receiptPath: string): { setup: CodexSetupReceipt | null; hosted: { mcp_url?: string } | null } {
  if (!existsSync(receiptPath)) return { setup: null, hosted: null };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  } catch { throw new Error(`the connection receipt ${receiptPath} is unreadable; move it aside only if you know which install wrote it, then run setup again.`); }
  if (raw.client_id) return { setup: null, hosted: { mcp_url: typeof raw.mcp_url === 'string' ? raw.mcp_url : undefined } };
  if (raw.harness === 'codex' && raw.connection === 'local-stdio' && raw.setup_receipt_version === CODEX_SETUP_RECEIPT_VERSION) return { setup: raw as unknown as CodexSetupReceipt, hosted: null };
  throw new Error(`the connection receipt ${receiptPath} was not written by gbrain setup; it is left untouched. Choose another --name.`);
}

const writeReceipt = (path: string, receipt: CodexSetupReceipt) => atomicWriteTextFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { forceMode: 0o600 });

export function desiredCodexMcpEntry(plan: Pick<CodexSetupPlan, 'launcher' | 'surface' | 'gbrainHomeEnv' | 'sourceId'>): Record<string, CodexTomlValue> {
  const env: Record<string, string> = {};
  if (plan.gbrainHomeEnv) env.GBRAIN_HOME = plan.gbrainHomeEnv;
  if (plan.sourceId) env.GBRAIN_SOURCE = plan.sourceId;
  return { command: plan.launcher, args: stdioServeArgv(plan.launcher, plan.surface).slice(1), ...(Object.keys(env).length ? { env } : {}) };
}

function desiredGroups(plan: CodexSetupPlan): Partial<Record<CodexSetupEvent, CodexHookGroup>> {
  const env = { GBRAIN_HOME: plan.gbrainHomeEnv, GBRAIN_SOURCE: plan.sourceId ?? undefined };
  return Object.fromEntries(plan.events.map((e) => [e, codexSetupHookGroup(plan.launcher, e, env)]));
}

const hashes = (groups: Partial<Record<CodexSetupEvent, CodexHookGroup>>): Hashes =>
  Object.fromEntries(Object.entries(groups).map(([e, g]) => [e, ownedEntryFingerprint(g)]));
const values = (h: Hashes | undefined): string[] => Object.values(h ?? {}).filter((v): v is string => typeof v === 'string');
const trustPath = (key: string) => ['hooks', 'state', key];
const trustFingerprint = (key: string, table: unknown) => ownedEntryFingerprint({ key, table });
const consentValues = (c: SetupConsent): string => JSON.stringify([c.wiring_scope.value.hooks, c.capture.value, c.providers.value]);

/** A setup-lane group of THIS install (its launcher and GBRAIN_HOME pin), whatever its fingerprint. */
function isThisInstallsGroup(commands: string[], launcher: string, homeEnv: string | undefined): boolean {
  return commands.some((c) => c.includes(CODEX_SETUP_LANE_TOKEN) && c.includes(launcher)
    && (homeEnv ? c.includes(`GBRAIN_HOME=${homeEnv}`) : !c.includes('GBRAIN_HOME=')));
}

/** Desired trust records for the wanted groups at their current hooks.json indexes. */
function desiredTrust(hooksPath: string, groups: Partial<Record<CodexSetupEvent, CodexHookGroup>>, indexes: Partial<Record<CodexSetupEvent, number>>): Array<{ event: CodexSetupEvent; key: string; table: { trusted_hash: string }; hash: string }> {
  return (Object.keys(groups) as CodexSetupEvent[]).flatMap((event) => {
    const index = indexes[event];
    if (index === undefined) return [];
    const { key, trusted_hash } = codexSetupTrustEntry(hooksPath, event, index, groups[event]!);
    return [{ event, key, table: { trusted_hash }, hash: trustFingerprint(key, { trusted_hash }) }];
  });
}

/** Read-only: what setup would find and own. Throws on an unparseable config or hooks file. */
export function inspectCodexSetup(plan: CodexSetupPlan): CodexInspection {
  const paths = codexSetupPaths(plan.name);
  const { setup: prior, hosted } = readCodexSetupReceipt(paths.receiptPath);
  const entry = readCodexTomlTable(paths.configPath, ['mcp_servers', plan.name]);
  const desired = ownedEntryFingerprint(desiredCodexMcpEntry(plan));
  const entryFp = entry === undefined ? null : ownedEntryFingerprint(entry);
  const mcp: CodexInspection['mcp'] = entry === undefined ? { state: 'absent' }
    : entryFp === desired ? { state: 'current' }
      : typeof (entry as Record<string, unknown>)?.url === 'string' ? { state: 'remote', url: (entry as Record<string, string>).url }
        : prior && [prior.entry_hash, prior.pending_entry_hash].includes(entryFp) ? { state: 'owned' } : { state: 'unowned' };

  const census = codexHookCensus(paths.hooksPath);
  const groups = desiredGroups(plan);
  const want = hashes(groups);
  const owned = new Set([...values(prior?.hooks.owned), ...values(prior?.hooks.pending), ...values(want)]);
  const edited: Hashes = {};
  for (const event of CODEX_SETUP_EVENTS) {
    const present = census.filter((g) => g.event === event);
    const priorEdit = prior?.hooks.edited[event];
    const recorded = prior?.hooks.owned[event];
    if (priorEdit && present.some((g) => g.hash === priorEdit)) { edited[event] = priorEdit; continue; }
    const candidate = recorded && !present.some((g) => g.hash === recorded)
      ? present.find((g) => !owned.has(g.hash) && isThisInstallsGroup(g.commands, plan.launcher, plan.gbrainHomeEnv)) : undefined;
    if (candidate) edited[event] = candidate.hash;
  }
  let hooksCurrent = true;
  const indexes: Partial<Record<CodexSetupEvent, number>> = {};
  for (const g of census) {
    const target = want[g.event as CodexSetupEvent];
    if (owned.has(g.hash) && g.hash !== target) hooksCurrent = false;
    if (target && g.hash === target) {
      if (indexes[g.event as CodexSetupEvent] !== undefined) hooksCurrent = false;
      indexes[g.event as CodexSetupEvent] = g.index;
    }
  }
  for (const event of plan.events) if (!edited[event] && indexes[event] === undefined) hooksCurrent = false;

  let trustCurrent = hooksCurrent;
  if (trustCurrent) {
    const wanted = desiredTrust(paths.hooksPath, Object.fromEntries(Object.entries(groups).filter(([e]) => !edited[e as CodexSetupEvent])), indexes);
    for (const t of wanted) if (trustFingerprint(t.key, readCodexTomlTable(paths.configPath, trustPath(t.key))) !== t.hash) trustCurrent = false;
    for (const rec of [...Object.values(prior?.trust.owned ?? {}), ...Object.values(prior?.trust.pending ?? {})]) {
      if (!rec || wanted.some((t) => t.key === rec.key && t.hash === rec.hash)) continue;
      if (trustFingerprint(rec.key, readCodexTomlTable(paths.configPath, trustPath(rec.key))) === rec.hash) trustCurrent = false;
    }
  }
  const otherLaneEvents = [...new Set(census.filter((g) => g.lane === 'bootstrap').map((g) => g.event))];
  return { ...paths, prior, hostedReceipt: hosted, mcp, otherLaneEvents, edited, hooksCurrent, trustCurrent };
}

export interface CodexApplyResult { steps: CodexSetupStep[]; receipt: CodexSetupReceipt; changed: boolean; preserved: CodexPreserved[]; notes: string[] }

/**
 * Apply the plan under the Codex config-dir lock, in the write order above.
 * `pluginOwner` skips the MCP table (the gbrain Codex plugin serves the name);
 * `beforeMcp` runs after the receipt is prepared (the brain init step);
 * `abortAfter` is the crash-injection test seam.
 */
export async function applyCodexSetup(
  plan: CodexSetupPlan,
  consent: SetupConsent,
  opts: { pluginOwner: string | null; brainCreated: boolean; beforeMcp?: () => Promise<void>; abortAfter?: string },
): Promise<CodexApplyResult> {
  const paths = codexSetupPaths(plan.name);
  mkdirSync(dirname(paths.configPath), { recursive: true, mode: 0o700 });
  const lock = await acquireBootstrapLock(dirname(paths.configPath));
  try {
    const found = inspectCodexSetup(plan);
    const prior = found.prior;
    const now = new Date().toISOString();
    const desired = desiredCodexMcpEntry(plan);
    const desiredHash = ownedEntryFingerprint(desired);
    const groups = desiredGroups(plan);
    const writeGroups = Object.fromEntries(Object.entries(groups).filter(([e]) => !found.edited[e as CodexSetupEvent])) as Partial<Record<CodexSetupEvent, CodexHookGroup>>;
    const want = hashes(writeGroups);
    const steps: CodexSetupStep[] = [];
    const preserved: CodexPreserved[] = Object.keys(found.edited).map((event) => ({ kind: 'hook', event, reason: 'edited' }));
    const notes: string[] = [];
    const mcpDone = opts.pluginOwner !== null || found.mcp.state === 'current';
    const consentSame = prior?.consent !== undefined && consentValues(prior.consent) === consentValues(consent);
    if (prior?.status === 'installed' && consentSame && mcpDone && found.hooksCurrent && found.trustCurrent && !opts.brainCreated) {
      steps.push({ step: 'receipt', action: 'keep', detail: `${paths.receiptPath} already records this install` });
      steps.push({ step: 'mcp', action: opts.pluginOwner ? 'skip' : 'keep', detail: opts.pluginOwner ? `the '${opts.pluginOwner}' plugin serves '${plan.name}'` : `[mcp_servers.${plan.name}] in ${paths.configPath} is current` });
      steps.push({ step: 'hooks', action: 'keep', detail: plan.events.length ? `${plan.events.join(', ')} in ${paths.hooksPath} are current` : 'no hooks wanted' });
      steps.push({ step: 'trust', action: 'keep', detail: plan.events.length ? `trust entries in ${paths.configPath} are current` : 'no trust entries wanted' });
      for (const p of preserved) steps.push({ step: 'hooks', action: 'preserve', detail: `${p.event} in ${paths.hooksPath} was edited after setup wrote it; kept as is` });
      return { steps, receipt: prior, changed: false, preserved, notes };
    }

    const receipt: CodexSetupReceipt = {
      harness: 'codex', connection: 'local-stdio', setup_receipt_version: CODEX_SETUP_RECEIPT_VERSION, status: 'prepared',
      name: plan.name, gbrain_home: plan.brainHome, ...(plan.gbrainHomeEnv ? { gbrain_home_env: plan.gbrainHomeEnv } : {}),
      launcher: plan.launcher, source_id: plan.sourceId, surface: plan.surface,
      config_path: paths.configPath, hooks_path: paths.hooksPath,
      entry_hash: prior?.entry_hash ?? null, pending_entry_hash: opts.pluginOwner ? null : desiredHash,
      ...(prior?.mcp_adopted ? { mcp_adopted: true } : {}),
      ...(opts.pluginOwner ? { mcp_plugin: opts.pluginOwner } : {}),
      hooks: { owned: prior?.hooks.owned ?? {}, pending: want, edited: found.edited },
      trust: { owned: prior?.trust.owned ?? {}, pending: prior?.trust.pending ?? {}, edited: prior?.trust.edited ?? {} },
      consent: { ...consent, recorded_at: now },
      brain_created_by_setup: (prior?.brain_created_by_setup ?? false) || opts.brainCreated,
      native_harness_verified: false,
      created_at: prior?.created_at ?? now, updated_at: now,
    };
    const save = () => writeReceipt(paths.receiptPath, receipt);
    save();
    steps.push({ step: 'receipt', action: 'write', detail: `${paths.receiptPath} (prepared: consent and pending fingerprints recorded)` });
    if (opts.abortAfter === 'receipt') throw new SetupAbortInjected('receipt');
    await opts.beforeMcp?.();

    // 2. MCP table.
    if (opts.pluginOwner) {
      steps.push({ step: 'mcp', action: 'skip', detail: `the '${opts.pluginOwner}' plugin serves '${plan.name}'; no hand-wired table` });
    } else if (found.mcp.state === 'current') {
      if (!prior?.entry_hash && !prior?.pending_entry_hash) receipt.mcp_adopted = true;
      steps.push({ step: 'mcp', action: 'keep', detail: `[mcp_servers.${plan.name}] in ${paths.configPath} is current${receipt.mcp_adopted ? ' (adopted: it was already there, so --remove keeps it)' : ''}` });
    } else {
      if (found.mcp.state === 'owned' && removeCodexTomlTable(paths.configPath, ['mcp_servers', plan.name]) === 'unlocatable') {
        throw new Error(`[mcp_servers.${plan.name}] in ${paths.configPath} is setup's but was re-rendered in a shape setup cannot rewrite safely; remove that table by hand, then run setup again.`);
      }
      appendCodexTomlTable(paths.configPath, ['mcp_servers', plan.name], desired, `gbrain setup (${plan.name}): owned by fingerprint; \`gbrain setup codex --remove\` deletes it while unchanged`);
      delete receipt.mcp_adopted;
      steps.push({ step: 'mcp', action: 'write', detail: `[mcp_servers.${plan.name}] in ${paths.configPath}` });
    }
    if (!opts.pluginOwner) receipt.entry_hash = desiredHash;
    receipt.pending_entry_hash = null;
    save();
    if (opts.abortAfter === 'mcp') throw new SetupAbortInjected('mcp');

    // 3. hooks.json groups (inert until trusted).
    const ownedHooks = new Set([...values(prior?.hooks.owned), ...values(prior?.hooks.pending), ...values(want)]);
    const w = writeCodexSetupHooks(paths.hooksPath, { want: writeGroups, owned: ownedHooks, preserve: new Set(Object.keys(found.edited)) });
    notes.push(...w.notes);
    const written = Object.keys(writeGroups);
    steps.push(w.changed
      ? { step: 'hooks', action: 'write', detail: written.length ? `${written.join(', ')} in ${paths.hooksPath}` : `removed setup's groups from ${paths.hooksPath}` }
      : { step: 'hooks', action: 'keep', detail: written.length ? `${written.join(', ')} in ${paths.hooksPath} are current` : 'no hooks wanted' });
    for (const event of Object.keys(found.edited)) steps.push({ step: 'hooks', action: 'preserve', detail: `${event} in ${paths.hooksPath} was edited after setup wrote it; kept as is (and left untrusted by setup)` });
    receipt.hooks.owned = want;
    receipt.hooks.pending = {};
    const wanted = desiredTrust(paths.hooksPath, writeGroups, w.indexes);
    receipt.trust.pending = Object.fromEntries(wanted.map((t) => [t.event, { key: t.key, hash: t.hash }]));
    save();
    if (opts.abortAfter === 'hooks') throw new SetupAbortInjected('hooks');

    // 4. Trust tables: drop stale owned ones (an index or command change), then add the wanted ones.
    const trustEdited: TrustRecords = { ...receipt.trust.edited };
    const ownedTrust = [...Object.entries(prior?.trust.owned ?? {}), ...Object.entries(prior?.trust.pending ?? {})] as Array<[CodexSetupEvent, TrustRecord]>;
    for (const [event, rec] of ownedTrust) {
      if (wanted.some((t) => t.key === rec.key && t.hash === rec.hash)) continue;
      const table = readCodexTomlTable(paths.configPath, trustPath(rec.key));
      if (table === undefined) continue;
      if (trustFingerprint(rec.key, table) !== rec.hash) {
        trustEdited[event] = { key: rec.key, hash: trustFingerprint(rec.key, table) };
        preserved.push({ kind: 'trust', event, reason: 'edited' });
        steps.push({ step: 'trust', action: 'preserve', detail: `[hooks.state."${rec.key}"] changed after setup wrote it; kept` });
        continue;
      }
      const r = removeCodexTomlTable(paths.configPath, trustPath(rec.key));
      if (r === 'unlocatable') {
        preserved.push({ kind: 'trust', event, reason: 'unlocatable' });
        steps.push({ step: 'trust', action: 'preserve', detail: `[hooks.state."${rec.key}"] could not be located as one table; kept` });
      } else steps.push({ step: 'trust', action: 'remove', detail: `stale [hooks.state."${rec.key}"] (setup's ${event} group moved or changed)` });
    }
    const trusted: TrustRecords = {};
    for (const t of wanted) {
      const table = readCodexTomlTable(paths.configPath, trustPath(t.key));
      if (table !== undefined && trustFingerprint(t.key, table) === t.hash) {
        trusted[t.event] = { key: t.key, hash: t.hash };
        steps.push({ step: 'trust', action: 'keep', detail: `${t.event} is trusted in ${paths.configPath}` });
      } else if (table !== undefined) {
        preserved.push({ kind: 'trust', event: t.event, reason: 'conflict' });
        steps.push({ step: 'trust', action: 'preserve', detail: `${paths.configPath} already has a different [hooks.state."${t.key}"]; kept, so codex will ask before running setup's ${t.event} hook` });
      } else {
        appendCodexTomlTable(paths.configPath, trustPath(t.key), t.table, `gbrain setup (${plan.name}): trusts setup's ${t.event} hook; owned by fingerprint`);
        trusted[t.event] = { key: t.key, hash: t.hash };
        steps.push({ step: 'trust', action: 'write', detail: `${t.event} trust entry in ${paths.configPath}` });
      }
    }
    if (wanted.length === 0 && !steps.some((s) => s.step === 'trust')) steps.push({ step: 'trust', action: 'keep', detail: 'no trust entries wanted' });
    receipt.trust = { owned: trusted, pending: {}, edited: trustEdited };
    save();
    if (opts.abortAfter === 'trust') throw new SetupAbortInjected('trust');
    receipt.status = 'installed';
    save();
    return { steps, receipt, changed: true, preserved, notes };
  } finally {
    lock.release();
  }
}

export interface CodexRemoveResult { steps: CodexSetupStep[]; preserved: CodexPreserved[]; notes: string[]; receiptRemoved: boolean }

/** Remove exactly what the receipt owns by fingerprint (trust, hooks, MCP, receipt); edited entries survive and are reported. */
export async function removeCodexSetup(receipt: CodexSetupReceipt, receiptPath: string, opts: { dryRun: boolean }): Promise<CodexRemoveResult> {
  const lock = await acquireBootstrapLock(dirname(receipt.config_path));
  try {
    const steps: CodexSetupStep[] = [];
    const preserved: CodexPreserved[] = [];
    const notes: string[] = [];
    const trustEdited: TrustRecords = {};
    for (const [event, rec] of [...Object.entries(receipt.trust.owned), ...Object.entries(receipt.trust.pending)] as Array<[CodexSetupEvent, TrustRecord]>) {
      const table = readCodexTomlTable(receipt.config_path, trustPath(rec.key));
      if (table === undefined) continue;
      if (trustFingerprint(rec.key, table) !== rec.hash) {
        trustEdited[event] = { key: rec.key, hash: trustFingerprint(rec.key, table) };
        preserved.push({ kind: 'trust', event, reason: 'edited' });
        steps.push({ step: 'trust', action: 'preserve', detail: `[hooks.state."${rec.key}"] changed after setup wrote it; kept` });
      } else if (removeCodexTomlTable(receipt.config_path, trustPath(rec.key), { dryRun: opts.dryRun }) === 'unlocatable') {
        preserved.push({ kind: 'trust', event, reason: 'unlocatable' });
        steps.push({ step: 'trust', action: 'preserve', detail: `[hooks.state."${rec.key}"] could not be located as one table; kept` });
      } else steps.push({ step: 'trust', action: 'remove', detail: `${event} trust entry from ${receipt.config_path}` });
    }

    const owned = new Set([...values(receipt.hooks.owned), ...values(receipt.hooks.pending)]);
    const census = codexHookCensus(receipt.hooks_path);
    const removedGroups = census.filter((g) => owned.has(g.hash));
    const w = writeCodexSetupHooks(receipt.hooks_path, { want: {}, owned, preserve: new Set(), dryRun: opts.dryRun });
    notes.push(...w.notes);
    steps.push(removedGroups.length
      ? { step: 'hooks', action: 'remove', detail: `${removedGroups.map((g) => g.event).join(', ')} from ${receipt.hooks_path}` }
      : { step: 'hooks', action: 'skip', detail: `no owned groups in ${receipt.hooks_path}` });
    const edited: Hashes = {};
    for (const event of CODEX_SETUP_EVENTS) {
      const recorded = receipt.hooks.owned[event] ?? receipt.hooks.pending[event];
      const present = census.filter((g) => g.event === event && !owned.has(g.hash));
      const hit = present.find((g) => g.hash === receipt.hooks.edited[event])
        ?? (recorded && !census.some((g) => g.hash === recorded) ? present.find((g) => isThisInstallsGroup(g.commands, receipt.launcher, receipt.gbrain_home_env)) : undefined);
      if (!hit) continue;
      edited[event] = hit.hash;
      preserved.push({ kind: 'hook', event, reason: 'edited' });
      steps.push({ step: 'hooks', action: 'preserve', detail: `${event} in ${receipt.hooks_path} was edited after setup wrote it; kept` });
    }

    const entry = readCodexTomlTable(receipt.config_path, ['mcp_servers', receipt.name]);
    const entryFp = entry === undefined ? null : ownedEntryFingerprint(entry);
    if (receipt.mcp_plugin) {
      steps.push({ step: 'mcp', action: 'skip', detail: `the '${receipt.mcp_plugin}' plugin serves '${receipt.name}'; setup wrote no table` });
    } else if (entry === undefined) {
      steps.push({ step: 'mcp', action: 'skip', detail: `no [mcp_servers.${receipt.name}] in ${receipt.config_path}` });
    } else if (receipt.mcp_adopted && entryFp === receipt.entry_hash) {
      preserved.push({ kind: 'mcp', reason: 'adopted' });
      steps.push({ step: 'mcp', action: 'preserve', detail: `[mcp_servers.${receipt.name}] existed before setup ran; kept` });
    } else if ([receipt.entry_hash, receipt.pending_entry_hash].includes(entryFp)) {
      if (removeCodexTomlTable(receipt.config_path, ['mcp_servers', receipt.name], { dryRun: opts.dryRun }) === 'unlocatable') {
        preserved.push({ kind: 'mcp', reason: 'unlocatable' });
        steps.push({ step: 'mcp', action: 'preserve', detail: `[mcp_servers.${receipt.name}] could not be located as one table; kept` });
      } else steps.push({ step: 'mcp', action: 'remove', detail: `[mcp_servers.${receipt.name}] from ${receipt.config_path}` });
    } else {
      preserved.push({ kind: 'mcp', reason: 'edited' });
      steps.push({ step: 'mcp', action: 'preserve', detail: `[mcp_servers.${receipt.name}] in ${receipt.config_path} changed after setup wrote it; kept` });
    }

    let receiptRemoved = false;
    if (!opts.dryRun) {
      if (preserved.some((p) => p.reason === 'edited')) {
        writeReceipt(receiptPath, { ...receipt, status: 'removed', entry_hash: null, pending_entry_hash: null,
          hooks: { owned: {}, pending: {}, edited }, trust: { owned: {}, pending: {}, edited: trustEdited }, updated_at: new Date().toISOString() });
        steps.push({ step: 'receipt', action: 'write', detail: `${receiptPath} (removed; remembers the edited entries so a later setup leaves them alone)` });
      } else {
        if (existsSync(receiptPath)) unlinkSync(receiptPath);
        receiptRemoved = true;
        steps.push({ step: 'receipt', action: 'remove', detail: receiptPath });
      }
    }
    return { steps, preserved, notes, receiptRemoved };
  } finally {
    lock.release();
  }
}
