/**
 * The worktree refresh statements (`refreshStore()`): the rows `gbrain sources refresh` writes (persistence/worktree-refresh.ts),
 * the reads its recovery and the writes waiting behind it make (refresh-barrier.ts, import-deferral.ts, page-prepare.ts), and
 * the held-write statements of the refresh barrier. Each method sends the text its caller has always sent, moved unchanged
 * (the refresh schema constants and the `RELEASED_DEFERRED` fragment are written out as literal text, so this module imports no
 * persistence code and test/persistence-journal-statements.test.ts pins them against the callers' constants).
 *
 * Row locks and session settings stay in the SQL text here. The Rust store answers the same calls from its refresh records
 * (rust/crates/gbrain-store/src/persistence/refresh_store.rs), where each is a stated guarantee instead: an explicit
 * transaction is Serialized (it holds the store's writer, so no other commit interleaves with what it read), and under
 * optimistic transactions the rows read are in the transaction's read set, so a racing change aborts the commit with
 * `write_conflict`. The callers' compare-and-set checks (state, owner epoch, topology generation) stay as they are.
 */
import type { BrainEngine } from '../engine.ts';
import type { WriteRequest } from '../persistence/model.ts';

type RawSql = Pick<BrainEngine, 'executeRaw'>;

export type RefreshState = 'draining' | 'fenced' | 'merged' | 'syncing' | 'completed' | 'aborted' | 'recovery_required';
/** One `persistence_worktree_refreshes` row. */
export interface RefreshRow {
  id: string; worktree_id: string; source_ids: string[]; principal_id: string; owner_epoch: string | number;
  topology_generation: string | number; state: RefreshState; old_head: string; target_head: string; upstream_ref: string;
  preserved_uncommitted: string[]; outcome: Record<string, unknown>; created_at: string | Date; updated_at: string | Date; completed_at: string | Date | null;
  /** The newest write request sequence when the row was inserted: a managed-sync request past it was admitted after the refresh began. */
  barrier_sequence?: string | number | null;
}
/** The fence row a refresh inserts in state `draining`. */
export interface RefreshInsert {
  worktreeId: string; sourceIds: readonly string[]; principalId: string; ownerEpoch: string; topologyGeneration: string;
  oldHead: string; targetHead: string; upstreamRef: string; preserved: readonly string[]; outcome: Record<string, unknown>;
}
/** The session settings a refresh transaction takes before its statements. */
export type RefreshSettings = 'synchronous_commit' | 'fence' | 'lock_timeout';

export interface RefreshStore {
  /** The transaction settings: a synchronous commit (and a 5 s lock wait for `fence`), or only the 5 s lock wait. */
  settings(which: RefreshSettings): Promise<void>;
  /** The worktree's active refresh, or null. */
  readActive(worktreeId: string): Promise<RefreshRow | null>;
  read(id: string): Promise<RefreshRow | null>;
  /** Conditional transition: true when the row was in one of `from` and moved to `to` (a terminal state stamps `completed_at`). */
  transition(id: string, from: readonly string[], to: string, outcome: Record<string, unknown>, terminal: boolean): Promise<boolean>;
  /** A fenced row whose merge has not started takes a new start and target; the row, or null. */
  replan(id: string, oldHead: string, targetHead: string): Promise<RefreshRow | null>;
  /** The fence insert; the unique violation of a second active refresh of the worktree is thrown with code `23505`. */
  insertDraining(insert: RefreshInsert): Promise<RefreshRow>;
  /** Marks the merge started on a still fenced row; whether it did. */
  markMergeStarted(id: string, atMs: number): Promise<boolean>;
  /** The caller becomes the active row's holder; `previous_holder` keeps the first holder replaced. */
  setHolder(id: string, holder: object): Promise<void>;
  /** The members' upstream observation after the merge: checked now, at the target, none behind. */
  recordMergedUpstream(sourceIds: readonly string[], targetHead: string): Promise<void>;
  /** The target heads of the worktree's last 100 completed refreshes of `upstreamRef`, newest first. */
  completedTargets(worktreeId: string, upstreamRef: string): Promise<string[]>;
  /** The worktree's newest refresh state and members, or null. */
  newest(worktreeId: string): Promise<{ state: string; source_ids: string[] } | null>;
  /** A refresh of the worktree that blocks a managed sync (draining, fenced, merged or recovery_required), or null. */
  blocking(worktreeId: string): Promise<{ id: string; state: string } | null>;
  /** Whether publication or topology recovery is pending on the worktree (a record no live claim holds). */
  recoveryProbe(worktreeId: string): Promise<{ publication: boolean; topology: boolean }>;
  /** What a refresh waits to drain: requests, checkout effects and recovery records of the worktree. */
  drainCounts(worktreeId: string): Promise<{ requests: number; effects: number; recovery: number }>;
  /** The first unfinished managed-sync cursor of these members, or null. */
  unfinishedSyncCursor(members: readonly string[]): Promise<{ source_id: string; header: Record<string, unknown> } | null>;
  /** Each member's last commit, and whether a managed-sync import or delete was admitted after `barrierSequence`, in source id order. */
  membersPastStart(sourceIds: readonly string[], barrierSequence: string | null): Promise<Array<{ id: string; last_commit: string | null; imported: boolean }>>;
  /** Each member's id and last commit, in byte order of the id. */
  sourceCommits(sourceIds: readonly string[]): Promise<Array<{ id: string; last_commit: string | null }>>;
  /** Each member's last commit, in no stated order. */
  memberCommits(sourceIds: readonly string[]): Promise<Array<{ last_commit: string | null }>>;

