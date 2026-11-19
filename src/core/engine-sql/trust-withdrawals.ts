/**
 * Trust: the fact withdrawal ledger (`fact_withdrawals`, facts/withdrawal-schema.ts). Each function runs the statement
 * its caller ran through `executeRaw`, with the same text and parameters, on the engine's own raw path; only its home
 * moved. Statements that also read `facts` or `fact_purges` stay with their callers.
 */
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { MOVE_WITHDRAWAL_SUBJECT_SQL } from '../facts/withdrawal-schema.ts';

/** One claim of a fence: its row number, its text and its visibility. */
export interface WithdrawalClaimRow { row_num: number; claim: string; visibility: string }

/** The earliest withdrawal of a claim row. */
export interface WithdrawalDateRow { row_num: number; withdrawn_at: Date }

/** A ledger row's key. */
export interface WithdrawalKeyRow { visibility: string; fact_hash: string; subject: string }

export async function hasCoveringFactWithdrawal(exec: LegacyUnscopedRead, sourceId: string, visibility: string, factHash: string, claim: string, subject: string): Promise<boolean> {
  const rows = await exec.executeRaw(`SELECT 1 FROM fact_withdrawals
    WHERE source_id=$1 AND visibility=$2 AND fact_hash IN ($3,gbrain_fact_fingerprint_v2($5),gbrain_fact_fingerprint_v1($5)) AND (subject='*' OR subject=$4) LIMIT 1`,
  [sourceId, visibility, factHash, subject, claim]);
  return rows.length > 0;
}

export async function insertFactWithdrawal(exec: SqlExecutor, sourceId: string, visibility: string, claim: string, subject: string, withdrawnAt: string | null): Promise<boolean> {
  const inserted = await exec.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash,withdrawn_at)
        VALUES ($1,$2,$4,gbrain_fact_fingerprint($3),COALESCE($5::timestamptz,now())) ON CONFLICT DO NOTHING RETURNING fact_hash`, [sourceId, visibility, claim, subject, withdrawnAt]);
  return inserted.length > 0;
}

// Fingerprint each incoming claim once. Inside the join condition the planner
// re-evaluates both fingerprint functions for every (claim, withdrawal) pair,
// so a 28-row fence against 400 withdrawals spent 4 s in this query.
export async function listFactWithdrawalDates(exec: LegacyUnscopedRead, sourceId: string, claims: readonly WithdrawalClaimRow[], subject: string | null): Promise<WithdrawalDateRow[]> {
  if (!claims.length) return [];
  const rows = await exec.executeRaw<{ row_num: number; withdrawn_at: Date | string }>(
    `WITH incoming AS MATERIALIZED (SELECT i.visibility, gbrain_fact_fingerprint(i.claim) AS fp, gbrain_fact_fingerprint_v2(i.claim) AS fp_v2,
        gbrain_fact_fingerprint_v1(i.claim) AS fp_v1, i.row_num
        FROM jsonb_to_recordset($2::text::jsonb) AS i(row_num integer,claim text,visibility text))
      SELECT incoming.row_num, min(w.withdrawn_at) AS withdrawn_at FROM incoming
      JOIN fact_withdrawals w ON w.source_id=$1 AND w.visibility=incoming.visibility
        AND w.fact_hash IN (incoming.fp,incoming.fp_v2,incoming.fp_v1)
        AND ($3::text IS NULL OR w.subject = '*' OR w.subject = $3::text)
      GROUP BY incoming.row_num`,
    [sourceId, JSON.stringify(claims.map(c => ({ row_num: c.row_num, claim: c.claim, visibility: c.visibility }))), subject],
  );
  return rows.map(r => ({ row_num: Number(r.row_num), withdrawn_at: r.withdrawn_at instanceof Date ? r.withdrawn_at : new Date(r.withdrawn_at) }));
}

export async function moveFactWithdrawalSubject(exec: SqlExecutor, sourceId: string, oldSlug: string, newSlug: string): Promise<void> {
  await exec.executeRaw(MOVE_WITHDRAWAL_SUBJECT_SQL, [sourceId, oldSlug, newSlug]);
}

export async function hasFactWithdrawalForSubject(exec: LegacyUnscopedRead, sourceId: string, subject: string): Promise<boolean> {
  const [withdrawn] = await exec.executeRaw('SELECT 1 FROM fact_withdrawals WHERE source_id=$1 AND subject=$2 LIMIT 1', [sourceId, subject]);
  return withdrawn !== undefined;
}

export async function listFactWithdrawalKeys(exec: LegacyUnscopedRead, sourceId: string, limit: number): Promise<WithdrawalKeyRow[]> {
  return exec.executeRaw<WithdrawalKeyRow>(`SELECT visibility,fact_hash,subject FROM fact_withdrawals
      WHERE source_id=$1 ORDER BY visibility,fact_hash,subject LIMIT $2`, [sourceId, limit]);
}
