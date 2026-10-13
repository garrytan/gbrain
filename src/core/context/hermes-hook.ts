/**
 * hermes-hook.ts — the Hermes side of `gbrain hook … --harness hermes`.
 *
 * Hermes (v0.21.7, agent/shell_hooks.py) runs a configured shell hook with ONE
 * JSON object on stdin `{hook_event_name, session_id, cwd, profile, extra}` and
 * reads ONE JSON object back, `{"context": "<text>"}`, which only `pre_llm_call`
 * consumes (appended to the current user message). `pre_llm_call.extra` carries
 * `user_message` and `is_first_turn` (true iff the loaded history is empty, so a
 * RESUMED session reports false) beside a large `conversation_history` that is
 * deliberately never read here. There is no transcript path: the session-end
 * lane reads the profile's `state.db` (transcripts/capture-spec.ts).
 *
 * Pure helpers (engine-free, no Hermes import): payload parsing, the per-session
 * first-turn claim (the resume sentinel) and the output envelope. The
 * orchestration lives in src/commands/hook.ts next to the other hook events.
 */
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type GBrainConfig } from '../config.ts';
import { ensureGbrainHome, resolveGbrainHome } from '../gbrain-home.ts';
import { composeSessionStartOutput } from './session-start-output.ts';
import { requestSessionStartPack, sessionStartAwaitsServe } from './session-start-pack.ts';
import { IPC_UNAVAILABLE, hookResolveSocketForConfig, readIpcSecretForConfig, requestTurnContext, type TurnContextResponse } from './resolve-ipc.ts';

/** Hermes spills hook output over 10000 chars to a file; stay well under so the context is delivered whole. */
export const HERMES_CONTEXT_MAX_CHARS = 8000;
const SENTINEL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FIRST_TURN_DIGEST_FLOOR = 400;

export interface HermesPromptPayload {
  prompt: string;
  sessionId: string | undefined;
  cwd: string | undefined;
  /** Hermes' own flag; the caller also checks the per-session sentinel for resumes. */
  firstTurn: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * The prompt, session and first-turn flag of a `pre_llm_call` payload; null when it is some other event
 * or carries no user message (a hook misregistered on another event must stay silent, never inject).
 */
export function parseHermesPromptPayload(j: Record<string, unknown>): HermesPromptPayload | null {
  const event = str(j.hook_event_name);
  if (event !== undefined && event !== 'pre_llm_call') return null;
  const extra = j.extra && typeof j.extra === 'object' && !Array.isArray(j.extra) ? (j.extra as Record<string, unknown>) : {};
  const prompt = typeof extra.user_message === 'string' ? extra.user_message : '';
  if (!prompt.trim()) return null;
  return { prompt, sessionId: str(j.session_id), cwd: str(j.cwd), firstTurn: extra.is_first_turn === true };
}

/** True once a first turn was delivered for this session id (the resume sentinel; Hermes reports a resumed session as not-first). */
export function hermesFirstTurnSeen(dir: string, sessionId: string): boolean {
  try { return statSync(join(dir, sessionId)).isFile(); } catch { return false; }
}

/**
 * Record that the session-start digest reached stdout. Called AFTER the write (a deadline-suppressed digest must
 * re-fire next turn). Old sentinels are pruned on each mark. Fail-open: a filesystem error only means the digest may repeat.
 */
export function markHermesFirstTurn(dir: string, sessionId: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const cutoff = Date.now() - SENTINEL_TTL_MS;
    for (const name of readdirSync(dir)) {
      try { if (statSync(join(dir, name)).mtimeMs < cutoff) rmSync(join(dir, name), { force: true }); } catch { /* per-file best effort */ }
    }
    closeSync(openSync(join(dir, sessionId), 'a', 0o600));
  } catch { /* fail-open */ }
}

/** Per-turn block first (it answers the user's message), the first-turn digest trimmed to what is left. */
export function composeHermesContext(digest: string | null, block: string | null): string {
  const turn = (block ?? '').slice(0, HERMES_CONTEXT_MAX_CHARS);
  const room = HERMES_CONTEXT_MAX_CHARS - turn.length - 2;
  const head = digest && room >= FIRST_TURN_DIGEST_FLOOR ? digest.slice(0, room) : '';
  return [head, turn].filter(Boolean).join('\n\n');
}

/** The one line Hermes parses, or '' when there is nothing to inject. */
export const hermesContextLine = (context: string): string => (context ? `${JSON.stringify({ context })}\n` : '');

// ── the pre_llm_call run ────────────────────────────────────────────────────

const HERMES_TURN_DEADLINE_MS = 800;

const sentinelDir = async (): Promise<string> => {
  let base: string;
  try { base = ensureGbrainHome(); } catch { base = resolveGbrainHome(); }
  return join(base, 'integrations', 'hermes', 'sessions');
};

/** Record that the session-start digest reached stdout (called after the write; see markHermesFirstTurn). */
async function markHermesGreeted(sessionId: string): Promise<void> {
  markHermesFirstTurn(await sentinelDir(), sessionId);
}

export interface HermesRunResult { outcome: 'ok' | 'degraded' | 'error'; reason?: string; turns?: number; greeted?: string }
interface HermesRunDeps {
  t0: number;
  sanitize: (id: unknown) => string;
  write: (line: string) => void;
  configOverride?: GBrainConfig | null;
  turnDeadlineMs?: number;
  /** hook.ts' session-start self-deadlines: the plain one, and the longer one while a starting serve is awaited. */
  startDeadlineMs: number;
  serveWaitDeadlineMs: number;
}

const code = (r: string): string => (/^[A-Za-z0-9_.:-]{1,48}$/.test(r) ? r : 'server_error');

