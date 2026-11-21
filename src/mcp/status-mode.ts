/**
 * Status-only serve (agent operator contract v1, F4). `gbrain serve` (stdio)
 * never exits before the MCP handshake: when the brain is locked by another
 * server, missing, or its config is unreadable, it completes the handshake
 * with exactly one tool, `gbrain_status`, that says what is wrong, names the
 * lock owner / brain path, and gives the fix plus the words to relay.
 *
 * Recovery: the engine is a lazy proxy (the degraded-engine shape) whose
 * reconnect is gated here: the gate re-reads config and `peekLock()` only
 * (file reads, no lock attempt) and refuses while a live holder or a missing
 * config remains; lock acquisition happens only inside a tool call, at most
 * once per 5 s, only with no live holder. On success serve boots its engine
 * dependents and sends `tools/list_changed`; the full catalog replaces
 * `gbrain_status`.
 *
 * Dependency-light on purpose: server.ts imports it on every boot.
 */
import { existsSync } from 'node:fs';
import { renderAction, toAgentError, toolErrorResult, type Action, type Decision, type RenderContext, type ToolResultShape } from '../core/agent-output.ts';
import { isEngineDegraded } from '../core/degraded-marker.ts';
import { opError } from '../core/ops/contract.ts';
import { configPath, gbrainPath, loadConfig, type GBrainConfig } from '../core/config.ts';
import { inspectLockHolder, peekLock } from '../core/pglite-lock.ts';
import { HANDS_OFF_BRAIN_FILES, readRepairFailedMarker, type RepairFailedMarker } from '../core/pglite-repair.ts';
import { engineGraduatedFor, graduationStatusReason } from '../core/persistence/graduation-serve-guard.ts';
import { inspectGraduationPath } from '../core/persistence/graduation-custody.ts';

export const STATUS_TOOL_NAME = 'gbrain_status';
export type StatusReason = 'lock_held' | 'no_brain' | 'config_unreadable' | 'missing_brain' | 'brain_unopenable' | 'repair_failed' | 'engine_graduated';
/** stdio: a harness-launched server re-probing inside tool calls. http: a `serve --http` daemon re-probing on a 5 s tick. */
export type StatusTransport = 'stdio' | 'http';

export interface StatusModeState {
  reason: StatusReason;
  /** PGLite data dir (lock_held) — what the lock owner holds. */
  brain_path?: string;
  config_path: string;
  lock_owner?: { pid?: number; transport: 'stdio' | 'http' | 'unknown'; serve: boolean };
  /** repair_failed: the durable marker automatic PGLite repair left. */
  repair_failed?: RepairFailedMarker;
  recovered: boolean;
  /** Last re-probe (epoch ms). */
  checked_at: number;
}

const STATUS_STATE = Symbol.for('gbrain.statusMode.state');

/** Attach status-mode state to the lazy engine (cli.ts builds it). */
export function markStatusModeEngine<T extends object>(engine: T, state: StatusModeState): T {
  (engine as Record<symbol, unknown>)[STATUS_STATE] = state;
  return engine;
}

/** The status-mode state of an engine; null for every ordinary engine. */
export function statusModeOf(engine: unknown): StatusModeState | null {
  const s = (engine as Record<symbol, unknown> | null | undefined)?.[STATUS_STATE];
  return s && typeof s === 'object' ? (s as StatusModeState) : null;
}

function brainPathFor(cfg: GBrainConfig | null): string | undefined {
  if (!cfg || cfg.engine !== 'pglite' || cfg.database_url) return undefined;
  return cfg.database_path ?? gbrainPath('brain.pglite');
}

/**
 * Classify the startup failure (or re-probe): file reads only — config and
 * the lock holder's metadata. Returns null when nothing blocks a connect.
 */
