/**
 * #6712 L6: how long a publication transaction spends in each member's
 * `apply` (the page and its projections) and in queueing its effects, the two
 * steps a large page's publish time goes to. Totals are process-local and cost
 * no statement; with `GBRAIN_SYNC_TRACE` set (the sync's opt-in hang-triage
 * trace) each step also prints one stderr line naming the page, so nothing is
 * logged by default.
 */
export type PublicationStep = 'apply' | 'effects';

const totals: Record<PublicationStep, { ms: number; count: number }> = { apply: { ms: 0, count: 0 }, effects: { ms: 0, count: 0 } };

export async function timePublicationStep<T>(step: PublicationStep, slug: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await run(); } finally {
    const ms = performance.now() - started;
    totals[step].ms += ms;
    totals[step].count++;
    if (process.env.GBRAIN_SYNC_TRACE) process.stderr.write(`[sync] publish ${step} ${slug}: ${Math.round(ms)}ms\n`);
  }
}

/** Totals since process start: milliseconds and steps timed, per step. */
export function publicationStepTotals(): Record<PublicationStep, { ms: number; count: number }> {
  return { apply: { ...totals.apply }, effects: { ...totals.effects } };
}
