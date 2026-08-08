/**
 * pglite-leftovers-check — detect abandoned PGLite stores after an engine
 * migration (#3856).
 *
 * A pglite -> postgres migration leaves BOTH `brain.pglite/` (the old engine's
 * store) and `brain.pglite.pre-migrate-<date>/` (the safety copy the migration
 * takes first) under the gbrain home, untouched, forever. Together they weigh
 * roughly 2x the live DB, nothing ever surfaces them, and they silently ride
 * along in any backup that archives the gbrain home — the reporting brain paid
 * to permanently archive a dead engine's corpse on Arweave for 2.5 months
 * (898 MB -> 459 MB snapshot, ~half the monthly cost, once excluded by hand).
 *
 * Pure assessment helpers (filesystem-only, no network, no shelling out) so
 * `gbrain doctor` can warn with receipts, in the same shape as
 * npm-squat-check.ts (#505). The caller supplies the engine kind — which MUST
 * come from the DURABLE file config, not the resolved/env-overridden one: a
 * transient `DATABASE_URL` (#427) can make a live PGLite brain look like
 * postgres for one process, and deletion advice must never rest on that.
 *
 * Scope is deliberately the migration's own artifacts only: `brain.pglite`
 * and `brain.pglite.pre-migrate-<suffix>`. Other `brain.pglite.*` siblings
 * (hand-made `.bak` copies etc.) have unknown provenance and are NOT claimed.
 *
 * Deliberately warn-only with a MANUAL remediation: deciding when a
 * pre-migration copy is safe to drop is a policy question (#3856 ask 2) — this
 * check only makes the corpse visible, it never deletes anything. The
 * remediation text names no CLI command that does not exist (#3697).
 */
import { lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';

export interface PgliteLeftoverDir {
  path: string;
  /** Bytes summed over a bounded, symlink-free walk — a floor when size_incomplete. */
  approx_bytes: number;
  /** True when the walk hit its budget OR any entry was unreadable — approx_bytes is then a floor. */
  size_incomplete: boolean;
  /** The directory inode's own mtime (ISO) — labeled as such in the message: file
   *  contents can change without touching the parent dir's mtime. */
  dir_mtime: string | null;
}

export interface PgliteLeftoversAssessment {
  status: 'ok' | 'warn' | 'skip';
  message: string;
  leftovers: PgliteLeftoverDir[];
}

/**
 * Bound on how many directory entries the size walk visits across the WHOLE
 * assessment (all leftover dirs share one budget). A PGLite store is a modest
 * number of large files, so real stores finish well under this; the cap exists
 * so a pathological tree cannot stall doctor's synchronous path.
 */
export const SIZE_WALK_MAX_ENTRIES = 20_000;

/** True only for the migration's own artifacts: the old store itself and the
 *  migration's pre-migrate safety copies. Other `brain.pglite.*` siblings
 *  (hand-made backups etc.) have unknown provenance and are out of scope. */
export function isMigrationLeftoverName(name: string): boolean {
  return name === 'brain.pglite' || name.startsWith('brain.pglite.pre-migrate-');
}

/** Iterative, symlink-free size walk. Shares `budget` across calls; flags
 *  incompleteness on budget exhaustion AND on any unreadable entry (an
 *  unreadable multi-GB store must never be reported as exactly 0 B). */
function walkSize(root: string, budget: { entries: number }): { bytes: number; incomplete: boolean } {
  let bytes = 0;
  let incomplete = false;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let handle: ReturnType<typeof opendirSync>;
    try {
      handle = opendirSync(dir);
    } catch {
      incomplete = true;
      continue;
    }
    try {
      for (;;) {
        if (budget.entries <= 0) {
          incomplete = true;
          break;
        }
        let entry: ReturnType<typeof handle.readSync>;
        try {
          entry = handle.readSync();
        } catch {
          // opendirSync can succeed on a dir whose entries we cannot read
          // (mode 000) — the EACCES surfaces here, not at open (measured).
          incomplete = true;
          break;
        }
        if (entry === null) break;
        budget.entries--;
        const p = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue; // never follow — the walk must not escape the store
        if (entry.isDirectory()) {
          stack.push(p);
        } else if (entry.isFile()) {
          try {
            bytes += lstatSync(p).size;
          } catch {
            incomplete = true;
          }
        }
      }
    } finally {
      try {
        handle.closeSync();
      } catch {
        // already closed / racing unlink — nothing to do
      }
    }
    if (budget.entries <= 0 && stack.length > 0) {
      incomplete = true;
      break;
    }
  }
  return { bytes, incomplete };
}

