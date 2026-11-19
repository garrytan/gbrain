/**
 * The Rust brains this process owns. election.ts records each owner lock it takes; the config plane
 * (readiness.ts `lockOwnerFor`) reads this synchronously, since it cannot ask an owner socket. A released
 * lock no longer counts. Another process's owner is not named here: only its socket's hello carries its pid.
 */
import { resolve } from 'node:path';
import type { NativeLockHandle } from '../../persistence/native-lock.ts';

const owned = new Map<string, { lock: NativeLockHandle; acquiredAt: number }>();

/** Records that this process took the owner lock of the Rust brain at `databasePath`. */
export function recordOwnedBrain(databasePath: string, lock: NativeLockHandle): void {
  owned.set(resolve(databasePath), { lock, acquiredAt: Date.now() });
}

/** When this process still holds the owner lock of the Rust brain at `databasePath`, when it took it. */
export function ownedBrainFor(databasePath: string): { acquiredAt: number } | null {
  const key = resolve(databasePath);
  const entry = owned.get(key);
  if (!entry) return null;
  if (entry.lock.released) { owned.delete(key); return null; }
  return { acquiredAt: entry.acquiredAt };
}
