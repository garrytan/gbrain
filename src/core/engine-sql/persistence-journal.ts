/**
 * Write-journal statements: one SQL implementation for both engines (Rust engine persistence, slice 1).
 *
 * These are the statements `src/core/persistence/journal.ts`, `limits.ts` and `held-reads.ts` sent through
 * `executeRaw`: the journal limit read, the two hold reads, the request reads, the counter lock, the admission
 * insert, the claim stamp, the completion and the publication's effects insert (effect-journal.ts). The text is
 * unchanged, written out in full so this module imports no persistence code (journal.ts pulls in most of the
 * codebase, which an engine must not load).
 * `test/persistence-journal-statements.test.ts` checks each written-out statement against the journal's builders.
 * Decisions (who may claim, whether a write fits, what a refusal says) stay with the callers.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import { COVERAGE_COUNT_CAP } from '../search/retrieval-coverage.ts';
import type { SqlExecutor, QueryOpts } from './executor.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { JOURNAL_LIMITS_SQL } from '../persistence/limits.ts';
import { COMPACTED_RECEIPT_BYTES_SQL, EFFECT_BYTES_SQL } from '../persistence/receipt-bytes.ts';
import { TOKEN_GRANT_ROW_COLUMNS, type TokenGrantRow } from '../grants/model.ts';
import { sqlFragment, trustedSql } from './fragment.ts';
import { GIT_HOLD_SUMMARY_OP, MANAGED_SYNC_PASS_OP } from './sync-hold-op.ts';

/** The op of a held file's checkpoint row (sync-holds.ts re-exports it). */
export const GIT_HOLD_OP = 'sync-hold';
/** The op of a source's held-file summary row (sync-holds.ts re-exports it). */
export { GIT_HOLD_SUMMARY_OP };

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

/** One page of a grouped admission (`insertWriteRequestGroup`). */
export interface WriteRequestGroupItem {
  requestId: string; pageId: number | null; slug: string | null; digest: string; intent: unknown; intentBytes: number;
  terminalReservation: number; clientRequestId: string | null;
}
/** A grouped admission's shared columns and its pages in manifest order; every row is a queued page write, protocol 1. */
export interface WriteRequestGroupInsert {
  principalKind: string; principalId: string; operation: string; sourceId: string; sourceIncarnation: string; worktreeId: string | null;
  topologyGeneration: number | string | null; authority: unknown; admitterVersion: string; admitterHostId: string | null; counterKeys: string[];
  items: WriteRequestGroupItem[];
}

/** The terminal state of one request and the numbers its completion statement needs. */
export interface WriteCompletion {
  id: string; state: 'committed' | 'conflict' | 'failed' | 'cancelled'; outcome: unknown; errorCode: string | null; errorMessage: string | null;
  consumerVersion: string; consumerHostId: string | null; errorDetail: unknown; resultBytes: number; counterKeys: string[]; intentBytes: number;
  retainedBytes: number; terminalReservation: number; probePurges: boolean;
}

/**
 * A cancellation: the completion of a request that is still in `expectState` under `expectExecutionToken`, not
 * terminal, not publishing and not in recovery. The engine checks that and completes the row in one step.
 */
export interface WriteCancellation extends Omit<WriteCompletion, 'state'> { state: 'cancelled'; expectState: string; expectExecutionToken: string | null }
/**
 * `cancelled`: the completed row. `kept`: the row was terminal, publishing, in recovery, or no longer the row the
 * caller read, and nothing changed. `too_large`: the result exceeds the reservation, and nothing changed.
 */
