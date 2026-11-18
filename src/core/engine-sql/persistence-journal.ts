/**
 * Write-journal statements: one SQL implementation for both engines (Rust engine persistence, slice 1).
 *
 * These are the statements `src/core/persistence/journal.ts`, `limits.ts` and `held-reads.ts` sent through
 * `executeRaw`: the journal limit read, the two hold reads, the request reads, the counter lock, the admission
 * insert, the claim stamp and the completion. The text is unchanged, written out in full so this module imports no
 * persistence code (journal.ts pulls in most of the codebase, which an engine must not load).
 * `test/persistence-journal-statements.test.ts` checks each written-out statement against the journal's builders.
 * Decisions (who may claim, whether a write fits, what a refusal says) stay with the callers.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor, QueryOpts } from './executor.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { JOURNAL_LIMITS_SQL } from '../persistence/limits.ts';

/** The op of a held file's checkpoint row (sync-holds.ts re-exports it). */
export const GIT_HOLD_OP = 'sync-hold';
/** The op of a source's held-file summary row (sync-holds.ts re-exports it). */
export const GIT_HOLD_SUMMARY_OP = 'sync-hold-summary';

/** Creates missing counter rows; takes no lock on existing ones. Keys sorted. */
export const ENSURE_COUNTERS_SQL = 'INSERT INTO persistence_counters(key) SELECT k FROM unnest($1::text[]) WITH ORDINALITY AS u(k,n) ORDER BY n ON CONFLICT DO NOTHING';
/** Locks counter rows in one global order (deadlock avoidance). */
export const LOCK_COUNTERS_SQL = 'SELECT * FROM persistence_counters WHERE key=ANY($1::text[]) ORDER BY key COLLATE "C" FOR UPDATE';

/** The request row and its counter reservation in one statement; the counters are already locked. */
export const ADMIT_WRITE_SQL = `WITH reserved AS (UPDATE persistence_counters SET outstanding_count=outstanding_count+1,
      intent_bytes=intent_bytes+$14,lifetime_ids=lifetime_ids+1,terminal_bytes=terminal_bytes+$15 WHERE key=ANY($20::text[]))
      INSERT INTO persistence_requests
      (principal_kind,principal_id,request_id,operation,source_id,source_incarnation,page_id,slug,
       worktree_id,topology_generation,digest,intent,authority,intent_bytes,terminal_reservation,target_kind,protocol_version,
       admitter_version,admitter_host_id,client_request_id,admitter_segment_reader,state,deferred_refresh_id)
      VALUES($1,$2,$3::uuid,$4,$5,$6::uuid,$7,$8,$9::uuid,$10,$11,$12::text::jsonb,$13::text::jsonb,$14,$15,$16,$17,$18,$19::uuid,$21,true,$22,$23::uuid)
      RETURNING *`;

/** The claim of one request row, with whether it went ahead of a queued sync row of its root and, for a sync row, the newest sequence. */
export const CLAIM_STAMP_SQL = `UPDATE persistence_requests SET state='running',
      execution_token=$2::uuid,claim_expires_at=now()+($3::double precision*interval '1 millisecond'),
      updated_at=now(),blocked_reason=NULL,claim_phase=$4::text::jsonb WHERE id=$1::uuid AND set_config('gbrain.refresh_barrier','1',true)='1' RETURNING *,EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE earlier.worktree_id=persistence_requests.worktree_id AND earlier.sequence<persistence_requests.sequence
        AND earlier.state='queued' AND COALESCE(earlier.intent->>'kind','') LIKE 'managed_sync_%') AS passed_sync,
        CASE WHEN COALESCE(persistence_requests.intent->>'kind','') LIKE 'managed_sync_%' THEN (SELECT max(sequence) FROM persistence_requests)::text END AS seen_sequence`;

/**
 * The completion: sizes the queued effects, checks the terminal reservation, completes the row and releases its
 * outstanding counters in one statement. No row means the encoding exceeds the reservation and nothing changed.
 */