  /** The worktree's member source ids, in byte order. */
  memberIds(worktreeId: string): Promise<string[]>;
  /** The checkout root host `hostId` binds the worktree at, or null. */
  hostLocalPath(worktreeId: string, hostId: string): Promise<string | null>;
  /** The commit the source's last sync reached; null before the first sync and for an unknown source. */
  sourceLastCommit(sourceId: string): Promise<string | null>;
  /** The source's incarnation, or null for an unknown source. */
  sourceIncarnation(sourceId: string): Promise<string | null>;

  // The writes that wait behind a refresh or an import (import-deferral.ts, refresh-barrier.ts).
  /** A claimed write whose preparation was refused `pending_import` moves back to `deferred` behind that import; the row or null. */
  holdForImport(id: string, token: string, importFrom: string): Promise<WriteRequest | null>;
  /** The refresh row as a deferred write's replay reads it: its state, heads, and whether it was released; null when it does not exist. */
  readReleased(id: string): Promise<{ state: string; old_head: string; target_head: string; released: boolean } | null>;
  /** The request id of the oldest committed write to the page accepted after `sequence`, other than the managed import a held write waited for. */
  laterWrite(sourceId: string, slug: string, sequence: string): Promise<string | null>;
  /** How many writes wait behind a refresh or an import, and how long the oldest has waited (ms). */
  deferredBacklog(): Promise<{ count: number; oldest_age_ms: number }>;
  /** Whether a deferred write still waits: behind an unreleased refresh, or for an import that has not landed. A read that fails counts as waiting. */
  deferredWaiting(row: { source_id: string; deferred_refresh_id?: string | null; deferred_import_from?: string | null }): Promise<boolean>;
}

const SETTINGS_SQL: Record<RefreshSettings, string> = {
  synchronous_commit: "SELECT set_config('synchronous_commit','on',true)",
  fence: "SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','5s',true)",
  lock_timeout: "SELECT set_config('lock_timeout','5s',true)",
};
/** ACTIVE_REFRESH_STATES_SQL (persistence/worktree-refresh-schema.ts) written out. */
const READ_ACTIVE_SQL = `SELECT * FROM persistence_worktree_refreshes
    WHERE worktree_id=$1::uuid AND state IN ('draining','fenced','merged','syncing','recovery_required')`;
const READ_SQL = 'SELECT * FROM persistence_worktree_refreshes WHERE id=$1::uuid';
const TRANSITION_SQL = `UPDATE persistence_worktree_refreshes SET state=$3,outcome=outcome||$4::text::jsonb,updated_at=now(),
    completed_at=CASE WHEN $5::boolean THEN now() ELSE completed_at END WHERE id=$1::uuid AND state=ANY($2::text[]) RETURNING id`;
const REPLAN_SQL = `UPDATE persistence_worktree_refreshes SET old_head=$2,target_head=$3,updated_at=now()
      WHERE id=$1::uuid AND state='fenced' AND (outcome->>'merge_started') IS DISTINCT FROM 'true' RETURNING *`;
