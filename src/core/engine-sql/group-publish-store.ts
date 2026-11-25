/**
 * The statements of a grouped publication (`groupPublishStore()`): the owner's claim of a group's followers, the renewal and
 * dispatch marks of the group's claims (persistence/journal.ts), the group's recovery check, its publication mark and its
 * one-step completion (persistence/group-publish.ts), and the source roots an import checks its paths against
 * (persistence/import-prepare.ts). Each method sends the text its caller has always sent, moved unchanged; the shared
 * fragments (`GROUP_KEY_SQL`, `BACKOFF_ELAPSED`, `RELEASED_DEFERRED`, the protocol predicate, the receipt-byte fragments) are
 * written out as literal text, and test/persistence-journal-statements.test.ts pins them against the callers' constants.
 *
 * Row locks stay in the SQL text. The Rust store answers the same calls from its request, counter and source records
 * (rust/crates/gbrain-store/src/persistence/group_publish_store.rs), where each lock is a stated guarantee instead: an
 * explicit transaction is Serialized (it holds the store's writer, so no other commit interleaves with what it read), and under
 * optimistic transactions the rows read are in the transaction's read set, so a racing change aborts the commit with
 * `write_conflict`. The callers' compare-and-set checks (execution token, state) stay as they are.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { pipelined } from '../page-state/transactions.ts';

type RawSql = Pick<BrainEngine, 'executeRaw'>;

/** One member of a group's claim renewal or dispatch mark: its id, its claim token and the phase stamp to record (null keeps the recorded one). */
export interface GroupClaimMember { id: string; token: string; stamp: string | null }
/** One member of a group's completion: its claim, its outcome and the sizes the completion checks. */
export interface GroupCompletionMember { id: string; token: string; outcome: string; need: number; principalKey: string; retained: number }
export interface ImportSourceRoot { id: string; local_path: string | null; worktree_path: string | null; relative_path: string | null }

export interface GroupPublishStore {
  /** Claims the queued members that directly follow `head` in its group (at most `max`), in sequence order; each carries the phase its row held. */
  claimFollowers(head: { worktree_id: string; sequence: string | number }, group: string, max: number, leaseMs: number, owner: unknown): Promise<Array<WriteRequest & { previous_claim_phase: unknown }>>;
  /** Renews the members' claims (and their phase stamps) in one step; the ids still held. */
  renewClaims(members: readonly GroupClaimMember[], leaseMs: number, opts?: { signal?: AbortSignal }): Promise<string[]>;
  /** Stores each member's dispatch stamp; the ids whose claim still held. */
  markDispatched(members: readonly GroupClaimMember[], opts?: { signal?: AbortSignal }): Promise<string[]>;
  /** Whether a request (other than `excluded`) or an effect of the worktree carries a recovery record. */
  recoveryBlocked(worktreeId: string, excluded: readonly string[]): Promise<boolean>;
  /** Marks the members' publication started where their claim holds; the ids marked. */
  startPublication(members: ReadonlyArray<{ id: string; token: string }>): Promise<string[]>;
  /** Completes every member in one step (missing counters created, then locked, then the rows completed and the counters released); the completed rows, each with its `principal_key`. */
  completeGroup(members: readonly GroupCompletionMember[], keys: readonly string[], version: string, hostId: string | null): Promise<Array<WriteRequest & { principal_key: string }>>;
  /** The owner's host binding rows of the worktree (`local_path`); none when the worktree has no owner binding. */
  hostBinding(worktreeId: string): Promise<Array<{ local_path: string | null }>>;
  /** The state of the request a principal submitted under `requestId`, or null. */
  requestState(principalKind: string, principalId: string, requestId: string): Promise<string | null>;
  /** The source config row an owner-source write's trust is read from (`[{ config }]`, none for an unknown source). */
  sourceTrustConfig(sourceId: string): Promise<Array<{ config: Record<string, unknown> | string | null }>>;
  /** Sets a coordinated write's attribution and trust settings for the rest of the transaction: `sql` is the one statement that sets `names` to `values`. */
  setMemberSettings(sql: string, names: readonly string[], values: readonly string[]): Promise<void>;
  /** Every live source with its own root and its binding on this host. */
  importRoots(hostId: string): Promise<ImportSourceRoot[]>;
  /** Records every member's recovery record and reserves `total` recovery bytes on the counters, all or nothing; the ids recorded (fewer than the members: nothing was). */
  recordRecoveries(members: ReadonlyArray<{ id: string; token: string; record: unknown; bytes: number }>, total: number, counterKeys: readonly string[]): Promise<string[]>;
  /** Clears the resolved recovery records of terminal members of one worktree (each `record` must still be the stored one) and releases their bytes; the ids cleared. */
  clearRecoveries(resolved: ReadonlyArray<{ id: string; record: unknown }>, counterKeys: readonly string[], worktreeId: string | null): Promise<string[]>;
  /** The pending-import checkpoints of `op` under these fingerprints: each fingerprint with its completed keys. */
  readImportCheckpoints<R = unknown>(op: string, fingerprints: readonly string[]): Promise<Array<{ fingerprint: string; completed_keys: [R] }>>;
  /** Stores each pending-import checkpoint (`docs[i]`, the JSON text of its completed keys) unless its fingerprint has one. */
  insertImportCheckpoints(op: string, fingerprints: readonly string[], docs: readonly string[]): Promise<void>;
  /** Deletes each checkpoint whose completed keys are still exactly `docs[i]`. */
  deleteImportCheckpoints(op: string, fingerprints: readonly string[], docs: readonly string[]): Promise<void>;
}