export type WriteCancelResult = { status: 'cancelled'; row: CompletedWriteRow } | { status: 'kept' | 'too_large'; row: WriteRequest };

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
      ORDER BY h.fingerprint COLLATE "C"`;

/** The current-incarnation hold rows naming these page ids, each with its page's revision, in fingerprint order. */
export function readHeldPageRows<R>(exec: LegacyUnscopedRead, pageIds: string[]): Promise<Array<{ record: R; revision: string | null }>> {
  return exec.executeRaw<{ record: R; revision: string | null }>(HELD_PAGES_SQL, [GIT_HOLD_OP, pageIds]);
}

/** The query of `readHeldHitRows`: the hits' page ids, the read's live sources, and the relevance types and patterns. */
export interface HeldHitQuery { pageIds: string[]; sourceIds: string[]; types: string[]; patterns: string[] }
/** The hold rows of the hits (`record` and the page's `revision`), then one row with `could_affect` alone. */
export interface HeldHitRow<R> { record: R | null; revision: string | null; could_affect: number | string | null }
// moved from persistence/held-reads.ts stampHeldHits unchanged, with its HOLD_PAGE_JOIN and COVERAGE_COUNT_CAP (1000) written out
const HELD_HIT_ROWS_SQL = `(SELECT h.completed_keys->0 AS record, p.knowledge_revision::text AS revision, NULL::int AS could_affect FROM op_checkpoints h
      JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
      LEFT JOIN pages p ON p.id=(h.completed_keys->0->>'page_id')::int
        WHERE h.op=$1 AND (h.completed_keys->0->>'page_id')=ANY($2::text[]) ORDER BY h.fingerprint COLLATE "C")
      UNION ALL
      SELECT NULL, NULL, (SELECT count(*)::int FROM (SELECT 1 FROM op_checkpoints h
      JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
      LEFT JOIN pages p ON p.id=(h.completed_keys->0->>'page_id')::int
        WHERE h.op=$1 AND s.archived IS NOT TRUE AND s.id=ANY($3::text[])
          AND ((h.completed_keys->0->>'page_id')=ANY($2::text[]) OR p.type=ANY($4::text[])
            OR lower(concat_ws(' ', h.completed_keys->0->>'path', h.completed_keys->0->>'slug', p.title)) ~ ANY($5::text[]))
        LIMIT 1000) x)`;
// The cap is the coverage count cap every engine applies; a change to one must change the other.
if (!HELD_HIT_ROWS_SQL.includes(`LIMIT ${COVERAGE_COUNT_CAP}) x)`)) throw new Error('readHeldHitRows: the LIMIT is not COVERAGE_COUNT_CAP');

/** The current-incarnation holds naming the hits' pages, in fingerprint order, then how many held files (capped) could affect the read. */
export function readHeldHitRows<R>(exec: LegacyUnscopedRead, query: HeldHitQuery): Promise<Array<HeldHitRow<R>>> {
  return exec.executeRaw<HeldHitRow<R>>(HELD_HIT_ROWS_SQL, [GIT_HOLD_OP, query.pageIds, query.sourceIds, query.types, query.patterns]);
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
      ORDER BY s.id COLLATE "C"`, [GIT_HOLD_SUMMARY_OP, sourceIds]);
}

/** The request a principal admitted under `requestId`, or null. */
export async function readWriteRequest(exec: LegacyUnscopedRead, principalKind: string, principalId: string, requestId: string): Promise<WriteRequest | null> {
  const [row] = await exec.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid',
    [principalKind, principalId, requestId]);
  return row ?? null;
}

/** The requests a principal admitted under any of `requestIds` (uuids), in no order. */
export function readWriteRequestsByRequestIds(exec: LegacyUnscopedRead, principalKind: string, principalId: string, requestIds: readonly string[]): Promise<WriteRequest[]> {
  return exec.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=ANY($3::uuid[])',
    [principalKind, principalId, requestIds]);
}

/** The owner host's checkout path of worktree `worktreeId` (its host binding's `local_path`), or null when it has no owner or no binding. */
export async function readOwnerHostBinding(exec: LegacyUnscopedRead, worktreeId: string): Promise<string | null> {
  const [binding] = await exec.executeRaw<{ local_path: string | null }>(`SELECT h.local_path FROM persistence_host_bindings h
      JOIN persistence_worktrees w ON w.id=h.worktree_id AND w.owner_host_id=h.host_id WHERE w.id=$1::uuid`, [worktreeId]);
  return binding?.local_path ?? null;
}

/**
 * At most two request rows with this request_id, whoever submitted them (ops/persistence.ts hostOperatorReceipt): the
 * trusted local CLI reads a receipt by request_id alone only when exactly one row has it.
 */
export async function readWriteRequestsByRequestId(exec: LegacyUnscopedRead, requestId: string): Promise<WriteRequest[]> {
  return exec.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid LIMIT 2', [requestId]);
}

/**
 * `listWriteRequestRows` filters. `before` is a sequence as decimal text; a null list skips its fence and an empty
 * list matches nothing. `slugPrefixes` are lower-case (one ending in `/` matches under it, any other matches the slug
 * or under it); `operations` match `authority.attestedOp`, else `operation`; `slugAllowList` holds exact slugs or
 * `<prefix>/*`.
 */
export interface WriteRequestListFilter {
  before: string | null; limit: number; slugPrefixes: string[] | null; operations: string[] | null; slugAllowList: string[] | null;
}

/**
 * One candidate page of `list_write_requests` (persistence/control.ts): a principal's requests in one live source
 * (the source has the request's incarnation and is not archived), newest sequence first, through the filter. The
 * caller authorizes each row and pages.
 */
