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
import { parseTimelineEntries, findTimelineSourceDelimiter } from './link-extraction.ts';

const INDEX_NAME = 'idx_timeline_dedup';
// #3737: the dedup tuple keys md5(summary) — the raw summary overflowed the
// btree v4 row cap (~2704 bytes) on long/incompressible summaries and aborted
// every timeline insert for that page. Both engines' insert sites infer
// ON CONFLICT (page_id, date, md5(summary), source) against this shape, so
// the self-heal MUST expect (and rebuild to) the md5 form — an
// EXPECTED_COLUMNS of the raw shape would make this repair revert migration
// v138 on every migrate pass.
const EXPECTED_COLUMNS = ['page_id', 'date', 'md5(summary)', 'source'];

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

/**
 * Parse the column list out of a pg_indexes `indexdef` string.
 *
 * #3737: the column list is the span from the FIRST `(` (the list opener
 * after `USING btree`) to the LAST `)`. The previous `lastIndexOf('(')`
 * pointed INSIDE an expression column — `... (page_id, date, md5(summary),
 * source)` parsed as `['summary']` — so the shape check misread a healthy
 * md5-keyed index as drifted and rebuilt it on every migrate pass. The
 * split is paren-depth-aware so `md5(summary)` (or any future expression
 * with internal commas) stays one entry.
 */