export function probeStatus(): Omit<StatusModeState, 'recovered'> | null {
  const cfgPath = configPath();
  const cfg = loadConfig();
  const now = Date.now();
  if (!cfg) return { reason: existsSync(cfgPath) ? 'config_unreadable' : 'no_brain', config_path: cfgPath, brain_path: gbrainPath('brain.pglite'), checked_at: now };
  const dataDir = brainPathFor(cfg);
  if (!dataDir) return null;
  // A configured brain that is not there (unmounted drive, moved folder) is never recreated empty here.
  if (!existsSync(dataDir)) return { reason: 'missing_brain', config_path: cfgPath, brain_path: dataDir, checked_at: now };
  // A graduated brain's old path is a tombstone file: answer engine_graduated, never open or recreate it.
  if (graduationStatusReason(cfg)) return { reason: 'engine_graduated', config_path: cfgPath, brain_path: dataDir, checked_at: now };
  const marker = readRepairFailedMarker(dataDir);
  if (marker) return { reason: 'repair_failed', config_path: cfgPath, brain_path: dataDir, checked_at: now, repair_failed: marker };
  const holder = inspectLockHolder(dataDir);
  if (!holder.held || holder.pid === process.pid) return null;
  const peek = peekLock(dataDir);
  return {
    reason: 'lock_held', config_path: cfgPath, brain_path: dataDir, checked_at: now,
    lock_owner: { pid: holder.pid, transport: peek.isServe ? (peek.http ? 'http' : 'stdio') : 'unknown', serve: !!holder.serve },
  };
}

/**
 * Initial state for a startup failure. `lock_held` comes from the connect
 * error itself when the re-probe races the holder's exit.
 */
export function initialStatusState(fallback: StatusReason): StatusModeState {
  const probed = probeStatus();
  if (probed) return { ...probed, recovered: false };
  return { reason: fallback, config_path: configPath(), recovered: false, checked_at: Date.now(),
    ...(fallback === 'lock_held' ? { brain_path: brainPathFor(loadConfig()), lock_owner: { transport: 'unknown' as const, serve: false } } : {}),
    ...(fallback === 'brain_unopenable' ? { brain_path: brainPathFor(loadConfig()) } : {}) };
}

/**
 * The one re-probe both transports run (stdio inside a tool call, HTTP on its
 * 5 s tick): classify with file reads only; while still blocked, update the
 * state and return null (no lock attempt); otherwise forget memoized
 * readiness and connect once. `connect` is throw-only, so a failed attempt
 * rejects into the caller and never exits the process.
 */
export async function reprobe<E>(state: StatusModeState, connect: () => Promise<E>): Promise<E | null> {
  const probed = probeStatus();
  if (probed) {
    Object.assign(state, probed);
    return null;
  }
  (await import('../core/readiness.ts')).resetReadinessMemo();
  const engine = await connect();
  state.recovered = true;
  state.checked_at = Date.now();
  return engine;
}

/** The lazy engine's reconnect gate on stdio: `reprobe`, throwing `serve_status_only` while still blocked. */
export async function statusReconnect<E>(state: StatusModeState, probe: () => Promise<E | null>): Promise<E> {
  const engine = await probe();
  if (engine === null) {
    throw opError('serve_status_only', statusHeadline(state), 'Call gbrain_status for the cause, the fix and what to tell the user.', { reason: state.reason });
  }
  return engine;
}

function ownerPhrase(state: StatusModeState): string {
  const o = state.lock_owner;
  if (!o) return 'another process';
  const pid = o.pid !== undefined ? ` (PID ${o.pid})` : '';
  if (!o.serve) return `another gbrain process${pid}`;
  return o.transport === 'http' ? `a shared \`gbrain serve --http\`${pid}` : `another \`gbrain serve\`${pid}, usually started by another agent session`;
}

/** One sentence naming the cause plainly (lock owner, brain path, config path). */
export function statusHeadline(state: StatusModeState): string {
  if (state.reason === 'lock_held') return `This brain (${state.brain_path ?? 'its data directory'}) is open in ${ownerPhrase(state)}, so this server cannot open it.`;
  if (state.reason === 'config_unreadable') return `The gbrain config at ${state.config_path} exists but cannot be read (invalid JSON or unreadable), so this server cannot open a brain.`;
  if (state.reason === 'brain_unopenable') return `The brain at ${state.brain_path ?? 'its configured path'} exists, but its writer lock file next to it cannot be opened (a read-only or unmounted drive, or permissions), so this server cannot open it.`;
  if (state.reason === 'missing_brain') return `The brain configured in ${state.config_path} is not at ${state.brain_path ?? 'its configured path'} (an unmounted drive or a moved folder?), so this server cannot open it. Nothing was created there.`;
  if (state.reason === 'engine_graduated') return `This brain moved to Postgres; ${state.brain_path ?? 'its old PGLite path'} is a tombstone, and this server's config still points at it.`;
  if (state.reason === 'repair_failed') return `The brain at ${state.brain_path ?? 'its data directory'} is damaged and gbrain's automatic repair failed, so gbrain refuses to open it until the user decides how to recover.`;
  return `No gbrain brain is set up on this machine yet (no config at ${state.config_path}), so this server has no brain to open.`;
}

