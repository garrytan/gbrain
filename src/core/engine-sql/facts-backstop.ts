/**
 * The two reads the facts backstop effect (persistence/effect-facts.ts) sent through `executeRaw`: whether a page
 * still has a facts extraction waiting to run, and whether one has finished for it. One SQL implementation for both
 * engines; each text is the one its caller has always sent. The decision (skip, queue, settle) stays with the caller.
 */
import type { LegacyUnscopedRead } from './brands.ts';

/**
 * hasPendingFactsExtraction: true when page `pageId` has a queued or running `facts-backstop` effect, or a
 * `facts-absorb` job in one of `jobStates`. Both are matched on their `data->>'page_id'`.
 */
export async function hasPendingFactsExtraction(exec: LegacyUnscopedRead, pageId: number | string, jobStates: readonly string[]): Promise<boolean> {
  const [row] = await exec.executeRaw<{ pending: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM persistence_effects
                     WHERE kind = 'facts-backstop' AND state IN ('queued', 'running') AND data->>'page_id' = $1)
         OR EXISTS (SELECT 1 FROM minion_jobs
                     WHERE name = 'facts-absorb' AND status = ANY($2::text[]) AND data->>'page_id' = $1) AS pending`,
    [String(pageId), [...jobStates]]);
  return row?.pending === true;
}

/** hasCompletedFactsExtraction: true when a `facts-absorb` job for page `pageId` completed without `result.skipped`. */
export async function hasCompletedFactsExtraction(exec: LegacyUnscopedRead, pageId: number | string): Promise<boolean> {
  const [row] = await exec.executeRaw<{ done: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM minion_jobs
                     WHERE name = 'facts-absorb' AND status = 'completed' AND data->>'page_id' = $1
                       AND result->>'skipped' IS NULL) AS done`,
    [String(pageId)]);
  return row?.done === true;
}
