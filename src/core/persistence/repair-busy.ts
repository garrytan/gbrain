/**
 * #6278: which paths and slugs of a managed source a repair must not write
 * right now, so `gbrain repair fences` (and the managed file repair
 * admission under it and under `gbrain repair frontmatter`) runs during a
 * sync for every other candidate instead of skipping the whole source while
 * a managed sync cursor is unfinished.
 *
 * Busy (`sync_in_progress` for that candidate):
 *   - every request of the source that is queued, running or recovering, or
 *     terminal with an open recovery: its slug, path, origin path and both
 *     endpoints of a rename;
 *   - every entry at or after the index of each unfinished managed sync
 *     cursor of the source's current incarnation, read from the run's frozen
 *     manifest: the sync admits those entries later with the raw hash it
 *     reads then, and a repair that changed the bytes in between would make
 *     the entry refuse on it (`source_changed`); a held path is left out,
 *     because the sync does not retry a held entry until its bytes change,
 *     and a repair that changes them is exactly what makes the next sync
 *     re-screen it.
 *
 * #6712 PR 4b (design v3.2 §3.7, CEO N4): a non-company source's pass adds
 * nothing here. A pass freezes and admits under the drain lease and its
 * freeze re-checks each candidate's revision, so busy means its open
 * requests (the first arm) only; the cursor arm stays for company brains and
 * for a legacy cursor the first pass has not retired yet.
 *
 * The read fails closed: a query that throws, or an unfinished cursor whose
 * manifest cannot be read, makes every candidate busy (`unknown` names why).
 * Callers check once when they plan and again at coordinated admission of
 * the write, because a new sync can freeze a candidate while a repair waits
 * on its model call.
 */
import type { BrainEngine } from '../engine.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';

export interface RepairBusySet {
  paths: Set<string>;
  slugs: Set<string>;
  /** Set when the busy set could not be read; then every candidate is busy. */
  unknown: string | null;
}

interface ManifestEntry { path?: string; sourcePath?: string; slug?: string; renameFrom?: { sourcePath?: string; slug?: string } }

const MANIFEST_OP = 'managed-sync-manifest';

const BUSY_UNINFORMED = (why: string) => `the busy set could not be read (${why}), so every candidate of the source is treated as in flight`;

/** The busy set of one source incarnation; never throws. */
export async function loadRepairBusySet(engine: BrainEngine, sourceId: string, incarnation: string): Promise<RepairBusySet> {
  const paths = new Set<string>(), slugs = new Set<string>();
  const add = (path: string | null | undefined, slug?: string | null) => { if (path) paths.add(path); if (slug) slugs.add(slug); };
  try {
    const { pending, cursors, held: heldPaths } = await engine.readRepairBusyRows(sourceId, incarnation);
    for (const row of pending) { add(row.path, row.slug); add(row.source_path); add(row.rename_source_path, row.rename_slug); }
    if (!cursors.length) return { paths, slugs, unknown: null };
    const held = new Set(heldPaths);
    for (const cursor of cursors) {
      const record = cursor.run_id ? await engine.readOpCheckpointRecord(MANIFEST_OP, cursor.run_id) : null;
      const manifest = record ? { entries: record.completed_keys as ManifestEntry[] | null } : undefined;
      if (!Array.isArray(manifest?.entries)) return { paths, slugs, unknown: BUSY_UNINFORMED(`the manifest of sync run ${cursor.run_id ?? '<unknown>'} is missing`) };
      const from = Math.max(0, Math.trunc(Number(cursor.index ?? 0)) || 0);
      for (const entry of manifest.entries.slice(from)) {
        if (entry.path && held.has(entry.path)) continue;
        add(entry.path, entry.slug); add(entry.sourcePath); add(entry.renameFrom?.sourcePath, entry.renameFrom?.slug);
      }
    }
    return { paths, slugs, unknown: null };
  } catch (error) {
    return { paths, slugs, unknown: BUSY_UNINFORMED(error instanceof Error ? error.message : String(error)) };
  }
}

/** Whether a candidate (by path, origin path or slug) is busy; always true while the set is unknown. */
export function repairBusy(busy: RepairBusySet, candidate: { path?: string | null; sourcePath?: string | null; slug?: string | null }): boolean {
  if (busy.unknown !== null) return true;
  return (!!candidate.path && busy.paths.has(candidate.path)) || (!!candidate.sourcePath && busy.paths.has(candidate.sourcePath)) || (!!candidate.slug && busy.slugs.has(candidate.slug));
}

/** The `sync_in_progress` message for one busy candidate: what names it and when the next run picks it up. */
export function repairBusyMessage(busy: RepairBusySet, sourceId: string, what: string): string {
  if (busy.unknown !== null) return `${what} was not repaired: ${busy.unknown}. The next run reads it again.`;
  return `A running sync of ${sourceId}, or a write still in flight, names ${what}; finish the sync (gbrain sync --source ${sourceId} --no-pull) and the next run repairs it.`;
}

/** The refusal a coordinated repair admission raises when its candidate became busy after the plan read it. */
export function repairBusyError(busy: RepairBusySet, sourceId: string, path: string): OperationError {
  return opError('sync_in_progress', `${path} is named by a sync or write of ${sourceId} that started after this repair was planned, so nothing was written.`,
    `${repairBusyMessage(busy, sourceId, path)} Check the source with the command in fix; the repair is read again on the next run.`,
    { reason: busy.unknown !== null ? 'busy_set_unreadable' : 'candidate_in_flight',
      fix: readFix('Shows the sync cursors and in-flight writes of the source, read-only.', { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] }) });
}
