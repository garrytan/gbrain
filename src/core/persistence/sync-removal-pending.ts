/**
 * LC-1 (decision E1): the paths a committed-mode stamp settled `deleted_same` only because a person's delete removed the
 * file and the removal is not committed yet (the file is gone from disk, or differs there, while the commit still holds it).
 * Restoring the file (`git checkout -- <path>`) moves neither HEAD nor a request, so the idle check would never read the
 * path again and the restore would never be held for the file-drift consent step. The stamp records each such path with
 * its disk stat (`PassConverged.removal_pending`), and the idle check re-stats them: a changed stat runs the pass.
 */

/** At most this many paths are recorded; more and the stamp records null, which is never idle. */
export const REMOVAL_PENDING_CAP = 256;

export type RemovalPending = Array<{ path: string; stat: string }> | null;

interface PendingEntry {
  path: string;
  state: { removedFile?: true; dirty: string | null };
  result: { cls: string };
}

const CLEAN_DIRTINESS = new Set<string | null>(['clean', 'clean_eol', 'clean_lfs', 'unknown']);

/** A working-tree file's stat (a stat key, `absent` or `unreadable`); the caller owns the filesystem read. */
export type StatFile = (path: string) => string;

/**
 * The level's `removalPending` field: the removal-pending paths of a committed-mode level, absent when there are none.
 * `observed` holds each probed path's stat from before its dirtiness probe read it: a path whose stat moved since (a restore
 * while the pass ran) records `raced`, which no stat matches, so the next sync reads it again instead of going idle.
 */
export function removalPendingField(mode: 'committed' | 'working', entries: Iterable<PendingEntry>, stat: StatFile,
  observed?: ReadonlyMap<string, string>): { removalPending?: RemovalPending } {
  const pending = removalPending(mode, entries, stat, observed);
  return pending !== undefined ? { removalPending: pending } : {};
}

function removalPending(mode: 'committed' | 'working', entries: Iterable<PendingEntry>, stat: StatFile,
  observed: ReadonlyMap<string, string> | undefined): RemovalPending | undefined {
  if (mode !== 'committed') return undefined;
  const pending: Array<{ path: string; stat: string }> = [];
  for (const entry of entries) {
    if (entry.result.cls !== 'deleted_same' || entry.state.removedFile !== true || CLEAN_DIRTINESS.has(entry.state.dirty)) continue;
    if (pending.length >= REMOVAL_PENDING_CAP) return null;
    // A staged removal can be undone in the index alone (`git restore --staged`), which leaves the disk stat as it was: such a
    // path records `staged`, which no stat matches, so the stamp is never idle until the pass reads the path again.
    const now = entry.state.dirty === 'staged' ? 'staged' : stat(entry.path), seen = observed?.get(entry.path);
    pending.push({ path: entry.path, stat: now !== 'staged' && seen !== undefined && seen !== now ? 'raced' : now });
  }
  return pending.length ? pending : undefined;
}

/** Whether a recorded removal-pending path changed on disk since the stamp (null, the overflowed set, and an `unreadable` stat always count). */
export function removalPendingChanged(pending: RemovalPending | undefined, stat: StatFile): boolean {
  if (pending === undefined) return false;
  if (pending === null) return true;
  return pending.some(entry => entry.stat === 'unreadable' || stat(entry.path) !== entry.stat);
}
