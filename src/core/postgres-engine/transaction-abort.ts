/**
 * `transaction(fn, { signal })` on Postgres: aborting the signal cancels the
 * transaction's running statement, then discards its connection.
 *
 * postgres.js gives every `begin()` callback a handle whose `discard()` (the
 * vendored #5466/#5560 hunk, `sql.discard = reservation.discard` in
 * vendor/postgres/src/index.js) rejects the reservation's queue with
 * `CONNECTION_CLOSED`, drops the reservation and terminates the socket. A
 * Terminate on a busy socket does not stop the statement already running on
 * the backend, so a discard alone can leave it holding locks until its
 * statement timeout (#6598). The handle's `cancelAndDiscard()` (#6598 hunk)
 * sends the fenced statement's CancelRequest first, keeps the reservation
 * closed to successors until the statement settles, then discards; it rejects
 * `CANCEL_UNCONFIRMED` when the statement does not settle inside the settle
 * window (or ran without a cancel fence), and that rejection rides on the
 * abort as `cancelFailure`. `cause` stays the driver error the transaction
 * itself ended with, which callers classify for retry. The server rolls the
 * open transaction back when the socket closes, directly or behind a
 * transaction-mode pooler; the pool reconnects on its next checkout. An abort
 * that lands while `BEGIN` is still on the wire is applied as soon as the
 * handle exists. One that lands after `COMMIT` returned finds no owned
 * reservation, is a no-op in the driver, and keeps the committed result.
 */
export interface Discardable {
  discard?: () => void;
  cancelAndDiscard?: (opts?: { timeout?: number }) => Promise<void>;
}

/**
 * The rejection for an aborted transaction: an `AbortError` carrying the
 * signal's reason, the driver error that ended it (`cause`) and, when the
 * running statement's cancellation could not be confirmed, that failure
 * (`cancelFailure`).
 */
export function transactionAborted(signal: AbortSignal, cause?: unknown, cancelFailure?: unknown): Error {
  const reason = signal.reason;
  const error = new DOMException(reason instanceof Error ? reason.message : 'transaction aborted', 'AbortError');
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause, configurable: true, writable: true });
  if (cancelFailure !== undefined) Object.defineProperty(error, 'cancelFailure', { value: cancelFailure, configurable: true, writable: true, enumerable: true });
  return error;
}

/**
 * Runs `run`, whose `attach` callback hands over the transaction handle once
 * `begin()` has produced it. While `signal` is live, an abort cancels and
 * discards the attached handle (`discard()` alone on a driver without
 * `cancelAndDiscard()`); the helper waits for that to settle before it
 * returns. A rejection that follows an abort is rethrown as
 * `transactionAborted(signal, error, cancelFailure)`.
 */
export async function withTransactionAbort<T>(
  signal: AbortSignal | undefined,
  run: (attach: (handle: Discardable) => void) => Promise<T>,
  opts?: { cancelSettleMs?: number },
): Promise<T> {
  if (!signal) return run(() => {});
  let handle: Discardable | null = null;
  let aborting: Promise<void> | undefined;
  let abortFailure: unknown;
  const onAbort = () => {
    if (!handle || aborting) return;
    try {
      aborting = Promise.resolve(handle.cancelAndDiscard
        ? handle.cancelAndDiscard(opts?.cancelSettleMs === undefined ? undefined : { timeout: opts.cancelSettleMs })
        : handle.discard?.())
        .catch(error => { abortFailure = error; });
    } catch (error) {
      abortFailure = error;
      aborting = Promise.resolve();
    }
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await run(h => {
      handle = h;
      if (signal.aborted) onAbort();
    });
    await aborting;
    return result;
  } catch (error) {
    await aborting;
    if (signal.aborted) throw transactionAborted(signal, error, abortFailure);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
