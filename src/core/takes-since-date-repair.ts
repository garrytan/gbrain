import type { BrainEngine } from './engine.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

export interface TakeSinceDateRepairCandidate {
  take_id: number;
  page_id: number;
  page_slug: string;
  row_num: number;
  claim: string;
  kind: string;
  holder: string;
  current_since_date: string | null;
  effective_date: string;
  effective_date_source: string;
}

export interface TakeSinceDateRepairResult {
  dry_run: boolean;
  limit: number;
  candidates: TakeSinceDateRepairCandidate[];
  updated: number;
}

interface CandidateRow {
  take_id: number | string;
  page_id: number | string;
  page_slug: string;
  row_num: number | string;
  claim: string;
  kind: string;
  holder: string;
  current_since_date: string | Date | null;
  effective_date: string | Date;
  effective_date_source: string;
}

export function normalizeTakeSinceDateRepairLimit(raw: number | undefined): number {
  const limit = raw ?? DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('limit must be a positive number');
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function dateOnly(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function normalizeCandidate(row: CandidateRow): TakeSinceDateRepairCandidate {
  return {
    take_id: Number(row.take_id),
    page_id: Number(row.page_id),
    page_slug: row.page_slug,
    row_num: Number(row.row_num),
    claim: row.claim,
    kind: row.kind,
    holder: row.holder,
    current_since_date: row.current_since_date ? dateOnly(row.current_since_date) : null,
    effective_date: dateOnly(row.effective_date),
    effective_date_source: row.effective_date_source,
  };
}

export async function repairTakeSinceDates(
  engine: BrainEngine,
  opts: { apply?: boolean; limit?: number } = {},
): Promise<TakeSinceDateRepairResult> {
  const limit = normalizeTakeSinceDateRepairLimit(opts.limit);
  const rows = await engine.executeRaw<CandidateRow>(
    `SELECT t.id AS take_id,
            t.page_id,
            p.slug AS page_slug,
            t.row_num,
            t.claim,
            t.kind,
            t.holder,
            t.since_date AS current_since_date,
            p.effective_date,
            p.effective_date_source
       FROM takes t
       JOIN pages p ON p.id = t.page_id
      WHERE t.active = TRUE
        AND t.since_date IS NULL
        AND p.effective_date IS NOT NULL
        AND p.effective_date_source IS NOT NULL
        AND p.effective_date_source <> 'fallback'
      ORDER BY p.effective_date DESC, t.id ASC
      LIMIT $1`,
    [limit],
  );
  const candidates = rows.map(normalizeCandidate);

  if (!opts.apply || candidates.length === 0) {
    return { dry_run: !opts.apply, limit, candidates, updated: 0 };
  }

  let updated = 0;
  await engine.transaction(async (tx) => {
    for (const candidate of candidates) {
      const result = await tx.executeRaw<{ id: number }>(
        `UPDATE takes
            SET since_date = $1::text,
                updated_at = now()
          WHERE id = $2
            AND since_date IS NULL
          RETURNING id`,
        [candidate.effective_date, candidate.take_id],
      );
      updated += result.length;
    }
  });

  return { dry_run: false, limit, candidates, updated };
}