export function listWriteRequestRows(exec: LegacyUnscopedRead, principalKind: string, principalId: string, sourceId: string,
  filter: WriteRequestListFilter): Promise<WriteRequest[]> {
  return exec.executeRaw<WriteRequest>(`SELECT r.* FROM persistence_requests r
      JOIN sources s ON s.id=r.source_id AND s.incarnation=r.source_incarnation AND NOT s.archived
      WHERE r.principal_kind=$1 AND r.principal_id=$2 AND r.source_id=$3
      AND ($4::bigint IS NULL OR r.sequence<$4::bigint)
      AND ($6::text[] IS NULL OR EXISTS (SELECT 1 FROM unnest($6::text[]) AS p(prefix)
        WHERE length(p.prefix)>0 AND (CASE WHEN right(p.prefix,1)='/'
          THEN left(lower(r.slug),length(p.prefix))=p.prefix
          ELSE lower(r.slug)=p.prefix OR left(lower(r.slug),length(p.prefix)+1)=p.prefix||'/' END)))
      AND ($7::text[] IS NULL OR COALESCE(r.authority->>'attestedOp', r.operation)=ANY($7::text[]))
      AND ($8::text[] IS NULL OR EXISTS (SELECT 1 FROM unnest($8::text[]) AS a(pattern)
        WHERE CASE WHEN right(a.pattern,2)='/*' THEN left(r.slug,length(a.pattern)-1)=left(a.pattern,length(a.pattern)-1)
          ELSE r.slug=a.pattern END))
      ORDER BY r.sequence DESC LIMIT $5`,
  [principalKind, principalId, sourceId, filter.before, filter.limit, filter.slugPrefixes, filter.operations, filter.slugAllowList]);
}

/** The request with journal id `id`, or null. */
export async function readWriteRequestById(exec: LegacyUnscopedRead, id: string, opts?: QueryOpts): Promise<WriteRequest | null> {
  const [row] = await exec.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [id], opts);
  return row ?? null;
}

/** The requests admitted under any of the client request ids `requestIds`, any principal, by sequence. */
export async function listWriteRequestsByRequestIds(exec: LegacyUnscopedRead, requestIds: readonly string[]): Promise<WriteRequest[]> {
  if (!requestIds.length) return [];
  return exec.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=ANY($1::uuid[]) ORDER BY sequence', [[...requestIds]]);
}

/** #5984: the columns a waiter needs while a request is unfinished; the full row is read once it is terminal. */
export type WriteRequestProgress = Pick<WriteRequest, 'state' | 'error_code' | 'error_message' | 'completed_at' | 'updated_at' | 'blocked_reason' | 'outcome' | 'deferred_refresh_id' | 'deferred_import_from'>;
/** The progress columns of request `id` (the wait loop's poll). */
export const WRITE_PROGRESS_SQL = 'SELECT state,error_code,error_message,completed_at,updated_at,blocked_reason,outcome,deferred_refresh_id,deferred_import_from FROM persistence_requests WHERE id=$1::uuid';
export async function readWriteRequestProgress(exec: LegacyUnscopedRead, id: string, opts?: QueryOpts): Promise<WriteRequestProgress | null> {
  const [row] = await exec.executeRaw<WriteRequestProgress>(WRITE_PROGRESS_SQL, [id], opts);
  return row ?? null;
}

/** One source holding outstanding requests of a principal, and how many. */
export interface OutstandingBySource { source_id: string; n: number }
/** The sources holding requests of one principal that are queued, deferred, running or recovering: the most first, a tie in byte order of the source id. */
export const OUTSTANDING_BY_SOURCE_SQL = `SELECT source_id,count(*) AS n FROM persistence_requests
    WHERE principal_kind=$1 AND principal_id=$2 AND state IN ('queued','deferred','running','recovering') GROUP BY source_id ORDER BY count(*) DESC,source_id COLLATE "C"`;
export async function countOutstandingBySource(exec: LegacyUnscopedRead, principalKind: string, principalId: string): Promise<OutstandingBySource[]> {
  const rows = await exec.executeRaw<{ source_id: string; n: number | string }>(OUTSTANDING_BY_SOURCE_SQL, [principalKind, principalId]);
  return rows.map(row => ({ source_id: row.source_id, n: Number(row.n) }));
}