function restartNote(t: StatusTransport): string {
  return t === 'http'
    ? 'HTTP clients then re-list tools or reconnect; a client that connected during status mode signs in again (HTTP 401 with WWW-Authenticate).'
    : 'If your client does not refresh its tool list after recovery, restart this MCP server.';
}

/** How the server picks the brain up once the cause is fixed. */
function recheck(t: StatusTransport): string {
  return t === 'http' ? 'this HTTP server re-checks every 5 s and opens the brain in place' : 'call gbrain_status again and this server opens the brain in place';
}

/** The stdio wait fix calls gbrain_status; an HTTP daemon re-checks on its own. */
const statusCall = (t: StatusTransport) => (t === 'stdio' ? { mcp: { tool: STATUS_TOOL_NAME, arguments: {} } } : {});

/** The cause's fix, decisions and relay text; `transport` says how the blocked server re-checks. */
export function statusFix(state: StatusModeState, t: StatusTransport = 'stdio'): { fix: Action; user_message: string; decisions?: Decision[]; plan?: Action } {
  if (state.reason === 'no_brain') {
    return {
      fix: {
        argv: ['gbrain', 'init', '--pglite', '--no-embedding'], consent: ['persistent_install'], actor: 'agent', requires_exclusive: false,
        why: `Creates a keyless local brain (config at ${state.config_path}); semantic search can be enabled later. Then ${recheck(t)}, without a restart. ${restartNote(t)}`,
        user_message: 'gbrain memory is installed but no brain exists yet. Should I create a local one now? It stays on this machine and needs no API key.',
        verify: { argv: ['gbrain', 'doctor', '--json'] }, docs: 'INSTALL_FOR_AGENTS.md',
      },
      user_message: 'gbrain memory is installed but no brain exists yet. Should I create a local one now? It stays on this machine and needs no API key.',
    };
  }
  if (state.reason === 'missing_brain' || state.reason === 'brain_unopenable') {
    const where = state.brain_path ?? 'its configured path';
    const user_message = state.reason === 'missing_brain'
      ? `Your gbrain brain is configured at ${where}, but nothing is there right now. Is it on a drive that needs mounting, or did it move? Once it's back I'll reconnect. If it's gone for good I can create a new empty brain, but your old notes would not be in it.`
      : `Your gbrain brain at ${where} is there, but gbrain can't open its lock file next to it (a read-only or unmounted drive, or a permissions problem). Can you check that drive? Once it's writable I'll reconnect.`;
    return {
      fix: {
        ...statusCall(t), consent: [], actor: 'user', requires_exclusive: false,
        why: `${state.reason === 'missing_brain' ? `Mount or reconnect the drive that holds ${where}, or point \`database_path\` in ${state.config_path} at where the brain lives now` : `Make the folder holding ${where} writable for this user (or mount the drive read-write)`}; then ${recheck(t)}. ${restartNote(t)}`,
        user_message,
        verify: { argv: ['gbrain', 'doctor', '--only', 'connection', '--json'] },
      },
      user_message,
      decisions: state.reason === 'missing_brain' ? [{
        id: 'missing_brain_recovery',
        question: `The brain at ${where} is not there. Bring it back, or start a new empty brain?`,
        options: [
          { id: 'reconnect', label: `Mount or move the brain back; ${t === 'http' ? 'this server reconnects within 5 s' : 'this server reconnects on the next gbrain_status call'}.` },
          { id: 'new_brain', label: 'Create a new, empty keyless brain at that path (the old notes are not in it).', argv: ['gbrain', 'init', '--pglite', '--no-embedding', '--path', where] },
        ],
        default: 'reconnect',
        default_reason: 'Nothing is created or overwritten; the user\'s existing brain comes back as soon as its drive does.',
      }] : undefined,
    };
  }
  if (state.reason === 'engine_graduated' && state.brain_path) {
    const fix = engineGraduatedFor(inspectGraduationPath(state.brain_path), 'stdio').fix!;
    return { fix, user_message: fix.user_message ?? statusHeadline(state) };
  }
  if (state.reason === 'repair_failed') {
    const user_message = `Your gbrain brain at ${state.brain_path ?? 'its data directory'} is damaged and gbrain's automatic repair did not fix it, so gbrain has stopped opening it to keep it from getting worse. In a terminal you can preview the repair with \`gbrain pglite-repair --dry-run\` and run the one it prints after you agree, or restore the brain from a backup. Nobody should copy, move or edit the brain files by hand.`;
    return {
      fix: {
        argv: ['gbrain', 'pglite-repair', '--dry-run', '--json'], consent: [], actor: 'user', requires_exclusive: false,
        why: `${HANDS_OFF_BRAIN_FILES} The read-only preview names the consented repair (\`gbrain pglite-repair --yes --expect <plan_hash>\`, effects destructive) the user runs once they agree; then ${recheck(t)}. ${restartNote(t)}`,
        user_message,
      },
      user_message,
    };
  }
  if (state.reason === 'config_unreadable') {
    return {
      fix: {
        argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'user', requires_exclusive: false,
        why: `Fix or restore ${state.config_path} (it must be valid JSON; \`gbrain doctor --json\` names the problem), then ${recheck(t)}. Never delete it without asking: it holds the brain's settings and may hold keys.`,
        user_message: `Your gbrain config file (${state.config_path}) is damaged, so memory is offline. Can you check it, or should I show you what doctor reports?`,
      },
      user_message: `Your gbrain config file (${state.config_path}) is damaged, so memory is offline. Can you check it, or should I show you what doctor reports?`,
    };
  }
  const owner = ownerPhrase(state);
  const wireHarnesses: Action = {
    argv: ['gbrain', 'bootstrap', 'harness', '--harness', 'all', '--yes'], consent: ['persistent_install', 'credentials'], actor: 'agent', requires_exclusive: false,
    why: 'Mints one bearer token per detected harness through the running HTTP server and rewrites each harness MCP entry to it (each stdio entry keeps working until its harness is rewired).',
    user_message: 'I can connect your agent apps to the shared gbrain server so every session uses memory at once. That stores an access token in each app\'s config and pre-approves gbrain\'s tools. OK?',
    verify: { argv: ['gbrain', 'doctor', '--only', 'harness_wiring', '--json'] }, docs: 'docs/guides/remote-mcp.md',
  };
  if (state.lock_owner?.transport === 'http') {
    // A shared HTTP server already owns the brain: only this harness needs rewiring.
    return { fix: wireHarnesses, user_message: wireHarnesses.user_message! };
  }
  if (t === 'http') {
    // This process is the shared HTTP server: once the owner stops, it opens the brain and the harnesses move to it.
    const user_message = `Your gbrain brain is open in ${owner.replace(/`/g, '')}, so the shared gbrain server can't open it. Should I stop that session so every agent shares the server?`;
    return { user_message, fix: {
      ...(state.lock_owner?.pid !== undefined ? { argv: ['kill', String(state.lock_owner.pid)] } : {}), consent: [], actor: 'user', requires_exclusive: false, user_message,
      why: `Stop ${owner} (or quit that session); ${recheck(t)}. Then wire the harnesses to it.`, then: wireHarnesses,
    } };
  }
  const startHttp: Action = {
    argv: ['gbrain', 'serve', '--http'], consent: ['persistent_install'], actor: 'user', requires_exclusive: true,
    why: 'Run ONE shared HTTP server for every agent session on this machine (keep it running, e.g. under autopilot or a terminal).',
    then: wireHarnesses,
  };
  const shareHttp: Action = state.lock_owner?.pid !== undefined
    ? { argv: ['kill', String(state.lock_owner.pid)], consent: [], actor: 'user', requires_exclusive: false,
      why: `Stop ${owner} first (or quit that session); the shared server needs the brain's single-writer lock.`, then: startHttp }
    : startHttp;
  const waitFix: Action = {
    ...statusCall(t), consent: [], actor: 'user', requires_exclusive: false,
    why: `Close the session that owns the brain (${owner}); then ${recheck(t)} (re-checked at most every 5 s). ${restartNote(t)}`,
  };
  const user_message = `Your gbrain brain is already open in ${owner.replace(/`/g, '')}, so this session can't use memory right now. Close that session and I'll reconnect, or I can set up one shared gbrain server so both sessions work at once. Which do you prefer?`;
  return {
    fix: { ...waitFix, user_message },
    user_message,
    decisions: [{
      id: 'lock_recovery',
      question: 'Two agent sessions want the same brain. Close the other session, or share one HTTP server?',
      options: [
        { id: 'close_owner', label: `Close ${owner.replace(/`/g, '')}; this server recovers on the next gbrain_status call.` },
        { id: 'share_http', label: 'Run one shared `gbrain serve --http` and connect every harness to it (writes harness config, mints tokens); the full plan is share_http_plan.', argv: shareHttp.argv },
      ],
      default: 'close_owner',
      default_reason: 'Nothing is installed or reconfigured; the brain comes back as soon as the other session ends.',
    }],
    plan: shareHttp,
  };
}

