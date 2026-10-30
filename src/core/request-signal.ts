/**
 * GBRA-156: the abort signal of the request a statement runs for. The warm CLI socket aborts it when its client
 * disconnects before the answer or the request reaches its round-trip cap; the Postgres engine then refuses every
 * later statement of that request and cancels its open read transactions (cancel, then discard the connection), so a
 * request nobody waits for stops holding connections and its serve slot. Work started outside a request (sweeps,
 * writes deferred past the response) runs with no signal.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<AbortSignal | undefined>();

export function withRequestSignal<T>(signal: AbortSignal, fn: () => T): T {
  return store.run(signal, fn);
}

/** Runs `fn` outside any request's signal (work that must outlive the request). */
export function withoutRequestSignal<T>(fn: () => T): T {
  return store.run(undefined, fn);
}

export function requestSignal(): AbortSignal | undefined {
  return store.getStore();
}

/** Throws the request's AbortError when its signal has fired. */
export function throwIfRequestAborted(): void {
  const signal = store.getStore();
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw new DOMException(reason instanceof Error ? reason.message : 'request aborted', 'AbortError');
}
