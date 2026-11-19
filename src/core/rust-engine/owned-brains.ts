/**
 * The Rust brains this process owns (it holds the store's owner lock), by resolved store path, with the time the
 * process took the owner role. `RustEngine` records a brain when it opens the store as owner and forgets it on
 * disconnect. Readiness reads it to name the process's own `gbrain serve` as the lock owner of a Rust brain
 * (readiness.ts `lockOwnerFor`), as PGLite reads its held lock (`heldLockFor`).
 *
 * Synchronous and in-process only: it never reads another process's state, so readiness never names another
 * process's pid for a Rust brain (TODOS.md, "async Rust owner read").
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const owned = new Map<string, { acquiredAt: number; count: number }>();

function keyOf(path: string): string {
  const full = resolve(path);
  try { return realpathSync(full); } catch { return full; }
}

/** Records that this process owns the Rust brain at `path`, from now. */
export function recordOwnedRustBrain(path: string): void {
  const key = keyOf(path);
  const held = owned.get(key);
  if (held) held.count++;
  else owned.set(key, { acquiredAt: Date.now(), count: 1 });
}

/** Forgets one ownership of the Rust brain at `path` (the last one removes it). */
export function forgetOwnedRustBrain(path: string): void {
  const key = keyOf(path);
  const held = owned.get(key);
  if (!held) return;
  if (--held.count <= 0) owned.delete(key);
}

/** When this process owns the Rust brain at `path`: the time it took the owner role. Null otherwise. */
export function ownedRustBrain(path: string | undefined): { acquiredAt: number } | null {
  if (!path) return null;
  const held = owned.get(keyOf(path));
  return held ? { acquiredAt: held.acquiredAt } : null;
}