/** GROUP_KEY_SQL, BACKOFF_ELAPSED('persistence_requests') and RELEASED_DEFERRED('persistence_requests') written out. */
const FOLLOWER_CANDIDATES_SQL = `WITH next AS (
        SELECT id,sequence,state,CASE WHEN jsonb_typeof(intent->'group')='string' THEN 'sync:'||(intent->>'group')
  WHEN operation='submit_job' AND intent->>'kind'='managed_maintenance_page' AND jsonb_typeof(intent->'maintenance_batch')='string' THEN 'maintenance:'||(intent->>'maintenance_batch')
  WHEN operation='submit_job' AND (intent->>'kind' IN ('managed_atom_page','managed_atom_delete')
    OR intent->>'kind'='managed_generation_activate' AND intent->'key'->>'kind'='atom') AND jsonb_typeof(intent->'activationId')='string' THEN 'generation:'||(intent->>'activationId')
  WHEN operation='put_page' AND intent->>'kind'='managed_file_import' AND jsonb_typeof(intent->'import_batch')='string' THEN 'import:'||(intent->>'import_batch')
  WHEN operation IN ('put_page','add_timeline_entry') AND NOT (intent ? 'kind') AND jsonb_typeof(intent->'page_batch'->'id')='string' THEN 'batch:'||(intent->'page_batch'->>'id') END AS grp,recovery IS NOT NULL AS recovering,NOT (persistence_requests.next_attempt_at IS NULL OR persistence_requests.next_attempt_at<=now()) AS backoff,transient_interruptions>0 AS charged FROM persistence_requests
        WHERE worktree_id=$1::uuid AND sequence>$2 AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL OR (persistence_requests.state='deferred' AND (persistence_requests.deferred_refresh_id IS NOT NULL OR persistence_requests.deferred_import_from IS NOT NULL)
        AND (persistence_requests.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=persistence_requests.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (persistence_requests.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=persistence_requests.source_id AND COALESCE(imported.last_commit,'')<>persistence_requests.deferred_import_from)))) ORDER BY sequence LIMIT $3),
      -- v261: a member still in its transient backoff ends the group's prefix like a non-member, and so does one already
      -- charged a transient interruption: it publishes alone, so a batch that overruns only as a whole is not retried as one.
      bound AS (SELECT min(sequence) AS sequence FROM next WHERE grp IS DISTINCT FROM $4 OR state<>'queued' OR recovering OR backoff OR charged)
      SELECT r.id,r.state,CASE WHEN jsonb_typeof(intent->'group')='string' THEN 'sync:'||(intent->>'group')
  WHEN operation='submit_job' AND intent->>'kind'='managed_maintenance_page' AND jsonb_typeof(intent->'maintenance_batch')='string' THEN 'maintenance:'||(intent->>'maintenance_batch')
  WHEN operation='submit_job' AND (intent->>'kind' IN ('managed_atom_page','managed_atom_delete')
    OR intent->>'kind'='managed_generation_activate' AND intent->'key'->>'kind'='atom') AND jsonb_typeof(intent->'activationId')='string' THEN 'generation:'||(intent->>'activationId')
  WHEN operation='put_page' AND intent->>'kind'='managed_file_import' AND jsonb_typeof(intent->'import_batch')='string' THEN 'import:'||(intent->>'import_batch')
  WHEN operation IN ('put_page','add_timeline_entry') AND NOT (intent ? 'kind') AND jsonb_typeof(intent->'page_batch'->'id')='string' THEN 'batch:'||(intent->'page_batch'->>'id') END AS grp,r.recovery IS NOT NULL AS recovering,r.claim_phase
      FROM persistence_requests r WHERE r.id IN (SELECT id FROM next WHERE sequence<COALESCE((SELECT sequence FROM bound),9223372036854775807))
      ORDER BY r.sequence FOR UPDATE OF r`;