const INSERT_DRAINING_SQL = `INSERT INTO persistence_worktree_refreshes
      (worktree_id,source_ids,principal_id,owner_epoch,topology_generation,state,old_head,target_head,upstream_ref,preserved_uncommitted,outcome,barrier_sequence)
      VALUES($1::uuid,$2::text[],$3::uuid,$4,$5,'draining',$6,$7,$8,$9::text[],$10::text::jsonb,(SELECT max(sequence) FROM persistence_requests)) RETURNING *`;
const MARK_MERGE_STARTED_SQL = `UPDATE persistence_worktree_refreshes SET outcome=outcome||jsonb_build_object('merge_started',true,'merge_started_at',$2::bigint),updated_at=now() WHERE id=$1::uuid AND state='fenced' RETURNING id`;
const SET_HOLDER_SQL = `UPDATE persistence_worktree_refreshes SET outcome=outcome||jsonb_build_object('holder',$2::text::jsonb,'previous_holder',COALESCE(outcome->'previous_holder',outcome->'holder'))
    WHERE id=$1::uuid AND state IN ('draining','fenced','merged','syncing','recovery_required')`;
const MERGED_UPSTREAM_SQL = `UPDATE sources SET upstream_checked_at=now(),upstream_commit=$2,upstream_behind=0 WHERE id=ANY($1::text[])`;
const COMPLETED_TARGETS_SQL = `SELECT target_head FROM persistence_worktree_refreshes WHERE worktree_id=$1::uuid AND upstream_ref=$2 AND state='completed' ORDER BY created_at DESC, id LIMIT 100`;
const NEWEST_SQL = 'SELECT state,source_ids FROM persistence_worktree_refreshes WHERE worktree_id=$1::uuid ORDER BY created_at DESC, id LIMIT 1';
const BLOCKING_SQL = `SELECT id,state FROM persistence_worktree_refreshes
    WHERE worktree_id=$1::uuid AND state IN ('draining','fenced','merged','recovery_required')`;
const RECOVERY_PROBE_SQL = `SELECT
    EXISTS (SELECT 1 FROM persistence_requests WHERE worktree_id=$1::uuid AND recovery IS NOT NULL
      AND NOT (state='running' AND claim_expires_at > now()))
    OR EXISTS (SELECT 1 FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL
      AND NOT (state='running' AND claim_expires_at > now())) AS publication,
    EXISTS (SELECT 1 FROM persistence_topology_changes WHERE recovery IS NOT NULL AND recovery->>'worktreeId'=$1::text) AS topology`;
/** RELEASED_DEFERRED('r') and CHECKOUT_EFFECT_KINDS_SQL (persistence/worktree-refresh-schema.ts) written out. */
const DRAIN_COUNTS_SQL = `SELECT
    (SELECT count(*) FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND (r.state IN ('queued','running','recovering') OR (r.state='deferred' AND (r.deferred_refresh_id IS NOT NULL OR r.deferred_import_from IS NOT NULL)
        AND (r.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=r.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (r.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=r.source_id AND COALESCE(imported.last_commit,'')<>r.deferred_import_from)))))::int AS requests,
    (SELECT count(*) FROM persistence_effects WHERE worktree_id=$1::uuid AND kind IN ('git','withdrawal-mirror') AND state IN ('queued','running'))::int AS effects,
    ((SELECT count(*) FROM persistence_requests WHERE worktree_id=$1::uuid AND recovery IS NOT NULL)
      +(SELECT count(*) FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL))::int AS recovery`;
const UNFINISHED_CURSOR_SQL = `SELECT c.completed_keys->0->>'sourceId' AS source_id,
    c.completed_keys->0 AS header
    FROM op_checkpoints c WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
    AND c.completed_keys->0->>'sourceId'=ANY($1::text[]) ORDER BY c.updated_at, c.fingerprint COLLATE "C" LIMIT 1`;
const MEMBERS_PAST_START_SQL = `SELECT s.id,s.last_commit,
    EXISTS (SELECT 1 FROM persistence_requests r WHERE r.source_id=s.id AND $2::bigint IS NOT NULL AND r.sequence > $2::bigint
      AND r.intent->>'kind' IN ('managed_sync_import','managed_sync_delete') AND r.state NOT IN ('failed','conflict','cancelled')) AS imported
    FROM sources s WHERE s.id = ANY($1::text[]) ORDER BY s.id COLLATE "C"`;
