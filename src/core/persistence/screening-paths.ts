import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * One screening batch's memo of root-level filesystem facts (GBRA-75 wave 7).
 *
 * A managed import or sync screens each file of a batch through the same path
 * guards, and those guards resolve the same registered roots for every file:
 * the realpath of each other source's root, the canonical path of each shared
 * skillpack root, the Git scope of the source root. Inside `withScreeningPaths`
 * the guards resolve each such root once; per-file paths (the input, the target,
 * the page's own candidate files) are never memoized, so a file that moves or
 * turns into a symlink is still caught on its own check.
 *
 * The memo only lives while `run` is pending: work that outlives it (a consumer
 * loop started from inside, a later publication) computes everything fresh,
 * and a compute that throws is never memoized.
 */
interface ScreeningPaths { memo: Map<string, unknown>; open: boolean }
const scope = new AsyncLocalStorage<ScreeningPaths>();

/** A nested call joins the open batch it runs in. */
export async function withScreeningPaths<T>(run: () => Promise<T>): Promise<T> {
  if (scope.getStore()?.open) return run();
  const current: ScreeningPaths = { memo: new Map(), open: true };
  try { return await scope.run(current, run); } finally { current.open = false; current.memo.clear(); }
}

/** `compute()` once per open screening batch for `key`; outside a batch, every call computes. */
export function screeningPath<T>(key: string, compute: () => T): T {
  const current = scope.getStore();
  if (!current?.open) return compute();
  if (current.memo.has(key)) return current.memo.get(key) as T;
  const value = compute();
  current.memo.set(key, value);
  return value;
}
