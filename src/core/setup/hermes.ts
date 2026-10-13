/**
 * Hermes wiring for `gbrain setup hermes`: the stdio MCP entry
 * `mcp_servers.<name>` in `$HERMES_HOME/config.yaml`, setup's shell-hook items
 * under `hooks.pre_llm_call` (read context; SessionStart-style digest rides the
 * first turn) and, only after capture is accepted, `hooks.on_session_finalize`,
 * and the approval Hermes requires before it runs a user shell hook: one
 * `(event, command)` entry per hook in `$HERMES_HOME/shell-hooks-allowlist.json`
 * (without it a non-interactive Hermes silently skips the hook).
 *
 * Ownership is a hash, as for Codex: every owned entry (the MCP entry, each hook
 * item, each approval) is fingerprinted with `ownedEntryFingerprint` over its
 * PARSED value and recorded in the connection receipt
 * `.gbrain-connection-hermes-<name>.json` beside config.yaml (the name `gbrain
 * connect --install` uses; a receipt carrying `client_id`, or the hosted
 * provider's `.gbrain-hermes/receipt.json`, is a hosted connection and is never
 * adopted). Setup replaces or removes an entry only when its current fingerprint
 * is one the receipt recorded; an edited entry is preserved and reported.
 * Receipt schema: `setup_receipt_version: 3` = the Codex receipt's fields with
 * `hermes_home`/`allowlist_path` for `hooks_path`, and `trust` keyed by Hermes
 * event holding the approved `{command, hash}` pair.
 *
 * The MCP entry is `{command, args: [serve, --surface, S], env}` and nothing
 * more: Hermes filters a stdio child's environment to a safe baseline plus the
 * entry's own `env`, so GBRAIN_HOME (always pinned) and GBRAIN_SOURCE travel
 * there. Hermes' optional keys (connect_timeout, enabled, tools) are left to
 * its defaults; a user who adds them is an edit, preserved on `--remove`. No
 * `memory.provider`: that slot is exclusive and belongs to the hosted lane.
 *
 * Write order, each step idempotent and resumable from the receipt:
 *   1. receipt `prepared` (consent, pending MCP/hook fingerprints, pending approvals);
 *   2. the MCP entry, then the receipt records its fingerprint;
 *   3. the hook items (inert until approved), then the receipt records them;
 *   4. the approvals (activation, last), stale owned ones revoked first;
 *   5. receipt `installed`.
 * `--remove` runs the reverse: approvals, hooks, MCP, receipt.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { ownedEntryFingerprint } from '../bootstrap/adopted-connections.ts';
import { acquireBootstrapLock } from '../bootstrap/lock.ts';
import { hermesAllowlistPath, hermesConfigPath, hermesHome } from '../bootstrap/host-specs.ts';
import { appendHermesYamlEntry, readHermesYaml, removeHermesYamlEntry } from '../bootstrap/hermes-yaml.ts';
import {
  HERMES_SETUP_EVENTS,
  HERMES_SETUP_LANE_TOKEN,
  approvalIsEdited,
  approveHermesHooks,
  hermesHookCensus,
  hermesSetupHookItem,
  isApproved,
  readHermesAllowlist,
  revokeHermesHooks,
  writeHermesSetupHooks,
  type HermesHookItem,
  type HermesPair,
  type HermesSetupEvent,
} from '../bootstrap/hermes-hooks.ts';
import { stdioServeArgv } from '../mcp-registration.ts';
import type { McpSurface } from '../../mcp/surface.ts';
import { SetupAbortInjected, type SetupConsent, type SetupStep } from './claude-code.ts';

export const HERMES_SETUP_RECEIPT_VERSION = 3;

type Hashes = Partial<Record<HermesSetupEvent, string>>;
interface TrustRecord { command: string; hash: string }
type TrustRecords = Partial<Record<HermesSetupEvent, TrustRecord>>;

export interface HermesSetupReceipt {
  harness: 'hermes';
  connection: 'local-stdio';
  setup_receipt_version: typeof HERMES_SETUP_RECEIPT_VERSION;
  status: 'prepared' | 'installed' | 'removed';
  name: string;
  gbrain_home: string;
  gbrain_home_env: string;
  hermes_home: string;
  launcher: string;
  source_id: string | null;
  surface: McpSurface;
  config_path: string;
  allowlist_path: string;
  entry_hash: string | null;
  pending_entry_hash: string | null;
  mcp_adopted?: boolean;
  hooks: { owned: Hashes; pending: Hashes; edited: Hashes };
  trust: { owned: TrustRecords; pending: TrustRecords; edited: TrustRecords; allowlist_created?: boolean };
  consent: SetupConsent & { recorded_at: string };
  brain_created_by_setup: boolean;
  native_harness_verified: false;
  created_at: string;
  updated_at: string;
}

export interface HermesSetupPlan {
  name: string;
  launcher: string;
  /** `configDir()` of the install: the receipt's identity. */
  brainHome: string;
  /** GBRAIN_HOME rendered into the entry and the hooks (Hermes filters env, so it is always pinned). */
  gbrainHomeEnv: string;
  hermesHome: string;
  sourceId: string | null;
  surface: McpSurface;
  events: HermesSetupEvent[];
}