const CLAIM_FOLLOWERS_SQL = `UPDATE persistence_requests r SET state='running',execution_token=t.token,
      claim_expires_at=now()+($3::double precision*interval '1 millisecond'),updated_at=now(),blocked_reason=NULL,
      claim_phase=jsonb_build_object('token',t.token::text,'owner',$4::text::jsonb,'claimed_at',to_jsonb(now()))
      FROM unnest($1::uuid[],$2::uuid[]) AS t(id,token) WHERE r.id=t.id AND r.state='queued' RETURNING r.*`;
const RENEW_CLAIMS_SQL = `UPDATE persistence_requests r SET claim_expires_at=now()+($3::double precision*interval '1 millisecond'),updated_at=now(),
    claim_phase=COALESCE(jsonb_set(t.stamp::jsonb,'{token}',to_jsonb(t.token::text)),r.claim_phase)
    FROM unnest($1::uuid[],$2::uuid[],$4::text[]) AS t(id,token,stamp) WHERE r.id=t.id AND r.execution_token=t.token AND r.state='running' AND set_config('gbrain.persistence_protocol','2',true)='2' RETURNING r.id`;
const MARK_DISPATCHED_SQL = `UPDATE persistence_requests r SET claim_phase=jsonb_set(t.stamp::jsonb,'{token}',to_jsonb(t.token::text))
    FROM unnest($1::uuid[],$2::uuid[],$3::text[]) AS t(id,token,stamp) WHERE r.id=t.id AND r.execution_token=t.token AND r.state='running' AND set_config('gbrain.persistence_protocol','2',true)='2' RETURNING r.id`;
const RECOVERY_BLOCKED_SQL = `SELECT 1 FROM persistence_requests WHERE worktree_id=$1::uuid AND NOT (id=ANY($2::uuid[])) AND recovery IS NOT NULL
      UNION ALL SELECT 1 FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL LIMIT 1`;
const START_PUBLICATION_SQL = `UPDATE persistence_requests r SET publication_started=true FROM unnest($1::uuid[],$2::uuid[]) AS t(id,token)
          WHERE r.id=t.id AND r.execution_token=t.token AND r.state='running' RETURNING r.id`;
