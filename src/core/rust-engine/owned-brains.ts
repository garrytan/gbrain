/**
 * The Rust brains this process owns (it holds the store's owner lock), by resolved store path, with the time the
 * process took the owner role. `electOwner` (owner-ipc/election.ts) records each owner lock it takes; a released lock
 * no longer counts, so a disconnected engine stops naming itself without a forget call. Readiness reads it to name the
 * process's own `gbrain serve` as the lock owner of a Rust brain (readiness.ts `lockOwnerFor`), as PGLite reads its
 * held lock (`heldLockFor`).
 *
 * Synchronous and in-process only: it never reads another process's state, so readiness never names another
 * process's pid for a Rust brain (TODOS.md, "async Rust owner read"). This is the only registry of owned Rust brains.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NativeLockHandle } from '../persistence/native-lock.ts';

const owned = new Map<string, Array<{ lock: NativeLockHandle; acquiredAt: number }>>();

function keyOf(path: string): string {
  const full = resolve(path);
  try { return realpathSync(full); } catch { return full; }
}

/** Records that this process took the owner lock of the Rust brain at `path`, from now. */
export function recordOwnedRustBrain(path: string, lock: NativeLockHandle): void {
  const key = keyOf(path);
  const held = (owned.get(key) ?? []).filter(entry => !entry.lock.released);
  held.push({ lock, acquiredAt: Date.now() });
  owned.set(key, held);
}

/** When this process still holds the owner lock of the Rust brain at `path`: the time it took the owner role (the earliest live one). Null otherwise. */
export function ownedRustBrain(path: string | undefined): { acquiredAt: number } | null {
  if (!path) return null;
  const key = keyOf(path);
  const held = (owned.get(key) ?? []).filter(entry => !entry.lock.released);
  if (held.length === 0) { owned.delete(key); return null; }
  owned.set(key, held);
  return { acquiredAt: held[0]!.acquiredAt };
}
