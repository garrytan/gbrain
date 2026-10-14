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
import { HERMES_NON_HUMAN_SOURCES } from '../transcripts/hermes.ts';
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
  /** True for a turn no human drove: a cron/kanban/subagent platform or a child session (parent_session_id set). */
  nonHuman: boolean;
}

/** Hermes puts the whole conversation_history on stdin every turn; read all of it (a long agentic session passes 4 MiB). */
export const HERMES_STDIN_MAX_CHARS = 64 * 1024 * 1024;

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
  const platform = (str(extra.platform) ?? '').toLowerCase();
  return { prompt, sessionId: str(j.session_id), cwd: str(j.cwd), firstTurn: extra.is_first_turn === true,
    nonHuman: HERMES_NON_HUMAN_SOURCES.includes(platform) || !!str(extra.parent_session_id) };
}

/**
 * Hermes' stdin as text: the injected seam, else process stdin read to EOF. Bounded by `hardMs` (the hook's overall
 * deadline), by `capChars`, and by `idleMs` of silence (a parent that never closes the pipe costs 1s, not the
 * deadline). Empty on a TTY. Never rejects.
 */
export function readHermesStdin(io: { stdin?: string }, hardMs: number, opts: { idleMs?: number; capChars?: number } = {}): Promise<string> {
  if (io.stdin !== undefined) return Promise.resolve(io.stdin);
  const idleMs = opts.idleMs ?? 1000;
  const cap = opts.capChars ?? HERMES_STDIN_MAX_CHARS;
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks: string[] = [];
    let size = 0;
    let done = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const finish = () => { if (done) return; done = true; clearTimeout(idle); clearTimeout(hard); resolve(chunks.join('')); };
    const arm = () => { clearTimeout(idle); idle = setTimeout(finish, idleMs); (idle as { unref?: () => void }).unref?.(); };
    const hard = setTimeout(finish, hardMs);
    (hard as { unref?: () => void }).unref?.();
    arm();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => { chunks.push(c); size += c.length; if (size > cap) finish(); else arm(); });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

const lastMatch = (raw: string, re: RegExp): RegExpExecArray | null => { let m: RegExpExecArray | null = null; for (const x of raw.matchAll(re)) m = x; return m; };
const jsonString = (m: RegExpExecArray | null): string | undefined => { if (!m) return undefined; try { return JSON.parse(m[1]!) as string; } catch { return undefined; } };
/** The payload string fields recovered from a torn payload: literal patterns (fresh /g instance per use, since lastIndex is stateful). */
type HermesPayloadField = 'user_message' | 'hook_event_name' | 'session_id' | 'cwd' | 'platform' | 'parent_session_id';
const FIELD_RES: Record<HermesPayloadField, () => RegExp> = {
  user_message: () => /"user_message"\s*:\s*("(?:[^"\\]|\\.)*")/g,
  hook_event_name: () => /"hook_event_name"\s*:\s*("(?:[^"\\]|\\.)*")/g,
  session_id: () => /"session_id"\s*:\s*("(?:[^"\\]|\\.)*")/g,
  cwd: () => /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/g,
  platform: () => /"platform"\s*:\s*("(?:[^"\\]|\\.)*")/g,
  parent_session_id: () => /"parent_session_id"\s*:\s*("(?:[^"\\]|\\.)*")/g,
};

/**
 * The payload object from Hermes' stdin text. A whole-document JSON.parse first; if that fails (the read was cut by the
 * deadline or the size cap, or the history carries something the parser rejects), the fields the hook needs are lifted
 * straight from the text: session_id and cwd lead the document, extra.user_message precedes conversation_history, and
 * is_first_turn / platform / parent_session_id follow it (so the last match is the structural one; a quoted copy inside
 * a message is backslash-escaped and never matches). Null when nothing usable is there.
 */
