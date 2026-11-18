/**
 * Facts: the typed `fact_relink_attempts` record (DDL in facts/relink-schema.ts), one row per fact holding the latest
 * relink outcome or memo. Each function runs the statement facts/relink.ts, facts/conversation-relink.ts,
 * facts/relink-publish.ts and facts/conversation-memo.ts ran through `executeRaw`, with the same columns and parameters;
 * only its home moved. The doctor's reads of the table stay in engine-sql/facts-doctor.ts, and the `to_regclass` probes
 * that ask whether the table exists stay with their callers.
 */
import type { SqlExecutor } from './executor.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

/** One attempt as a writer records it. `attempted_at` is always the statement's `now()`. */
export interface FactRelinkAttempt {
  factId: number;
  outcome: string;
  reason: string | null;
  tier: string | null;
  model: string | null;
  targetSlug: string | null;
  runId: string | null;
}

/** `keepModelAndRun`: a conflict keeps the stored `model` and `run_id` (the paid re-extraction memo's upsert). */
export interface FactRelinkUpsertOpts { keepModelAndRun?: boolean }

export interface FactRelinkOutcome { fact_id: number; outcome: string }

const UPSERT = `INSERT INTO fact_relink_attempts (source_id, fact_id, outcome, reason, tier, model, target_slug, run_id, attempted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (source_id, fact_id) DO UPDATE SET outcome = EXCLUDED.outcome, reason = EXCLUDED.reason, tier = EXCLUDED.tier,
       model = EXCLUDED.model, target_slug = EXCLUDED.target_slug, run_id = EXCLUDED.run_id, attempted_at = EXCLUDED.attempted_at`;

const UPSERT_KEEP_MODEL_AND_RUN = `INSERT INTO fact_relink_attempts (source_id, fact_id, outcome, reason, tier, model, target_slug, run_id, attempted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (source_id, fact_id) DO UPDATE SET outcome = EXCLUDED.outcome, reason = EXCLUDED.reason, tier = EXCLUDED.tier,
       target_slug = EXCLUDED.target_slug, attempted_at = EXCLUDED.attempted_at`;

/** Records the fact's latest attempt, replacing the one stored for `(source_id, fact_id)`. */
export async function upsertFactRelinkAttempt(exec: SqlExecutor, sourceId: string, attempt: FactRelinkAttempt, opts: FactRelinkUpsertOpts = {}): Promise<void> {
  await exec.executeRaw(opts.keepModelAndRun ? UPSERT_KEEP_MODEL_AND_RUN : UPSERT,
    [sourceId, attempt.factId, attempt.outcome, attempt.reason, attempt.tier, attempt.model, attempt.targetSlug, attempt.runId]);
}

/** The stored outcome of each of `factIds` in the source whose outcome is one of `outcomes`, by fact id. */
export async function listFactRelinkOutcomes(raw: EngineRawRead, sourceId: string, factIds: number[], outcomes: string[]): Promise<FactRelinkOutcome[]> {
  const rows = await raw<{ fact_id: number | string; outcome: string }>(
    `SELECT fact_id, outcome FROM fact_relink_attempts WHERE source_id = $1 AND fact_id = ANY($2::bigint[]) AND outcome = ANY($3::text[]) ORDER BY fact_id`,
    [sourceId, factIds, outcomes]);
  return rows.map(r => ({ fact_id: Number(r.fact_id), outcome: r.outcome }));
}

/** Deletes the source's attempts of one tier that name `targetSlug` (the paid memos of a page before a new one). */
export async function deleteFactRelinkMemos(exec: SqlExecutor, sourceId: string, tier: string, targetSlug: string): Promise<void> {
  await exec.executeRaw(`DELETE FROM fact_relink_attempts WHERE source_id = $1 AND tier = $2 AND target_slug = $3`, [sourceId, tier, targetSlug]);
}
