/**
 * Trust: the fact withdrawal ledger (`fact_withdrawals`, facts/withdrawal-schema.ts). Each function runs the statement
 * its caller ran through `executeRaw`, with the same text and parameters, on the engine's own raw path; only its home
 * moved. `isFactWithdrawn` and `isFactPurged` also read
 * `fact_purges` (facts/purge-schema.ts): every writer runs them before it saves a claim (facts/withdrawal.ts).
 * `readSourcePurgeFlags` is the per-source purge probe of the import overlay (facts/purge-overlay.ts): whether the
 * source has any fact or take purge tombstone. `listPurgedTakeRows` is that overlay's take match: which incoming
 * takes-fence rows a take tombstone names.
 *
 * `readFactCacheWatermark` is the hot-memory cache's watermark (facts/meta-hook.ts): the ledger's row count and newest
 * withdrawal, plus a digest of the folder access rules and pending coverage, so a forget or a rulebook install in any
 * process changes it. `readTrustGeneration` is the other half of that cache identity: the trust policy generation
 * (`trust_policy_state`, eligibility/generation-schema.ts), which moves whenever cached proactive content could turn
 * wrong.
 *
 * The forget commit (recordFactWithdrawal, facts/withdrawal.ts; forget-prepare.ts) and the `fact_withdrawn` refusal
 * (factWithdrawnRefusal, facts/single-prepare.ts) also read and write `facts`, `pages` and `decide_review_queue`:
 * `lockFactForWithdrawal` locks the claim, `queueWithdrawalReview` queues its overnight review,
 * `listSegmentedPagesBySlug`, `bumpWithdrawnPageRevisions` and `readPageRevisions` move the changed pages' revisions,
 * `appendFactForgetReason` notes the reason, and `readFactWithdrawnRow` / `readFactWithdrawnBacking` read the
 * withdrawal a refused save met. The lock and the two refusal reads are whole static texts from
 * facts/withdrawal-statements.ts, passed as they are, because the refusal reads reuse placeholders.
 */
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';

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

/** Whether the source has any fact purge tombstone and any take purge tombstone (one indexed probe each). */
export async function readSourcePurgeFlags(exec: LegacyUnscopedRead, sourceId: string): Promise<{ facts: boolean; takes: boolean }> {
  const [row] = await exec.executeRaw<{ facts: boolean; takes: boolean }>(`SELECT
    EXISTS (SELECT 1 FROM fact_purges WHERE source_id=$1) AS facts,
    EXISTS (SELECT 1 FROM take_purges WHERE source_id=$1) AS takes`, [sourceId]);
  return { facts: row?.facts === true, takes: row?.takes === true };
}

/** One take row of an incoming takes fence: its row number and its claim. */
export interface TakeClaimRow { row_num: number; claim: string }

/** The import overlay's take match: the row numbers of `takes` whose claim fingerprint a take tombstone of the source names, under subject '*' or `subject` (any subject when null), each once. No set order. */
export async function listPurgedTakeRows(exec: LegacyUnscopedRead, sourceId: string, takes: readonly TakeClaimRow[], subject: string | null): Promise<number[]> {
  const rows = await exec.executeRaw<{ row_num: number }>(`SELECT DISTINCT i.row_num
      FROM jsonb_to_recordset($2::text::jsonb) AS i(row_num integer, claim text)
      JOIN take_purges p ON p.source_id=$1 AND p.claim_hash=gbrain_fact_fingerprint(i.claim)
        AND ($3::text IS NULL OR p.subject='*' OR p.subject=$3::text)`,
    [sourceId, JSON.stringify(takes.map(t => ({ row_num: t.row_num, claim: t.claim }))), subject]);
  return rows.map(r => Number(r.row_num));
}