/** Whether this connection's role is a member of the role that owns the gbrain tables (`sources` stands for them). */
export const OWNS_SCHEMA_TABLES_SQL = `SELECT pg_has_role(current_user, c.relowner, 'USAGE') AS owns FROM pg_class c WHERE c.oid = to_regclass('sources')`;
/** `ownsSchemaTables()`: false only when the role provably does not own the tables; a missing table reads as owned. */
export async function ownsSchemaTables(exec: LegacyUnscopedRead): Promise<boolean> {
  const [owner] = await exec.executeRaw<{ owns: boolean | null }>(OWNS_SCHEMA_TABLES_SQL);
  return owner?.owns !== false;
}

/**
 * The live grant of the OAuth client that owns a write (persistence/authority.ts `authorizeWrite`): the columns the
 * write re-check reads. Every value is the stored column as the driver returns it; the caller decides what it permits.
 */
export type OAuthClientWriteGrant = {
  deleted_at: unknown; scope: unknown; source_id: unknown; source_grant: unknown; allowed_operations: unknown;
  bound_slug_prefixes: unknown; bound_tools: unknown; delegated_namespace: unknown; delegated_slug_prefixes: unknown;
};
/** The live grant of the legacy token that owns a write: the token grant columns this brain has, and `revoked_at`. */
export type AccessTokenWriteGrant = TokenGrantRow & { revoked_at: unknown };

/** The OAuth client grant read `authorizeWrite` has always sent, plain and with `FOR SHARE` (written out: static text only). */
export const OAUTH_CLIENT_GRANT_SQL = `SELECT deleted_at,scope,source_id,source_grant,allowed_operations,
      bound_slug_prefixes,bound_tools,delegated_namespace,delegated_slug_prefixes FROM oauth_clients WHERE client_id=$1`;
export const OAUTH_CLIENT_GRANT_SHARE_SQL = `SELECT deleted_at,scope,source_id,source_grant,allowed_operations,
      bound_slug_prefixes,bound_tools,delegated_namespace,delegated_slug_prefixes FROM oauth_clients WHERE client_id=$1 FOR SHARE`;
/** `readOAuthClientWriteGrant(clientId, { lock })`: the client's grant row or null; `lock` holds it `FOR SHARE` so a revocation waits. */
export async function readOAuthClientWriteGrant(exec: LegacyUnscopedRead, clientId: string, opts: { lock?: boolean } = {}): Promise<OAuthClientWriteGrant | null> {
  const [row] = await exec.executeRaw<OAuthClientWriteGrant>(opts.lock ? OAUTH_CLIENT_GRANT_SHARE_SQL : OAUTH_CLIENT_GRANT_SQL, [clientId]);
  return row ?? null;
}

/** The access_tokens columns this brain has (a column a pending migration adds reads as absent). */
export const ACCESS_TOKEN_COLUMNS_SQL = "SELECT attname FROM pg_attribute WHERE attrelid=to_regclass('access_tokens') AND attnum>0 AND NOT attisdropped";
/** The select list of the token grant columns (grants/model.ts `TOKEN_GRANT_ROW_COLUMNS`, constant names) present in `present`. */
export function tokenGrantSelectList(present: ReadonlySet<string>): string {
  return TOKEN_GRANT_ROW_COLUMNS.filter(c => present.has(c)).join(',');
}
/**
 * `readAccessTokenWriteGrant(tokenId, { lock })`: the token's grant row or null, named columns only (GST-2314: a
 * prepared SELECT * cached before a migration added a column fails 0A000 inside the transaction); `lock` holds it
 * `FOR SHARE`. The same two statements grants/model.ts `tokenGrantRowSelect` and authority.ts sent.
 */
export async function readAccessTokenWriteGrant(exec: LegacyUnscopedRead, tokenId: string, opts: { lock?: boolean } = {}): Promise<AccessTokenWriteGrant | null> {
  const present = new Set((await exec.executeRaw<{ attname: string }>(ACCESS_TOKEN_COLUMNS_SQL)).map(c => c.attname));
  const { rows: [row] } = await exec.run<AccessTokenWriteGrant>(
    sqlFragment`SELECT ${trustedSql(tokenGrantSelectList(present))},revoked_at FROM access_tokens WHERE id=${tokenId}${opts.lock ? trustedSql(' FOR SHARE') : sqlFragment``}`);
  return row ?? null;
}

