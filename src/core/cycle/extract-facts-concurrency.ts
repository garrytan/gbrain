/** Opt-in page parallelism. Accept whole integers only, never partial parses. */
export function resolveExtractFactsConcurrency(env = process.env): number {
  const value = env.GBRAIN_EXTRACT_FACTS_CONCURRENCY?.trim() ?? '';
  if (!/^[+-]?\d+$/.test(value)) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

/** The CLI's ordinary Postgres pool reports its configured max without SQL. */
export function capExtractFactsConcurrency(requested: number, engine: unknown): number {
  const pg = engine as { kind?: string; getPoolDiagnostics?: () => { poolMax: number | null } | null };
  if (pg.kind !== 'postgres') return requested; // PGLite has no connection pool.
  let max: number | null | undefined;
  try { max = pg.getPoolDiagnostics?.()?.poolMax; } catch { /* diagnostics are best effort */ }
  // Only a known configured pool size limits the caller-requested parallelism.
  return Math.min(requested, max != null && Number.isSafeInteger(max) && max > 0 ? max : requested);
}

export interface BoundedPoolOpts<T, O> {
  items: readonly T[];
  concurrency: number;
  shouldStart: (item: T, index: number) => boolean;
  task: (item: T, index: number) => Promise<O>;
  onError: (error: unknown, item: T, index: number) => O;
  stopOn: (outcome: O) => boolean;
  finished: (outcome: O) => boolean;
}

/**
 * Claim indexes synchronously, check admission before every claim, and always
 * drain all workers. A failed index leaves a cursor gap: successful pages past
 * that gap may be done again next run (page reconciliation is idempotent).
 * Tasks own their connections; no worker holds one while awaiting another page.
 */
export async function runBoundedPool<T, O>(opts: BoundedPoolOpts<T, O>): Promise<{
  outcomes: Array<O | undefined>; visited: number;
}> {
  const outcomes: Array<O | undefined> = new Array(opts.items.length);
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < opts.items.length) {
      if (!opts.shouldStart(opts.items[next], next)) { stopped = true; break; }
      const index = next++;
      let outcome: O;
      try { outcome = await opts.task(opts.items[index], index); }
      catch (error) { outcome = opts.onError(error, opts.items[index], index); }
      outcomes[index] = outcome;
      if (opts.stopOn(outcome)) stopped = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, opts.items.length) }, worker));
  let visited = 0;
  while (visited < outcomes.length && outcomes[visited] !== undefined && opts.finished(outcomes[visited]!)) visited++;
  return { outcomes, visited };
}