const SOURCE_COMMITS_SQL = 'SELECT id,last_commit FROM sources WHERE id = ANY($1::text[]) ORDER BY id COLLATE "C"';
const MEMBER_COMMITS_SQL = 'SELECT last_commit FROM sources WHERE id = ANY($1::text[])';
/** REFRESH_BARRIER_CLAIM_PREDICATE (persistence/journal.ts) and PERSISTENCE_PROTOCOL_PREDICATE (persistence/protocol.ts) written out. */
const HOLD_FOR_IMPORT_SQL = `UPDATE persistence_requests SET state='deferred',deferred_import_from=$3,deferred_refresh_id=NULL,execution_token=NULL,
    claim_expires_at=NULL,blocked_reason=NULL,claim_phase=NULL,updated_at=now()
    WHERE id=$1::uuid AND execution_token=$2::uuid AND state='running' AND recovery IS NULL AND publication_started=false
      AND set_config('gbrain.persistence_protocol','2',true)='2' AND set_config('gbrain.refresh_barrier','1',true)='1' RETURNING *`;
const READ_RELEASED_SQL = 'SELECT state,old_head,target_head,released_at IS NOT NULL AS released FROM persistence_worktree_refreshes WHERE id=$1::uuid';
/** SYNC_KIND('r') (persistence/journal.ts) written out. */
const LATER_WRITE_SQL = `SELECT r.request_id::text AS request_id FROM persistence_requests r
    WHERE r.source_id=$1 AND r.slug=$2 AND r.sequence>$3 AND r.state='committed' AND NOT (r.operation='submit_job'
      AND (COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' OR (r.intent IS NULL AND COALESCE(r.outcome->>'imported_file','')='true' AND NOT (r.outcome ? 'connector_database')))) ORDER BY r.sequence LIMIT 1`;
const DEFERRED_BACKLOG_SQL = `SELECT count(*)::int AS count,
    (EXTRACT(EPOCH FROM now()-min(created_at))*1000)::bigint AS oldest_age_ms FROM persistence_requests
    WHERE (deferred_refresh_id IS NOT NULL OR deferred_import_from IS NOT NULL) AND state IN ('deferred','queued','running','recovering')`;
const MEMBER_IDS_SQL = 'SELECT source_id FROM persistence_source_bindings WHERE worktree_id=$1::uuid ORDER BY source_id COLLATE "C"';
const HOST_LOCAL_PATH_SQL = 'SELECT local_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid AND host_id=$2::uuid';
const SOURCE_LAST_COMMIT_SQL = 'SELECT last_commit FROM sources WHERE id=$1';
const SOURCE_INCARNATION_SQL = 'SELECT incarnation::text AS incarnation FROM sources WHERE id=$1';
const DEFERRED_WAITING_SQL = `SELECT
    ($1::uuid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM persistence_worktree_refreshes WHERE id=$1::uuid AND released_at IS NOT NULL))
    OR ($2::text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sources WHERE id=$3 AND COALESCE(last_commit,'')<>$2::text)) AS waiting`;

/** `refreshStore()` on PGLite and Postgres: the store over `exec` (a transaction engine runs every call in it). */
export async function refreshStore(exec: RawSql): Promise<RefreshStore> {
  return sqlRefreshStore(exec);
}

