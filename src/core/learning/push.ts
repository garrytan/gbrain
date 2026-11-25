/**
 * Nightly learning PR 2: the one line the owner's agent gets at session start when the learned note holds items it
 * has not shown yet: through the serve's context pack (Claude Code and Codex session start) and OpenClaw's core lane.
 * Count only, never item text, so the line says nothing about what was learned. learning.note.push false turns it off.
 * The agent then asks the owner and calls learned, which reads at the caller's own scope.
 */
import type { BrainEngine } from '../engine.ts';
import { hasCapability } from '../engine-capabilities.ts';
import { QUESTION_KINDS, learningTablePresent } from './kinds.ts';
import { LEARNED_WINDOW_DAYS } from './read.ts';

export const LEARNING_PUSH_KEY = 'learning.note.push';

export interface LearnedPush { text: string; run_id: string; count: number; questions: number }

const list = (values: readonly string[]) => values.map(v => `'${v}'`).join(', ');

/** Unseen pending items of the last seven days in one source, with the newest run that recorded one; null when there are none or the line is off. */
export async function learnedPushLine(engine: BrainEngine, sourceId: string, now: Date = new Date()): Promise<LearnedPush | null> {
  if (!hasCapability(engine, 'raw_sql')) return null;
  if ((await engine.getConfig(LEARNING_PUSH_KEY))?.trim().toLowerCase() === 'false') return null;
  if (!await learningTablePresent(engine)) return null;
  const [row] = await engine.executeRaw<{ n: number | string; q: number | string; run_id: string | null }>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE kind IN (${list(QUESTION_KINDS)}))::int AS q,
            (array_agg(run_id::text ORDER BY created_at DESC, id DESC))[1] AS run_id
       FROM learning_items WHERE source_id = $1 AND state = 'pending' AND shown_at IS NULL AND created_at >= $2::timestamptz`,
    [sourceId, new Date(now.getTime() - LEARNED_WINDOW_DAYS * 86_400_000).toISOString()]);
  const count = Number(row?.n ?? 0);
  if (!count || !row?.run_id) return null;
  const questions = Number(row.q ?? 0);
  const things = count === 1 ? '1 thing' : `${count} things`;
  return {
    count, questions, run_id: row.run_id,
    text: `[gbrain] Nightly learning: the brain has ${things} to show the user${questions ? ` (${questions} need a yes or no)` : ''}. ` +
      `Say "I learned ${things} last night; want them?" and, if they say yes, call the learned tool.`,
  };
}