/** Status mode's render context: on stdio, only gbrain_status is callable. */
const STATUS_RENDER: RenderContext = { transport: 'stdio', isCallable: n => n === STATUS_TOOL_NAME, preapproved: () => false };
/** HTTP status mode: every caller is unauthenticated (its tokens live in the brain it cannot open). */
const HTTP_STATUS_RENDER: RenderContext = { transport: 'http', isCallable: n => n === STATUS_TOOL_NAME, preapproved: () => false };

/** Seconds an HTTP client waits before asking again (the daemon's re-probe interval). */
export const HTTP_STATUS_RETRY_AFTER_S = 5;
/**
 * The only cause an unauthenticated HTTP response states. The bind address
 * cannot tell who is asking (Tailscale Funnel delivers public requests from a
 * loopback address), so the detailed reason stays in stderr, the status
 * marker and doctor on the host.
 */
const HTTP_UNAVAILABLE_WHY = 'This gbrain server cannot open its brain; its host operator can see why with `gbrain doctor`.';
const HTTP_USER_MESSAGE = 'The gbrain memory server is running but cannot open its brain, so memory is offline. Can whoever runs that machine run `gbrain doctor` there? The server reconnects by itself once it is fixed.';

function httpStatusFix(): Action {
  return {
    argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'host_admin', requires_exclusive: false, user_message: HTTP_USER_MESSAGE,
    why: `Run on the brain host: doctor names the cause and its fix. This server re-checks every ${HTTP_STATUS_RETRY_AFTER_S} s and serves the full tool list once the brain opens; then re-list tools or reconnect.`,
    verify: { mcp: { tool: STATUS_TOOL_NAME, arguments: {} } }, docs: 'docs/mcp/DEPLOY.md#status-only-mode',
  };
}