export const COMPLETE_WRITE_SQL = `WITH effects AS (SELECT COALESCE(SUM(octet_length(data::text)+octet_length(kind)+1024),0) AS bytes,
      COALESCE(bool_or(state<>'committed'),false) AS unfinished FROM persistence_effects WHERE request_id=$1::uuid),
    done AS (UPDATE persistence_requests SET state=$2,outcome=$3::text::jsonb,
      error_code=$4,error_message=$5,error_detail=COALESCE($8::text::jsonb,error_detail),completed_at=now(),updated_at=now(),claim_expires_at=NULL,blocked_reason=NULL,
      consumer_version=CASE WHEN $2='committed' THEN $6 ELSE consumer_version END,
      consumer_host_id=CASE WHEN $2='committed' THEN $7::uuid ELSE consumer_host_id END,
      consumer_segment_reader=CASE WHEN $2='committed' THEN true ELSE consumer_segment_reader END,
      published_at=CASE WHEN $2='committed' THEN now() ELSE published_at END,
      preparation_attempts=CASE WHEN $2='committed' THEN 0 ELSE preparation_attempts END,
      terminal_reservation=CASE WHEN (SELECT unfinished FROM effects) THEN terminal_reservation
        ELSE LEAST(terminal_reservation,$12::bigint+(SELECT bytes FROM effects)) END
      WHERE id=$1::uuid AND $9::bigint+(SELECT bytes FROM effects)<=terminal_reservation RETURNING *),
    released AS (UPDATE persistence_counters c SET outstanding_count=c.outstanding_count-1,intent_bytes=c.intent_bytes-$11,
      terminal_bytes=c.terminal_bytes-LEAST($13::bigint-done.terminal_reservation,c.terminal_bytes)
      FROM done WHERE c.key=ANY($10::text[])),
    clamped AS (INSERT INTO config(key,value) SELECT 'persistence.true_up.clamped',k.n::text FROM (SELECT count(*) FROM persistence_counters c, done WHERE c.key=ANY($10::text[]) AND $13::bigint-done.terminal_reservation>c.terminal_bytes) AS k(n) WHERE k.n>0
      ON CONFLICT (key) DO UPDATE SET value=(CASE WHEN config.value ~ '^[0-9]+$' THEN config.value::bigint ELSE 0 END+EXCLUDED.value::bigint)::text)
    SELECT done.* FROM done`;

/** The completion that also reports whether the source has fact or page purges (an intent that carries content). */
export const COMPLETE_WRITE_PURGE_PROBE_SQL = `WITH effects AS (SELECT COALESCE(SUM(octet_length(data::text)+octet_length(kind)+1024),0) AS bytes,
      COALESCE(bool_or(state<>'committed'),false) AS unfinished FROM persistence_effects WHERE request_id=$1::uuid),
    done AS (UPDATE persistence_requests SET state=$2,outcome=$3::text::jsonb,
      error_code=$4,error_message=$5,error_detail=COALESCE($8::text::jsonb,error_detail),completed_at=now(),updated_at=now(),claim_expires_at=NULL,blocked_reason=NULL,
      consumer_version=CASE WHEN $2='committed' THEN $6 ELSE consumer_version END,
      consumer_host_id=CASE WHEN $2='committed' THEN $7::uuid ELSE consumer_host_id END,
      consumer_segment_reader=CASE WHEN $2='committed' THEN true ELSE consumer_segment_reader END,
      published_at=CASE WHEN $2='committed' THEN now() ELSE published_at END,
      preparation_attempts=CASE WHEN $2='committed' THEN 0 ELSE preparation_attempts END,
      terminal_reservation=CASE WHEN (SELECT unfinished FROM effects) THEN terminal_reservation
        ELSE LEAST(terminal_reservation,$12::bigint+(SELECT bytes FROM effects)) END
      WHERE id=$1::uuid AND $9::bigint+(SELECT bytes FROM effects)<=terminal_reservation RETURNING *),
    released AS (UPDATE persistence_counters c SET outstanding_count=c.outstanding_count-1,intent_bytes=c.intent_bytes-$11,
      terminal_bytes=c.terminal_bytes-LEAST($13::bigint-done.terminal_reservation,c.terminal_bytes)
      FROM done WHERE c.key=ANY($10::text[])),
    clamped AS (INSERT INTO config(key,value) SELECT 'persistence.true_up.clamped',k.n::text FROM (SELECT count(*) FROM persistence_counters c, done WHERE c.key=ANY($10::text[]) AND $13::bigint-done.terminal_reservation>c.terminal_bytes) AS k(n) WHERE k.n>0
      ON CONFLICT (key) DO UPDATE SET value=(CASE WHEN config.value ~ '^[0-9]+$' THEN config.value::bigint ELSE 0 END+EXCLUDED.value::bigint)::text)
    SELECT done.*, EXISTS (SELECT 1 FROM fact_purges WHERE source_id=done.source_id) AS purge_has_facts,
    EXISTS (SELECT 1 FROM page_purges WHERE source_id=done.source_id) AS purge_has_pages FROM done`;

