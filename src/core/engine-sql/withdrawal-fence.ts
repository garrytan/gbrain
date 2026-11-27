/**
 * The withdrawal check a prepared import runs on a malformed facts fence (assertPreparedFactWithdrawals,
 * src/core/facts/withdrawal.ts). A fence the parser cannot read is not struck row by row, so the import refuses it
 * when any claim it holds is withdrawn or purged. The statement ran through `executeRaw` before it was a typed member;
 * it keeps that text and parameter order, so PGLite and Postgres answer exactly as before
 * (test/withdrawal-fence-sql-pin.test.ts pins the text). A Rust brain answers from its withdrawal and purge ledgers
 * (rust/crates/gbrain-store/src/facts/withdrawal_fence.rs).
 *
 * `hasWithdrawnFenceClaim(sourceId, claims, subject)` is true when a withdrawal or a purge tombstone of the source has
 * the fingerprint, the v2 fingerprint or the v1 fingerprint of a claim, at the claim's visibility (any visibility when the claim has
 * none), under subject '*' or `subject` (any subject when `subject` is null).
 *
 * The CTE fingerprints each incoming claim once. Inside the join condition the planner re-evaluates both fingerprint
 * functions for every (claim, withdrawal) pair, so a 28-row fence against 400 withdrawals spent 4 s in this query.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One claim of a malformed fence: its text and its visibility cell (null when the cell is not private or world). */
export interface FenceClaimRow { claim: string; visibility: string | null }

const WITHDRAWN_FENCE_CLAIM_SQL = `WITH incoming AS MATERIALIZED (SELECT i.visibility, gbrain_fact_fingerprint(i.claim) AS fp, gbrain_fact_fingerprint_v2(i.claim) AS fp_v2,
      gbrain_fact_fingerprint_v1(i.claim) AS fp_v1
      FROM jsonb_to_recordset($2::text::jsonb) i(claim text,visibility text))
    SELECT 1 FROM incoming
    JOIN (SELECT source_id,visibility,subject,fact_hash FROM fact_withdrawals WHERE source_id=$1
      UNION ALL SELECT source_id,visibility,subject,fact_hash FROM fact_purges WHERE source_id=$1) w
      ON w.source_id=$1 AND w.fact_hash IN (incoming.fp,incoming.fp_v2,incoming.fp_v1)
      AND (incoming.visibility IS NULL OR w.visibility=incoming.visibility)
      AND ($3::text IS NULL OR w.subject = '*' OR w.subject = $3::text) LIMIT 1`;

/** Whether a withdrawal or purge tombstone of `sourceId` covers one of `claims` for `subject`. False for no claims. */
export async function hasWithdrawnFenceClaim(exec: Raw, sourceId: string, claims: readonly FenceClaimRow[], subject: string | null): Promise<boolean> {
  if (!claims.length) return false;
  const rows = await exec.executeRaw(WITHDRAWN_FENCE_CLAIM_SQL, [sourceId, JSON.stringify(claims.map(c => ({ claim: c.claim, visibility: c.visibility }))), subject]);
  return rows.length > 0;
}
