/**
 * Claude Code wiring for `gbrain setup claude-code`: the MCP entry in
 * Claude Code's own config (`~/.claude.json`, user scope, or that file's
 * `projects[<dir>]` block for project scope) and the hook entries in its
 * settings file, owned by exact hash through a connection receipt.
 *
 * The receipt is the connection receipt `gbrain connect --install` already
 * writes next to the harness config (`.gbrain-connection-claude-code-<name>.json`,
 * `entry_hash` / `pending_entry_hash`, `status: prepared | installed`), with a
 * `connection: 'local-stdio'` marker and the hook hashes added. A hosted
 * receipt (it carries `client_id`) is never adopted.
 *
 * Write order, each step idempotent and resumable from the receipt:
 *   1. receipt `prepared`: consent decisions plus the pending MCP and hook hashes
 *   2. MCP entry, then the receipt records its hash
 *   3. hook entries, then the receipt records their hashes
 *   4. receipt `installed`
 * A crash after any step leaves pending hashes that the next run treats as
 * owned, so a resume never duplicates an entry. An entry whose hash the
 * receipt did not record is never replaced or removed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { acquireBootstrapLock } from '../bootstrap/lock.ts';
import { buildClaudeHookCommand, classifyHarnessHook, hookEntryHash, removeClaudeHooksAt, writeClaudeHooksAt } from '../bootstrap/hooks.ts';
import {
  CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS,
  CLAUDE_HOOK_EVENTS,
  CLAUDE_SETTINGS_FILE_RELPATH,
  GBRAIN_HOOK_MARKER_KEY,
  GBRAIN_SETUP_MARKER_VALUE,
  claudeUserMcpConfigPath,
  claudeUserSettingsPath,
  type ClaudeHookEvent,
} from '../bootstrap/host-specs.ts';
import { stdioServeArgv } from '../mcp-registration.ts';
import type { McpSurface } from '../../mcp/surface.ts';

export type WiringScope = 'user' | 'project';
export type DecisionSource = 'flag' | 'default' | 'prior' | 'opt_out';
export interface Decision<T> { value: T; source: DecisionSource; note?: string }

/** The three setup decisions, recorded separately (D8). */
export interface SetupConsent {
  wiring_scope: Decision<{ scope: WiringScope; hooks: 'read-context' | 'none' }>;
  capture: Decision<'accepted' | 'declined'>;
  providers: Decision<'accepted' | 'declined'>;
}

type HookHashes = Partial<Record<ClaudeHookEvent, string>>;

export interface ClaudeSetupReceipt {
  harness: 'claude-code';
  connection: 'local-stdio';
  setup_receipt_version: 1;
  status: 'prepared' | 'installed' | 'removed';
  name: string;
  gbrain_home: string;
  launcher: string;
  scope: WiringScope;
  project_dir?: string;
  source_id: string | null;
  surface: McpSurface;
  config_path: string;
  entry_hash: string | null;
  pending_entry_hash: string | null;
  /** The entry existed byte-identical before setup ran; `--remove` keeps it. */
  mcp_adopted?: boolean;
  /** The gbrain plugin serves the MCP name; setup wrote no MCP entry. */
  mcp_plugin?: string;
  hooks: { settings_path: string; owned: HookHashes; pending: HookHashes; edited: HookHashes };
  consent: SetupConsent & { recorded_at: string };
  brain_created_by_setup: boolean;
  native_harness_verified: false;
  created_at: string;
  updated_at: string;
}

export interface ClaudeSetupPlan {
  name: string;
  scope: WiringScope;
  projectDir?: string;
  launcher: string;
  /** `configDir()` of the install: the receipt's identity. */
  brainHome: string;
  /** GBRAIN_HOME as set in this environment, rendered into the entry and the hooks. */
  gbrainHomeEnv?: string;
  sourceId: string | null;
  surface: McpSurface;
  events: ClaudeHookEvent[];
}

export interface SetupStep { step: 'brain' | 'receipt' | 'mcp' | 'hooks'; action: 'write' | 'keep' | 'skip' | 'remove' | 'preserve'; detail: string }