/** One counter row as the admission checks read it. */
export interface CounterRow { key: string; outstanding_count: number | string; intent_bytes: number | string; lifetime_ids: number | string; terminal_bytes: number | string; recovery_bytes: number | string }

/** A request row to admit, with the counter keys its reservation charges. */
export interface WriteRequestInsert {
  principalKind: string; principalId: string; requestId: string; operation: string; sourceId: string; sourceIncarnation: string;
  pageId: number | null; slug: string | null; worktreeId: string | null; topologyGeneration: number | string | null; digest: string;
  intent: unknown; authority: unknown; intentBytes: number; terminalReservation: number; targetKind: string; protocolVersion: number;
  admitterVersion: string; admitterHostId: string | null; counterKeys: string[]; clientRequestId: string | null; state: 'queued' | 'deferred';
  deferredRefreshId: string | null;
}

/** The terminal state of one request and the numbers its completion statement needs. */
export interface WriteCompletion {
  id: string; state: 'committed' | 'conflict' | 'failed' | 'cancelled'; outcome: unknown; errorCode: string | null; errorMessage: string | null;
  consumerVersion: string; consumerHostId: string | null; errorDetail: unknown; resultBytes: number; counterKeys: string[]; intentBytes: number;
  retainedBytes: number; terminalReservation: number; probePurges: boolean;
}

/** The claimed row: the request as stamped, whether it passed a queued sync row, and the newest sequence for a sync row. */
export type ClaimedWriteRow = WriteRequest & { passed_sync: boolean; seen_sequence: string | null };
/** A completed row; the purge columns are present only when the completion probed purges. */
export type CompletedWriteRow = WriteRequest & { purge_has_facts?: boolean; purge_has_pages?: boolean };

/** The journal's config rows (key, value) and its last row (key null): the largest page stored in segments, or 'unindexed'. */
export function readJournalLimitRows(exec: LegacyUnscopedRead): Promise<Array<{ key: string | null; value: string | null }>> {
  return exec.executeRaw<{ key: string | null; value: string | null }>(JOURNAL_LIMITS_SQL);
}

/** The held-page read: $1 the hold op, $2 the page ids as text. Joins each hold to its page by key. */
export const HELD_PAGES_SQL = `SELECT h.completed_keys->0 AS record, p.knowledge_revision::text AS revision
      FROM op_checkpoints h
      JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
      LEFT JOIN pages p ON p.id=(h.completed_keys->0->>'page_id')::int
      WHERE h.op=$1 AND (h.completed_keys->0->>'page_id')=ANY($2::text[])
      ORDER BY h.fingerprint`;

/** The current-incarnation hold rows naming these page ids, each with its page's revision, in fingerprint order. */
export function readHeldPageRows<R>(exec: LegacyUnscopedRead, pageIds: string[]): Promise<Array<{ record: R; revision: string | null }>> {
  return exec.executeRaw<{ record: R; revision: string | null }>(HELD_PAGES_SQL, [GIT_HOLD_OP, pageIds]);
}

/** One source's held-file counts from its summary row. */
export interface HeldCoverageRow { source_id: string; count: number | string; stale: number | string; fences: number | string; concurrent: number | string; stalled: number | string; dirty: number | string; drift: number | string }

/** The held-file summary rows of live sources with at least one held file, in source order; null `sourceIds` reads every source. */
export function readHeldCoverageRows(exec: LegacyUnscopedRead, sourceIds: string[] | null): Promise<HeldCoverageRow[]> {
  return exec.executeRaw<HeldCoverageRow>(`SELECT s.id AS source_id,
        COALESCE((h.completed_keys->0->>'count')::int,0) AS count, COALESCE((h.completed_keys->0->>'stale')::int,0) AS stale,
        COALESCE((h.completed_keys->0->>'fences')::int,0) AS fences, COALESCE((h.completed_keys->0->>'concurrent')::int,0) AS concurrent,
        COALESCE((h.completed_keys->0->>'stalled')::int,0) AS stalled, COALESCE((h.completed_keys->0->>'dirty')::int,0) AS dirty,
        COALESCE((h.completed_keys->0->>'drift')::int,0) AS drift
      FROM op_checkpoints h JOIN sources s ON h.fingerprint=s.id||':'||s.incarnation::text
      WHERE h.op=$1 AND s.archived IS NOT TRUE AND ($2::text[] IS NULL OR s.id=ANY($2::text[]))
        AND COALESCE((h.completed_keys->0->>'count')::int,0)>0
      ORDER BY s.id`, [GIT_HOLD_SUMMARY_OP, sourceIds]);
}

