/**
 * #2038 — idx_timeline_dedup schema-drift self-heal.
 *
 * Migration v102 (`timeline_entries_source_in_dedup`) widens the dedup index
 * from (page_id, date, summary) to (page_id, date, summary, source). It was
 * renumbered from v99 during a master merge, so a brain that ran the OLD v99
 * variant has its version counter stamped PAST v102 while the index stayed
 * 3-column. `runMigrations` then can't see the drift (it early-returns when no
 * version is pending), and every `addTimelineEntry(esBatch)` fails with
 * "no unique or exclusion constraint matching the ON CONFLICT specification"
 * because both insert sites infer on the 4-column tuple — timeline writes
 * silently break brain-wide.
 *
 * The version counter can't detect this, so the repair is keyed off the actual
 * index SHAPE and runs on every migrate pass (including the no-pending path).
 * Idempotent: a no-op when the index is already 4-column.
 */

import type { BrainEngine } from './engine.ts';

const INDEX_NAME = 'idx_timeline_dedup';
const EXPECTED_COLUMNS = ['page_id', 'date', 'summary', 'source'];

export interface TimelineDedupStatus {
  /** The timeline_entries table exists (nothing to repair if not). */
  tablePresent: boolean;
  /** The index exists. */
  indexPresent: boolean;
  /** Indexed columns in order (empty when the index is absent). */
  columns: string[];
  /** Index exists in the wrong (pre-v102) shape — needs a rebuild. */
  needsRepair: boolean;
}

/** Parse the column list out of a pg_indexes `indexdef` string. */
function parseIndexColumns(indexdef: string): string[] {
  const open = indexdef.lastIndexOf('(');
  const close = indexdef.lastIndexOf(')');
  if (open < 0 || close < 0 || close < open) return [];
  return indexdef
    .slice(open + 1, close)
    .split(',')
    .map(c => c.trim().split(/\s+/)[0]) // drop any "col DESC"/opclass suffix
    .filter(Boolean);
}

export async function checkTimelineDedupIndex(engine: BrainEngine): Promise<TimelineDedupStatus> {
  const tbl = await engine.executeRaw<{ reg: string | null }>(
    `SELECT to_regclass('timeline_entries')::text AS reg`,
  );
  const tablePresent = !!tbl[0]?.reg;
  if (!tablePresent) {
    return { tablePresent: false, indexPresent: false, columns: [], needsRepair: false };
  }
  const rows = await engine.executeRaw<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
    [INDEX_NAME],
  );
  const indexPresent = rows.length > 0;
  const columns = indexPresent ? parseIndexColumns(rows[0].indexdef) : [];
  const correct =
    columns.length === EXPECTED_COLUMNS.length &&
    EXPECTED_COLUMNS.every((c, i) => columns[i] === c);
  // An ABSENT index is also "needs repair" — the migration that creates it was
  // skipped. (A fresh brain always has it, created by the migration chain.)
  return { tablePresent, indexPresent, columns, needsRepair: !correct };
}

export interface TimelineDedupRepairResult {
  repaired: boolean;
  before: string[];
  collapsedDuplicates: number;
  reason: 'already_correct' | 'no_table' | 'rebuilt';
}

/**
 * Heal the index if it's missing the v102 4-column shape. Dedupes FIRST —
 * the loose 3-column index let rows differing only by `source` coexist, and
 * `CREATE UNIQUE INDEX` would throw on those collisions otherwise. Keeps the
 * earliest row (min ctid) of each 4-tuple group.
 */
export async function repairTimelineDedupIndex(engine: BrainEngine): Promise<TimelineDedupRepairResult> {
  const status = await checkTimelineDedupIndex(engine);
  if (!status.tablePresent) {
    return { repaired: false, before: [], collapsedDuplicates: 0, reason: 'no_table' };
  }
  if (!status.needsRepair) {
    return { repaired: false, before: status.columns, collapsedDuplicates: 0, reason: 'already_correct' };
  }

  // Keep the lowest `id` per 4-tuple group — deterministic and consistent with
  // the existing v-migration dedup rule (`a.id > b.id`), unlike `ctid` which is
  // a physical tuple location that can preserve an arbitrary duplicate.
  const del = await engine.executeRaw<{ n: string }>(
    `WITH d AS (
       DELETE FROM timeline_entries t
       USING (
         SELECT page_id, date, summary, source, MIN(id) AS keep
           FROM timeline_entries
          GROUP BY page_id, date, summary, source
         HAVING COUNT(*) > 1
       ) dup
       WHERE t.page_id = dup.page_id
         AND t.date = dup.date
         AND t.summary = dup.summary
         AND t.source IS NOT DISTINCT FROM dup.source
         AND t.id <> dup.keep
       RETURNING 1
     )
     SELECT COUNT(*)::text AS n FROM d`,
  );
  const collapsedDuplicates = parseInt(del[0]?.n ?? '0', 10);

  await engine.executeRaw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
  await engine.executeRaw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}
       ON timeline_entries(page_id, date, summary, source)`,
  );
  return { repaired: true, before: status.columns, collapsedDuplicates, reason: 'rebuilt' };
}