export function parseHermesStdin(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch { /* fall through to field extraction */ }
  if (!raw.trimStart().startsWith('{')) return null;
  const field = (name: HermesPayloadField): RegExp => FIELD_RES[name]();
  const user = jsonString(field('user_message').exec(raw));
  if (user === undefined) return null;
  const first = lastMatch(raw, /"is_first_turn"\s*:\s*(true|false)/g);
  return {
    hook_event_name: jsonString(field('hook_event_name').exec(raw)),
    session_id: jsonString(field('session_id').exec(raw)),
    cwd: jsonString(field('cwd').exec(raw)),
    extra: { user_message: user, is_first_turn: first?.[1] === 'true', platform: jsonString(lastMatch(raw, field('platform'))),
      parent_session_id: jsonString(lastMatch(raw, field('parent_session_id'))) },
  };
}

/** True once a first turn was delivered for this session id (the resume sentinel; Hermes reports a resumed session as not-first). */
export function hermesFirstTurnSeen(dir: string, sessionId: string): boolean {
  try { return statSync(join(dir, sessionId)).isFile(); } catch { return false; }
}

/**
 * Record that this session's first-turn attempt is over. Called when the attempt COMPLETES, whether or not a digest
 * reached stdout: an empty digest or a serve that was not ready must not make every later turn pay the serve wait again
 * (they take the plain 800ms path). A digest suppressed by the outer deadline is the one case left unmarked, so it can
 * re-fire. Old sentinels are pruned on each mark. Fail-open: a filesystem error only means the wait may repeat.
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

/** Record that the first-turn attempt completed (see markHermesFirstTurn). */
async function markHermesGreeted(sessionId: string): Promise<void> {
  markHermesFirstTurn(await sentinelDir(), sessionId);
}

export interface HermesRunResult { outcome: 'ok' | 'degraded' | 'error'; reason?: string; turns?: number; /** the session whose first-turn attempt completed */ greeted?: string }
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
  // cron / kanban / subagent turns and child sessions are not a human conversation: no cold start, no heartbeat noise, no injection.
  // (Gateway senders are humans and are NOT skipped; reads stay world-visibility only on the serve side.)
  if (p.nonHuman) return { outcome: 'ok', reason: 'non_human_session' };
  const sessionId = deps.sanitize(p.sessionId);
  const dir = await sentinelDir();
  const seen = sessionId !== 'unknown' && hermesFirstTurnSeen(dir, sessionId);
  // First = Hermes says so, or gbrain has never attempted this (resumed) session. The serve wait is paid only while no
  // sentinel exists AND Hermes reports a first turn: a later turn, or a resumed session, takes the plain deadline.
  const first = p.firstTurn || (sessionId !== 'unknown' && !seen);
  const mayWait = p.firstTurn && !seen;
  const cfg = deps.configOverride !== undefined ? deps.configOverride : loadConfig();
  const sourceId = process.env.GBRAIN_SOURCE || undefined;
  const socketPath = await hookResolveSocketForConfig(cfg, sourceId);
  if (!socketPath) return { outcome: 'degraded', reason: 'no_pglite_path' };
  const secret = readIpcSecretForConfig(cfg);
  if (!secret) return { outcome: 'degraded', reason: 'no_serve' };
  const awaitServe = mayWait && sessionStartAwaitsServe('startup', 'hermes', p.cwd ?? process.cwd());
  const deadlineAt = deps.t0 + (first ? (awaitServe ? deps.serveWaitDeadlineMs : deps.startDeadlineMs) : (deps.turnDeadlineMs ?? HERMES_TURN_DEADLINE_MS));
  // Marked as soon as the attempt completes (any outcome below): the wait is one-time per session.
  const greeted = first && sessionId !== 'unknown' ? { greeted: sessionId } : {};
  const [turn, start] = await Promise.all([
    requestTurnContext(socketPath, { secret, window: [{ role: 'user', text: p.prompt }], ...(sessionId !== 'unknown' ? { sessionId } : {}), ...(sourceId ? { sourceId } : {}), channel: 'hermes' }),
    first ? requestSessionStartPack(cfg, { sourceId, sessionId, trigger: 'session-start:hermes', deadlineAt, awaitServe }) : Promise.resolve(null),
  ]);
  if (turn === IPC_UNAVAILABLE && !start?.pack) return { outcome: 'degraded', reason: start?.serveNotReady ? 'serve_not_ready' : 'ipc_unavailable', turns: 1, ...greeted };
  const resp = turn !== IPC_UNAVAILABLE && !('degraded' in turn) ? (turn as TurnContextResponse) : null;
  const pack = start?.pack?.ok ? start.pack.block : null;
  const digest = pack ? composeSessionStartOutput(process.env.GBRAIN_CORE !== '0' ? pack.core?.text ?? '' : '', pack.text ? [pack.text] : []) : null;
  const context = composeHermesContext(digest, resp?.ok ? resp.block?.text ?? null : null);
  if (!context) return { outcome: 'ok', reason: resp && !resp.ok ? code(resp.error ?? 'server_error') : 'empty_block', turns: 1, ...greeted };
  deps.write(hermesContextLine(context));
  return { outcome: 'ok', turns: 1, ...greeted };
}