export interface ClaudeInspection {
  configPath: string;
  settingsPath: string;
  receiptPath: string;
  prior: ClaudeSetupReceipt | null;
  /** A hosted `gbrain connect --install` receipt sits at this name. */
  hostedReceipt: { mcp_url?: string } | null;
  mcp: { state: 'absent' | 'current' | 'owned' | 'remote' | 'unowned'; url?: string };
  /** Events wired by another gbrain lane in this settings file. */
  otherLaneEvents: string[];
  /** Owned events whose entry the user edited: preserved, never rewritten. */
  edited: HookHashes;
  /** True when the desired hooks are present and nothing owned is stale. */
  hooksCurrent: boolean;
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
      : v;
export const entryHash = (v: unknown): string => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');

export function claudeSetupPaths(plan: Pick<ClaudeSetupPlan, 'name' | 'scope' | 'projectDir'>): { configPath: string; settingsPath: string; receiptPath: string } {
  const configPath = claudeUserMcpConfigPath();
  const suffix = plan.scope === 'project' ? `-project-${createHash('sha256').update(plan.projectDir!).digest('hex').slice(0, 12)}` : '';
  return {
    configPath,
    settingsPath: plan.scope === 'project' ? join(plan.projectDir!, CLAUDE_SETTINGS_FILE_RELPATH) : claudeUserSettingsPath(),
    receiptPath: join(dirname(configPath), `.gbrain-connection-claude-code-${plan.name}${suffix}.json`),
  };
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (text.trim() === '') return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e) {
    throw new Error(`${path} is not valid JSON (${(e as Error).message}); setup never rewrites a file it cannot parse. Fix it by hand, then run setup again.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object; setup never rewrites a file it cannot parse.`);
  return parsed as Record<string, unknown>;
}

export function readSetupReceipt(receiptPath: string): { setup: ClaudeSetupReceipt | null; hosted: { mcp_url?: string } | null } {
  if (!existsSync(receiptPath)) return { setup: null, hosted: null };
  let raw: Record<string, unknown>;
  try { raw = readJsonObject(receiptPath); } catch { throw new Error(`the connection receipt ${receiptPath} is unreadable; move it aside only if you know which install wrote it, then run setup again.`); }
  if (raw.client_id) return { setup: null, hosted: { mcp_url: typeof raw.mcp_url === 'string' ? raw.mcp_url : undefined } };
  if (raw.connection === 'local-stdio' && raw.setup_receipt_version === 1) return { setup: raw as unknown as ClaudeSetupReceipt, hosted: null };
  throw new Error(`the connection receipt ${receiptPath} was not written by gbrain setup; it is left untouched. Choose another --name.`);
}

function writeSetupReceipt(path: string, receipt: ClaudeSetupReceipt): void {
  atomicWriteTextFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { forceMode: 0o600 });
}

function mcpServers(config: Record<string, unknown>, plan: Pick<ClaudeSetupPlan, 'scope' | 'projectDir'>, create: boolean): Record<string, unknown> | undefined {
  let holder: Record<string, unknown> = config;
  if (plan.scope === 'project') {
    const projects = config.projects as Record<string, unknown> | undefined;
    if (projects !== undefined && (typeof projects !== 'object' || projects === null || Array.isArray(projects))) throw new Error('the Claude Code config "projects" key is not an object; setup leaves it untouched.');
    if (!projects && !create) return undefined;
    const all = projects ?? (config.projects = {}) as Record<string, unknown>;
    const project = all[plan.projectDir!] as Record<string, unknown> | undefined;
    if (!project && !create) return undefined;
    holder = project ?? (all[plan.projectDir!] = {}) as Record<string, unknown>;
  }
  const servers = holder.mcpServers;
  if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) throw new Error('the Claude Code "mcpServers" key is not an object; setup leaves it untouched.');
  if (!servers && !create) return undefined;
  return (servers ?? (holder.mcpServers = {})) as Record<string, unknown>;
}