export type HermesSetupStep = Omit<SetupStep, 'step'> & { step: SetupStep['step'] | 'trust' };
export interface HermesPreserved { kind: 'mcp' | 'hook' | 'trust'; event?: string; reason: 'edited' | 'adopted' | 'unlocatable' | 'conflict' }

export interface HermesInspection {
  configPath: string;
  allowlistPath: string;
  receiptPath: string;
  prior: HermesSetupReceipt | null;
  hostedReceipt: { mcp_url?: string } | null;
  mcp: { state: 'absent' | 'current' | 'owned' | 'remote' | 'unowned'; url?: string };
  /** Events already wired by a hand-written or bootstrap gbrain hermes hook (no setup lane token). */
  otherLaneEvents: string[];
  /** Owned events whose item the user edited: preserved, never rewritten. */
  edited: Hashes;
  hooksCurrent: boolean;
  trustCurrent: boolean;
}

export function hermesSetupPaths(name: string, home: string = hermesHome()): { home: string; configPath: string; allowlistPath: string; receiptPath: string } {
  return { home, configPath: hermesConfigPath(home), allowlistPath: hermesAllowlistPath(home), receiptPath: join(home, `.gbrain-connection-hermes-${name}.json`) };
}

/** The hosted provider lane's receipt (`gbrain hermes setup --url …`): a url-bearing connection setup never replaces. */
export function hermesProviderReceipt(home: string): { mcp_url?: string } | null {
  try {
    const raw = JSON.parse(readFileSync(join(home, '.gbrain-hermes', 'receipt.json'), 'utf8')) as Record<string, unknown>;
    if (raw && (raw.state === 'prepared' || raw.state === 'installed')) return { mcp_url: typeof raw.connection_url === 'string' ? raw.connection_url : undefined };
  } catch { /* none */ }
  return null;
}

export function readHermesSetupReceipt(receiptPath: string): { setup: HermesSetupReceipt | null; hosted: { mcp_url?: string } | null } {
  if (!existsSync(receiptPath)) return { setup: null, hosted: null };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  } catch { throw new Error(`the connection receipt ${receiptPath} is unreadable; move it aside only if you know which install wrote it, then run setup again.`); }
  if (raw.client_id) return { setup: null, hosted: { mcp_url: typeof raw.mcp_url === 'string' ? raw.mcp_url : undefined } };
  if (raw.harness === 'hermes' && raw.connection === 'local-stdio' && raw.setup_receipt_version === HERMES_SETUP_RECEIPT_VERSION) return { setup: raw as unknown as HermesSetupReceipt, hosted: null };
  throw new Error(`the connection receipt ${receiptPath} was not written by gbrain setup; it is left untouched. Choose another --name.`);
}

const writeReceipt = (path: string, receipt: HermesSetupReceipt) => atomicWriteTextFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { forceMode: 0o600 });