/**
 * The unauthenticated HTTP status payload, built from an allowlist (never by
 * redacting the stdio payload): no path, PID, config or repair detail, and
 * the reason collapsed to `unavailable`.
 */
export function httpStatusPayload(): Record<string, unknown> {
  return {
    status: 'unavailable', reason: 'unavailable', why: HTTP_UNAVAILABLE_WHY,
    fix: renderAction(httpStatusFix(), HTTP_STATUS_RENDER), user_message: HTTP_USER_MESSAGE,
    retry_after_s: HTTP_STATUS_RETRY_AFTER_S, contract_version: 1,
  };
}

/** The `serve_status_only` error envelope for HTTP (OAuth/admin routes and any tool but gbrain_status). */
export function httpStatusEnvelope(tool?: string): Record<string, unknown> {
  const e = opError('serve_status_only', tool ? `${HTTP_UNAVAILABLE_WHY} ${tool} is unavailable until it can.` : HTTP_UNAVAILABLE_WHY,
    `Tell the user what user_message says; retry after ${HTTP_STATUS_RETRY_AFTER_S} s.`, { reason: 'unavailable', why: HTTP_UNAVAILABLE_WHY, fix: httpStatusFix() });
  return { ...toAgentError(e, { transport: 'http', ...(tool ? { op: tool } : {}), render: HTTP_STATUS_RENDER }), user_message: HTTP_USER_MESSAGE, retry_after_s: HTTP_STATUS_RETRY_AFTER_S };
}