const ENSURE_COUNTERS_SQL = 'INSERT INTO persistence_counters(key) SELECT k FROM unnest($1::text[]) WITH ORDINALITY AS u(k,n) ORDER BY n ON CONFLICT DO NOTHING';
const LOCK_COUNTERS_SQL = 'SELECT * FROM persistence_counters WHERE key=ANY($1::text[]) ORDER BY key COLLATE "C" FOR UPDATE';
/** EFFECT_BYTES_SQL and TRUE_UP_CLAMP_SQL (persistence/receipt-bytes.ts) written out. */
const COMPLETE_GROUP_SQL = `WITH m AS (
        SELECT * FROM unnest($1::uuid[],$2::uuid[],$3::text[],$4::bigint[],$5::text[],$8::bigint[]) AS m(id,token,outcome,need,principal_key,retained)
      ), e AS (
        SELECT request_id,SUM(octet_length(data::text)+octet_length(kind)+1024) AS bytes,bool_or(state<>'committed') AS unfinished FROM persistence_effects WHERE request_id=ANY($1::uuid[]) GROUP BY request_id
      ), prior AS (
        SELECT r.id,r.terminal_reservation FROM persistence_requests r JOIN m ON m.id=r.id
      ), done AS (
        UPDATE persistence_requests r SET state='committed',outcome=m.outcome::jsonb,error_code=NULL,error_message=NULL,
          completed_at=now(),updated_at=now(),claim_expires_at=NULL,blocked_reason=NULL,
          consumer_version=$6,consumer_host_id=$7::uuid,consumer_segment_reader=true,published_at=now(),preparation_attempts=0,
          terminal_reservation=CASE WHEN COALESCE(e.unfinished,false) THEN r.terminal_reservation
            ELSE LEAST(r.terminal_reservation,m.retained+COALESCE(e.bytes,0)) END
        FROM m LEFT JOIN e ON e.request_id=m.id
        WHERE r.id=m.id AND r.execution_token=m.token AND r.state='running' AND m.need+COALESCE(e.bytes,0)<=r.terminal_reservation
        RETURNING r.*,m.principal_key
      ), d AS (
        SELECT k.key,count(*) AS n,SUM(done.intent_bytes) AS bytes,SUM(prior.terminal_reservation-done.terminal_reservation) AS freed
        FROM done JOIN prior ON prior.id=done.id CROSS JOIN LATERAL (VALUES ('brain'),(done.principal_key)) AS k(key) GROUP BY k.key
      ), released AS (
        UPDATE persistence_counters c SET outstanding_count=c.outstanding_count-d.n,intent_bytes=c.intent_bytes-d.bytes,
          terminal_bytes=c.terminal_bytes-LEAST(d.freed,c.terminal_bytes)
        FROM d WHERE c.key=d.key
      ), clamped AS (INSERT INTO config(key,value) SELECT 'persistence.true_up.clamped',k.n::text FROM (SELECT count(*) FROM d JOIN persistence_counters c ON c.key=d.key WHERE d.freed>c.terminal_bytes) AS k(n) WHERE k.n>0
      ON CONFLICT (key) DO UPDATE SET value=(CASE WHEN config.value ~ '^[0-9]+$' THEN config.value::bigint ELSE 0 END+EXCLUDED.value::bigint)::text)
      SELECT * FROM done`;
const HOST_BINDING_SQL = 'SELECT h.local_path FROM persistence_host_bindings h JOIN persistence_worktrees w ON w.id=h.worktree_id AND w.owner_host_id=h.host_id WHERE w.id=$1::uuid';
const REQUEST_STATE_SQL = 'SELECT state FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid';
const SOURCE_TRUST_CONFIG_SQL = 'SELECT config FROM sources WHERE id = $1';
const IMPORT_ROOTS_SQL = `SELECT s.id,s.local_path,h.local_path AS worktree_path,b.relative_path FROM sources s
      LEFT JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
      LEFT JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$1::uuid WHERE NOT s.archived`;

