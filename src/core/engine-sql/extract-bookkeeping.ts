/**
 * The extract bookkeeping statements (core/extract/rollup-writer.ts and receipt-writer.ts): one SQL implementation for
 * both engines. Each statement is the text its caller ran through `executeRaw` at 54246f2bd8, byte for byte
 * (test/engine-sql-caller-raw-sql-pins.test.ts). Every member runs on the executor it is given, so a member of a
 * transaction-bound engine runs on that transaction.
 */
import { SAFE_FENCE_CHUNKER_VERSION } from '../search/safe-chunks.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/** The engine's own executeRaw (a transaction-bound engine inside a transaction). */
export interface ExtractBookkeepingExec {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

/**
 * One extract_rollup_7d event, its deltas already defaulted to 0. `reason` is the halt reason bucket (null: none or
 * unclassified, read back as `unknown`).
 */
export interface ExtractRollupRow {
  kind: string; sourceId: string; day: string; cost: number; halts: number; evalFails: number; evalPasses: number;
  completed: number; expectedLimits: number; failures: number; reason: string | null;
}

/** The page row a receipt write checks before it writes (`pages` columns of that slug, deleted or not). */
export interface ExtractReceiptPriorRow { type: string | null; source_path: string | null; source_uri: string | null; withheld_source_path: string | null }

const ROLLUP_SQL = `INSERT INTO extract_rollup_7d (
         kind, source_id, day,
         cost_usd, halt_count, eval_fail_count, eval_pass_count,
         round_completed_count, expected_limit_count, rollup_write_failures, halt_reasons, updated_at
       )
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10,
         CASE WHEN $11::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object($11::text, $5::int) END, now())
       ON CONFLICT (kind, source_id, day) DO UPDATE SET
         cost_usd               = extract_rollup_7d.cost_usd               + EXCLUDED.cost_usd,
         halt_count             = extract_rollup_7d.halt_count             + EXCLUDED.halt_count,
         eval_fail_count        = extract_rollup_7d.eval_fail_count        + EXCLUDED.eval_fail_count,
         eval_pass_count        = extract_rollup_7d.eval_pass_count        + EXCLUDED.eval_pass_count,
         round_completed_count  = extract_rollup_7d.round_completed_count  + EXCLUDED.round_completed_count,
         expected_limit_count   = extract_rollup_7d.expected_limit_count   + EXCLUDED.expected_limit_count,
         rollup_write_failures  = extract_rollup_7d.rollup_write_failures  + EXCLUDED.rollup_write_failures,
         halt_reasons           = CASE WHEN $11::text IS NULL THEN extract_rollup_7d.halt_reasons
           ELSE jsonb_set(extract_rollup_7d.halt_reasons, ARRAY[$11::text],
             to_jsonb(COALESCE((extract_rollup_7d.halt_reasons->>$11::text)::int, 0) + $5::int)) END,
         updated_at             = now()`;

// A brain before migration v141 has no expected_limit_count column: the cap stop is added to halt_count.
const ROLLUP_PRE_V141_SQL = `INSERT INTO extract_rollup_7d (
             kind, source_id, day,
             cost_usd, halt_count, eval_fail_count, eval_pass_count,
             round_completed_count, rollup_write_failures, updated_at
           )
           VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, now())
           ON CONFLICT (kind, source_id, day) DO UPDATE SET
             cost_usd               = extract_rollup_7d.cost_usd               + EXCLUDED.cost_usd,
             halt_count             = extract_rollup_7d.halt_count             + EXCLUDED.halt_count,
             eval_fail_count        = extract_rollup_7d.eval_fail_count        + EXCLUDED.eval_fail_count,
             eval_pass_count        = extract_rollup_7d.eval_pass_count        + EXCLUDED.eval_pass_count,
             round_completed_count  = extract_rollup_7d.round_completed_count  + EXCLUDED.round_completed_count,
             rollup_write_failures  = extract_rollup_7d.rollup_write_failures  + EXCLUDED.rollup_write_failures,
             updated_at             = now()`;

/**
 * Adds one event to its (kind, source, day) rollup row. `pre_v141` is the statement of a brain whose schema is behind
 * v141 (the caller retries with it when the column is missing). Errors reach the caller, which records them.
 */
export async function upsertExtractRollup(exec: ExtractBookkeepingExec, row: ExtractRollupRow, form?: 'pre_v141'): Promise<void> {
  if (form === 'pre_v141') {
    await exec.executeRaw(ROLLUP_PRE_V141_SQL,
      [row.kind, row.sourceId, row.day, row.cost, row.halts + row.expectedLimits, row.evalFails, row.evalPasses, row.completed, row.failures]);
    return;
  }
  await exec.executeRaw(ROLLUP_SQL,
    [row.kind, row.sourceId, row.day, row.cost, row.halts, row.evalFails, row.evalPasses, row.completed, row.expectedLimits, row.failures, row.reason]);
}

/** The page row at (sourceId, slug), deleted or not; undefined when there is none. */
export async function readExtractReceiptPrior(exec: ExtractBookkeepingExec, sourceId: string, slug: string): Promise<ExtractReceiptPriorRow | undefined> {
  const [row] = await exec.executeRaw<ExtractReceiptPriorRow>(
    'SELECT type, source_path, source_uri, withheld_source_path FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  return row;
}

/**
 * Whether the page at (sourceId, slug) is sealed at the safe-chunk fence: its chunker version is at least
 * SAFE_FENCE_CHUNKER_VERSION and its text projection is at its knowledge revision. The SQL value (true, false or null)
 * is returned as read; undefined when there is no row.
 */
export async function readExtractReceiptSealed(exec: ExtractBookkeepingExec, sourceId: string, slug: string): Promise<{ sealed: boolean | null } | undefined> {
  // The fence version is spliced as constant text, as the caller's template did; the text Postgres gets is unchanged.
  const version = SAFE_FENCE_CHUNKER_VERSION;
  if (!Number.isFinite(version)) throw new Error(`invalid safe-chunk fence version: ${version}`);
  const fence = trustedSql(`${version}`);
  const { text, params } = renderFragment(sqlFragment`SELECT chunker_version >= ${fence} AND text_projection_revision = knowledge_revision AS sealed FROM pages WHERE source_id=${sourceId} AND slug=${slug}`);
  const [row] = await exec.executeRaw<{ sealed: boolean | null }>(text, params);
  return row;
}
