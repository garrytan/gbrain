// Schema cathedral v2 — `gbrain schema stats`.
//
// Reports how the brain's actual content maps onto the active pack's
// type system. Single SQL query against pages:
//   SELECT COALESCE(type, '(untyped)') AS type, count(*) AS cnt
//   FROM pages WHERE deleted_at IS NULL
//   GROUP BY type ORDER BY cnt DESC
//
// Output is shaped for both human and machine consumption (matches the
// --json contract used by detect/suggest/review-candidates).

import type { BrainEngine } from '../engine.ts';

export interface StatsOpts {
  /** Restrict the count to a single source_id. Omit to count globally. */
  sourceId?: string;
}

export interface PerTypeCount {
  type: string;
  count: number;
}

export interface StatsResult {
  /** Total page rows considered (deleted_at IS NULL). */
  total_pages: number;
  /** Pages with a non-null, non-empty type. */
  typed_pages: number;
  /** Pages with NULL or '' type. */
  untyped_pages: number;
  /**
   * Coverage = typed_pages / total_pages, rounded to 4 decimals.
   * Reported as 0 when total_pages = 0 to avoid NaN.
   */
  coverage: number;
  /** Per-type count, descending by count. Untyped reported as '(untyped)'. */
  per_type: PerTypeCount[];
  /** Source the count was scoped to, or null for global. */
  source_id: string | null;
}

interface PerTypeRow {
  type: string;
  cnt: string | number;
}

export async function runStats(engine: BrainEngine, opts: StatsOpts = {}): Promise<StatsResult> {
  const sourceId = opts.sourceId ?? null;
  const where = sourceId
    ? `WHERE deleted_at IS NULL AND source_id = $1`
    : `WHERE deleted_at IS NULL`;
  const params = sourceId ? [sourceId] : [];

  const rows = await engine.executeRaw<PerTypeRow>(
    `SELECT COALESCE(NULLIF(type, ''), '(untyped)') AS type, COUNT(*)::text AS cnt
       FROM pages
       ${where}
       GROUP BY 1
       ORDER BY 2 DESC, 1 ASC`,
    params,
  );

  const per_type: PerTypeCount[] = rows.map((r) => ({
    type: r.type,
    count: Number(r.cnt ?? 0),
  }));

  const total_pages = per_type.reduce((acc, r) => acc + r.count, 0);
  const untyped_pages =
    per_type.find((r) => r.type === '(untyped)')?.count ?? 0;
  const typed_pages = total_pages - untyped_pages;
  const coverage = total_pages === 0
    ? 0
    : Math.round((typed_pages / total_pages) * 10000) / 10000;

  return {
    total_pages,
    typed_pages,
    untyped_pages,
    coverage,
    per_type,
    source_id: sourceId,
  };
}