const RECORD_RECOVERIES_SQL = `WITH recorded AS (UPDATE persistence_requests r SET recovery=t.record,recovery_bytes=t.bytes,updated_at=now()
        FROM jsonb_to_recordset($1::text::jsonb) AS t(id uuid,token uuid,record jsonb,bytes bigint)
        WHERE r.id=t.id AND r.execution_token=t.token AND r.state='running' AND r.recovery IS NULL RETURNING r.id),
      reserved AS (UPDATE persistence_counters SET recovery_bytes=recovery_bytes+$2 WHERE key=ANY($3::text[]) AND (SELECT count(*) FROM recorded)=$4)
      SELECT id FROM recorded`;
const CLEAR_RECOVERIES_SQL = `WITH locked AS (SELECT r.id,r.recovery_bytes FROM persistence_requests r
        JOIN jsonb_to_recordset($1::text::jsonb) AS t(id uuid,record jsonb) ON t.id=r.id
        WHERE r.recovery=t.record AND r.worktree_id IS NOT DISTINCT FROM $3::uuid AND r.state IN ('committed','conflict','failed','cancelled') FOR UPDATE OF r),
      released AS (UPDATE persistence_counters SET recovery_bytes=recovery_bytes-(SELECT COALESCE(SUM(recovery_bytes),0) FROM locked) WHERE key=ANY($2::text[]))
      UPDATE persistence_requests r SET recovery=NULL,recovery_bytes=0,blocked_reason=NULL FROM locked WHERE r.id=locked.id RETURNING r.id`;
const READ_IMPORT_CHECKPOINTS_SQL = 'SELECT fingerprint,completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[])';
const INSERT_IMPORT_CHECKPOINTS_SQL = `INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
        SELECT $1,k,c::jsonb FROM unnest($2::text[],$3::text[]) AS u(k,c) ON CONFLICT DO NOTHING`;
const DELETE_IMPORT_CHECKPOINTS_SQL = `DELETE FROM op_checkpoints o USING unnest($2::text[],$3::text[]) AS d(k,c)
      WHERE o.op=$1 AND o.fingerprint=d.k AND o.completed_keys=d.c::jsonb`;

/** `groupPublishStore()` on PGLite and Postgres: the store over `exec` (a transaction engine runs every call in it). */
export async function groupPublishStore(exec: RawSql): Promise<GroupPublishStore> {
  return sqlGroupPublishStore(exec);
}

