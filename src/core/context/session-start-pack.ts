/**
 * The SessionStart context pack (hook.ts step 6), fetched from the serve over
 * its resolve-IPC socket. Engine-free: the hook never opens the brain, so a
 * live PGLite owner is never contended.
 *
 * Cat 41 first push: Claude Code spawns its MCP servers alongside SessionStart
 * (observed on 2.1.285: the server starts ~45ms before the hook, in parallel),
 * and a fresh stdio `gbrain serve` binds its socket about 2s later; Codex
 * does the same. Without a wait the hook found no socket and a fresh session
 * got no pack. When
 * `sessionStartAwaitsServe` says the harness is starting a serve for this
 * session, the request is retried until the serve answers or the deadline
 * nears; otherwise one attempt, as before.
 */
import {
  CONTEXT_PACK_CLIENT_TIMEOUT_MS,
  IPC_UNAVAILABLE,
  hookResolveSocketForConfig,
  readIpcSecretForConfig,
  requestContextPack,
  type ContextPackResponse,
  type IpcPathConfig,
} from './resolve-ipc.ts';
import { claudeCodeSpawnsServe, codexSpawnsServe } from '../setup/local-receipts.ts';
import type { FirstSessionOutcome, SessionStartSection } from './session-start-sections.ts';

const POLL_MS = 100;
/** Kept free before the deadline for composing and writing stdout. */
const WRITE_MARGIN_MS = 100;

/**
 * True when this SessionStart belongs to a new Claude Code or Codex process
 * (source startup or resume; clear and compact run inside a process whose
 * serve is already up) and an installed `gbrain setup` receipt for that
 * harness says the process spawns a stdio serve (Claude Code: for this
 * directory). Codex starts its MCP servers alongside the hook too, and a
 * serve binds its socket only after its MCP handshake (src/mcp/server.ts), so
 * without the wait the hook's attempt and its one retry both land before the
 * bind. Fail-open: false.
 */
export function sessionStartAwaitsServe(source: unknown, harness: string, cwd: string): boolean {
  if (source !== undefined && source !== 'startup' && source !== 'resume') return false;
  try {
    if (harness === 'codex') return codexSpawnsServe();
    return harness === 'claude-code' && claudeCodeSpawnsServe(cwd);
  } catch {
    return false;
  }
}

export interface SessionStartPackResult {
  pack: ContextPackResponse | null;
  /** The wait ran out before a serve answered. */
  serveNotReady: boolean;
  /** A serve's secret exists but its round trip failed or outlasted the client timeout. */
  ipcUnavailable?: boolean;
  /** No serve was found: no socket, or no secret (no serve ever started). */
  noServe?: boolean;
  /** A serve answered without the protocol echo (an older serve). */
  stale?: boolean;
  /** The one retry of a transient failure ran (onboarding PR 2 d8). */
  retried?: boolean;
}

/**
 * One context_pack request, or (awaitServe) retries until the serve answers.
 * Socket and secret are re-resolved each round: a serve on a fresh brain
 * creates the secret, and on Postgres it binds a source-keyed socket. A stale
 * serve (no protocol echo) yields no pack.
 */
