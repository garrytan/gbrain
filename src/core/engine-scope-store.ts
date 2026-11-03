/**
 * The store engine-scope.ts reads, and the local scope the CLI, gbrain serve and the jobs worker enter at their entry
 * points. A leaf (no imports beyond node), so the CLI entry pays nothing to enter it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const engineScopeStore = new AsyncLocalStorage<object>();

const LOCAL = Object.freeze({});

/** Runs `fn` as a call that belongs to no embedded engine: its AI calls use the process gateway, as before embedded engines existed. */
export function withLocalScope<T>(fn: () => T): T {
  return engineScopeStore.run(LOCAL, fn);
}