/** The credential locks `authorizeWrite` takes before it re-reads an attest right (GST-1113). */
export const LOCK_OAUTH_CLIENT_SHARE_SQL = 'SELECT 1 FROM oauth_clients WHERE client_id=$1 FOR SHARE';
export const LOCK_ACCESS_TOKEN_SHARE_SQL = 'SELECT 1 FROM access_tokens WHERE id=$1 FOR SHARE';
/** `shareLockWriteCredential(kind, id)`: holds the credential row `FOR SHARE` for the caller's transaction, so a concurrent removal commits before or after. */
export async function shareLockWriteCredential(exec: LegacyUnscopedRead, kind: 'oauth_client' | 'legacy_token', id: string): Promise<void> {
  await exec.executeRaw(kind === 'oauth_client' ? LOCK_OAUTH_CLIENT_SHARE_SQL : LOCK_ACCESS_TOKEN_SHARE_SQL, [id]);
}

/** The counter rows of `keys` that exist, unlocked (`readCounterRows`). */
export const READ_COUNTERS_SQL = 'SELECT * FROM persistence_counters WHERE key=ANY($1::text[]) ORDER BY key COLLATE "C"';
/** `readCounterRows(keys)`: the existing counter rows of `keys` in key byte order, without a lock; a missing key has no row. */
export async function readCounterRows(exec: LegacyUnscopedRead, keys: readonly string[]): Promise<CounterRow[]> {
  return exec.executeRaw<CounterRow>(READ_COUNTERS_SQL, [[...keys]]);
}

/**
 * The admission rate a one-year cap value projects (`readAdmissionRate`): the brain's first request id (so a reused engine
 * on another brain ignores rates cached for this one) and a sample of the latest 1,000 admissions, of one principal or of
 * the whole brain: how many, the age of the oldest in seconds, their mean reservation (`gross`) and mean compacted
 * receipt size (`net`). The three are null when nothing was admitted. With `{ sample: false }` it reads only the first
 * request id (the statement oneYearCapacity sends when cached forecast rates may apply, so a refusal under the counter
 * locks does not walk the sample) and answers no admissions.
 */
export interface AdmissionRate { first_request_id: string | null; admissions: number; age_seconds: number | null; gross: number | null; net: number | null }
const ADMISSION_RATE_SQL = (principal: boolean) => `WITH recent AS (
      SELECT id,created_at,terminal_reservation,authority,outcome,error_detail,client_request_id FROM persistence_requests
      ${principal ? 'WHERE principal_kind=$1 AND principal_id=$2' : ''} ORDER BY sequence DESC LIMIT 1000),
    e AS (SELECT request_id,SUM(${EFFECT_BYTES_SQL}) AS bytes FROM persistence_effects WHERE request_id IN (SELECT id FROM recent) GROUP BY request_id)
    SELECT (SELECT id::text FROM persistence_requests ORDER BY sequence LIMIT 1) AS first_request_id,
      count(*)::int AS admissions,EXTRACT(EPOCH FROM (now()-min(created_at)))::float8 AS age_seconds,avg(terminal_reservation)::float8 AS gross,
      avg(${COMPACTED_RECEIPT_BYTES_SQL('recent', 'e')})::float8 AS net FROM recent LEFT JOIN e ON e.request_id=recent.id`;
