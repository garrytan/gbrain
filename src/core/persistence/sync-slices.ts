/**
 * #6349 (fix wave 15 P4.4): path-sliced staging for a managed sync whose selected entries exceed the cursor bound
 * when no commit staging applies: a first sync (no `last_commit`), a `--full` tree walk, or one commit that alone
 * changes more than the bound. The whole target is discovered every time (origin collisions are screened over the
 * whole set), then cut into slices ordered `(phase, path)`: every import slice first, then bounded deletion slices,
 * each pinned at the same target. The slice cursor `{ phase, after, head, target }` is written by the slice's
 * checkpoint, in the same transaction, instead of `last_commit`, which advances only when the last slice settles.
 * The record is keyed by source, incarnation and the run's cursor-selecting options, so a resumed invocation with
 * other exclusions starts over instead of borrowing a slice cut under different options.
 */
import type { SyncOpts } from '../../commands/sync.ts';
import type { BrainEngine } from '../engine.ts';
import { digest } from './digest.ts';
import type { SyncEntry } from './sync-discovery.ts';
import type { SyncCursorOptions } from './sync-prepare.ts';

type Exec = Pick<BrainEngine, 'executeRaw'>;
export const SYNC_SLICE_OP = 'managed-sync-slice';
export type SyncSlicePhase = 'import' | 'delete';
/** Where the next slice starts: the phase and the last path the previous slice of that phase committed. */
export interface SyncSliceCursor { phase: SyncSlicePhase; after: string | null; head: string; target: string }
/** The slice a discovery produced, carried on the cursor and the checkpoint intent; `done` marks the target's last slice. */
export interface SyncSliceState extends SyncSliceCursor { done: boolean }

/** The cursor-selecting options of a managed run; part of its durable cursor key and of the slice record's key. */
export function syncCursorOptions(opts: SyncOpts): SyncCursorOptions {
  return { full: opts.full ?? false, workingTree: opts.workingTree ?? false, srcSubpath: opts.srcSubpath ?? null,
    exclude: opts.exclude ?? [], includeHidden: opts.includeHidden ?? [], strategy: opts.strategy ?? null };
}
const sliceFingerprint = (sourceId: string, incarnation: string, options: SyncCursorOptions) => `${sourceId}:${incarnation}:${digest(options)}`;

export async function readSyncSlice(engine: Exec, sourceId: string, incarnation: string, options: SyncCursorOptions): Promise<SyncSliceCursor | null> {
  const [row] = await engine.executeRaw<{ record: SyncSliceCursor }>('SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND fingerprint=$2',
    [SYNC_SLICE_OP, sliceFingerprint(sourceId, incarnation, options)]);
  const record = row?.record;
  if (!record || (record.phase !== 'import' && record.phase !== 'delete') || typeof record.target !== 'string' || typeof record.head !== 'string') return null;
  return { phase: record.phase, after: typeof record.after === 'string' ? record.after : null, head: record.head, target: record.target };
}
export async function writeSyncSlice(tx: Exec, sourceId: string, incarnation: string, options: SyncCursorOptions, slice: SyncSliceCursor): Promise<void> {
  await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
  [SYNC_SLICE_OP, sliceFingerprint(sourceId, incarnation, options), JSON.stringify([{ ...slice, recorded_at: new Date().toISOString() }])]);
}
/** `target` (#6834) clears the record only while it still names that target. */
export async function clearSyncSlice(tx: Exec, sourceId: string, incarnation: string, options: SyncCursorOptions, target?: string): Promise<void> {
  await tx.executeRaw("DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND ($3::text IS NULL OR completed_keys->0->>'target'=$3)",
    [SYNC_SLICE_OP, sliceFingerprint(sourceId, incarnation, options), target ?? null]);
}

/** Code-unit order: the cursor's `after` must compare the same way on every host, which `localeCompare` does not promise. */
const byPath = (a: SyncEntry, b: SyncEntry) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * The next slice of `entries` (the whole target, identities resolved): the import phase runs to its end before the
 * first deletion; within a phase, entries after `resume.after` in code-unit path order, the longest prefix the bound
 * admits (at least one entry, so a single oversized entry still refuses through `fits` at the caller). `done` is true
 * when nothing follows the slice in either phase.
 */
export function sliceEntries(entries: readonly SyncEntry[], resume: Pick<SyncSliceCursor, 'phase' | 'after'> | null,
  fits: (entries: readonly SyncEntry[]) => boolean): { entries: SyncEntry[]; phase: SyncSlicePhase; after: string | null; done: boolean } {
  const imports = entries.filter(entry => entry.action === 'import').sort(byPath);
  const deletes = entries.filter(entry => entry.action === 'delete').sort(byPath);
  let phase: SyncSlicePhase = resume?.phase ?? 'import';
  let after = resume?.after ?? null;
  let remaining = (phase === 'import' ? imports : deletes).filter(entry => after === null || entry.path > after);
  if (phase === 'import' && !remaining.length) { phase = 'delete'; after = null; remaining = deletes; }
  // Gallop up, then bisect: `fits` serializes the candidate, so the probes stay logarithmic.
  let good = 0, step = 1;
  while (good < remaining.length) {
    const at = Math.min(good + step, remaining.length);
    if (fits(remaining.slice(0, at))) { good = at; step *= 2; continue; }
    let low = good, high = at;
    while (high - low > 1) { const mid = (low + high) >> 1; if (fits(remaining.slice(0, mid))) low = mid; else high = mid; }
    good = low;
    break;
  }
  const slice = remaining.slice(0, Math.max(good, remaining.length ? 1 : 0));
  const last = slice.at(-1)?.path ?? after;
  const done = slice.length === remaining.length && (phase === 'delete' || !deletes.length);
  return { entries: slice, phase, after: last, done };
}