export function sqlGroupPublishStore(exec: RawSql): GroupPublishStore {
  return {
    async claimFollowers(head, group, max, leaseMs, owner) {
      const next = await exec.executeRaw<{ id: string; state: string; grp: string | null; recovering: boolean; claim_phase: unknown }>(FOLLOWER_CANDIDATES_SQL,
        [head.worktree_id, head.sequence, max, group]);
      const members: string[] = [];
      const previous = new Map<string, unknown>();
      for (const row of next) {
        if (row.grp !== group || row.state !== 'queued' || row.recovering) break;
        members.push(row.id);
        previous.set(row.id, row.claim_phase);
      }
      if (!members.length) return [];
      const tokens = members.map(() => randomUUID());
      return exec.executeRaw<WriteRequest>(CLAIM_FOLLOWERS_SQL, [members, tokens, leaseMs, JSON.stringify(owner)])
        .then(rows => rows.sort((a, b) => Number(BigInt(a.sequence) - BigInt(b.sequence))).map(row => ({ ...row, previous_claim_phase: previous.get(row.id) })));
    },
    async renewClaims(members, leaseMs, opts) {
      return (await exec.executeRaw<{ id: string }>(RENEW_CLAIMS_SQL, [members.map(m => m.id), members.map(m => m.token), leaseMs, members.map(m => m.stamp)], opts)).map(row => row.id);
    },
    async markDispatched(members, opts) {
      return (await exec.executeRaw<{ id: string }>(MARK_DISPATCHED_SQL, [members.map(m => m.id), members.map(m => m.token), members.map(m => m.stamp)], opts)).map(row => row.id);
    },
    recoveryBlocked: async (worktreeId, excluded) => (await exec.executeRaw(RECOVERY_BLOCKED_SQL, [worktreeId, excluded])).length > 0,
    startPublication: async members => (await exec.executeRaw<{ id: string }>(START_PUBLICATION_SQL, [members.map(m => m.id), members.map(m => m.token)])).map(row => row.id),
    async completeGroup(members, keys, version, hostId) {
      // Three statements sent together on Postgres (one round trip), in this order; PGLite runs them one at a time.
      const [, , completed] = await pipelined(exec, [
        () => exec.executeRaw(ENSURE_COUNTERS_SQL, [keys]),
        () => exec.executeRaw(LOCK_COUNTERS_SQL, [keys]),
        () => exec.executeRaw(COMPLETE_GROUP_SQL, [members.map(m => m.id), members.map(m => m.token), members.map(m => m.outcome), members.map(m => m.need),
          members.map(m => m.principalKey), version, hostId, members.map(m => m.retained)]),
      ]);
      return completed as Array<WriteRequest & { principal_key: string }>;
    },
    hostBinding: worktreeId => exec.executeRaw<{ local_path: string | null }>(HOST_BINDING_SQL, [worktreeId]),
    requestState: async (principalKind, principalId, requestId) => (await exec.executeRaw<{ state: string }>(REQUEST_STATE_SQL, [principalKind, principalId, requestId]))[0]?.state ?? null,
    sourceTrustConfig: sourceId => exec.executeRaw<{ config: Record<string, unknown> | string | null }>(SOURCE_TRUST_CONFIG_SQL, [sourceId]),
    setMemberSettings: async (sql, _names, values) => { await exec.executeRaw(sql, [...values]); },
    importRoots: hostId => exec.executeRaw<ImportSourceRoot>(IMPORT_ROOTS_SQL, [hostId]),
    async recordRecoveries(members, total, counterKeys) {
      return (await exec.executeRaw<{ id: string }>(RECORD_RECOVERIES_SQL, [JSON.stringify(members.map(member => ({ id: member.id, token: member.token, record: member.record, bytes: member.bytes }))),
        total, counterKeys, members.length])).map(row => row.id);
    },
    async clearRecoveries(resolved, counterKeys, worktreeId) {
      return (await exec.executeRaw<{ id: string }>(CLEAR_RECOVERIES_SQL, [JSON.stringify(resolved.map(row => ({ id: row.id, record: row.record }))), counterKeys, worktreeId])).map(row => row.id);
    },
    readImportCheckpoints: <R>(op: string, fingerprints: readonly string[]) => exec.executeRaw<{ fingerprint: string; completed_keys: [R] }>(READ_IMPORT_CHECKPOINTS_SQL, [op, fingerprints]),
    insertImportCheckpoints: (op, fingerprints, docs) => exec.executeRaw(INSERT_IMPORT_CHECKPOINTS_SQL, [op, fingerprints, docs]).then(() => undefined),
    deleteImportCheckpoints: (op, fingerprints, docs) => exec.executeRaw(DELETE_IMPORT_CHECKPOINTS_SQL, [op, fingerprints, docs]).then(() => undefined),
  };
}

/** The statements `sqlGroupPublishStore` sends whose text a test pins against the callers' fragments. */
export const GROUP_PUBLISH_STORE_STATEMENTS = { RECORD_RECOVERIES_SQL, CLEAR_RECOVERIES_SQL, FOLLOWER_CANDIDATES_SQL, RENEW_CLAIMS_SQL, MARK_DISPATCHED_SQL, COMPLETE_GROUP_SQL } as const;
