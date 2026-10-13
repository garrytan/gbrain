/**
 * hermes-hook-lane.ts — the HOOK-LANE view of a Hermes session for
 * `gbrain hook session-end --harness hermes` (the `on_session_finalize` hook of
 * `gbrain setup hermes --capture`).
 *
 * Hermes hands the hook no transcript: the payload carries `session_id` only,
 * and the conversation lives in the profile's `state.db`. So the "transcript
 * path" is NEVER taken from the payload; hook.ts derives it from the Hermes
 * home pinned in the hook command (HERMES_HOME) and this module confines it to
 * `<home>/state.db`, a regular, non-symlink file, and reads one session by id
 * through the same row selection as the import adapter (transcripts/hermes.ts
 * hermesSessionMessages). The store is opened read-only on the live file (no
 * snapshot: a profile store can be gigabytes, and one indexed session read is
 * cheap); source storage is never written.
 *
 * Anti-self-consumption: only sessions a human drove are captured. Sessions
 * whose `source` is cron, subagent, kanban, tool, recovered, acp or api_server
 * are read as empty. Hermes keeps injected context (our own pre_llm_call block)
 * in a sidecar column, so `messages.content` is the clean conversation and
 * gbrain's pushed context never re-enters the corpus as a "conversation".
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { Database } from 'bun:sqlite';
import { hermesHome } from '../bootstrap/host-specs.ts';
import { isPathContained } from '../path-confine.ts';
import type { ConfineTranscriptResult, ParsedTranscript } from './claude-code-jsonl.ts';
import { HERMES_NON_HUMAN_SOURCES, hermesSessionMessages } from './hermes.ts';

/** Confine `p` to the active Hermes home's state.db. `opts.root` is the test seam (the Hermes home). */
export function confineHermesStateDb(p: unknown, opts: { root?: string } = {}): ConfineTranscriptResult {
  if (typeof p !== 'string' || p.length === 0) return { ok: false, reason: 'missing_path' };
  if (basename(p) !== 'state.db') return { ok: false, reason: 'not_file' };
  let st: ReturnType<typeof lstatSync>;
  try { st = lstatSync(p); } catch (e) {
    return { ok: false, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing_path' : 'unreadable' };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!st.isFile()) return { ok: false, reason: 'not_file' };
  const root = opts.root ?? hermesHome();
  if (!existsSync(root) || !isPathContained(p, root) || realpathSync(p) !== `${realpathSync(root)}/state.db`) return { ok: false, reason: 'outside_projects_dir' };
  return { ok: true, path: p, size: st.size };
}

const empty = (): ParsedTranscript => ({
  turns: [], genuineUserTurnIndexes: [], injectedContextBlocks: [], bytesRead: 0, parsedLines: 0, skippedLines: 0,
  compactBoundaries: 0, boundaryTurnIndexes: [], toolCalls: [], toolCallTurnIndexes: [],
});

/** One Hermes session's conversation as the hook lane's ParsedTranscript. Throws on a store it cannot read; callers confine first and fail open. */
export function parseHermesHookSession(path: string, opts: { sessionId?: string } = {}): ParsedTranscript {
  if (!opts.sessionId) return empty();
  const db = new Database(path, { readonly: true });
  try {
    const { source, messages } = hermesSessionMessages(db, opts.sessionId);
    if (source === null || HERMES_NON_HUMAN_SOURCES.includes(source)) return empty();
    const turns = messages.map((m) => ({ role: m.role, text: m.text }));
    return {
      ...empty(), turns,
      genuineUserTurnIndexes: turns.flatMap((t, i) => (t.role === 'user' ? [i] : [])),
      bytesRead: turns.reduce((n, t) => n + Buffer.byteLength(t.text, 'utf8'), 0), parsedLines: turns.length,
    };
  } finally {
    db.close();
  }
}