function hookEnv(plan: ClaudeSetupPlan) {
  return { ...(plan.sourceId ? { GBRAIN_SOURCE: plan.sourceId } : {}), ...(plan.gbrainHomeEnv ? { GBRAIN_HOME: plan.gbrainHomeEnv } : {}), GBRAIN_SEAT: '' };
}

export function desiredMcpEntry(plan: ClaudeSetupPlan): Record<string, unknown> {
  const env: Record<string, string> = {};
  if (plan.gbrainHomeEnv) env.GBRAIN_HOME = plan.gbrainHomeEnv;
  if (plan.sourceId) env.GBRAIN_SOURCE = plan.sourceId;
  return { type: 'stdio', command: plan.launcher, args: stdioServeArgv(plan.launcher, plan.surface).slice(1), env };
}

export function desiredHookHashes(plan: ClaudeSetupPlan): HookHashes {
  const out: HookHashes = {};
  for (const event of plan.events) {
    out[event] = hookEntryHash({ type: 'command', command: buildClaudeHookCommand(plan.launcher, event, hookEnv(plan)), timeout: CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS[event] })!;
  }
  return out;
}

const consentValues = (c: SetupConsent): string => JSON.stringify([c.wiring_scope.value.scope, c.wiring_scope.value.hooks, c.capture.value, c.providers.value]);

const values = (h: HookHashes | undefined): string[] => Object.values(h ?? {}).filter((v): v is string => typeof v === 'string');

interface HookCensus { byEvent: Map<string, Array<{ hash: string; marked: boolean }>>; otherLane: Set<string> }

function hookCensus(settingsPath: string): HookCensus {
  const settings = readJsonObject(settingsPath);
  const byEvent = new Map<string, Array<{ hash: string; marked: boolean }>>();
  const otherLane = new Set<string>();
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return { byEvent, otherLane };
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const entries = (group as { hooks?: unknown })?.hooks;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const marker = (entry as Record<string, unknown> | null)?.[GBRAIN_HOOK_MARKER_KEY];
        if ((typeof marker === 'string' && marker !== GBRAIN_SETUP_MARKER_VALUE) || classifyHarnessHook(entry, event, 'any')) {
          if ((CLAUDE_HOOK_EVENTS as readonly string[]).includes(event)) otherLane.add(event);
          continue;
        }
        const hash = hookEntryHash(entry);
        if (hash) byEvent.set(event, [...(byEvent.get(event) ?? []), { hash, marked: marker === GBRAIN_SETUP_MARKER_VALUE }]);
      }
    }
  }
  return { byEvent, otherLane };
}

/** Read-only: what setup would find and own. Throws on an unparseable config. */
export function inspectClaudeSetup(plan: ClaudeSetupPlan): ClaudeInspection {
  const paths = claudeSetupPaths(plan);
  const { setup: prior, hosted } = readSetupReceipt(paths.receiptPath);
  const servers = mcpServers(readJsonObject(paths.configPath), plan, false);
  const entry = servers?.[plan.name];
  const desired = entryHash(desiredMcpEntry(plan));
  const mcp: ClaudeInspection['mcp'] = entry === undefined ? { state: 'absent' }
    : entryHash(entry) === desired ? { state: 'current' }
      : typeof (entry as Record<string, unknown>)?.url === 'string' ? { state: 'remote', url: (entry as Record<string, string>).url }
        : prior && [prior.entry_hash, prior.pending_entry_hash].includes(entryHash(entry)) ? { state: 'owned' } : { state: 'unowned' };

  const census = hookCensus(paths.settingsPath);
  const want = desiredHookHashes(plan);
  const owned = new Set([...values(prior?.hooks.owned), ...values(prior?.hooks.pending), ...values(want)]);
  const edited: HookHashes = {};
  for (const event of CLAUDE_HOOK_EVENTS) {
    const present = census.byEvent.get(event) ?? [];
    const recorded = prior?.hooks.owned[event];
    const priorEdit = prior?.hooks.edited[event];
    const stillEdited = priorEdit && present.some((p) => p.hash === priorEdit);
    const newlyEdited = recorded && !present.some((p) => p.hash === recorded) && present.find((p) => p.marked && !owned.has(p.hash));
    if (stillEdited) edited[event] = priorEdit;
    else if (newlyEdited) edited[event] = newlyEdited.hash;
  }
  let hooksCurrent = true;
  for (const [event, present] of census.byEvent) {
    const target = want[event as ClaudeHookEvent];
    if (present.some((p) => owned.has(p.hash) && p.hash !== target)) hooksCurrent = false;
    if (target && present.filter((p) => p.hash === target).length > 1) hooksCurrent = false;
  }
  for (const event of plan.events) {
    if (!edited[event] && !(census.byEvent.get(event) ?? []).some((p) => p.hash === want[event])) hooksCurrent = false;
  }
  return { ...paths, prior, hostedReceipt: hosted, mcp, otherLaneEvents: [...census.otherLane], edited, hooksCurrent };
}

