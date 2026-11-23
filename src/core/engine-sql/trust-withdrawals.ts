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
import { MOVE_WITHDRAWAL_SUBJECT_SQL } from '../facts/withdrawal-schema.ts';
import { FACT_WITHDRAWN_BACKING_SQL, FACT_WITHDRAWN_ROW_SQL, LOCK_FACT_FOR_WITHDRAWAL_FLOOR_SQL, LOCK_FACT_FOR_WITHDRAWAL_SQL } from '../facts/withdrawal-statements.ts';

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
    WHERE source_id=$1 AND visibility=$2 AND fact_hash IN ($3,gbrain_fact_fingerprint_v2($5),gbrain_fact_fingerprint_v1($5)) AND (subject='*' OR subject=$4) LIMIT 1`,
  [sourceId, visibility, factHash, subject, claim]);
  return rows.length > 0;
}

/**
 * Whether a withdrawal (fingerprint or v1 fingerprint; subject '*', `entitySlug` or `memberPage`) or a purge tombstone
 * (fingerprint; subject '*' or `entitySlug`) of the source covers `claim`. A null `visibility` matches any visibility.
 */
export async function isFactWithdrawn(exec: LegacyUnscopedRead, sourceId: string, visibility: string | null, claim: string, entitySlug: string | null, memberPage: string | null): Promise<boolean> {
  const rows = await exec.executeRaw(`SELECT 1 FROM fact_withdrawals
    WHERE source_id=$1 AND ($2::text IS NULL OR visibility=$2) AND fact_hash IN (gbrain_fact_fingerprint($3),gbrain_fact_fingerprint_v2($3),gbrain_fact_fingerprint_v1($3))
      AND (subject = '*' OR subject = $4::text OR subject = $5::text)
    UNION ALL SELECT 1 FROM fact_purges WHERE source_id=$1 AND ($2::text IS NULL OR visibility=$2) AND fact_hash IN (gbrain_fact_fingerprint($3),gbrain_fact_fingerprint_v2($3))
      AND (subject = '*' OR subject = $4::text) LIMIT 1`, [sourceId, visibility, claim, entitySlug, memberPage]);
  return rows.length > 0;
}

/** Whether a purge tombstone of the source at `visibility` names the fingerprint of `claim` for subject '*' or `entitySlug`. */
export async function isFactPurged(exec: LegacyUnscopedRead, sourceId: string, visibility: string, claim: string, entitySlug: string | null): Promise<boolean> {
  const rows = await exec.executeRaw(`SELECT 1 FROM fact_purges WHERE source_id=$1 AND visibility=$2 AND fact_hash IN (gbrain_fact_fingerprint($3),gbrain_fact_fingerprint_v2($3))
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
      JOIN take_purges p ON p.source_id=$1 AND p.claim_hash IN (gbrain_fact_fingerprint(i.claim), gbrain_fact_fingerprint_v2(i.claim))
        AND ($3::text IS NULL OR p.subject='*' OR p.subject=$3::text)`,
    [sourceId, JSON.stringify(takes.map(t => ({ row_num: t.row_num, claim: t.claim }))), subject]);
  return rows.map(r => Number(r.row_num));
}

/** `lockFactForWithdrawal`: the fact a withdrawal admits (FactWithdrawalClaimSpec), locked; outcome markers too. */
export interface WithdrawalLockSpec { id: number; sourceId: string; worldOnly: boolean; memberPage: string | null; remoteFloor: boolean }

/** The locked claim: its visibility, text and withdrawal subject. */
export interface WithdrawalLockRow { visibility: string; fact: string; subject: string }

/** A page a withdrawal changed: its id, slug and knowledge revision. */
export interface WithdrawnPageRevision { id: number; slug: string; knowledge_revision: string }

/**
 * `readFactWithdrawnRow` / `readFactWithdrawnBacking`: the claim a save met a withdrawal of, its entity, the owned
 * memory page it is checked on (ownedPageWithdrawalSubject), and whether the caller cannot read private pages.
 */
export interface FactWithdrawnSpec { sourceId: string; visibility: string; fact: string; entitySlug: string | null; ownedPage: string | null; excludePrivate: boolean }

/** The withdrawal a refusal names: its subject, visibility and time (timestamptz text). */
export interface FactWithdrawnRow { subject: string; withdrawn_at: string; visibility: 'world' | 'private' }

export async function lockFactForWithdrawal(exec: SqlExecutor, spec: WithdrawalLockSpec): Promise<WithdrawalLockRow | null> {
  const [row] = await exec.executeRaw<WithdrawalLockRow>(spec.remoteFloor ? LOCK_FACT_FOR_WITHDRAWAL_FLOOR_SQL : LOCK_FACT_FOR_WITHDRAWAL_SQL,
    [spec.id, spec.sourceId, spec.worldOnly, spec.memberPage ?? null]);
  return row ?? null;
}

export async function queueWithdrawalReview(exec: SqlExecutor, sourceId: string, factRef: string): Promise<void> {
  await exec.executeRaw(`INSERT INTO decide_review_queue(kind,source_id,a_ref) VALUES ('withdraw',$1,$2) ON CONFLICT DO NOTHING`, [sourceId, factRef]);
}

export async function listSegmentedPagesBySlug(exec: LegacyUnscopedRead, sourceId: string, slugs: readonly string[]): Promise<Array<{ id: number; slug: string }>> {
  return exec.executeRaw<{ id: number; slug: string }>(`SELECT id,slug FROM pages
        WHERE source_id=$1 AND slug=ANY($2::text[]) AND body_storage='segmented'`, [sourceId, slugs]);
}

export async function bumpWithdrawnPageRevisions(exec: SqlExecutor, sourceId: string, slugs: readonly string[]): Promise<WithdrawnPageRevision[]> {
  return exec.executeRaw<WithdrawnPageRevision>(
    `UPDATE pages SET knowledge_revision=gen_random_uuid(),text_projection_revision=NULL,embedding_signature=NULL
          WHERE source_id=$1 AND slug=ANY($2::text[]) AND body_storage<>'segmented' RETURNING id,slug,knowledge_revision`, [sourceId, slugs]);
}

export async function readPageRevisions(exec: LegacyUnscopedRead, ids: readonly number[]): Promise<WithdrawnPageRevision[]> {
  return exec.executeRaw<WithdrawnPageRevision>('SELECT id,slug,knowledge_revision FROM pages WHERE id=ANY($1::int[])', [ids]);
}

export async function appendFactForgetReason(exec: SqlExecutor, id: number, sourceId: string, note: string): Promise<void> {
  await exec.executeRaw(`UPDATE facts SET context=concat_ws(' | ',NULLIF(context,''),$3::text)
        WHERE id=$1 AND source_id=$2`, [id, sourceId, note]);
}

export async function readFactWithdrawnBacking(exec: LegacyUnscopedRead, spec: FactWithdrawnSpec): Promise<{ visible: boolean; hidden: boolean }> {
  const [backing] = await exec.executeRaw<{ visible: boolean; hidden: boolean }>(FACT_WITHDRAWN_BACKING_SQL,
    [spec.sourceId, spec.visibility, spec.fact, spec.entitySlug, spec.ownedPage]);
  return { visible: backing?.visible === true, hidden: backing?.hidden === true };
}

export async function readFactWithdrawnRow(exec: LegacyUnscopedRead, spec: FactWithdrawnSpec): Promise<FactWithdrawnRow | null> {
  const [row] = await exec.executeRaw<FactWithdrawnRow>(FACT_WITHDRAWN_ROW_SQL,
    [spec.sourceId, spec.visibility, spec.fact, spec.entitySlug, spec.excludePrivate === true, spec.ownedPage]);
  return row ?? null;
}
