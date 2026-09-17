/** Evaluation-only concurrent dispatch with a single atomic document/quota allocator. */
import type { RerankInput, RerankResult } from '../../src/core/ai/gateway.ts';
import type { RerankBatchPlan } from './rerank-batch-plan.ts';

export interface RerankReservation {
  plan: RerankBatchPlan;
  waitMs: number;
  settle(): void;
}

export async function rerankConcurrentPool(input: RerankInput & { documents: string[] }, concurrency: number,
  acquire: (offset: number, signal: AbortSignal) => Promise<RerankReservation>,
  call: (input: RerankInput, plan: RerankBatchPlan, batch: number, waitMs: number) => Promise<RerankResult[]>) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('Invalid reranking concurrency');
  const abort = new AbortController();
  const running = new Set<Promise<void>>();
  const ranked: RerankResult[] = [];
  const intervals: Array<[number, number]> = [];
  let offset = 0, batch = 0, wallStart: number | null = null, failure: unknown;
  try {
    while (offset < input.documents.length && !abort.signal.aborted) {
      if (running.size >= concurrency) await Promise.race(running);
      if (abort.signal.aborted) break;
      const reservation = await acquire(offset, abort.signal);
      const plan = reservation.plan;
      if (abort.signal.aborted) break;
      if (plan.offset !== offset || !Number.isSafeInteger(plan.count) || plan.count < 1 || offset + plan.count > input.documents.length) {
        throw new Error('Invalid reranking batch coverage');
      }
      offset += plan.count;
      const number = ++batch;
      const start = performance.now();
      wallStart ??= start;
      const documents = input.documents.slice(plan.offset, plan.offset + plan.count);
      // Invoke immediately: context and start order do not depend on completion order.
      const task = (async () => {
        try {
          const chunk = await call({ ...input, documents }, plan, number, reservation.waitMs);
          if (chunk.length !== documents.length || new Set(chunk.map(row => row.index)).size !== chunk.length ||
              chunk.some(row => !Number.isInteger(row.index) || row.index < 0 || row.index >= documents.length || !Number.isFinite(row.relevanceScore))) {
            throw new Error('Incomplete reranking response');
          }
          ranked.push(...chunk.map(row => ({ ...row, index: plan.offset + row.index })));
        } catch (error) {
          if (!abort.signal.aborted) failure = error;
          abort.abort();
        } finally {
          intervals.push([start, performance.now()]);
          reservation.settle();
        }
      })();
      running.add(task);
      void task.then(() => running.delete(task));
    }
  } catch (error) {
    failure ??= error;
    abort.abort();
  } finally {
    // Preserve usage from every started call, including after another batch fails.
    await Promise.all(running);
  }
  if (failure) throw failure;
  if (ranked.length !== input.documents.length) throw new Error('Incomplete reranking batch coverage');
  const mergeStart = performance.now();
  ranked.sort((a, b) => b.relevanceScore - a.relevanceScore || a.index - b.index);
  const end = performance.now();
  intervals.sort((a, b) => a[0] - b[0]);
  let activeMs = end - mergeStart, lastEnd = -Infinity;
  for (const [start, finish] of intervals) {
    activeMs += Math.max(0, finish - Math.max(start, lastEnd));
    lastEnd = Math.max(lastEnd, finish);
  }
  const wallMs = wallStart === null ? activeMs : end - wallStart;
  return { ranked, activeMs, wallMs, quotaWaitMs: Math.max(0, wallMs - activeMs) };
}
