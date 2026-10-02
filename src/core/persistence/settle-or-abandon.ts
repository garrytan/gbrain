/**
 * Bound a follow-up wait that must not pin the event loop.
 *
 * The losing promise is still observed: a rejection that arrives after the
 * deadline is swallowed here so it cannot surface as `unhandledRejection`
 * (which, on hosted HTTP, exits the process). The caller treats
 * `AbandonedError` as fail-open. This does not cancel the underlying
 * query or release a pool client; the driver still owns that connection
 * until the query settles. Use it only for work that already has its own
 * abort, or for a follow-up that is safe to drop (the claim lease expires).
 */
export class AbandonedError extends Error {
  readonly abandoned = true;
  constructor(readonly ms: number) {
    super(`abandoned after ${ms}ms`);
    this.name = 'AbandonedError';
  }
}

export function settleOrAbandon<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      settled = true;
      reject(new AbandonedError(ms));
    }, ms);
    timer.unref?.();
    work.then(
      (value) => { if (!settled) resolve(value); },
      (error: unknown) => { if (!settled) reject(error); },
    );
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