/** What hook.ts lends the Hermes runner (its private plumbing), so this module stays free of the command file. */
export interface HermesHostDeps {
  withDeadline: <T>(ms: number, work: Promise<T>) => Promise<T | symbol>;
  DEADLINE: symbol;
  write: (io: HermesIo, s: string) => void;
  writeHeartbeat: (io: HermesIo, entry: { ts: string; event: string; outcome: 'ok' | 'degraded' | 'error'; reason?: string; duration_ms: number; turns?: number }) => Promise<void>;
  errorCode: (e: unknown) => string;
  sanitizeSessionId: (id: unknown) => string;
  startDeadlineMs: number;
  serveWaitDeadlineMs: number;
}
export interface HermesIo { configOverride?: GBrainConfig | null; userPromptDeadlineMs?: number; stdin?: string }

/** Outer bound for the whole hook (a first turn awaiting a starting serve); under the 10s Hermes timeout setup writes. */
const FIRST_TURN_MAX_PAD_MS = 500;

/** Hermes' `pre_llm_call` hook: `{"context": ...}` out, one heartbeat, exit 0 on every path. */
export async function hookUserPromptHermes(io: HermesIo, h: HermesHostDeps): Promise<number> {
  const t0 = Date.now();
  let expired = false;
  let result: HermesRunResult;
  try {
    const raced = await h.withDeadline(h.serveWaitDeadlineMs + FIRST_TURN_MAX_PAD_MS, (async () =>
      runHermesPrompt(parseHermesStdin(await readHermesStdin(io, h.serveWaitDeadlineMs)), { t0, sanitize: h.sanitizeSessionId, configOverride: io.configOverride, turnDeadlineMs: io.userPromptDeadlineMs,
        startDeadlineMs: h.startDeadlineMs, serveWaitDeadlineMs: h.serveWaitDeadlineMs, write: (line) => { if (!expired) h.write(io, line); } }))());
    if (raced === h.DEADLINE) { expired = true; result = { outcome: 'degraded', reason: 'deadline' }; } else result = raced as HermesRunResult;
  } catch (e) {
    expired = true;
    result = { outcome: 'error', reason: h.errorCode(e) };
  }
  if (result.greeted && !expired) await markHermesGreeted(result.greeted); // record once the attempt completed, not only when a digest was written
  await h.writeHeartbeat(io, { ts: new Date().toISOString(), event: 'user-prompt', outcome: result.outcome,
    ...(result.reason ? { reason: result.reason } : {}), duration_ms: Date.now() - t0, ...(result.turns !== undefined ? { turns: result.turns } : {}) });
  return 0;
}