export interface ApplyResult { steps: SetupStep[]; receipt: ClaudeSetupReceipt; changed: boolean; edited: HookHashes }

/**
 * Apply the plan under the config-dir lock. `pluginOwner` skips the MCP
 * entry (the plugin serves the name). `beforeMcp` runs after the receipt is
 * prepared and before the MCP write (the brain init step); `abortAfter` is
 * the crash-injection test seam.
 */
export async function applyClaudeSetup(
  plan: ClaudeSetupPlan,
  consent: SetupConsent,
  opts: { pluginOwner: string | null; brainCreated: boolean; beforeMcp?: () => Promise<void>; abortAfter?: string },
): Promise<ApplyResult> {
  const paths = claudeSetupPaths(plan);
  const lock = await acquireBootstrapLock(dirname(paths.configPath));
  try {
    const found = inspectClaudeSetup(plan);
    const now = new Date().toISOString();
    const desired = desiredMcpEntry(plan);
    const desiredHash = entryHash(desired);
    const want = desiredHookHashes(plan);
    const writeEvents = plan.events.filter((e) => !found.edited[e]);
    const prior = found.prior;
    const consentSame = prior?.consent !== undefined && consentValues(prior.consent) === consentValues(consent);
    const mcpDone = opts.pluginOwner !== null || found.mcp.state === 'current';
    const steps: SetupStep[] = [];
    if (prior?.status === 'installed' && consentSame && mcpDone && found.hooksCurrent && !opts.brainCreated) {
      steps.push({ step: 'receipt', action: 'keep', detail: `${paths.receiptPath} already records this install` });
      steps.push({ step: 'mcp', action: opts.pluginOwner ? 'skip' : 'keep', detail: opts.pluginOwner ? `the '${opts.pluginOwner}' plugin serves '${plan.name}'` : `'${plan.name}' in ${paths.configPath} is current` });
      steps.push({ step: 'hooks', action: 'keep', detail: plan.events.length ? `${plan.events.join(', ')} in ${paths.settingsPath} are current` : 'no hooks wanted' });
      return { steps, receipt: prior, changed: false, edited: found.edited };
    }
    const receipt: ClaudeSetupReceipt = {
      harness: 'claude-code', connection: 'local-stdio', setup_receipt_version: 1, status: 'prepared',
      name: plan.name, gbrain_home: plan.brainHome, launcher: plan.launcher, scope: plan.scope,
      ...(plan.projectDir ? { project_dir: plan.projectDir } : {}),
      source_id: plan.sourceId, surface: plan.surface, config_path: paths.configPath,
      entry_hash: prior?.entry_hash ?? null, pending_entry_hash: opts.pluginOwner ? null : desiredHash,
      ...(prior?.mcp_adopted ? { mcp_adopted: true } : {}),
      ...(opts.pluginOwner ? { mcp_plugin: opts.pluginOwner } : {}),
      hooks: { settings_path: paths.settingsPath, owned: prior?.hooks.owned ?? {}, pending: Object.fromEntries(writeEvents.map((e) => [e, want[e]])), edited: found.edited },
      consent: { ...consent, recorded_at: now },
      brain_created_by_setup: (prior?.brain_created_by_setup ?? false) || opts.brainCreated,
      native_harness_verified: false,
      created_at: prior?.created_at ?? now, updated_at: now,
    };
    const save = () => writeSetupReceipt(paths.receiptPath, receipt);
    save();
    steps.push({ step: 'receipt', action: 'write', detail: `${paths.receiptPath} (prepared: consent and pending hashes recorded)` });
    if (opts.abortAfter === 'receipt') throw new SetupAbortInjected('receipt');
    await opts.beforeMcp?.();

    if (opts.pluginOwner) {
      steps.push({ step: 'mcp', action: 'skip', detail: `the '${opts.pluginOwner}' plugin serves '${plan.name}'; no hand-wired entry` });
    } else if (found.mcp.state === 'current') {
      if (!prior?.entry_hash && !prior?.pending_entry_hash) receipt.mcp_adopted = true;
      receipt.entry_hash = desiredHash;
      steps.push({ step: 'mcp', action: 'keep', detail: `'${plan.name}' in ${paths.configPath} is current${receipt.mcp_adopted ? ' (adopted: it was already there, so --remove keeps it)' : ''}` });
    } else {
      const config = readJsonObject(paths.configPath);
      mcpServers(config, plan, true)![plan.name] = desired;
      atomicWriteTextFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, { freshMode: 0o600 });
      receipt.entry_hash = desiredHash;
      delete receipt.mcp_adopted;
      steps.push({ step: 'mcp', action: 'write', detail: `'${plan.name}' in ${paths.configPath}` });
    }
    receipt.pending_entry_hash = null;
    save();
    if (opts.abortAfter === 'mcp') throw new SetupAbortInjected('mcp');

    if (found.hooksCurrent) {
      steps.push({ step: 'hooks', action: 'keep', detail: plan.events.length ? `${plan.events.join(', ')} in ${paths.settingsPath} are current` : 'no hooks wanted' });
    } else {
      const ownedHashes = new Set([...values(prior?.hooks.owned), ...values(prior?.hooks.pending), ...values(receipt.hooks.pending)]);
      writeClaudeHooksAt(paths.settingsPath, {
        gbrainBin: plan.launcher, env: hookEnv(plan), events: writeEvents, marker: GBRAIN_SETUP_MARKER_VALUE,
        ownedEntryHashes: ownedHashes, freshMode: 0o600,
      });
      steps.push({ step: 'hooks', action: 'write', detail: writeEvents.length ? `${writeEvents.join(', ')} in ${paths.settingsPath}` : `removed setup's hooks from ${paths.settingsPath}` });
    }
    for (const [event, hash] of Object.entries(found.edited)) {
      steps.push({ step: 'hooks', action: 'preserve', detail: `${event} in ${paths.settingsPath} was edited after setup wrote it (hash ${hash.slice(0, 12)}); kept as is` });
    }
    receipt.hooks.owned = Object.fromEntries(writeEvents.map((e) => [e, want[e]]));
    receipt.hooks.pending = {};
    save();
    if (opts.abortAfter === 'hooks') throw new SetupAbortInjected('hooks');
    receipt.status = 'installed';
    save();
    return { steps, receipt, changed: true, edited: found.edited };
  } finally {
    lock.release();
  }
}

