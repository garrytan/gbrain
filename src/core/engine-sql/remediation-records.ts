/**
 * Two statements that reindex consent and the remediation impact log made through `executeRaw`: the page count and
 * text length the paid markdown reindex prices (`estimateReindexSpend`), and the insert of one `migration_impact_log`
 * row (`writeImpactLogRow`). SQL once for both engines. The Rust store serves the spend read from its page records and
 * refuses the insert by name: it keeps no migration impact log (rust/docs/store/remediation-records.md).
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The statements, pinned by test/remediation-records-sql-pin.test.ts. */
export const REMEDIATION_RECORDS_SQL = {
  reindexSpend: `SELECT COUNT(*)::bigint AS n, COALESCE(SUM(LENGTH(compiled_truth) + LENGTH(timeline)), 0)::bigint AS chars
         FROM pages
        WHERE page_kind = 'markdown' AND (chunker_version < $1 OR contextual_retrieval_mode IS NULL)
          AND deleted_at IS NULL AND ($2::text IS NULL OR type = $2)`,
  impactLogInsert: `INSERT INTO migration_impact_log (
         remediation_id, metric_name, metric_before, metric_after,
         job_id, source_id, brain_id, started_at, idempotency_key,
         applied_by, details
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb)`,
} as const;

/** The markdown pages a reindex would re-chunk, and the characters of their bodies (a NULL body adds none). */
export interface ReindexSpendInputs { pages: number; chars: number }

/**
 * The live markdown pages whose chunker version is below `chunkerVersion` or whose contextual-retrieval mode was never
 * decided, of type `type` when one is named: how many, and the summed character length of their body and timeline.
 */
export async function readReindexSpendInputs(tx: Raw, chunkerVersion: number, type: string | null): Promise<ReindexSpendInputs> {
  const rows = await tx.executeRaw<{ n: string | number; chars: string | number | null }>(
    REMEDIATION_RECORDS_SQL.reindexSpend, [chunkerVersion, type]);
  return { pages: Number(rows[0]?.n ?? 0), chars: Number(rows[0]?.chars ?? 0) };
}

/** One `migration_impact_log` row: a remediation step's metric before and after its job. */
export interface ImpactLogRow {
  remediation_id: string;
  metric_name: string;
  metric_before: number | null;
  metric_after: number | null;
  job_id: number | null;
  source_id: string | null;
  brain_id: string | null;
  started_at: string;
  idempotency_key: string | null;
  applied_by: string | null;
  details: Record<string, unknown>;
}

/** Inserts one impact log row. `details` binds as text and the cast parses it (never a double-encoded jsonb string). */
export async function insertImpactLogRow(tx: Raw, row: ImpactLogRow): Promise<void> {
  await tx.executeRaw(REMEDIATION_RECORDS_SQL.impactLogInsert, [
    row.remediation_id, row.metric_name, row.metric_before, row.metric_after, row.job_id, row.source_id,
    row.brain_id, row.started_at, row.idempotency_key, row.applied_by, JSON.stringify(row.details),
  ]);
}