export function sqlRefreshStore(exec: RawSql): RefreshStore {
  const run = async (sql: string, params?: unknown[]) => { await exec.executeRaw(sql, params); };
  const first = async <T>(sql: string, params: unknown[]): Promise<T | null> => (await exec.executeRaw<T>(sql, params))[0] ?? null;
  return {
    settings: which => run(SETTINGS_SQL[which]),
    readActive: worktreeId => first<RefreshRow>(READ_ACTIVE_SQL, [worktreeId]),
    read: id => first<RefreshRow>(READ_SQL, [id]),
    transition: async (id, from, to, outcome, terminal) => (await exec.executeRaw(TRANSITION_SQL, [id, from, to, JSON.stringify(outcome), terminal])).length === 1,
    replan: (id, oldHead, targetHead) => first<RefreshRow>(REPLAN_SQL, [id, oldHead, targetHead]),
    insertDraining: async insert => (await exec.executeRaw<RefreshRow>(INSERT_DRAINING_SQL, [insert.worktreeId, insert.sourceIds, insert.principalId, insert.ownerEpoch,
      insert.topologyGeneration, insert.oldHead, insert.targetHead, insert.upstreamRef, insert.preserved, JSON.stringify(insert.outcome)]))[0]!,
    markMergeStarted: async (id, atMs) => (await exec.executeRaw(MARK_MERGE_STARTED_SQL, [id, atMs])).length > 0,
    setHolder: (id, holder) => run(SET_HOLDER_SQL, [id, JSON.stringify(holder)]),
    recordMergedUpstream: (sourceIds, targetHead) => run(MERGED_UPSTREAM_SQL, [sourceIds, targetHead]),
    completedTargets: async (worktreeId, upstreamRef) => (await exec.executeRaw<{ target_head: string }>(COMPLETED_TARGETS_SQL, [worktreeId, upstreamRef])).map(row => row.target_head),
    newest: worktreeId => first(NEWEST_SQL, [worktreeId]),
    blocking: worktreeId => first(BLOCKING_SQL, [worktreeId]),
    recoveryProbe: async worktreeId => (await first<{ publication: boolean; topology: boolean }>(RECOVERY_PROBE_SQL, [worktreeId]))!,
    async drainCounts(worktreeId) {
      const row = (await first<{ requests: number; effects: number; recovery: number }>(DRAIN_COUNTS_SQL, [worktreeId]))!;
      return { requests: Number(row.requests), effects: Number(row.effects), recovery: Number(row.recovery) };
    },
    unfinishedSyncCursor: members => first(UNFINISHED_CURSOR_SQL, [members]),
    membersPastStart: (sourceIds, barrierSequence) => exec.executeRaw(MEMBERS_PAST_START_SQL, [sourceIds, barrierSequence]),
    sourceCommits: sourceIds => exec.executeRaw(SOURCE_COMMITS_SQL, [sourceIds]),
    memberCommits: sourceIds => exec.executeRaw(MEMBER_COMMITS_SQL, [sourceIds]),
    memberIds: async worktreeId => (await exec.executeRaw<{ source_id: string }>(MEMBER_IDS_SQL, [worktreeId])).map(row => row.source_id),
    hostLocalPath: async (worktreeId, hostId) => (await first<{ local_path: string | null }>(HOST_LOCAL_PATH_SQL, [worktreeId, hostId]))?.local_path ?? null,
    sourceLastCommit: async sourceId => (await first<{ last_commit: string | null }>(SOURCE_LAST_COMMIT_SQL, [sourceId]))?.last_commit ?? null,
    sourceIncarnation: async sourceId => (await first<{ incarnation: string }>(SOURCE_INCARNATION_SQL, [sourceId]))?.incarnation ?? null,
    holdForImport: (id, token, importFrom) => first<WriteRequest>(HOLD_FOR_IMPORT_SQL, [id, token, importFrom]),
    readReleased: id => first(READ_RELEASED_SQL, [id]),
    laterWrite: async (sourceId, slug, sequence) => (await first<{ request_id: string }>(LATER_WRITE_SQL, [sourceId, slug, sequence]))?.request_id ?? null,
    async deferredBacklog() {
      const row = await first<{ count: number; oldest_age_ms: number | null }>(DEFERRED_BACKLOG_SQL, []);
      return { count: Number(row?.count ?? 0), oldest_age_ms: Number(row?.oldest_age_ms ?? 0) };
    },
    async deferredWaiting(row) {
      const held = await first<{ waiting: boolean }>(DEFERRED_WAITING_SQL, [row.deferred_refresh_id ?? null, row.deferred_import_from ?? null, row.source_id]).catch(() => ({ waiting: true }));
      return held?.waiting !== false;
    },
  };
}

/** The statements `sqlRefreshStore` sends whose text a test pins against the callers' fragments. */
export const REFRESH_STORE_STATEMENTS = { DRAIN_COUNTS_SQL, HOLD_FOR_IMPORT_SQL, LATER_WRITE_SQL, UNFINISHED_CURSOR_SQL, MEMBERS_PAST_START_SQL } as const;
