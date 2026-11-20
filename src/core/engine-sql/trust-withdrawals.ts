/**
 * Trust: the fact withdrawal ledger (`fact_withdrawals`, facts/withdrawal-schema.ts). Each function runs the statement
 * its caller ran through `executeRaw`, with the same text and parameters, on the engine's own raw path; only its home
 * moved. Statements that also read `facts` stay with their callers. `isFactWithdrawn` and `isFactPurged` also read
 * `fact_purges` (facts/purge-schema.ts): every writer runs them before it saves a claim (facts/withdrawal.ts).
 *
 * `readFactCacheWatermark` is the hot-memory cache's watermark (facts/meta-hook.ts): the ledger's row count and newest
 * withdrawal, plus a digest of the folder access rules and pending coverage, so a forget or a rulebook install in any
 * process changes it. `readTrustGeneration` is the other half of that cache identity: the trust policy generation
 * (`trust_policy_state`, eligibility/generation-schema.ts), which moves whenever cached proactive content could turn
 * wrong.
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

/**
 * The hot-memory cache watermark of a source: its withdrawal count, its newest withdrawal time (UTC ISO text with
 * microseconds, null with no withdrawal), and the md5 digests of `access_rules` and `access_pending_coverage`
 * (every source), joined by ':'.
 */
export interface FactCacheWatermarkRow { withdrawals: number; latest_withdrawn_at: string | null; access_rules: string }

export async function hasCoveringFactWithdrawal(exec: LegacyUnscopedRead, sourceId: string, visibility: string, factHash: string, claim: string, subject: string): Promise<boolean> {
  const rows = await exec.executeRaw(`SELECT 1 FROM fact_withdrawals
    WHERE source_id=$1 AND visibility=$2 AND fact_hash IN ($3,gbrain_fact_fingerprint_v1($5)) AND (subject='*' OR subject=$4) LIMIT 1`,
  [sourceId, visibility, factHash, subject, claim]);
  return rows.length > 0;
}

/**
 * Whether a withdrawal (fingerprint or v1 fingerprint; subject '*', `entitySlug` or `memberPage`) or a purge tombstone
 * (fingerprint; subject '*' or `entitySlug`) of the source covers `claim`. A null `visibility` matches any visibility.
 */
export async function isFactWithdrawn(exec: LegacyUnscopedRead, sourceId: string, visibility: string | null, claim: string, entitySlug: string | null, memberPage: string | null): Promise<boolean> {
  const rows = await exec.executeRaw(`SELECT 1 FROM fact_withdrawals
    WHERE source_id=$1 AND ($2::text IS NULL OR visibility=$2) AND fact_hash IN (gbrain_fact_fingerprint($3),gbrain_fact_fingerprint_v1($3))
      AND (subject = '*' OR subject = $4::text OR subject = $5::text)
    UNION ALL SELECT 1 FROM fact_purges WHERE source_id=$1 AND ($2::text IS NULL OR visibility=$2) AND fact_hash=gbrain_fact_fingerprint($3)
      AND (subject = '*' OR subject = $4::text) LIMIT 1`, [sourceId, visibility, claim, entitySlug, memberPage]);
  return rows.length > 0;
}

/** Whether a purge tombstone of the source at `visibility` names the fingerprint of `claim` for subject '*' or `entitySlug`. */
export async function isFactPurged(exec: LegacyUnscopedRead, sourceId: string, visibility: string, claim: string, entitySlug: string | null): Promise<boolean> {
  const rows = await exec.executeRaw(`SELECT 1 FROM fact_purges WHERE source_id=$1 AND visibility=$2 AND fact_hash=gbrain_fact_fingerprint($3)
    AND (subject = '*' OR subject = $4::text) LIMIT 1`, [sourceId, visibility, claim, entitySlug]);
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
    `WITH incoming AS MATERIALIZED (SELECT i.visibility, gbrain_fact_fingerprint(i.claim) AS fp, gbrain_fact_fingerprint_v1(i.claim) AS fp_v1, i.row_num
        FROM jsonb_to_recordset($2::text::jsonb) AS i(row_num integer,claim text,visibility text))
      SELECT incoming.row_num, min(w.withdrawn_at) AS withdrawn_at FROM incoming
      JOIN fact_withdrawals w ON w.source_id=$1 AND w.visibility=incoming.visibility
        AND w.fact_hash IN (incoming.fp,incoming.fp_v1)
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
      WHERE source_id=$1 ORDER BY visibility COLLATE "C",fact_hash COLLATE "C",subject COLLATE "C" LIMIT $2`, [sourceId, limit]);
}

export async function readFactCacheWatermark(exec: LegacyUnscopedRead, sourceId: string): Promise<FactCacheWatermarkRow> {
  const [row] = await exec.executeRaw<{ withdrawals: number | string; latest_withdrawn_at: string | null; access_rules: string }>(
    `SELECT count(*)::int AS withdrawals,
       to_char(max(withdrawn_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS latest_withdrawn_at,
       (SELECT md5(coalesce(string_agg(source_id || '/' || rule_id || '/' || prefix || '/' || array_to_string(readable_by, ',') || '/' || revision::text, '|' ORDER BY source_id COLLATE "C", rule_id COLLATE "C"), '')) FROM access_rules)
         || ':' || (SELECT md5(coalesce(string_agg(source_id || '/' || prefix || '/' || reason || '/' || coalesce(revision::text, ''), '|' ORDER BY source_id COLLATE "C", prefix COLLATE "C", reason COLLATE "C"), '')) FROM access_pending_coverage) AS access_rules
     FROM fact_withdrawals WHERE source_id = $1`, [sourceId]);
  return { withdrawals: Number(row?.withdrawals ?? 0), latest_withdrawn_at: row?.latest_withdrawn_at ?? null, access_rules: row?.access_rules ?? '' };
}

/**
 * The trust policy generation as decimal text (`trust_policy_state`, one row, id 1). Throws when the row is missing:
 * the caller then delivers nothing rather than cached content (eligibility/generation.ts).
 */
export async function readTrustGeneration(exec: LegacyUnscopedRead): Promise<string> {
  const [row] = await exec.executeRaw<{ generation: string | number | bigint | null }>(
    'SELECT generation::text AS generation FROM trust_policy_state WHERE id = 1');
  if (row?.generation === undefined || row.generation === null) throw new Error('trust generation unreadable: trust_policy_state has no row');
  return String(row.generation);
}
