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
