/**
 * `transaction(fn, { signal })` on Postgres: aborting the signal discards the
 * transaction's connection.
 *
 * postgres.js gives every `begin()` callback a handle whose `discard()` (the
 * vendored #5466/#5560 hunk, `sql.discard = reservation.discard` in
 * vendor/postgres/src/index.js) rejects the reservation's queue with
 * `CONNECTION_CLOSED`, drops the reservation and terminates the socket. The
 * server sees the socket close and rolls the open transaction back on its
 * own, directly or behind a transaction-mode pooler, so no `pg_cancel_backend`
 * round trip is needed and nothing half-committed survives; the pool
 * reconnects on its next checkout. An abort that lands while `BEGIN` is still
 * on the wire is applied as soon as the handle exists. One that lands after
 * `COMMIT` returned finds no owned reservation and is a no-op in the driver.
 */
export interface Discardable { discard?: () => void }

/** The rejection for an aborted transaction: an `AbortError` carrying the signal's reason and the driver error that ended it. */
export function transactionAborted(signal: AbortSignal, cause?: unknown): Error {
  const reason = signal.reason;
  const error = new DOMException(reason instanceof Error ? reason.message : 'transaction aborted', 'AbortError');
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause, configurable: true, writable: true });
  return error;
}

/**
 * Runs `run`, whose `attach` callback hands over the transaction handle once
 * `begin()` has produced it. While `signal` is live, an abort discards the
 * attached handle; a rejection that follows an abort is rethrown as
 * `transactionAborted(signal, error)`.
 */
export async function withTransactionAbort<T>(signal: AbortSignal | undefined, run: (attach: (handle: Discardable) => void) => Promise<T>): Promise<T> {
  if (!signal) return run(() => {});
  let handle: Discardable | null = null;
  const onAbort = () => { handle?.discard?.(); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await run(h => {
      handle = h;
      if (signal.aborted) onAbort();
    });
  } catch (error) {
    if (signal.aborted) throw transactionAborted(signal, error);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