const FIRST_REQUEST_SQL = 'SELECT id::text AS first_request_id FROM persistence_requests ORDER BY sequence LIMIT 1';
export async function readAdmissionRate(exec: LegacyUnscopedRead, principal: { kind: string; id: string } | null, opts?: { sample?: boolean }): Promise<AdmissionRate> {
  if (opts?.sample === false) {
    const [first] = await exec.executeRaw<{ first_request_id: string }>(FIRST_REQUEST_SQL);
    return { first_request_id: first?.first_request_id ?? null, admissions: 0, age_seconds: null, gross: null, net: null };
  }
  const [row] = await exec.executeRaw<AdmissionRate>(ADMISSION_RATE_SQL(principal !== null), principal ? [principal.kind, principal.id] : []);
  const num = (v: number | string | null | undefined) => v === null || v === undefined ? null : Number(v);
  return { first_request_id: row?.first_request_id ?? null, admissions: Number(row?.admissions ?? 0), age_seconds: num(row?.age_seconds),
    gross: num(row?.gross), net: num(row?.net) };
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

/**
 * The grouped admission's rows and their counter reservation in one statement; the counters are already locked. The
 * rows are inserted in item order, so their sequences keep the manifest order.
 */
export const ADMIT_WRITE_GROUP_SQL = `WITH reserved AS (UPDATE persistence_counters SET outstanding_count=outstanding_count+$14,
      intent_bytes=intent_bytes+$12,lifetime_ids=lifetime_ids+$14,terminal_bytes=terminal_bytes+$13 WHERE key=ANY($15::text[]))
      INSERT INTO persistence_requests
      (principal_kind,principal_id,request_id,operation,source_id,source_incarnation,page_id,slug,
       worktree_id,topology_generation,digest,intent,authority,intent_bytes,terminal_reservation,target_kind,protocol_version,
       admitter_version,admitter_host_id,client_request_id,admitter_segment_reader)
      SELECT $1,$2,(e->>'request_id')::uuid,$3,$4,$5::uuid,(e->>'page_id')::integer,e->>'slug',$6::uuid,$7,e->>'digest',e->'intent',$8::text::jsonb,
        (e->>'intent_bytes')::bigint,(e->>'terminal_reservation')::bigint,'page',1,$9,$10::uuid,e->>'client_request_id',true
      FROM jsonb_array_elements($11::text::jsonb) WITH ORDINALITY AS t(e,n) ORDER BY n
      RETURNING *`;

/** Inserts a grouped admission's rows in item order and charges their counters (already locked); returns the stored rows. */
export async function insertWriteRequestGroup(exec: SqlExecutor, group: WriteRequestGroupInsert): Promise<WriteRequest[]> {
  if (!group.items.length) return [];
  const bytes = group.items.reduce((sum, item) => sum + item.intentBytes, 0), terminalBytes = group.items.reduce((sum, item) => sum + item.terminalReservation, 0);
  return exec.executeRaw<WriteRequest>(ADMIT_WRITE_GROUP_SQL, [group.principalKind, group.principalId, group.operation, group.sourceId, group.sourceIncarnation,
    group.worktreeId, group.topologyGeneration, JSON.stringify(group.authority), group.admitterVersion, group.admitterHostId,
    JSON.stringify(group.items.map(item => ({ request_id: item.requestId, page_id: item.pageId, slug: item.slug, digest: item.digest, intent: item.intent,
      intent_bytes: item.intentBytes, terminal_reservation: item.terminalReservation, client_request_id: item.clientRequestId }))),
    bytes, terminalBytes, group.items.length, group.counterKeys]);
}

/** Stamps the claim on request `id` (running, its token, its lease and its first phase); null when the refresh barrier refused it. */
export async function stampWriteClaim(exec: SqlExecutor, id: string, token: string, leaseMs: number, phaseJson: string): Promise<ClaimedWriteRow | null> {
  const [claimed] = await exec.executeRaw<ClaimedWriteRow>(CLAIM_STAMP_SQL, [id, token, leaseMs, phaseJson]);
  return claimed ?? null;
}

/** The one statement `lockWriteRequest` sends (a row lock, no row written): the shadow write sampler judges the member by it (shadow/write-capture.ts). */
export const LOCK_WRITE_REQUEST_SQL = 'SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE';

/** Request `id` locked FOR UPDATE until the transaction ends, or null. */
export async function lockWriteRequest(exec: SqlExecutor, id: string): Promise<WriteRequest | null> {
  const [row] = await exec.executeRaw<WriteRequest>(LOCK_WRITE_REQUEST_SQL, [id]);
  return row ?? null;
}

/** The requests with these ids, locked FOR UPDATE until the transaction ends, in id order (an unknown id reads nothing). */
export async function lockWriteRequestsById(exec: SqlExecutor, ids: readonly string[]): Promise<WriteRequest[]> {
  return exec.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
}

/**
 * A terminal request's compaction once its stored intent carried purged content (journal.ts finishTerminal). `left` is
 * what the receipt keeps without its intent, `reservation` the terminal reservation the completion left, `counterKeys`
 * the counters it charged.
 */
export interface TerminalIntentCompaction { id: string; left: number; reservation: number; counterKeys: readonly string[] }

/** journal.ts finishTerminal's compaction at b220b0df91, with EFFECT_BYTES_SQL written out (see the module header). */
export const COMPACT_TERMINAL_INTENT_SQL = `WITH effects AS (SELECT COALESCE(SUM(octet_length(data::text)+octet_length(kind)+1024),0) AS bytes,
        COALESCE(bool_or(state<>'committed'),false) AS unfinished FROM persistence_effects WHERE request_id=$1::uuid),
      r AS (UPDATE persistence_requests SET intent=NULL,compacted=true,terminal_reservation=CASE WHEN (SELECT unfinished FROM effects) THEN terminal_reservation
        ELSE LEAST(terminal_reservation,$2::bigint+(SELECT bytes FROM effects)) END WHERE id=$1::uuid RETURNING *),
      released AS (UPDATE persistence_counters c SET terminal_bytes=c.terminal_bytes-LEAST($3::bigint-r.terminal_reservation,c.terminal_bytes)
        FROM r WHERE c.key=ANY($4::text[]))
      SELECT * FROM r`;

/**
 * Drops the request's intent and marks it compacted. Its terminal reservation shrinks to `left` plus its effect bytes
 * once no effect is unfinished, and the counters release what it gave up. The compacted row, or null for an unknown id.
 */
export async function compactTerminalIntent(exec: SqlExecutor, c: TerminalIntentCompaction): Promise<WriteRequest | null> {
  const [redacted] = await exec.executeRaw<WriteRequest>(COMPACT_TERMINAL_INTENT_SQL, [c.id, c.left, c.reservation, c.counterKeys]);
  return redacted ?? null;
}

/** Records a request's terminal state and releases its counters; null when the result exceeds the reservation (nothing changed). */
export async function completeWriteRow(exec: SqlExecutor, c: WriteCompletion): Promise<CompletedWriteRow | null> {
  const [done] = await exec.executeRaw<CompletedWriteRow>(c.probePurges ? COMPLETE_WRITE_PURGE_PROBE_SQL : COMPLETE_WRITE_SQL, [c.id, c.state,
    JSON.stringify(c.outcome), c.errorCode, c.errorMessage, c.consumerVersion, c.consumerHostId,
    c.errorDetail ? JSON.stringify(c.errorDetail) : null, c.resultBytes, c.counterKeys, c.intentBytes, c.retainedBytes, c.terminalReservation]);
  return done ?? null;
}

/** Whether a locked request may still be cancelled under the caller's expectation (the same test the Rust store runs). */
function cancellable(row: WriteRequest, c: WriteCancellation): boolean {
  return !['committed', 'conflict', 'failed', 'cancelled'].includes(row.state) && row.state === c.expectState
    && (row.execution_token ?? null) === c.expectExecutionToken && !row.publication_started && row.recovery == null;
}

/**
 * Cancels request `c.id`: durable commit on, the row locked FOR UPDATE, the check, then the completion statement.
 * Null when the row does not exist.
 */
export async function cancelWriteRow(exec: SqlExecutor, c: WriteCancellation): Promise<WriteCancelResult | null> {
  const current = await lockWriteRequest(exec, c.id);
  if (!current) return null;
  if (!cancellable(current, c)) return { status: 'kept', row: current };
  await exec.executeRaw("SELECT set_config('synchronous_commit','on',true)");
  const done = await completeWriteRow(exec, c);
  return done ? { status: 'cancelled', row: done } : { status: 'too_large', row: current };
}

/** The config key that turns a remote write's mention links off (effect-model.ts `REMOTE_AUTO_LINKS_KEY`; the statement test pins the two). */
export const REMOTE_AUTO_LINKS_CONFIG_KEY = 'mcp.remote_auto_links';

/**
 * #6007: a publication's effects, inserted together in queue order by one statement. A `gated` effect (the mention
 * `links` effect) inserts nothing while config `auto_link` or `mcp.remote_auto_links` is off; unset is on. An effect
 * already queued for the request keeps its row. The config value test is edge-whitespace.ts `asciiLowerSql(edgeTrimSql('value'))`
 * written out; test/persistence-journal-statements.test.ts checks it against that fragment.
 */
export const PUBLICATION_EFFECTS_SQL = `INSERT INTO persistence_effects (request_id,kind,revision,data,source_id,source_incarnation,worktree_id)
    SELECT $1::uuid,t.e->>'kind',$2::uuid,t.e->'data',$3,$4::uuid,$5::uuid FROM jsonb_array_elements($6::text::jsonb) WITH ORDINALITY AS t(e,n)
    WHERE NOT (COALESCE((t.e->>'gated')::boolean,false) AND EXISTS (SELECT 1 FROM config
      WHERE key IN ('auto_link',$7) AND translate(btrim(value, (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('false','0','no','off')))
    ORDER BY t.n ON CONFLICT(request_id,kind) DO NOTHING RETURNING kind`;

/** One effect a publication queues: its kind, its data, and whether the auto-link switches gate it. */
export interface QueuedPublicationEffect { kind: string; data: Record<string, unknown>; gated?: boolean }

/** What `insertPublicationEffects` inserts: the request's identity columns and its effects in queue order (at least one). */
export interface PublicationEffectsSpec {
  requestId: string;
  /** The revision the publication wrote, or null when it wrote none. */
  revision: string | null;
  sourceId: string;
  sourceIncarnation: string;
  worktreeId: string | null;
  effects: readonly QueuedPublicationEffect[];
}

/** The effects insert's parameters for one spec. */
export function publicationEffectsParams(spec: PublicationEffectsSpec): unknown[] {
  return [spec.requestId, spec.revision, spec.sourceId, spec.sourceIncarnation, spec.worktreeId, JSON.stringify(spec.effects), REMOTE_AUTO_LINKS_CONFIG_KEY];
}

/** Inserts a publication's effects; returns the kinds it inserted, in queue order (a gated or already queued kind is missing). */
export async function insertPublicationEffects(exec: SqlExecutor, spec: PublicationEffectsSpec): Promise<string[]> {
  const rows = await exec.executeRaw<{ kind: string }>(PUBLICATION_EFFECTS_SQL, publicationEffectsParams(spec));
  return rows.map(row => row.kind);
}

/**
 * The effects a managed-request withdrawal queues (facts/withdrawal.ts `recordFactWithdrawal`): the text it sent
 * through `executeRaw`, byte for byte. One row per kind, stamped with the source's incarnation and its bound worktree;
 * an unknown source inserts nothing and a kind already queued for the request is kept.
 */
export const WITHDRAWAL_EFFECTS_SQL = `INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id)
          SELECT $1::uuid,k.kind,$3::text::jsonb,s.id,s.incarnation,b.worktree_id
          FROM sources s LEFT JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
          CROSS JOIN (VALUES ('withdrawal-mirror'),('git'),('embedding')) AS k(kind)
          WHERE s.id=$2 ON CONFLICT(request_id,kind) DO NOTHING`;

/** One page a withdrawal changed, as its effects name it. */
export interface WithdrawalEffectTarget { slug: string; page_id: number; revision: string }

/** What `insertWithdrawalEffects` inserts for a withdrawal under write request `requestId`. */
export interface WithdrawalEffectsSpec { requestId: string; sourceId: string; targets: readonly WithdrawalEffectTarget[] }

/** The data every effect of a withdrawal carries: version 2, its targets in slug order. */
export function withdrawalEffectsData(spec: WithdrawalEffectsSpec): { version: 2; targets: WithdrawalEffectTarget[] } {
  return { version: 2, targets: [...spec.targets].sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0) };
}