export function desiredHermesMcpEntry(plan: Pick<HermesSetupPlan, 'launcher' | 'surface' | 'gbrainHomeEnv' | 'sourceId'>): Record<string, unknown> {
  const env: Record<string, string> = { GBRAIN_HOME: plan.gbrainHomeEnv };
  if (plan.sourceId) env.GBRAIN_SOURCE = plan.sourceId;
  return { command: plan.launcher, args: stdioServeArgv(plan.launcher, plan.surface).slice(1), env };
}

function desiredItems(plan: HermesSetupPlan): Partial<Record<HermesSetupEvent, HermesHookItem>> {
  const env = { GBRAIN_HOME: plan.gbrainHomeEnv, GBRAIN_SOURCE: plan.sourceId ?? undefined, HERMES_HOME: plan.hermesHome };
  return Object.fromEntries(plan.events.map((e) => [e, hermesSetupHookItem(plan.launcher, e, env)]));
}

const hashes = (items: Partial<Record<HermesSetupEvent, HermesHookItem>>): Hashes =>
  Object.fromEntries(Object.entries(items).map(([e, it]) => [e, ownedEntryFingerprint(it)]));
const values = (h: Hashes | undefined): string[] => Object.values(h ?? {}).filter((v): v is string => typeof v === 'string');
const pairFingerprint = (p: HermesPair): string => ownedEntryFingerprint({ event: p.event, command: p.command });
const consentValues = (c: SetupConsent): string => JSON.stringify([c.wiring_scope.value.hooks, c.capture.value, c.providers.value]);

/** A setup-lane item of THIS install (its launcher and GBRAIN_HOME pin), whatever its fingerprint. */
const isThisInstallsItem = (command: string, launcher: string, homeEnv: string): boolean =>
  command.includes(HERMES_SETUP_LANE_TOKEN) && command.includes(launcher) && command.includes(`GBRAIN_HOME=${homeEnv}`);

function desiredPairs(items: Partial<Record<HermesSetupEvent, HermesHookItem>>): Array<HermesPair & { hash: string }> {
  return (Object.entries(items) as Array<[HermesSetupEvent, HermesHookItem]>).map(([event, it]) => ({ event, command: it.command, hash: pairFingerprint({ event, command: it.command }) }));
}

/** Read-only: what setup would find and own. Throws on an unparseable config or allowlist. */
export function inspectHermesSetup(plan: HermesSetupPlan): HermesInspection {
  const paths = hermesSetupPaths(plan.name, plan.hermesHome);
  const { setup: prior, hosted } = readHermesSetupReceipt(paths.receiptPath);
  const entry = readHermesYaml(paths.configPath, ['mcp_servers', plan.name]);
  const desired = ownedEntryFingerprint(desiredHermesMcpEntry(plan));
  const entryFp = entry === undefined ? null : ownedEntryFingerprint(entry);
  const mcp: HermesInspection['mcp'] = entry === undefined ? { state: 'absent' }
    : entryFp === desired ? { state: 'current' }
      : typeof (entry as Record<string, unknown>)?.url === 'string' ? { state: 'remote', url: (entry as Record<string, string>).url }
        : prior && [prior.entry_hash, prior.pending_entry_hash].includes(entryFp) ? { state: 'owned' } : { state: 'unowned' };

  const census = hermesHookCensus(paths.configPath);
  const items = desiredItems(plan);
  const want = hashes(items);
  const owned = new Set([...values(prior?.hooks.owned), ...values(prior?.hooks.pending), ...values(want)]);
  const edited: Hashes = {};
  for (const event of HERMES_SETUP_EVENTS) {
    const present = census.filter((g) => g.event === event);
    const priorEdit = prior?.hooks.edited[event];
    const recorded = prior?.hooks.owned[event];
    if (priorEdit && present.some((g) => g.hash === priorEdit)) { edited[event] = priorEdit; continue; }
    const candidate = recorded && !present.some((g) => g.hash === recorded)
      ? present.find((g) => !owned.has(g.hash) && isThisInstallsItem(g.command, plan.launcher, plan.gbrainHomeEnv)) : undefined;
    if (candidate) edited[event] = candidate.hash;
  }
  let hooksCurrent = true;
  const seen: Partial<Record<HermesSetupEvent, number>> = {};
  for (const g of census) {
    const target = want[g.event];
    if (owned.has(g.hash) && g.hash !== target) hooksCurrent = false;
    if (target && g.hash === target) { if (seen[g.event]) hooksCurrent = false; seen[g.event] = (seen[g.event] ?? 0) + 1; }
  }
  for (const event of plan.events) if (!edited[event] && !seen[event]) hooksCurrent = false;

  let trustCurrent = hooksCurrent;
  if (trustCurrent) {
    const file = readHermesAllowlist(paths.allowlistPath);
    const wanted = desiredPairs(Object.fromEntries(Object.entries(items).filter(([e]) => !edited[e as HermesSetupEvent])));
    for (const t of wanted) if (!isApproved(file, t)) trustCurrent = false;
    for (const rec of [...Object.entries(prior?.trust.owned ?? {}), ...Object.entries(prior?.trust.pending ?? {})] as Array<[HermesSetupEvent, TrustRecord]>) {
      if (wanted.some((t) => t.command === rec[1].command && t.event === rec[0])) continue;
      if (isApproved(file, { event: rec[0], command: rec[1].command })) trustCurrent = false;
    }
  }
  const otherLaneEvents = [...new Set(census.filter((g) => g.lane === 'other').map((g) => g.event))];
  return { configPath: paths.configPath, allowlistPath: paths.allowlistPath, receiptPath: paths.receiptPath, prior, hostedReceipt: hosted, mcp, otherLaneEvents, edited, hooksCurrent, trustCurrent };
}