/** The `gbrain_status` tool result: {status, reason, why, fix, user_message, …}. */
export function statusPayload(state: StatusModeState, t: StatusTransport = 'stdio'): Record<string, unknown> {
  if (state.recovered) {
    return {
      status: 'recovered', reason: state.reason,
      why: t === 'http'
        ? 'The brain is open now and this server serves the full tool list. Re-list tools or restart this MCP connection (an HTTP server cannot push tools/list_changed to this client).'
        : `The brain is open now; the full tool list replaced gbrain_status (tools/list_changed was sent). ${restartNote(t)}`,
      contract_version: 1,
    };
  }
  if (t === 'http') return httpStatusPayload();
  const { fix, user_message, decisions, plan } = statusFix(state);
  return {
    status: 'unavailable',
    reason: state.reason,
    why: statusHeadline(state),
    ...(state.brain_path ? { brain_path: state.brain_path } : {}),
    config_path: state.config_path,
    ...(state.lock_owner ? { lock_owner: state.lock_owner } : {}),
    ...(state.repair_failed ? { repair_failed: state.repair_failed } : {}),
    fix: renderAction(fix, STATUS_RENDER),
    user_message,
    ...(decisions ? { decisions } : {}),
    ...(plan ? { share_http_plan: renderAction(plan, STATUS_RENDER) } : {}),
    checked_at: new Date(state.checked_at).toISOString(),
    contract_version: 1,
  };
}

/** The one tool advertised in status mode. */
export const STATUS_TOOL_DEF = {
  name: STATUS_TOOL_NAME,
  description: 'gbrain is running in status-only mode: its brain is locked by another server, missing, damaged (automatic repair failed), or its config is unreadable. Call this for the cause (lock owner, brain path), the fix and what to tell the user; calling it also re-checks and restores the full tool list once the brain can be opened.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { title: 'gbrain status (status-only mode)', readOnlyHint: true },
};

/** The same tool on an HTTP status server: no host detail; the server re-checks on its own. */
export const HTTP_STATUS_TOOL_DEF = {
  ...STATUS_TOOL_DEF,
  description: 'This gbrain server is running in status-only mode: it cannot open its brain. Call this for what to tell the user; the server re-checks every 5 s, and once this reports recovered, re-list tools or reconnect for the full tool list.',
};

/**
 * One recovery attempt from inside a tool call: re-probe (file reads only);
 * when nothing blocks, touch the lazy engine so its gated reconnect runs
 * (lock acquisition at most once per 5 s). True once the brain is open.
 */
export async function attemptStatusRecovery(engine: { getConfig(key: string): Promise<unknown> }, state: StatusModeState): Promise<boolean> {
  if (!isEngineDegraded(engine)) { state.recovered = true; return true; }
  const probed = probeStatus();
  if (probed) { Object.assign(state, probed); return false; }
  try {
    await engine.getConfig('version');
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code !== 'GBRAIN_RECOVERED_RETRY') return !isEngineDegraded(engine);
  }
  state.recovered = !isEngineDegraded(engine);
  return state.recovered;
}

/** `gbrain_status` as an MCP result (never isError: the status IS the answer). */
export function statusToolResult(state: StatusModeState, t: StatusTransport = 'stdio'): ToolResultShape {
  return { content: [{ type: 'text', text: JSON.stringify(statusPayload(state, t), null, 2) }] };
}

/** Any other tool while still in status mode: one error block naming gbrain_status. */
export function statusModeErrorResult(state: StatusModeState, tool: string, t: StatusTransport = 'stdio'): ToolResultShape {
  if (t === 'http') return { content: [{ type: 'text', text: JSON.stringify(httpStatusEnvelope(tool), null, 2) }], isError: true };
  const { fix } = statusFix(state);
  const e = opError('serve_status_only', `${statusHeadline(state)} ${tool} is unavailable until it can.`,
    'Call gbrain_status for the cause, the fix and what to tell the user.', { reason: state.reason, fix });
  return toolErrorResult(toAgentError(e, { transport: 'stdio', op: tool, render: STATUS_RENDER }));
}

/** Line appended to the initialize instructions in status mode. */
export function statusInstructionLine(state: StatusModeState, t: StatusTransport = 'stdio'): string {
  if (t === 'http') return `STATUS-ONLY MODE: ${HTTP_UNAVAILABLE_WHY} Only gbrain_status is available: call it for what to tell the user. This server re-checks every ${HTTP_STATUS_RETRY_AFTER_S} s; once gbrain_status reports recovered, re-list tools or reconnect.`;
  return `STATUS-ONLY MODE: ${statusHeadline(state)} Only gbrain_status is available: call it for the fix and what to tell the user. The full tool list returns (tools/list_changed) once the brain opens.`;
}
