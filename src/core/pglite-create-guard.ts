/**
 * The one check `acquireLock` (src/core/pglite-lock.ts) runs on a persistent datastore once it holds the kernel lock and
 * before it creates the data dir or any metadata. A throw releases the lock and reaches the caller. Doctor installs it so
 * a datastore that went missing while it waited for the lock is refused instead of built empty
 * (src/commands/doctor/missing-brain.ts). One slot, not a registry: only one doctor runs per process.
 */
export type PgliteCreateGuard = (canonicalDataDir: string) => void;

let installed: PgliteCreateGuard | null = null;

/** Install the guard for the rest of this run; the returned function removes it (and only it). */
export function installPgliteCreateGuard(guard: PgliteCreateGuard): () => void {
  installed = guard;
  return () => { if (installed === guard) installed = null; };
}

/** Called by `acquireLock` under the held lock, before anything is created. */
export function runPgliteCreateGuard(canonicalDataDir: string): void {
  installed?.(canonicalDataDir);
}
