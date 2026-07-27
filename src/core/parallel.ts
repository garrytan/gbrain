/**
 * Bounded-concurrency Promise.allSettled.
 *
 * Runs `fn(item)` for each item with at most `concurrency` in flight at a time.
 * Returns a `PromiseSettledResult` per input item, in input order, so callers
 * can distinguish fulfilled-with-result from rejected-with-error per item.
 *
 * Used by `gbrain sync --all` (v0.40 Federated Sync v2) to fan out per-source
 * syncs without overwhelming the embedding API or local disk.
 *
 * Why a semaphore + `Promise.allSettled` instead of a library:
 *   - Zero new deps. Bun's stdlib has every primitive we need.
 *   - `Promise.allSettled` semantics are what we want: one source failing
 *     must NOT short-circuit the others. Bare `Promise.all` rejects on
 *     first failure.
 *   - The concurrency cap is a hard ceiling, not a target. With N items and
 *     concurrency C, the function makes at most C concurrent `fn` calls at
 *     any moment.
 *
 * Order guarantee: results[i] always corresponds to items[i]. The execution
 * order of `fn` calls is NOT guaranteed (a fast item submitted later can
 * complete before a slow item submitted earlier).
 */

export async function pMapAllSettled<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError(
      `pMapAllSettled: concurrency must be a positive integer, got ${concurrency}`,
    );
  }
  if (items.length === 0) return [];

  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  const effectiveConcurrency = Math.min(concurrency, items.length);

  let nextIndex = 0;

  // Each worker pulls the next available index and runs fn until exhausted.
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        const value = await fn(items[i], i);
        results[i] = { status: 'fulfilled', value };
      } catch (err) {
        results[i] = { status: 'rejected', reason: err };
      }
    }
  }

  const workers = Array.from({ length: effectiveConcurrency }, () => worker());
  await Promise.all(workers);
  return results;
}