export async function requestSessionStartPack(
  cfg: IpcPathConfig | null,
  opts: { sourceId?: string; sessionId: string; trigger: string; deadlineAt: number; awaitServe: boolean; sections?: string[]; harness?: string; retryOnce?: boolean },
): Promise<SessionStartPackResult> {
  let retried = false;
  for (;;) {
    const socket = await hookResolveSocketForConfig(cfg, opts.sourceId);
    if (!socket) return { pack: null, serveNotReady: false, noServe: true };
    const remaining = opts.deadlineAt - Date.now() - WRITE_MARGIN_MS;
    if (remaining <= WRITE_MARGIN_MS) return { pack: null, serveNotReady: opts.awaitServe };
    const secret = readIpcSecretForConfig(cfg);
    const res = secret
      ? await requestContextPack(socket, {
        secret,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
        trigger: opts.trigger,
        ...(opts.sections ? { sections: opts.sections } : {}),
        ...(opts.harness ? { harness: opts.harness } : {}),
      }, { timeoutMs: Math.min(CONTEXT_PACK_CLIENT_TIMEOUT_MS, remaining) })
      : IPC_UNAVAILABLE;
    if (res !== IPC_UNAVAILABLE) {
      const stale = 'degraded' in res;
      return { pack: stale ? null : res as ContextPackResponse, serveNotReady: false, ...(stale ? { stale: true } : {}), ...(retried ? { retried } : {}) };
    }
    // d8: one retry of a transient failure (the serve's socket and secret exist); a retried request reuses its session's reservation.
    if (!opts.awaitServe && secret && opts.retryOnce && !retried) { retried = true; continue; }
    if (!opts.awaitServe) return { pack: null, serveNotReady: false, ...(secret ? { ipcUnavailable: true } : { noServe: true }), ...(retried ? { retried } : {}) };
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Most time an acknowledgement round trip may take (twice with its one retry), after the payload was written. */
export const SECTION_ACK_TIMEOUT_MS = 400;

/**
 * Onboarding PR 2 (d14): the emission receipt for a section the hook's final payload held and wrote, over the
 * context_pack bankOnly arm (no new message type; an older serve ignores `sectionAck`). Retries a transient failure
 * once. 'unavailable' means nothing was recorded, so nothing was counted.
 */
export async function acknowledgeSessionStartSection(
  cfg: IpcPathConfig | null,
  opts: { sourceId?: string; sessionId: string; section: string; receipt: string; timeoutMs?: number },
): Promise<{ result: 'recorded' | 'refused' | 'unavailable'; reason?: string; retried: boolean }> {
  let retried = false;
  for (;;) {
    const socket = await hookResolveSocketForConfig(cfg, opts.sourceId);
    const secret = socket ? readIpcSecretForConfig(cfg) : null;
    const res = socket && secret
      ? await requestContextPack(socket, {
        secret, sessionId: opts.sessionId, bankOnly: true, trigger: 'session-start-ack',
        ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
        sectionAck: { section: opts.section, receipt: opts.receipt },
      }, { timeoutMs: opts.timeoutMs ?? SECTION_ACK_TIMEOUT_MS })
      : IPC_UNAVAILABLE;
    if (res !== IPC_UNAVAILABLE && !('degraded' in res)) {
      const ack = res.ok ? res.block?.sectionAck : undefined;
      if (ack && ack.recorded !== 'refused') return { result: 'recorded', retried };
      return { result: 'refused', reason: ack?.reason ?? (res.ok ? 'unsupported' : 'error'), retried };
    }
    if (retried || !socket) return { result: 'unavailable', retried };
    retried = true;
  }
}

/** What the hook's pack step learned about the named sections (onboarding PR 2). */
export interface FirstSessionPackState {
  reached: boolean;
  sections: SessionStartSection[];
  firstSession?: { due: boolean; reason?: string };
  outcome?: FirstSessionOutcome;
  reason?: string;
  retried?: boolean;
  sourceId?: string;
}

/**
 * d8: the first-session outcome a pack request settles before any section is composed, or {} when the serve
 * answered with a block (its firstSession state then decides).
 */
export function firstSessionPackOutcome(res: SessionStartPackResult): { outcome?: FirstSessionOutcome; reason?: string } {
  if (res.serveNotReady) return { outcome: 'serve_not_ready' };
  if (res.noServe || res.ipcUnavailable) return { outcome: 'no_ipc' };
  if (res.stale) return { outcome: 'stale_protocol' };
  const pack = res.pack;
  if (!pack) return { outcome: 'failed' };
  if (!pack.ok) {
    if (pack.error === 'unsupported_kind' || pack.error === 'unsupported_protocol') return { outcome: 'unsupported', reason: pack.error };
    return { outcome: 'failed', ...(pack.error === 'source_mismatch' || pack.error === 'unauthorized' ? { reason: pack.error } : {}) };
  }
  if (pack.block?.firstSession) return {};
  return pack.degradedReason === 'server_budget' ? { outcome: 'deadline', reason: 'server_budget' } : { outcome: 'unsupported', reason: 'no_sections' };
}

/** Receipt refusals that are the record's decision (nothing was due); any other refusal means the receipt did not land. */
const NOT_DUE_ACK = new Set(['stopped', 'sessions_exhausted', 'not_owner_lane']);

/**
 * d8 + d14, after the payload was written: the startup session's first-session outcome, sending the emission receipt
 * only when the written text held the section. Never throws (fail-open); nothing is counted without a receipt.
 */

export async function settleFirstSession(cfg: IpcPathConfig | null, s: FirstSessionPackState & { deadline: boolean; emitted: boolean; receipt?: string; sessionId: string }):
  Promise<{ outcome: FirstSessionOutcome; reason?: string; retried?: boolean }> {
  const retried = s.retried === true;
  if (s.outcome) return { outcome: s.outcome, reason: s.reason, retried };
  if (!s.firstSession) return { outcome: s.deadline || !s.reached ? 'deadline' : 'failed', retried };
  if (!s.firstSession.due) return { outcome: 'not_due', reason: s.firstSession.reason, retried };
  if (!s.emitted || !s.receipt) return { outcome: 'trimmed', retried };
  try {
    const ack = await acknowledgeSessionStartSection(cfg, { sourceId: s.sourceId, sessionId: s.sessionId, section: 'first_session', receipt: s.receipt });
    const notDue = ack.result === 'refused' && NOT_DUE_ACK.has(ack.reason ?? '');
    return { outcome: ack.result === 'recorded' ? 'delivered' : notDue ? 'not_due' : 'ack_failed', reason: ack.reason, retried: retried || ack.retried };
  } catch { // silent-read-ok: fail-open; a receipt that never landed counts nothing, and the outcome says so
    return { outcome: 'ack_failed', retried };
  }
}

/**
 * #5941: the source the hook's context arms (session-start pack, user-prompt)
 * ask for. `GBRAIN_SOURCE` wins; else, with a session, its frozen source
 * record (the one capture stamps: env, then the payload cwd's
 * `.gbrain-source` walk), so context and capture never disagree within a
 * session; without one, the cwd walk itself. Undefined (the serve's own
 * binding) when nothing names a source or anything fails. A named source with
 * no live keyed serve reaches the legacy socket, whose serve answers
 * `source_mismatch` (the heartbeat reason) instead of another source's context.
 */
export async function contextSourceId(openSession: (() => Promise<{ source?: string }>) | null, cwd: string): Promise<string | undefined> {
  if (process.env.GBRAIN_SOURCE) return process.env.GBRAIN_SOURCE;
  try {
    if (openSession) return (await openSession()).source;
    const { resolveSourceIdEngineFree } = await import('../source-resolver.ts');
    return resolveSourceIdEngineFree(null, cwd) ?? undefined;
  } catch {
    return undefined;
  }
}