/** The withdrawal effects insert's parameters; the data binds as one text parameter, so postgres.js does not double-encode it. */
export function withdrawalEffectsParams(spec: WithdrawalEffectsSpec): unknown[] {
  return [spec.requestId, spec.sourceId, JSON.stringify(withdrawalEffectsData(spec))];
}

/** Queues a withdrawal's `withdrawal-mirror`, `git` and `embedding` effects (see `WITHDRAWAL_EFFECTS_SQL`). */
export async function insertWithdrawalEffects(exec: SqlExecutor, spec: WithdrawalEffectsSpec): Promise<void> {
  await exec.executeRaw(WITHDRAWAL_EFFECTS_SQL, withdrawalEffectsParams(spec));
}

/** The raw progress row of a drain lease's holder (`readDrainHolderProgress`). */
export interface DrainHolderProgressRow { committed: number | string; last_committed_at: Date | string | null; last_saved_at: Date | string | null }

/**
 * The source's managed-sync commits since `since` (ISO), its last managed-sync commit, and its last cursor save, pass
 * row write or hold summary write, through the source's writer binding; null when no binding exists.
 */
export async function readDrainHolderProgress(exec: LegacyUnscopedRead, sourceId: string, since: string): Promise<DrainHolderProgressRow | null> {
  const [row] = await exec.executeRaw<DrainHolderProgressRow>(`
    SELECT (SELECT count(*) FROM persistence_requests r WHERE r.worktree_id=b.worktree_id AND r.state='committed'
        AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' AND r.completed_at >= $2::timestamptz) AS committed,
      (SELECT max(r.completed_at) FROM persistence_requests r WHERE r.worktree_id=b.worktree_id AND r.source_incarnation=b.source_incarnation
        AND r.state='committed' AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%') AS last_committed_at,
      GREATEST((SELECT max(c.updated_at) FROM op_checkpoints c WHERE c.op='managed-sync' AND c.completed_keys->0->>'sourceId'=$1),
        (SELECT c.updated_at FROM op_checkpoints c WHERE c.op=$3 AND c.fingerprint=b.source_id||':'||b.source_incarnation::text),
        (SELECT c.updated_at FROM op_checkpoints c WHERE c.op='sync-hold-summary' AND c.fingerprint=b.source_id||':'||b.source_incarnation::text)) AS last_saved_at
    FROM persistence_source_bindings b WHERE b.source_id=$1`, [sourceId, since, MANAGED_SYNC_PASS_OP]);
  return row ?? null;
}
