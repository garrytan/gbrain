/**
 * The extraction watermark and partial-input receipt (`page_extraction_state`, migration v247): the five statements
 * extraction-watermark.ts (which owns the policy) always sent through `executeRaw`, now one copy for both engines.
 * The watermark read, the commit of a successful extraction, the receipt read, the receipt delete and the receipt upsert.
 *
 * A row goes with its page (ON DELETE CASCADE): a hard page delete and a source delete remove it.
 */
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';

export type PageExtractionPipeline = 'facts_backstop' | 'extract_atoms' | 'conversation_facts';

/** A live page's id and the watermark stored for one pipeline; the three fields are null when the page has no watermark. */
export interface PageExtractionWatermarkRow {
  page_id: number;
  pipeline_version: number | null;
  watermark_bytes: number | null;
  watermark_sha256: string | null;
}

/** One successful extraction: the watermark moves to `watermarkBytes`; `receipt` is the new partial-input receipt (null clears it). */
export interface PageExtractionCommit {
  pageId: number;
  pipeline: PageExtractionPipeline;
  pipelineVersion: number;
  watermarkBytes: number;
  watermarkSha256: string;
  receipt: Record<string, unknown> | null;
  /** A complete tail read keeps whatever receipt an earlier read left, instead of replacing it with `receipt`. */
  keepReceipt: boolean;
}

const READ_WATERMARK_SQL = `SELECT p.id, s.pipeline_version, s.watermark_bytes, s.watermark_sha256
         FROM pages p LEFT JOIN page_extraction_state s ON s.page_id = p.id AND s.pipeline = $3
        WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL`;

const COMMIT_SQL = `INSERT INTO page_extraction_state (page_id, pipeline, pipeline_version, watermark_bytes, watermark_sha256, input_truncated, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, now())
       ON CONFLICT (page_id, pipeline) DO UPDATE SET pipeline_version = EXCLUDED.pipeline_version,
         watermark_bytes = EXCLUDED.watermark_bytes, watermark_sha256 = EXCLUDED.watermark_sha256,
         input_truncated = CASE WHEN $7 THEN page_extraction_state.input_truncated ELSE EXCLUDED.input_truncated END,
         updated_at = now()`;

const READ_RECEIPT_SQL = 'SELECT input_truncated AS receipt FROM page_extraction_state WHERE page_id = $1 AND pipeline = $2';

const DELETE_SQL = 'DELETE FROM page_extraction_state WHERE page_id = $1 AND pipeline = $2';

const UPSERT_RECEIPT_SQL = `INSERT INTO page_extraction_state (page_id, pipeline, pipeline_version, input_truncated, updated_at)
       VALUES ($1, $2, $3, $4::text::jsonb, now())
       ON CONFLICT (page_id, pipeline) DO UPDATE SET input_truncated = EXCLUDED.input_truncated, updated_at = now()`;

/** The live page's id and its stored watermark for `pipeline`; null when no live page has that slug in the source. */
export async function readPageExtractionWatermark(exec: LegacyUnscopedRead, sourceId: string, slug: string,
  pipeline: PageExtractionPipeline): Promise<PageExtractionWatermarkRow | null> {
  const [row] = await exec.executeRaw<{ id: number | string; pipeline_version: number | string | null; watermark_bytes: number | string | null; watermark_sha256: string | null }>(
    READ_WATERMARK_SQL, [sourceId, slug, pipeline]);
  if (!row) return null;
  return {
    page_id: Number(row.id),
    pipeline_version: row.pipeline_version === null || row.pipeline_version === undefined ? null : Number(row.pipeline_version),
    watermark_bytes: row.watermark_bytes === null || row.watermark_bytes === undefined ? null : Number(row.watermark_bytes),
    watermark_sha256: row.watermark_sha256 ?? null,
  };
}

/** Stores a successful extraction: the watermark, and the receipt per `keepReceipt`. */
export async function commitPageExtraction(exec: SqlExecutor, commit: PageExtractionCommit): Promise<void> {
  await exec.executeRaw(COMMIT_SQL, [commit.pageId, commit.pipeline, commit.pipelineVersion, commit.watermarkBytes, commit.watermarkSha256,
    commit.receipt ? JSON.stringify(commit.receipt) : null, commit.keepReceipt]);
}

/** The page's partial-input receipt for `pipeline`; null when it has none (no row, or a row without a receipt). */
export async function readPageExtractionReceipt(exec: LegacyUnscopedRead, pageId: number, pipeline: PageExtractionPipeline):
  Promise<Record<string, unknown> | null> {
  const [row] = await exec.executeRaw<{ receipt: Record<string, unknown> | string | null }>(READ_RECEIPT_SQL, [pageId, pipeline]);
  const receipt = row?.receipt ?? null;
  return typeof receipt === 'string' ? JSON.parse(receipt) as Record<string, unknown> : receipt;
}

/** Deletes the page's row for `pipeline`, watermark and receipt both. */
export async function clearPageExtractionState(exec: SqlExecutor, pageId: number, pipeline: PageExtractionPipeline): Promise<void> {
  await exec.executeRaw(DELETE_SQL, [pageId, pipeline]);
}

/** Records the receipt of a pipeline; a row that exists keeps its watermark and version. */
export async function writePageExtractionReceipt(exec: SqlExecutor, pageId: number, pipeline: PageExtractionPipeline,
  pipelineVersion: number, receipt: Record<string, unknown>): Promise<void> {
  await exec.executeRaw(UPSERT_RECEIPT_SQL, [pageId, pipeline, pipelineVersion, JSON.stringify(receipt)]);
}