export interface RemoveResult { steps: SetupStep[]; preserved: Array<{ kind: 'mcp' | 'hook'; event?: string; reason: string }>; receiptRemoved: boolean }

/** Remove exactly what the receipt owns by hash; edited entries survive and are reported. */
export async function removeClaudeSetup(receipt: ClaudeSetupReceipt, receiptPath: string, opts: { dryRun: boolean }): Promise<RemoveResult> {
  const plan = { name: receipt.name, scope: receipt.scope, projectDir: receipt.project_dir };
  const lock = await acquireBootstrapLock(dirname(receipt.config_path));
  try {
    const steps: SetupStep[] = [];
    const preserved: RemoveResult['preserved'] = [];
    const config = readJsonObject(receipt.config_path);
    const servers = mcpServers(config, plan, false);
    const entry = servers?.[receipt.name];
    if (receipt.mcp_plugin) {
      steps.push({ step: 'mcp', action: 'skip', detail: `the '${receipt.mcp_plugin}' plugin serves '${receipt.name}'; setup wrote no entry` });
    } else if (entry === undefined) {
      steps.push({ step: 'mcp', action: 'skip', detail: `no '${receipt.name}' entry in ${receipt.config_path}` });
    } else if (receipt.mcp_adopted && entryHash(entry) === receipt.entry_hash) {
      steps.push({ step: 'mcp', action: 'preserve', detail: `'${receipt.name}' existed before setup ran; kept` });
      preserved.push({ kind: 'mcp', reason: 'adopted' });
    } else if ([receipt.entry_hash, receipt.pending_entry_hash].includes(entryHash(entry))) {
      if (!opts.dryRun) {
        delete servers![receipt.name];
        atomicWriteTextFile(receipt.config_path, `${JSON.stringify(config, null, 2)}\n`, { freshMode: 0o600 });
      }
      steps.push({ step: 'mcp', action: 'remove', detail: `'${receipt.name}' from ${receipt.config_path}` });
    } else {
      steps.push({ step: 'mcp', action: 'preserve', detail: `'${receipt.name}' in ${receipt.config_path} changed after setup wrote it; kept` });
      preserved.push({ kind: 'mcp', reason: 'edited' });
    }

    const owned = new Set([...values(receipt.hooks.owned), ...values(receipt.hooks.pending)]);
    let before: HookCensus['byEvent'] = new Map();
    try { before = hookCensus(receipt.hooks.settings_path).byEvent; } catch { /* removeClaudeHooksAt reports an unparseable file */ }
    const r = removeClaudeHooksAt(receipt.hooks.settings_path, GBRAIN_SETUP_MARKER_VALUE, { ownedEntryHashes: owned, dryRun: opts.dryRun });
    steps.push({ step: 'hooks', action: r.removed > 0 ? 'remove' : 'skip', detail: r.removed > 0 ? `${r.removed} hook entr${r.removed === 1 ? 'y' : 'ies'} from ${r.settingsPath}` : (r.notes[0] ?? 'no owned hook entries present') });
    const edited: HookHashes = {};
    for (const p of r.preserved) {
      const event = p.event as ClaudeHookEvent;
      const recorded = receipt.hooks.owned[event] ?? receipt.hooks.pending[event];
      const ours = receipt.hooks.edited[event] === p.hash
        || (recorded !== undefined && !(before.get(event) ?? []).some((e) => e.hash === recorded) && edited[event] === undefined);
      if (!ours) continue;
      edited[p.event as ClaudeHookEvent] = p.hash;
      preserved.push({ kind: 'hook', event: p.event, reason: 'edited' });
      steps.push({ step: 'hooks', action: 'preserve', detail: `${p.event} in ${r.settingsPath} was edited after setup wrote it; kept` });
    }

    let receiptRemoved = false;
    if (!opts.dryRun) {
      if (preserved.some((p) => p.reason === 'edited')) {
        writeSetupReceipt(receiptPath, { ...receipt, status: 'removed', entry_hash: null, pending_entry_hash: null,
          hooks: { ...receipt.hooks, owned: {}, pending: {}, edited }, updated_at: new Date().toISOString() });
        steps.push({ step: 'receipt', action: 'write', detail: `${receiptPath} (removed; remembers the edited entries so a later setup leaves them alone)` });
      } else {
        if (existsSync(receiptPath)) unlinkSync(receiptPath);
        receiptRemoved = true;
        steps.push({ step: 'receipt', action: 'remove', detail: receiptPath });
      }
    }
    return { steps, preserved, receiptRemoved };
  } finally {
    lock.release();
  }
}

export class SetupAbortInjected extends Error {
  constructor(readonly phase: string) {
    super(`setup aborted after ${phase} (GBRAIN_SETUP_ABORT_AFTER test seam)`);
    this.name = 'SetupAbortInjected';
  }
}