export interface HermesApplyResult { steps: HermesSetupStep[]; receipt: HermesSetupReceipt; changed: boolean; preserved: HermesPreserved[]; notes: string[] }

/**
 * Apply the plan under the Hermes-home lock, in the write order above.
 * `beforeMcp` runs after the receipt is prepared (the brain init step);
 * `abortAfter` is the crash-injection test seam.
 */
export async function applyHermesSetup(
  plan: HermesSetupPlan,
  consent: SetupConsent,
  opts: { brainCreated: boolean; beforeMcp?: () => Promise<void>; abortAfter?: string },
): Promise<HermesApplyResult> {
  const paths = hermesSetupPaths(plan.name, plan.hermesHome);
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const lock = await acquireBootstrapLock(paths.home);
  try {
    const found = inspectHermesSetup(plan);
    const prior = found.prior;
    const now = new Date().toISOString();
    const desired = desiredHermesMcpEntry(plan);
    const desiredHash = ownedEntryFingerprint(desired);
    const items = desiredItems(plan);
    const writeItems = Object.fromEntries(Object.entries(items).filter(([e]) => !found.edited[e as HermesSetupEvent])) as Partial<Record<HermesSetupEvent, HermesHookItem>>;
    const want = hashes(writeItems);
    const steps: HermesSetupStep[] = [];
    const preserved: HermesPreserved[] = Object.keys(found.edited).map((event) => ({ kind: 'hook', event, reason: 'edited' }));
    const notes: string[] = [];
    const mcpDone = found.mcp.state === 'current';
    const consentSame = prior?.consent !== undefined && consentValues(prior.consent) === consentValues(consent);
    if (prior?.status === 'installed' && consentSame && mcpDone && found.hooksCurrent && found.trustCurrent && !opts.brainCreated) {
      steps.push({ step: 'receipt', action: 'keep', detail: `${paths.receiptPath} already records this install` });
      steps.push({ step: 'mcp', action: 'keep', detail: `mcp_servers.${plan.name} in ${paths.configPath} is current` });
      steps.push({ step: 'hooks', action: 'keep', detail: plan.events.length ? `${plan.events.join(', ')} in ${paths.configPath} are current` : 'no hooks wanted' });
      steps.push({ step: 'trust', action: 'keep', detail: plan.events.length ? `hook approvals in ${paths.allowlistPath} are current` : 'no approvals wanted' });
      for (const p of preserved) steps.push({ step: 'hooks', action: 'preserve', detail: `${p.event} in ${paths.configPath} was edited after setup wrote it; kept as is` });
      return { steps, receipt: prior, changed: false, preserved, notes };
    }

    const wantedPairs = desiredPairs(writeItems);
    const receipt: HermesSetupReceipt = {
      harness: 'hermes', connection: 'local-stdio', setup_receipt_version: HERMES_SETUP_RECEIPT_VERSION, status: 'prepared',
      name: plan.name, gbrain_home: plan.brainHome, gbrain_home_env: plan.gbrainHomeEnv, hermes_home: paths.home,
      launcher: plan.launcher, source_id: plan.sourceId, surface: plan.surface,
      config_path: paths.configPath, allowlist_path: paths.allowlistPath,
      entry_hash: prior?.entry_hash ?? null, pending_entry_hash: desiredHash,
      ...(prior?.mcp_adopted ? { mcp_adopted: true } : {}),
      hooks: { owned: prior?.hooks.owned ?? {}, pending: want, edited: found.edited },
      trust: { owned: prior?.trust.owned ?? {}, pending: Object.fromEntries(wantedPairs.map((t) => [t.event, { command: t.command, hash: t.hash }])), edited: prior?.trust.edited ?? {},
        ...(prior?.trust.allowlist_created ? { allowlist_created: true } : {}) },
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

    // 2. MCP entry.
    const comment = `gbrain setup (${plan.name}): owned by fingerprint; \`gbrain setup hermes --remove\` deletes it while unchanged`;
    if (found.mcp.state === 'current') {
      if (!prior?.entry_hash && !prior?.pending_entry_hash) receipt.mcp_adopted = true;
      steps.push({ step: 'mcp', action: 'keep', detail: `mcp_servers.${plan.name} in ${paths.configPath} is current${receipt.mcp_adopted ? ' (adopted: it was already there, so --remove keeps it)' : ''}` });
    } else {
      if (found.mcp.state === 'owned' && removeHermesYamlEntry(paths.configPath, ['mcp_servers'], { key: plan.name }) === 'unlocatable') {
        throw new Error(`mcp_servers.${plan.name} in ${paths.configPath} is setup's but was re-rendered in a shape setup cannot rewrite safely; remove that entry by hand, then run setup again.`);
      }
      appendHermesYamlEntry(paths.configPath, ['mcp_servers'], { key: plan.name, value: desired }, comment);
      delete receipt.mcp_adopted;
      steps.push({ step: 'mcp', action: 'write', detail: `mcp_servers.${plan.name} in ${paths.configPath}` });
    }
    receipt.entry_hash = desiredHash;
    receipt.pending_entry_hash = null;
    save();
    if (opts.abortAfter === 'mcp') throw new SetupAbortInjected('mcp');

    // 3. hook items (inert until approved).
    const ownedHooks = new Set([...values(prior?.hooks.owned), ...values(prior?.hooks.pending), ...values(want)]);
    const w = writeHermesSetupHooks(paths.configPath, { want: writeItems, owned: ownedHooks, preserve: new Set(Object.keys(found.edited)), comment });
    const written = Object.keys(writeItems);
    steps.push(w.changed
      ? { step: 'hooks', action: 'write', detail: written.length ? `${written.join(', ')} in ${paths.configPath}` : `removed setup's hook items from ${paths.configPath}` }
      : { step: 'hooks', action: 'keep', detail: written.length ? `${written.join(', ')} in ${paths.configPath} are current` : 'no hooks wanted' });
    for (const event of Object.keys(found.edited)) steps.push({ step: 'hooks', action: 'preserve', detail: `${event} in ${paths.configPath} was edited after setup wrote it; kept as is (and left unapproved by setup)` });
    receipt.hooks.owned = want;
    receipt.hooks.pending = {};
    save();
    if (opts.abortAfter === 'hooks') throw new SetupAbortInjected('hooks');

    // 4. approvals: drop stale owned ones (a command change), then add the wanted ones.
    const trustEdited: TrustRecords = { ...receipt.trust.edited };
    let file = readHermesAllowlist(paths.allowlistPath);
    for (const [event, rec] of [...Object.entries(prior?.trust.owned ?? {}), ...Object.entries(prior?.trust.pending ?? {})] as Array<[HermesSetupEvent, TrustRecord]>) {
      if (wantedPairs.some((t) => t.event === event && t.command === rec.command)) continue;
      const pair = { event, command: rec.command };
      if (!isApproved(file, pair)) continue;
      if (approvalIsEdited(file, pair)) {
        trustEdited[event] = rec;
        preserved.push({ kind: 'trust', event, reason: 'edited' });
        steps.push({ step: 'trust', action: 'preserve', detail: `the ${event} approval changed after setup wrote it; kept` });
        continue;
      }
      revokeHermesHooks(paths.allowlistPath, [pair]);
      steps.push({ step: 'trust', action: 'remove', detail: `stale ${event} approval (setup's hook command changed)` });
    }
    file = readHermesAllowlist(paths.allowlistPath);
    const trusted: TrustRecords = {};
    let created = prior?.trust.allowlist_created ?? false;
    const priorOwned = new Set([...Object.values(prior?.trust.owned ?? {}), ...Object.values(prior?.trust.pending ?? {})].map((r) => r?.hash));
    for (const t of wantedPairs) {
      if (isApproved(file, t) && approvalIsEdited(file, t)) {
        preserved.push({ kind: 'trust', event: t.event, reason: 'conflict' });
        steps.push({ step: 'trust', action: 'preserve', detail: `${paths.allowlistPath} already has a customized ${t.event} approval for this command; kept` });
      } else if (isApproved(file, t)) {
        if (priorOwned.has(t.hash)) trusted[t.event] = { command: t.command, hash: t.hash };
        steps.push({ step: 'trust', action: 'keep', detail: `${t.event} is approved in ${paths.allowlistPath}${priorOwned.has(t.hash) ? '' : ' (adopted: it was already there, so --remove keeps it)'}` });
      } else {
        const r = approveHermesHooks(paths.allowlistPath, [t]);
        created = created || r.created;
        trusted[t.event] = { command: t.command, hash: t.hash };
        steps.push({ step: 'trust', action: 'write', detail: `${t.event} approval in ${paths.allowlistPath}` });
      }
    }
    if (wantedPairs.length === 0 && !steps.some((s) => s.step === 'trust')) steps.push({ step: 'trust', action: 'keep', detail: 'no approvals wanted' });
    receipt.trust = { owned: trusted, pending: {}, edited: trustEdited, ...(created ? { allowlist_created: true } : {}) };
    save();
    if (opts.abortAfter === 'trust') throw new SetupAbortInjected('trust');
    receipt.status = 'installed';
    save();
    return { steps, receipt, changed: true, preserved, notes };
  } finally {
    lock.release();
  }
}

export interface HermesRemoveResult { steps: HermesSetupStep[]; preserved: HermesPreserved[]; notes: string[]; receiptRemoved: boolean }

/** Remove exactly what the receipt owns by fingerprint (approvals, hooks, MCP, receipt); edited entries survive and are reported. */
export async function removeHermesSetup(receipt: HermesSetupReceipt, receiptPath: string, opts: { dryRun: boolean }): Promise<HermesRemoveResult> {
  const lock = await acquireBootstrapLock(dirname(receipt.config_path));
  try {
    const steps: HermesSetupStep[] = [];
    const preserved: HermesPreserved[] = [];
    const trustEdited: TrustRecords = {};
    const file = readHermesAllowlist(receipt.allowlist_path);
    const approvals: HermesPair[] = [];
    for (const [event, rec] of [...Object.entries(receipt.trust.owned), ...Object.entries(receipt.trust.pending)] as Array<[HermesSetupEvent, TrustRecord]>) {
      const pair = { event, command: rec.command };
      if (!isApproved(file, pair)) continue;
      if (approvalIsEdited(file, pair)) {
        trustEdited[event] = rec;
        preserved.push({ kind: 'trust', event, reason: 'edited' });
        steps.push({ step: 'trust', action: 'preserve', detail: `the ${event} approval changed after setup wrote it; kept` });
      } else { approvals.push(pair); steps.push({ step: 'trust', action: 'remove', detail: `${event} approval from ${receipt.allowlist_path}` }); }
    }
    if (approvals.length) revokeHermesHooks(receipt.allowlist_path, approvals, { dryRun: opts.dryRun, deleteIfEmpty: receipt.trust.allowlist_created === true });

    const owned = new Set([...values(receipt.hooks.owned), ...values(receipt.hooks.pending)]);
    const census = hermesHookCensus(receipt.config_path);
    const removedItems = census.filter((g) => owned.has(g.hash));
    const unlocatableHooks = new Set<string>();
    for (const g of removedItems) {
      if (removeHermesYamlEntry(receipt.config_path, ['hooks', g.event], { match: (it) => !!it && typeof it === 'object' && ownedEntryFingerprint(it) === g.hash }, { dryRun: opts.dryRun }) === 'unlocatable') {
        unlocatableHooks.add(g.event);
        preserved.push({ kind: 'hook', event: g.event, reason: 'unlocatable' });
        steps.push({ step: 'hooks', action: 'preserve', detail: `${g.event} in ${receipt.config_path} could not be located as one item; kept` });
      }
    }
    const gone = removedItems.filter((g) => !unlocatableHooks.has(g.event));
    steps.push(gone.length
      ? { step: 'hooks', action: 'remove', detail: `${gone.map((g) => g.event).join(', ')} from ${receipt.config_path}` }
      : { step: 'hooks', action: 'skip', detail: `no owned hook items in ${receipt.config_path}` });
    const edited: Hashes = {};
    for (const event of HERMES_SETUP_EVENTS) {
      const recorded = receipt.hooks.owned[event] ?? receipt.hooks.pending[event];
      const present = census.filter((g) => g.event === event && !owned.has(g.hash));
      const hit = present.find((g) => g.hash === receipt.hooks.edited[event])
        ?? (recorded && !census.some((g) => g.hash === recorded) ? present.find((g) => isThisInstallsItem(g.command, receipt.launcher, receipt.gbrain_home_env)) : undefined);
      if (!hit) continue;
      edited[event] = hit.hash;
      preserved.push({ kind: 'hook', event, reason: 'edited' });
      steps.push({ step: 'hooks', action: 'preserve', detail: `${event} in ${receipt.config_path} was edited after setup wrote it; kept` });
    }

    const entry = readHermesYaml(receipt.config_path, ['mcp_servers', receipt.name]);
    const entryFp = entry === undefined ? null : ownedEntryFingerprint(entry);
    if (entry === undefined) {
      steps.push({ step: 'mcp', action: 'skip', detail: `no mcp_servers.${receipt.name} in ${receipt.config_path}` });
    } else if (receipt.mcp_adopted && entryFp === receipt.entry_hash) {
      preserved.push({ kind: 'mcp', reason: 'adopted' });
      steps.push({ step: 'mcp', action: 'preserve', detail: `mcp_servers.${receipt.name} existed before setup ran; kept` });
    } else if ([receipt.entry_hash, receipt.pending_entry_hash].includes(entryFp)) {
      if (removeHermesYamlEntry(receipt.config_path, ['mcp_servers'], { key: receipt.name }, { dryRun: opts.dryRun }) === 'unlocatable') {
        preserved.push({ kind: 'mcp', reason: 'unlocatable' });
        steps.push({ step: 'mcp', action: 'preserve', detail: `mcp_servers.${receipt.name} could not be located as one entry; kept` });
      } else steps.push({ step: 'mcp', action: 'remove', detail: `mcp_servers.${receipt.name} from ${receipt.config_path}` });
    } else {
      preserved.push({ kind: 'mcp', reason: 'edited' });
      steps.push({ step: 'mcp', action: 'preserve', detail: `mcp_servers.${receipt.name} in ${receipt.config_path} changed after setup wrote it; kept` });
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
    return { steps, preserved, notes: [], receiptRemoved };
  } finally {
    lock.release();
  }
}