/**
 * The per-turn context block and, on a first turn (Hermes' is_first_turn, or the first turn gbrain sees for a
 * resumed session id), the session-start pack, fetched from the running serve over IPC concurrently. Writes
 * Hermes' `{"context": ...}` line via `deps.write`; never throws on a miss (the caller fail-opens the rest).
 */
async function runHermesPrompt(j: Record<string, unknown> | null, deps: HermesRunDeps): Promise<HermesRunResult> {
  if (!j) return { outcome: 'degraded', reason: 'no_stdin' };
  const p = parseHermesPromptPayload(j);
  if (!p) return { outcome: 'ok', reason: 'no_prompt' };
  const sessionId = deps.sanitize(p.sessionId);
  const dir = await sentinelDir();
  const first = p.firstTurn || (sessionId !== 'unknown' && !hermesFirstTurnSeen(dir, sessionId));
  const cfg = deps.configOverride !== undefined ? deps.configOverride : loadConfig();
  const sourceId = process.env.GBRAIN_SOURCE || undefined;
  const socketPath = await hookResolveSocketForConfig(cfg, sourceId);
  if (!socketPath) return { outcome: 'degraded', reason: 'no_pglite_path' };
  const secret = readIpcSecretForConfig(cfg);
  if (!secret) return { outcome: 'degraded', reason: 'no_serve' };
  const awaitServe = first && sessionStartAwaitsServe('startup', 'hermes', p.cwd ?? process.cwd());
  const deadlineAt = deps.t0 + (first ? (awaitServe ? deps.serveWaitDeadlineMs : deps.startDeadlineMs) : (deps.turnDeadlineMs ?? HERMES_TURN_DEADLINE_MS));
  const [turn, start] = await Promise.all([
    requestTurnContext(socketPath, { secret, window: [{ role: 'user', text: p.prompt }], ...(sessionId !== 'unknown' ? { sessionId } : {}), ...(sourceId ? { sourceId } : {}), channel: 'hermes' }),
    first ? requestSessionStartPack(cfg, { sourceId, sessionId, trigger: 'session-start:hermes', deadlineAt, awaitServe }) : Promise.resolve(null),
  ]);
  if (turn === IPC_UNAVAILABLE && !start?.pack) return { outcome: 'degraded', reason: start?.serveNotReady ? 'serve_not_ready' : 'ipc_unavailable', turns: 1 };
  const resp = turn !== IPC_UNAVAILABLE && !('degraded' in turn) ? (turn as TurnContextResponse) : null;
  const pack = start?.pack?.ok ? start.pack.block : null;
  const digest = pack ? composeSessionStartOutput(process.env.GBRAIN_CORE !== '0' ? pack.core?.text ?? '' : '', pack.text ? [pack.text] : []) : null;
  const context = composeHermesContext(digest, resp?.ok ? resp.block?.text ?? null : null);
  if (!context) return { outcome: 'ok', reason: resp && !resp.ok ? code(resp.error ?? 'server_error') : 'empty_block', turns: 1 };
  deps.write(hermesContextLine(context));
  return { outcome: 'ok', turns: 1, ...(first && digest ? { greeted: sessionId } : {}) };
}

/** What hook.ts lends the Hermes runner (its private plumbing), so this module stays free of the command file. */
export interface HermesHostDeps {
  readStdinJson: (io: HermesIo, timeoutMs: number) => Promise<Record<string, unknown> | null>;
  withDeadline: <T>(ms: number, work: Promise<T>) => Promise<T | symbol>;
  DEADLINE: symbol;
  write: (io: HermesIo, s: string) => void;
  writeHeartbeat: (io: HermesIo, entry: { ts: string; event: string; outcome: 'ok' | 'degraded' | 'error'; reason?: string; duration_ms: number; turns?: number }) => Promise<void>;
  errorCode: (e: unknown) => string;
  sanitizeSessionId: (id: unknown) => string;
  startDeadlineMs: number;
  serveWaitDeadlineMs: number;
}
export interface HermesIo { configOverride?: GBrainConfig | null; userPromptDeadlineMs?: number }

/** Outer bound for the whole hook (a first turn awaiting a starting serve); under the 10s Hermes timeout setup writes. */
const FIRST_TURN_MAX_PAD_MS = 500;

/** Hermes' `pre_llm_call` hook: `{"context": ...}` out, one heartbeat, exit 0 on every path. */
export async function hookUserPromptHermes(io: HermesIo, h: HermesHostDeps): Promise<number> {
  const t0 = Date.now();
  let expired = false;
  let result: HermesRunResult;
  try {
    const raced = await h.withDeadline(h.serveWaitDeadlineMs + FIRST_TURN_MAX_PAD_MS, (async () =>
      runHermesPrompt(await h.readStdinJson(io, 300), { t0, sanitize: h.sanitizeSessionId, configOverride: io.configOverride, turnDeadlineMs: io.userPromptDeadlineMs,
        startDeadlineMs: h.startDeadlineMs, serveWaitDeadlineMs: h.serveWaitDeadlineMs, write: (line) => { if (!expired) h.write(io, line); } }))());
    if (raced === h.DEADLINE) { expired = true; result = { outcome: 'degraded', reason: 'deadline' }; } else result = raced as HermesRunResult;
  } catch (e) {
    expired = true;
    result = { outcome: 'error', reason: h.errorCode(e) };
  }
  if (result.greeted && !expired) await markHermesGreeted(result.greeted); // record-after-write: a suppressed digest re-fires
  await h.writeHeartbeat(io, { ts: new Date().toISOString(), event: 'user-prompt', outcome: result.outcome,
    ...(result.reason ? { reason: result.reason } : {}), duration_ms: Date.now() - t0, ...(result.turns !== undefined ? { turns: result.turns } : {}) });
  return 0;
}
