/**
 * Extract bookkeeping writes: the two page reads an extract receipt write makes inside its transaction
 * (src/core/extract/receipt-writer.ts) and the `extract_rollup_7d` day upsert the extract steps add their
 * deltas with (src/core/extract/rollup-writer.ts). Each statement ran through `executeRaw`; SQL once for both
 * engines, so a store that is not SQL serves the same members (rust/docs/store/extract-bookkeeping.md).
 *
 * The rollup reads (doctor's extract_health) are not here.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** What a receipt write checks before it writes its slug: the page the slug holds, live or a tombstone. */
export interface ExtractReceiptSlot {
  type: string | null;
  source_path: string | null;
  source_uri: string | null;
  withheld_source_path: string | null;
}

/** One event's deltas for its `(kind, source_id, day)` rollup row. `halt_reason`: the bucket the halts count under. */
export interface ExtractRollupDelta {
  kind: string;
  source_id: string;
  /** `YYYY-MM-DD`. */
  day: string;
  cost_usd: number;
  halt_count: number;
  eval_fail_count: number;
  eval_pass_count: number;
  round_completed_count: number;
  expected_limit_count: number;
  rollup_write_failures: number;
  halt_reason: string | null;
}

export async function readExtractReceiptSlot(exec: Raw, sourceId: string, slug: string): Promise<ExtractReceiptSlot | null> {
  const [row] = await exec.executeRaw<ExtractReceiptSlot>(
    'SELECT type, source_path, source_uri, withheld_source_path FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  return row ?? null;
}

/**
 * Whether the page's chunks are sealed: `chunker_version >= safeVersion AND text_projection_revision =
 * knowledge_revision`. Null for no page, or when SQL's answer is NULL.
 */
export async function readExtractReceiptSeal(exec: Raw, sourceId: string, slug: string, safeVersion: number): Promise<boolean | null> {
  const [row] = await exec.executeRaw<{ sealed: boolean | null }>(
    'SELECT chunker_version >= $3::int AND text_projection_revision = knowledge_revision AS sealed FROM pages WHERE source_id=$1 AND slug=$2',
    [sourceId, slug, safeVersion]);
  return row ? row.sealed ?? null : null;
}

/**
 * Inserts the day row or adds the deltas to the stored one; a named halt reason adds `halt_count` to its
 * `halt_reasons` bucket (bound as text and keyed in SQL, never JSON text cast to jsonb). `preV141`: a brain
 * without `expected_limit_count` (migration v141) counts expected limits as halts and has no `halt_reasons`.
 */
export async function upsertExtractRollupDay(exec: Raw, d: ExtractRollupDelta, opts: { preV141?: boolean } = {}): Promise<void> {
  if (opts.preV141) {
    await exec.executeRaw(
      `INSERT INTO extract_rollup_7d (
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
         updated_at             = now()`,
      [d.kind, d.source_id, d.day, d.cost_usd, d.halt_count + d.expected_limit_count, d.eval_fail_count,
        d.eval_pass_count, d.round_completed_count, d.rollup_write_failures],
    );
    return;
  }
  await exec.executeRaw(
    `INSERT INTO extract_rollup_7d (
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
       updated_at             = now()`,
    [d.kind, d.source_id, d.day, d.cost_usd, d.halt_count, d.eval_fail_count, d.eval_pass_count,
      d.round_completed_count, d.expected_limit_count, d.rollup_write_failures, d.halt_reason],
  );
}