export function parseIndexColumns(indexdef: string): string[] {
  const open = indexdef.indexOf('(');
  const close = indexdef.lastIndexOf(')');
  if (open < 0 || close < 0 || close < open) return [];
  const list = indexdef.slice(open + 1, close);
  const cols: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { cols.push(cur); cur = ''; }
    else cur += ch;
  }
  cols.push(cur);
  return cols
    .map(c => {
      const t = c.trim();
      // Drop any "col DESC"/opclass suffix — but only for plain columns;
      // an expression entry (contains '(') is kept whole.
      return t.includes('(') ? t : t.split(/\s+/)[0];
    })
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
 * Heal the index if it's missing the canonical shape (v138: (page_id, date,
 * md5(summary), source)). Dedupes FIRST — the loose 3-column index let rows
 * differing only by `source` coexist, and `CREATE UNIQUE INDEX` would throw
 * on those collisions otherwise. Keeps the earliest row (min id) of each
 * 4-tuple group (raw-summary grouping is equivalent to md5 grouping —
 * md5-equal ⟺ summary-equal modulo negligible collisions).
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
  // #3737: rebuild to the md5-keyed shape (matches migration v138 + both
  // engines' ON CONFLICT inference) — rebuilding the raw-summary shape here
  // would revert the btree-overflow fix on the next migrate pass.
  await engine.executeRaw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}
       ON timeline_entries(page_id, date, md5(summary), source)`,
  );
  return { repaired: true, before: status.columns, collapsedDuplicates, reason: 'rebuilt' };
}

// ─── #3957 — legacy-row (source='') shape repair ─────────────────────────

export interface LegacyTimelineRepairResult {
  /** Pages that carried at least one legacy (source='') row. */
  pagesScanned: number;
  /** Legacy rows rewritten in place to the split (source, summary) shape. */
  rowsRewritten: number;
  /** Legacy rows deleted because a new-shape duplicate already existed. */
  rowsDeleted: number;
  /** Legacy rows left untouched (no matching bullet in current content). */
  rowsSkipped: number;
}

/**
 * #3957 one-time repair: rewrite legacy DB-path timeline rows to the split
 * (source, summary) shape the post-#3957 parser emits.
 *
 * Pre-#3957, `parseTimelineEntries` (the DB extract / put_page auto-timeline
 * path) emitted no `source` — rows landed with the column default `''` and
 * the UNSPLIT bullet rest as `summary` (`'meeting — Discussed X'`). The
 * parser now splits pipe bullets into (source='meeting', summary=
 * 'Discussed X') and labels the rest 'markdown', so the
 * (page_id, date, md5(summary), source) dedup index can never collapse a
 * re-extraction onto a legacy row — every re-extract would DUPLICATE it.
 *
 * The rewrite is CONTENT-ANCHORED, not a blind string split: for each page
 * carrying legacy rows we re-parse its current content with the NEW parser
 * and rewrite a legacy row ONLY when it provably corresponds to a candidate
 * the next re-extract will emit — either verbatim (dash bullets, no-delimiter
 * pipe bullets, citation rows: same summary, new source label) or via the
 * shared link-aware `Source — Summary` split (pipe bullets). A blind split
 * would corrupt dash-bullet rows whose text contains an interior ` - `.
 * Legacy rows with no matching candidate (content edited/deleted since) are
 * left as-is: a re-extract won't re-emit them, so they can't duplicate.
 *
 * Idempotent (rewritten rows no longer match `source = ''`); same SQL text on
 * both engines. When the new-shape row ALREADY exists (a re-extract duplicated
 * before this repair ran), the legacy row is deleted instead of rewritten.
 */
export async function repairLegacyTimelineSourceRows(
  engine: BrainEngine,
): Promise<LegacyTimelineRepairResult> {
  const result: LegacyTimelineRepairResult = {
    pagesScanned: 0, rowsRewritten: 0, rowsDeleted: 0, rowsSkipped: 0,
  };
  const tbl = await engine.executeRaw<{ reg: string | null }>(
    `SELECT to_regclass('timeline_entries')::text AS reg`,
  );
  if (!tbl[0]?.reg) return result;

  // Soft-deleted pages are skipped: their rows are never re-extracted, so
  // they cannot duplicate — and their content is not authoritative.
  const pageIds = await engine.executeRaw<{ page_id: number }>(
    `SELECT DISTINCT te.page_id
       FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id AND p.deleted_at IS NULL
      WHERE te.source = ''`,
  );
  if (pageIds.length === 0) return result;

  const PAGE_BATCH = 100;
  for (let i = 0; i < pageIds.length; i += PAGE_BATCH) {
    const ids = pageIds.slice(i, i + PAGE_BATCH).map(r => Number(r.page_id));
    const pages = await engine.executeRaw<{
      id: number; compiled_truth: string | null; timeline: string | null;
    }>(
      `SELECT id, compiled_truth, timeline FROM pages WHERE id = ANY($1::int[])`,
      [ids],
    );
    for (const page of pages) {
      result.pagesScanned++;
      // Same content assembly as the DB extract paths (extractStaleFromDB /
      // extractTimelineFromDB): body + timeline column.
      const fullContent = `${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`;
      const byDate = new Map<string, Array<{ source: string; summary: string }>>();
      for (const c of parseTimelineEntries(fullContent)) {
        const list = byDate.get(c.date) ?? [];
        list.push({ source: c.source ?? '', summary: c.summary });
        byDate.set(c.date, list);
      }
      const legacyRows = await engine.executeRaw<{
        id: number; date: string; summary: string;
      }>(
        `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, summary
           FROM timeline_entries WHERE page_id = $1 AND source = ''
          ORDER BY id`,
        [page.id],
      );
      for (const row of legacyRows) {
        const candidates = byDate.get(row.date) ?? [];
        let target: { source: string; summary: string } | null = null;
        // 1. Verbatim: the new parser emits the same summary under a real
        //    source label (dash bullets → 'markdown', citations → label).
        target = candidates.find(c => c.source !== '' && c.summary === row.summary) ?? null;
        // 2. Split: the legacy summary is the UNSPLIT `Source — Summary`
        //    text of a pipe bullet; the shared delimiter finder must yield
        //    exactly the candidate's (source, summary) pair.
        if (!target) {
          const at = findTimelineSourceDelimiter(row.summary);
          if (at >= 0) {
            const pre = row.summary.slice(0, at).trim();
            const post = row.summary.slice(at + 1).trim();
            target = candidates.find(c => c.source === pre && c.summary === post) ?? null;
          }
        }
        if (!target) { result.rowsSkipped++; continue; }
        // A new-shape duplicate may already exist (re-extract ran before this
        // repair): drop the legacy row instead of colliding with the unique
        // (page_id, date, md5(summary), source) index on UPDATE.
        const del = await engine.executeRaw<{ id: number }>(
          `DELETE FROM timeline_entries t
            WHERE t.id = $1
              AND EXISTS (
                SELECT 1 FROM timeline_entries x
                 WHERE x.page_id = t.page_id AND x.date = t.date
                   AND md5(x.summary) = md5($2) AND x.source = $3 AND x.id <> t.id
              )
            RETURNING t.id`,
          [row.id, target.summary, target.source],
        );
        if (del.length > 0) { result.rowsDeleted++; continue; }
        await engine.executeRaw(
          `UPDATE timeline_entries SET source = $2, summary = $3
            WHERE id = $1 AND source = ''`,
          [row.id, target.source, target.summary],
        );
        result.rowsRewritten++;
      }
    }
  }
  return result;
}