/** Human-readable size. For floors (incomplete walks) the value is rounded
 *  DOWN, so ">= 1.6 MB" can never display as ">= 2 MB". */
function humanBytes(n: number, floor: boolean): string {
  const fmt = (v: number, digits: number) => (floor ? Math.floor(v * 10 ** digits) / 10 ** digits : v).toFixed(digits);
  if (n >= 1024 ** 3) return `${fmt(n / 1024 ** 3, 1)} GB`;
  if (n >= 1024 ** 2) return `${fmt(n / 1024 ** 2, 0)} MB`;
  if (n >= 1024) return `${fmt(n / 1024, 0)} KB`;
  return `${n} B`;
}

/**
 * Assess a gbrain home for abandoned PGLite migration leftovers.
 *
 * - engine `postgres` is the ONLY value that can warn: that is the migration
 *   target #3856 documents, and the one case where `brain.pglite` is known
 *   dead weight. `pglite` means the store is live; anything else (missing /
 *   unreadable / future engines) skips — deletion advice must fail open.
 * - postgres + no leftover dirs -> `ok`.
 * - postgres + leftovers -> `warn`, naming each dir with a floor-marked
 *   approximate size and its directory mtime.
 *
 * `engineKind` must be the DURABLE file-config engine (see file header).
 * `maxEntries` exists for tests; production callers use the default.
 */
export function assessPgliteLeftovers(
  engineKind: string | null | undefined,
  gbrainHome: string,
  maxEntries: number = SIZE_WALK_MAX_ENTRIES,
): PgliteLeftoversAssessment {
  if (engineKind !== 'postgres') {
    return { status: 'skip', message: '', leftovers: [] };
  }
  let names: string[] = [];
  const budget = { entries: maxEntries };
  try {
    const handle = opendirSync(gbrainHome);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (entry === null) break;
        // Top-level symlinks are skipped too: a symlinked brain.pglite is not
        // a store this check can claim ownership of.
        if (entry.isDirectory() && !entry.isSymbolicLink() && isMigrationLeftoverName(entry.name)) {
          names.push(entry.name);
        }
      }
    } finally {
      handle.closeSync();
    }
  } catch {
    return { status: 'skip', message: '', leftovers: [] };
  }
  const leftovers: PgliteLeftoverDir[] = [];
  for (const name of names.sort()) {
    const p = join(gbrainHome, name);
    let mtime: string | null = null;
    try {
      const st = lstatSync(p);
      mtime = st.mtime ? st.mtime.toISOString() : null;
    } catch {
      // stat raced a concurrent delete — still report the dir, without a date
    }
    const { bytes, incomplete } = walkSize(p, budget);
    leftovers.push({ path: p, approx_bytes: bytes, size_incomplete: incomplete, dir_mtime: mtime });
  }
  if (leftovers.length === 0) {
    return {
      status: 'ok',
      message: 'No abandoned PGLite store under the gbrain home (engine: postgres).',
      leftovers,
    };
  }
  const total = leftovers.reduce((s, l) => s + l.approx_bytes, 0);
  const anyIncomplete = leftovers.some((l) => l.size_incomplete);
  const listing = leftovers
    .map(
      (l) =>
        `${l.path} (${l.size_incomplete ? '>=' : ''}${humanBytes(l.approx_bytes, l.size_incomplete)}` +
        `${l.dir_mtime ? `, dir mtime ${l.dir_mtime.slice(0, 10)}` : ''})`,
    )
    .join('; ');
  return {
    status: 'warn',
    message:
      `Engine is postgres, but ${leftovers.length} PGLite store dir(s) from the migration remain: ${listing} — ` +
      `${anyIncomplete ? 'at least ' : ''}${humanBytes(total, anyIncomplete)} of reclaimable disk. ` +
      `They also inflate any backup that archives the gbrain home. Your live data is in the postgres ` +
      `engine; once you have verified that (a recent restore or backup of it), these dirs are safe to ` +
      `delete by hand — gbrain never deletes them for you.`,
    leftovers,
  };
}