/** The request a principal admitted under `requestId`, or null. */
export async function readWriteRequest(exec: LegacyUnscopedRead, principalKind: string, principalId: string, requestId: string): Promise<WriteRequest | null> {
  const [row] = await exec.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid',
    [principalKind, principalId, requestId]);
  return row ?? null;
}

/** The request with journal id `id`, or null. */
export async function readWriteRequestById(exec: LegacyUnscopedRead, id: string, opts?: QueryOpts): Promise<WriteRequest | null> {
  const [row] = await exec.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [id], opts);
  return row ?? null;
}

/**
 * Creates the missing counter rows and locks all of them in key order. On Postgres both statements are sent before
 * either is awaited (one round trip); a statement sent after the one that failed reports 25P02, so the error
 * thrown is the other one. Pipelining keeps their order only on one connection, so on Postgres `exec` must be a
 * transaction's (the engine member opens one when its caller has none).
 */
export async function lockPersistenceCounters(exec: SqlExecutor, keys: readonly string[]): Promise<CounterRow[]> {
  const sorted = [...new Set(keys)].sort();
  if (exec.dialect !== 'postgres') {
    await exec.executeRaw(ENSURE_COUNTERS_SQL, [sorted]);
    return exec.executeRaw<CounterRow>(LOCK_COUNTERS_SQL, [sorted]);
  }
  const settled = await Promise.allSettled([exec.executeRaw(ENSURE_COUNTERS_SQL, [sorted]), exec.executeRaw<CounterRow>(LOCK_COUNTERS_SQL, [sorted])]);
  const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
  const failed = rejected.find(s => (s.reason as { code?: unknown } | null)?.code !== '25P02') ?? rejected[0];
  if (failed) throw failed.reason;
  return (settled[1] as PromiseFulfilledResult<CounterRow[]>).value;
}

/** Inserts the request row and charges its counters (already locked); returns the stored row. */
export async function insertWriteRequest(exec: SqlExecutor, row: WriteRequestInsert): Promise<WriteRequest> {
  const [inserted] = await exec.executeRaw<WriteRequest>(ADMIT_WRITE_SQL, [row.principalKind, row.principalId, row.requestId, row.operation, row.sourceId,
    row.sourceIncarnation, row.pageId, row.slug, row.worktreeId, row.topologyGeneration, row.digest, JSON.stringify(row.intent),
    JSON.stringify(row.authority), row.intentBytes, row.terminalReservation, row.targetKind, row.protocolVersion, row.admitterVersion,
    row.admitterHostId, row.counterKeys, row.clientRequestId, row.state, row.deferredRefreshId]);
  return inserted!;
}

/** Stamps the claim on request `id` (running, its token, its lease and its first phase); null when the refresh barrier refused it. */
export async function stampWriteClaim(exec: SqlExecutor, id: string, token: string, leaseMs: number, phaseJson: string): Promise<ClaimedWriteRow | null> {
  const [claimed] = await exec.executeRaw<ClaimedWriteRow>(CLAIM_STAMP_SQL, [id, token, leaseMs, phaseJson]);
  return claimed ?? null;
}

/** Request `id` locked FOR UPDATE until the transaction ends, or null. */
export async function lockWriteRequest(exec: SqlExecutor, id: string): Promise<WriteRequest | null> {
  const [row] = await exec.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [id]);
  return row ?? null;
}

/** Records a request's terminal state and releases its counters; null when the result exceeds the reservation (nothing changed). */
export async function completeWriteRow(exec: SqlExecutor, c: WriteCompletion): Promise<CompletedWriteRow | null> {
  const [done] = await exec.executeRaw<CompletedWriteRow>(c.probePurges ? COMPLETE_WRITE_PURGE_PROBE_SQL : COMPLETE_WRITE_SQL, [c.id, c.state,
    JSON.stringify(c.outcome), c.errorCode, c.errorMessage, c.consumerVersion, c.consumerHostId,
    c.errorDetail ? JSON.stringify(c.errorDetail) : null, c.resultBytes, c.counterKeys, c.intentBytes, c.retainedBytes, c.terminalReservation]);
  return done ?? null;
}
