/** Evaluation-only rolling request/token window; reservations settle to native usage. */
import type { RerankBatchPlan } from './rerank-batch-plan.ts';

export function createRerankQuota(rpm: number, tpm: number,
  now = () => performance.now(), sleep?: (ms: number) => Promise<void>,
  windowMs = 61_000) {
  if (![rpm, tpm, windowMs].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Invalid reranking quota');
  }
  const entries: Array<{ started: number; tokens: number; pending: boolean }> = [];
  const waiters = new Set<() => void>();
  const wake = () => { for (const notify of [...waiters]) notify(); };
  const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (aborted = false) => {
      if (timer !== undefined) clearTimeout(timer);
      waiters.delete(notify);
      signal?.removeEventListener('abort', abort);
      if (aborted) reject(new Error('Reranking quota wait aborted')); else resolve();
    };
    const notify = () => finish();
    const abort = () => finish(true);
    waiters.add(notify);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    if (sleep) void sleep(ms).then(notify, () => finish(true));
    else timer = setTimeout(notify, ms);
  });
  return {
    async idle() {
      while (entries.length) {
        const current = now();
        while (entries.length && entries[0]!.started + windowMs <= current) entries.shift();
        if (!entries.length) break;
        await wait(Math.min(60_000, Math.max(1, entries[entries.length - 1]!.started + windowMs - current)));
      }
    },
    async acquire(offset: number, pairTokens: number[], maxInputTokens: number, maxDocuments: number, signal?: AbortSignal,
      minConcurrentInputTokens = 0) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= pairTokens.length ||
          pairTokens.some(tokens => !Number.isSafeInteger(tokens) || tokens < 0 || tokens > Math.min(tpm, maxInputTokens)) ||
          !Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0 ||
          !Number.isSafeInteger(maxDocuments) || maxDocuments <= 0 ||
          !Number.isSafeInteger(minConcurrentInputTokens) || minConcurrentInputTokens < 0 || minConcurrentInputTokens > Math.min(tpm, maxInputTokens)) {
        throw new Error('Evidence exceeds the reranking quota budget');
      }
      const waitStart = now();
      for (;;) {
        if (signal?.aborted) throw new Error('Reranking quota wait aborted');
        const current = now();
        while (entries.length && entries[0]!.started + windowMs <= current) entries.shift();
        const remaining = tpm - entries.reduce((sum, entry) => sum + entry.tokens, 0);
        if (entries.length < rpm && remaining >= pairTokens[offset]!) {
          let count = 0, inputTokens = 0;
          const budget = Math.min(maxInputTokens, remaining);
          while (offset + count < pairTokens.length && count < maxDocuments &&
                 inputTokens + pairTokens[offset + count]! <= budget) {
            inputTokens += pairTokens[offset + count]!; count++;
          }
          // Avoid spending a scarce RPM slot on a tiny tail while an earlier
          // reservation can settle and permit a larger useful batch. Finishing
          // the whole pool is always useful, regardless of batch size.
          if (inputTokens < minConcurrentInputTokens && offset + count < pairTokens.length && entries.some(entry => entry.pending)) {
            await wait(Math.min(60_000, Math.max(1, entries[0]!.started + windowMs - current)), signal);
            continue;
          }
          const entry = { started: current, tokens: inputTokens, pending: true };
          entries.push(entry);
          return { plan: { offset, count, inputTokens } satisfies RerankBatchPlan,
            waitMs: now() - waitStart,
            settle(tokens: number | null) {
              if (tokens !== null && Number.isSafeInteger(tokens) && tokens >= 0) entry.tokens = tokens;
              entry.pending = false;
              wake();
            } };
        }
        // Usage settlement can release token capacity before the rolling window expires.
        await wait(Math.min(60_000, Math.max(1, entries[0]!.started + windowMs - current)), signal);
      }
    },
  };
}
