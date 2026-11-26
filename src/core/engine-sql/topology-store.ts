/**
 * The managed source topology statements (`topologyStore()`): the locks and reads a source lifecycle change takes under
 * its topology locks (persistence/topology-locks.ts), its receipt accounting (topology-receipts.ts), its transaction
 * bounds (topology-transaction.ts), the lifecycle writes of add, claim, archive, restore, set-path, remove and purge
 * (source-lifecycle.ts), and the moved-checkout reads (physical-root.ts). Each method sends the text its caller has
 * always sent, moved unchanged.
 *
 * Row locks (`FOR UPDATE`, `FOR SHARE`) stay in the SQL text here. The Rust store answers the same calls from its
 * records (rust/crates/gbrain-store/src/persistence/topology_store.rs), where each lock is a stated guarantee instead:
 * an explicit transaction is Serialized (it holds the store's writer, so no other commit interleaves with what it read),
 * and under optimistic transactions the rows read are in the transaction's read set, so a racing change aborts the
 * commit with `write_conflict`. The compare-and-set checks the callers already make on owner epoch, topology generation,
 * incarnation and state are kept as they are.
 */
import type { BrainEngine } from '../engine.ts';
import type { WriteRequest } from '../persistence/model.ts';
import type { TopologyChange } from './persistence-claims.ts';
import { removedSourceRescrubStatement, sourceIncarnationDeleteStatement } from './sources.ts';
import { sqlContentReceiptStore, type ContentReceiptStore } from './writer-admin.ts';

type RawSql = Pick<BrainEngine, 'executeRaw'>;

/** A worktree row as the topology locks read it. */
export interface TopologyWorktreeRow { id: string; owner_host_id: string; state: string; owner_epoch: string; topology_generation: string }
/** A source row as the lifecycle reads it. */
export interface TopologySourceRow { id: string; incarnation: string; archived: boolean; local_path: string | null; config: Record<string, unknown>; name: string; last_commit: string | null }
/** Whose grant a topology settle share-locks. */
export type TopologyPrincipalKind = 'oauth_client' | 'legacy_token' | 'local_cli' | 'local_stdio' | string;

/** The content-receipt reads and swaps a set-path rebinds through (shared-skills/receipt-root.ts) are part of the store. */
export interface TopologyStore extends ContentReceiptStore {
  // Transaction bounds (topology-transaction.ts, source-lifecycle.ts).
  /** The topology transaction's settings: a synchronous commit, a 1 s lock wait and a 5 s statement bound. */
  bound(): Promise<void>;
  /** A synchronous commit for this transaction. */
  synchronousCommit(): Promise<void>;
  /** Marks this transaction as a topology change, which the managed-source guard admits. */
  markTopologyChange(): Promise<void>;

  // Topology locks (topology-locks.ts).
  lockBrain(): Promise<void>;
  /** Shares the brain row (the writer-admin lock check, admin-lock.ts). */
  shareBrain(): Promise<void>;
  lockWorktrees(ids: readonly string[]): Promise<TopologyWorktreeRow[]>;
  /** One active refresh of these worktrees other than `refreshId`, or null. */
  activeRefresh(ids: readonly string[], refreshId: string | null): Promise<{ id: string; state: string; source_ids: string[] } | null>;
  /** The member sources of these worktrees, in source id order. */
  memberSources(ids: readonly string[]): Promise<string[]>;
  lockSources(ids: readonly string[]): Promise<void>;
  /** Whether a source is bound to the worktree. */
  worktreeHasMember(worktreeId: string): Promise<boolean>;
  hostBinding(worktreeId: string, hostId: string): Promise<{ local_path: string; coordination_path: string } | null>;
  /** The md5 of every member page's id, knowledge revision and the member's incarnation, in page id order. */
  canonicalStamp(worktreeId: string): Promise<string>;
  /** The unsettled requests of these sources or worktrees (queued, deferred, running, recovering or with a recovery), in sequence order. */
  unsettledRequests(sources: readonly string[], worktrees: readonly string[]): Promise<WriteRequest[]>;
  /** One effect of these sources or worktrees that blocks a topology change, or null. */
  blockingEffect(sources: readonly string[], worktrees: readonly string[]): Promise<{ id: string; source_id: string | null } | null>;
  /** Share-locks one principal's grant row. */
  sharePrincipal(kind: TopologyPrincipalKind, id: string): Promise<void>;
  /** Advances the topology generation of these worktrees and of their source bindings. */
  advanceGeneration(worktrees: readonly string[]): Promise<void>;
  /** The checkout roots host `hostId` binds. */
  hostBindingPaths(hostId: string): Promise<{ local_path: string | null }[]>;

  // Receipts (topology-receipts.ts).
  /** One lifetime id and `bytes` of receipt reservation on counter `key`. */
  chargeReceipt(key: string, bytes: number): Promise<void>;
  /** Settles a retire admission still recovering with no recovery record; the settled row or null. */
  settleRetire(id: string, state: string, outcome: Record<string, unknown>, terminalBytes: number): Promise<TopologyChange | null>;
  addTerminalBytes(key: string, delta: number): Promise<void>;
  /** The other retire admissions of this incarnation still recovering with no record, in id order. */
  supersedableRetires(sourceId: string, incarnation: string, principal: string, requestId: string): Promise<TopologyChange[]>;
  /** Share-locks a local writer row (a reservation release locks an extant principal without checking its grant). */
  shareLocalWriter(id: string): Promise<void>;
  lockChange(id: string): Promise<TopologyChange | null>;
  releaseIntent(key: string, intentBytes: number): Promise<void>;
  releaseRecoveryBytes(key: string, bytes: number): Promise<void>;
  clearChangeRecovery(id: string): Promise<void>;

  // Lifecycle (source-lifecycle.ts).
  readSource(id: string): Promise<TopologySourceRow | null>;
  /** A remove or purge of `requestId` another principal admitted against another incarnation, or null. */
  supersededRetire(requestId: string, sourceId: string, principal: string, incarnation: string | null): Promise<TopologyChange | null>;
  /** The manifest digest of each worktree the source is bound to. */
  bindingDigests(sourceId: string): Promise<{ digest: string | null }[]>;
  /** The source's incarnation, archive state and whether it is due (an expired archive when `expiredOnly`). */
  retireState(sourceId: string, expiredOnly: boolean): Promise<{ incarnation: string; archived: boolean; due: boolean } | null>;
  /** One OAuth client bound to the source, or null. */
  oauthClientOf(sourceId: string): Promise<string | null>;
  /** Deletes up to `limit` pages of the source; how many went. */
  deletePageBatch(sourceId: string, limit: number): Promise<number>;
  isExpiredArchive(sourceId: string): Promise<boolean>;
  updateSourceRoot(id: string, localPath: string, name: string | null, config: Record<string, unknown>): Promise<void>;
  insertSource(id: string, name: string, localPath: string | null, config: Record<string, unknown>, incarnation: string): Promise<void>;
  archiveSource(id: string, config: Record<string, unknown>): Promise<void>;
  restoreSource(id: string, config: Record<string, unknown>): Promise<void>;
  setSourceLocalPath(id: string, localPath: string): Promise<void>;
  setHostBindingPath(worktreeId: string, hostId: string, localPath: string): Promise<void>;
  setBindingRelativePath(sourceId: string, relativePath: string): Promise<void>;
  countSourcePages(sourceId: string): Promise<number>;
  /** Deletes the incarnation's source row with the rows only it names (engine-sql/sources.ts sourceIncarnationDeleteStatement). */
  deleteSourceIncarnation(sourceId: string, incarnation: string): Promise<void>;
  /** Repeats that scrub once the row is gone (removedSourceRescrubStatement). */
  rescrubRemovedSource(sourceId: string): Promise<void>;
  deleteSourceBinding(sourceId: string, incarnation: string): Promise<void>;
  deleteManagedSyncCursors(sourceId: string): Promise<void>;
  setWorktreeManifest(id: string, manifest: Record<string, unknown>): Promise<void>;
  mergeCanonicalStamp(id: string, stamp: string): Promise<void>;
  /** The bindings of other sources on host `hostId`'s worktrees. */
  otherHostBindings(hostId: string, sourceId: string): Promise<{ source_id: string; relative_path: string; local_path: string }[]>;
  worktreeExists(id: string): Promise<boolean>;
  insertWorktree(id: string, hostId: string): Promise<void>;
  /** Inserts the host binding unless one exists. */
  insertHostBinding(worktreeId: string, hostId: string, localPath: string, coordinationPath: string): Promise<void>;
  /** Binds the source to the worktree at its topology generation, replacing an earlier binding. */
  upsertSourceBinding(sourceId: string, incarnation: string, worktreeId: string, relativePath: string): Promise<void>;
  /** The source's page count and how many other sources share its worktree. */
  retirableState(sourceId: string): Promise<{ pages: number; members: number }>;

  // Moved checkout (physical-root.ts).
  movedRootRow(worktreeId: string, hostId: string): Promise<{ brain_id: string; owner_host_id: string | null; local_path: string | null } | null>;
  /** The worktree's member sources and their relative paths, in byte order of the source id. */
  worktreeMembers(worktreeId: string): Promise<{ source_id: string; relative_path: string }[]>;
  brainId(): Promise<string | null>;
  worktreeOwner(id: string): Promise<{ owner_host_id: string | null; state: string } | null>;

  // Managed clone, reclone and their recovery (topology-clone.ts, topology-recovery.ts, physical-root.ts).
  /** The worktree's manifest (null when it has none), or null when the worktree is missing. */
  worktreeManifest(id: string): Promise<{ manifest: Record<string, any> | null } | null>;
  /** Locks the worktree and reads its owner host and manifest; null when it is missing. */
  lockWorktreeManifest(id: string): Promise<{ owner_host_id: string | null; manifest: Record<string, any> | null } | null>;
  /** The change with this id, or null. */
  readChange(id: string): Promise<TopologyChange | null>;
  /** Locks the recovering changes that name this worktree: their ids and recovery records. */
  lockRecoveringChanges(worktreeId: string): Promise<{ id: string; recovery: Record<string, any> | null }[]>;
  /** A new worktree owned by `hostId` at epoch 1 in the recovering state. */
  insertRecoveringWorktree(id: string, hostId: string): Promise<void>;
  markWorktreeRecovering(id: string): Promise<void>;
  markWorktreeActive(id: string): Promise<void>;
  /** Marks the worktree recovering and records its manifest. */
  recoverWorktreeWithManifest(id: string, manifest: Record<string, unknown>): Promise<void>;
  /** Binds a source to a worktree at the table's defaults (no relative path, generation 1). */
  insertCloneBinding(sourceId: string, incarnation: string, worktreeId: string): Promise<void>;
  /** Replaces a recovering change's recovery record. */
  setChangeRecovery(id: string, recovery: Record<string, unknown>): Promise<void>;
  /** Replaces a change's recovery record whatever its state (a restamp already holds the change locked). */
  restampChangeRecovery(id: string, recovery: Record<string, unknown>): Promise<void>;
  /** Closes a change committed or failed: clears its recovery and merges `outcome` into the recorded one. */
  closeChange(id: string, state: 'committed' | 'failed', outcome: Record<string, unknown>): Promise<void>;
  /** Commits a change and merges `outcome` into the recorded one. */
  commitChange(id: string, outcome: Record<string, unknown>): Promise<void>;
  /** Clears the source's last commit and sync time (a reclone starts its sync again). */
  resetSourceSync(id: string, incarnation: string): Promise<void>;

  // The clone and its recovery read these with the column lists they always sent (topology-clone.ts, topology-recovery.ts).
  /** The source's incarnation, config, last commit and local path, or null. */
  readCloneSource(id: string): Promise<{ incarnation: string; config: Record<string, unknown>; last_commit: string | null; local_path: string | null } | null>;
  /** The source's incarnation, last commit and config, or null. */
  readSourceHead(id: string): Promise<{ incarnation: string; last_commit: string | null; config: unknown } | null>;
  /** The host's local path of a worktree, or null. */
  cloneHostBindingPath(worktreeId: string, hostId: string): Promise<{ local_path: string } | null>;
  /** Locks the worktree and reads its owner host, owner epoch and state; null when missing. */
  lockCloneWorktree(id: string): Promise<{ owner_host_id: string; owner_epoch: string; state: string } | null>;
  /** The sources bound to the worktree, in source id order (the locale's, which never reaches output). */
  boundSourceIds(worktreeId: string): Promise<string[]>;
  /** The clone's host binding insert, unless one exists. */
  insertCloneHostBinding(worktreeId: string, hostId: string, localPath: string, coordinationPath: string): Promise<void>;

  // Owner activity (persistence/owner-activity.ts).
  /**
   * When the owner of each worktree was last active: its liveness (a consumer heartbeat within `lapsedMs`; this engine
   * keeps none on Rust and PGLite), the newest evidence of activity, the oldest open write and the store's clock. One
   * row per listed worktree that has an owner.
   */
  ownerActivity(ids: readonly string[], lapsedMs: number, opts?: { signal?: AbortSignal }): Promise<OwnerActivityRow[]>;
  /**
   * The managed writes waiting on each worktree (`owner_host_stale`, commands/doctor/checks/owner-host-stale.ts): per worktree with a
   * queued, deferred, running or recovering request, how many, when the oldest was created and the sources bound to it (byte
   * order); the order of the rows is not defined.
   */
  openWrites(): Promise<OpenWritesRow[]>;
}

/** One worktree's waiting writes (`openWrites`). */
export interface OpenWritesRow { worktree_id: string; open_writes: number; oldest_open: string | Date; source_ids: string[] | null }

/** One worktree's owner facts (`ownerActivity`). */
export interface OwnerActivityRow { worktree_id: string; owner_host_id: string; live: boolean; last_active: string | Date | null; oldest_open: string | Date | null; db_now: string | Date }

const TOPOLOGY_BOUND_SQL = "SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)";
const SYNCHRONOUS_COMMIT_SQL = "SELECT set_config('synchronous_commit','on',true)";
const TOPOLOGY_CHANGE_FLAG_SQL = "SELECT set_config('gbrain.topology_change','on',true)";
const LOCK_BRAIN_SQL = 'SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE';
const SHARE_BRAIN_SQL = 'SELECT singleton FROM persistence_brain WHERE singleton=1 FOR SHARE';
const LOCK_WORKTREES_SQL = 'SELECT id,owner_host_id,state,owner_epoch,topology_generation FROM persistence_worktrees WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE';
/** ACTIVE_REFRESH_STATES_SQL (worktree-refresh-schema.ts) written out. */
const ACTIVE_REFRESH_SQL = `SELECT id,state,source_ids FROM persistence_worktree_refreshes
    WHERE worktree_id=ANY($1::uuid[]) AND state IN ('draining','fenced','merged','syncing','recovery_required') AND ($2::uuid IS NULL OR id<>$2::uuid) LIMIT 1`;
// The member order never reaches output: callers re-sort the members in JS and only name the source rows to lock.
const MEMBER_SOURCES_SQL = 'SELECT source_id FROM persistence_source_bindings WHERE worktree_id=ANY($1::uuid[]) ORDER BY source_id';
// Plain ORDER BY id on purpose, not COLLATE "C": this only sets the lock order, the same as lockAllSourceRows (engine-sql/sources.ts), so no deadlock.
const LOCK_SOURCES_SQL = 'SELECT id FROM sources WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE';
const WORKTREE_MEMBER_SQL = 'SELECT source_id FROM persistence_source_bindings WHERE worktree_id=$1::uuid LIMIT 1';
const HOST_BINDING_SQL = 'SELECT local_path,coordination_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid AND host_id=$2::uuid';
const CANONICAL_STAMP_SQL = `SELECT md5(COALESCE(string_agg(p.id::text||':'||p.knowledge_revision::text||':'||b.source_incarnation::text,',' ORDER BY p.id),'')) AS stamp
    FROM persistence_source_bindings b LEFT JOIN pages p ON p.source_id=b.source_id WHERE b.worktree_id=$1::uuid`;
const UNSETTLED_REQUESTS_SQL = `SELECT * FROM persistence_requests
    WHERE (source_id=ANY($1::text[]) OR worktree_id=ANY($2::uuid[]))
      AND (state IN ('queued','deferred','running','recovering') OR recovery IS NOT NULL) ORDER BY sequence`;
const BLOCKING_EFFECT_SQL = `SELECT id,source_id FROM persistence_effects WHERE
    (source_id=ANY($1::text[]) OR worktree_id=ANY($2::uuid[])) AND
    (recovery IS NOT NULL OR state='running' OR (kind='withdrawal-mirror' AND state='queued')) LIMIT 1`;
const SHARE_OAUTH_CLIENT_SQL = 'SELECT client_id FROM oauth_clients WHERE client_id=$1 FOR SHARE';
const SHARE_ACCESS_TOKEN_SQL = 'SELECT id FROM access_tokens WHERE id=$1 FOR SHARE';
const SHARE_LOCAL_WRITER_SQL = 'SELECT id FROM persistence_local_writers WHERE id=$1::uuid FOR SHARE';
const ADVANCE_WORKTREES_SQL = 'UPDATE persistence_worktrees SET topology_generation=topology_generation+1 WHERE id=ANY($1::uuid[])';
const ADVANCE_BINDINGS_SQL = `UPDATE persistence_source_bindings b SET topology_generation=w.topology_generation
    FROM persistence_worktrees w WHERE b.worktree_id=w.id AND w.id=ANY($1::uuid[])`;
const HOST_BINDING_PATHS_SQL = 'SELECT local_path FROM persistence_host_bindings WHERE host_id=$1::uuid';
const CHARGE_RECEIPT_SQL = 'UPDATE persistence_counters SET lifetime_ids=lifetime_ids+1,terminal_bytes=terminal_bytes+$2 WHERE key=$1';
const SETTLE_RETIRE_SQL = `UPDATE persistence_topology_changes SET state=$2,outcome=$3::text::jsonb,terminal_bytes=$4,updated_at=now()
    WHERE id=$1::uuid AND state='recovering' AND recovery IS NULL RETURNING *`;
const ADD_TERMINAL_BYTES_SQL = 'UPDATE persistence_counters SET terminal_bytes=terminal_bytes+$2 WHERE key=$1';
const SUPERSEDABLE_RETIRES_SQL = `SELECT * FROM persistence_topology_changes WHERE source_id=$1 AND source_incarnation=$2::uuid
    AND state='recovering' AND recovery IS NULL AND operation IN ('remove','purge') AND NOT (principal_id=$3::uuid AND request_id=$4::uuid) ORDER BY id`;
const LOCK_CHANGE_SQL = 'SELECT * FROM persistence_topology_changes WHERE id=$1::uuid FOR UPDATE';
const RELEASE_INTENT_SQL = 'UPDATE persistence_counters SET outstanding_count=outstanding_count-1,intent_bytes=intent_bytes-$2 WHERE key=$1';
const RELEASE_RECOVERY_SQL = 'UPDATE persistence_counters SET recovery_bytes=recovery_bytes-$2 WHERE key=$1';
const CLEAR_CHANGE_RECOVERY_SQL = 'UPDATE persistence_topology_changes SET recovery=NULL,recovery_bytes=0,intent_bytes=0,updated_at=now() WHERE id=$1::uuid';
const READ_SOURCE_SQL = 'SELECT id,incarnation,archived,local_path,config,name,last_commit FROM sources WHERE id=$1';
const SUPERSEDED_RETIRE_SQL = `SELECT * FROM persistence_topology_changes
    WHERE request_id=$1::uuid AND source_id=$2 AND principal_id<>$3::uuid AND operation IN ('remove','purge') AND source_incarnation IS DISTINCT FROM $4::uuid
    ORDER BY created_at LIMIT 1`;
const BINDING_DIGESTS_SQL = `SELECT w.manifest->>'digest' AS digest FROM persistence_source_bindings b JOIN persistence_worktrees w ON w.id=b.worktree_id WHERE b.source_id=$1`;
/** EXPIRED_ARCHIVE_SQL (engine-sql/sources.ts) written out. */
const RETIRE_STATE_EXPIRED_SQL = `SELECT incarnation,archived,archived = true AND archived_at > '1970-01-02'::timestamptz
  AND archive_expires_at > '1970-01-02'::timestamptz AND archive_expires_at <= now() AS due FROM sources WHERE id=$1`;
const RETIRE_STATE_SQL = 'SELECT incarnation,archived,true AS due FROM sources WHERE id=$1';
const OAUTH_CLIENT_OF_SQL = 'SELECT client_id FROM oauth_clients WHERE source_id=$1 LIMIT 1';
const DELETE_PAGE_BATCH_SQL = 'DELETE FROM pages WHERE id IN (SELECT id FROM pages WHERE source_id=$1 LIMIT $2) RETURNING id';
const EXPIRED_ARCHIVE_ROW_SQL = `SELECT id FROM sources WHERE id=$1 AND archived = true AND archived_at > '1970-01-02'::timestamptz
  AND archive_expires_at > '1970-01-02'::timestamptz AND archive_expires_at <= now()`;
const UPDATE_SOURCE_ROOT_SQL = 'UPDATE sources SET local_path=$2,name=COALESCE($3,name),config=$4::text::jsonb WHERE id=$1';
const INSERT_SOURCE_SQL = 'INSERT INTO sources(id,name,local_path,config,incarnation) VALUES($1,$2,$3,$4::text::jsonb,$5::uuid)';
const ARCHIVE_SOURCE_SQL = `UPDATE sources SET archived=true,archived_at=COALESCE(archived_at,now()),
        archive_expires_at=COALESCE(archive_expires_at,now()+interval '72 hours'),config=$2::text::jsonb WHERE id=$1`;
const RESTORE_SOURCE_SQL = `UPDATE sources SET archived=false,archived_at=NULL,archive_expires_at=NULL,
        config=$2::text::jsonb WHERE id=$1`;
const SET_SOURCE_PATH_SQL = 'UPDATE sources SET local_path=$2 WHERE id=$1';
const SET_HOST_BINDING_PATH_SQL = 'UPDATE persistence_host_bindings SET local_path=$3 WHERE worktree_id=$1::uuid AND host_id=$2::uuid';
const SET_BINDING_RELATIVE_PATH_SQL = 'UPDATE persistence_source_bindings SET relative_path=$2 WHERE source_id=$1';
const COUNT_SOURCE_PAGES_SQL = 'SELECT count(*)::text AS count FROM pages WHERE source_id=$1';
const DELETE_SOURCE_BINDING_SQL = 'DELETE FROM persistence_source_bindings WHERE source_id=$1 AND source_incarnation=$2::uuid';
const DELETE_SYNC_CURSORS_SQL = "DELETE FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1";
const SET_MANIFEST_SQL = 'UPDATE persistence_worktrees SET manifest=$2::text::jsonb WHERE id=$1::uuid';
const MERGE_STAMP_SQL = `UPDATE persistence_worktrees SET manifest=COALESCE(manifest,'{}'::jsonb)||jsonb_build_object('canonical_stamp',$2::text) WHERE id=$1::uuid`;
const OTHER_HOST_BINDINGS_SQL = `SELECT b.source_id,b.relative_path,h.local_path
    FROM persistence_source_bindings b JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$1::uuid
    WHERE b.source_id<>$2`;
const WORKTREE_EXISTS_SQL = 'SELECT id FROM persistence_worktrees WHERE id=$1::uuid';
const INSERT_WORKTREE_SQL = 'INSERT INTO persistence_worktrees(id,owner_host_id,owner_epoch) VALUES($1::uuid,$2::uuid,1)';
const INSERT_HOST_BINDING_SQL = `INSERT INTO persistence_host_bindings(worktree_id,host_id,local_path,coordination_path) VALUES($1::uuid,$2::uuid,$3,$4)
    ON CONFLICT(worktree_id,host_id) DO NOTHING`;
const UPSERT_SOURCE_BINDING_SQL = `INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id,relative_path,topology_generation)
    SELECT $1,$2::uuid,$3::uuid,$4,topology_generation FROM persistence_worktrees WHERE id=$3::uuid
    ON CONFLICT(source_id) DO UPDATE SET source_incarnation=EXCLUDED.source_incarnation,worktree_id=EXCLUDED.worktree_id,
      relative_path=EXCLUDED.relative_path,topology_generation=EXCLUDED.topology_generation`;
const RETIRABLE_STATE_SQL = `SELECT (SELECT count(*)::int FROM pages WHERE source_id=$1) AS pages,
    (SELECT count(*)::int FROM persistence_source_bindings b JOIN persistence_source_bindings o ON o.worktree_id=b.worktree_id AND o.source_id<>b.source_id WHERE b.source_id=$1) AS members`;
const MOVED_ROOT_SQL = `SELECT brain_id::text AS brain_id,
    (SELECT owner_host_id::text FROM persistence_worktrees WHERE id=$1::uuid) AS owner_host_id,
    (SELECT local_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid AND host_id=$2::uuid) AS local_path
    FROM persistence_brain WHERE singleton=1`;
const WORKTREE_MEMBERS_SQL = 'SELECT source_id,relative_path FROM persistence_source_bindings WHERE worktree_id=$1::uuid ORDER BY source_id COLLATE "C"';
const BRAIN_ID_SQL = 'SELECT brain_id FROM persistence_brain WHERE singleton=1';
const WORKTREE_OWNER_SQL = 'SELECT owner_host_id,state FROM persistence_worktrees WHERE id=$1::uuid';
const WORKTREE_MANIFEST_SQL = 'SELECT manifest FROM persistence_worktrees WHERE id=$1::uuid';
const LOCK_WORKTREE_MANIFEST_SQL = 'SELECT owner_host_id,manifest FROM persistence_worktrees WHERE id=$1::uuid FOR UPDATE';
const READ_CHANGE_SQL = 'SELECT * FROM persistence_topology_changes WHERE id=$1::uuid';
const LOCK_RECOVERING_CHANGES_SQL = "SELECT id,recovery FROM persistence_topology_changes WHERE state='recovering' AND $1::uuid=ANY(worktree_ids) FOR UPDATE";
const INSERT_RECOVERING_WORKTREE_SQL = "INSERT INTO persistence_worktrees(id,owner_host_id,owner_epoch,state) VALUES($1::uuid,$2::uuid,1,'recovering')";
const MARK_WORKTREE_RECOVERING_SQL = "UPDATE persistence_worktrees SET state='recovering' WHERE id=$1::uuid";
const MARK_WORKTREE_ACTIVE_SQL = "UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid";
const RECOVER_WORKTREE_WITH_MANIFEST_SQL = "UPDATE persistence_worktrees SET state='recovering',manifest=$2::text::jsonb WHERE id=$1::uuid";
const INSERT_CLONE_BINDING_SQL = 'INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id) VALUES($1,$2::uuid,$3::uuid)';
const SET_CHANGE_RECOVERY_SQL = "UPDATE persistence_topology_changes SET recovery=$2::text::jsonb,updated_at=now() WHERE id=$1::uuid AND state='recovering'";
const RESTAMP_CHANGE_RECOVERY_SQL = 'UPDATE persistence_topology_changes SET recovery=$2::text::jsonb,updated_at=now() WHERE id=$1::uuid';
const CLOSE_CHANGE_SQL = `UPDATE persistence_topology_changes SET state=$2,recovery=NULL,recovery_bytes=0,updated_at=now(),
    outcome=COALESCE(outcome,'{}'::jsonb)||$3::text::jsonb WHERE id=$1::uuid`;
const COMMIT_CHANGE_SQL = "UPDATE persistence_topology_changes SET state='committed',outcome=outcome||$2::text::jsonb,updated_at=now() WHERE id=$1::uuid";
/** `owner_host_stale`'s read of the writes waiting on each worktree: the statement the doctor check sent through executeRaw, unchanged. */
const OPEN_WRITES_SQL = `
      SELECT r.worktree_id::text AS worktree_id, count(*)::int AS open_writes, min(r.created_at) AS oldest_open,
        (SELECT array_agg(b.source_id ORDER BY b.source_id COLLATE "C") FROM persistence_source_bindings b WHERE b.worktree_id=r.worktree_id) AS source_ids
      FROM persistence_requests r WHERE r.worktree_id IS NOT NULL AND r.state IN ('queued','deferred','running','recovering')
      GROUP BY r.worktree_id`;

const OWNER_ACTIVITY_SQL = `
    SELECT now() AS db_now, w.id::text AS worktree_id, w.owner_host_id::text AS owner_host_id,
      EXISTS (SELECT 1 FROM persistence_consumers c WHERE c.host_id=w.owner_host_id
        AND c.renewed_at > now() - ($2::double precision * interval '1 millisecond')) AS live,
      GREATEST(w.heartbeat_at,
        (SELECT max(c.renewed_at) FROM persistence_consumers c WHERE c.host_id=w.owner_host_id),
        (SELECT COALESCE(r.published_at, r.completed_at) FROM persistence_requests r WHERE r.worktree_id>=w.id AND r.worktree_id<=w.id
          AND r.state='committed' AND NOT COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' ORDER BY r.worktree_id DESC, r.sequence DESC LIMIT 1),
        (SELECT max(x.completed_at) FROM sources s CROSS JOIN LATERAL (SELECT r.completed_at FROM persistence_requests r
          WHERE r.worktree_id=w.id AND r.source_incarnation=s.incarnation AND r.state='committed' AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%'
          ORDER BY r.completed_at DESC LIMIT 1) x)) AS last_active,
      (SELECT min(r.created_at) FROM persistence_requests r WHERE r.worktree_id=w.id AND r.state IN ('queued','deferred','running','recovering')) AS oldest_open
    FROM persistence_worktrees w
    WHERE w.id::text = ANY($1::text[]) AND w.owner_host_id IS NOT NULL`;
const READ_CLONE_SOURCE_SQL = 'SELECT incarnation,config,last_commit,local_path FROM sources WHERE id=$1';
const READ_SOURCE_HEAD_SQL = 'SELECT incarnation,last_commit,config FROM sources WHERE id=$1';
const CLONE_HOST_BINDING_PATH_SQL = 'SELECT local_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid AND host_id=$2::uuid';
const LOCK_CLONE_WORKTREE_SQL = 'SELECT owner_host_id,owner_epoch,state FROM persistence_worktrees WHERE id=$1::uuid FOR UPDATE';
// The member order never reaches output: the members are re-sorted in JS and only name the source rows to lock.
const BOUND_SOURCE_IDS_SQL = 'SELECT source_id FROM persistence_source_bindings WHERE worktree_id=$1::uuid ORDER BY source_id';
const INSERT_CLONE_HOST_BINDING_SQL = 'INSERT INTO persistence_host_bindings(worktree_id,host_id,local_path,coordination_path) VALUES($1::uuid,$2::uuid,$3,$4) ON CONFLICT(worktree_id,host_id) DO NOTHING';
const RESET_SOURCE_SYNC_SQL = 'UPDATE sources SET last_commit=NULL,last_sync_at=NULL WHERE id=$1 AND incarnation=$2::uuid';

/** `topologyStore()` on PGLite and Postgres: the store over `exec` (a transaction engine runs every call in it). */
export async function topologyStore(exec: RawSql): Promise<TopologyStore> {
  return sqlTopologyStore(exec);
}

export function sqlTopologyStore(exec: RawSql): TopologyStore {
  const run = async (sql: string, params?: unknown[]) => { await exec.executeRaw(sql, params); };
  const first = async <T>(sql: string, params: unknown[]): Promise<T | null> => (await exec.executeRaw<T>(sql, params))[0] ?? null;
  return {
    ...sqlContentReceiptStore(exec),
    bound: () => run(TOPOLOGY_BOUND_SQL),
    synchronousCommit: () => run(SYNCHRONOUS_COMMIT_SQL),
    markTopologyChange: () => run(TOPOLOGY_CHANGE_FLAG_SQL),
    lockBrain: () => run(LOCK_BRAIN_SQL),
    shareBrain: () => run(SHARE_BRAIN_SQL),
    lockWorktrees: ids => exec.executeRaw<TopologyWorktreeRow>(LOCK_WORKTREES_SQL, [ids]),
    activeRefresh: (ids, refreshId) => first(ACTIVE_REFRESH_SQL, [ids, refreshId]),
    memberSources: async ids => (await exec.executeRaw<{ source_id: string }>(MEMBER_SOURCES_SQL, [ids])).map(row => row.source_id),
    lockSources: ids => run(LOCK_SOURCES_SQL, [ids]),
    worktreeHasMember: async id => (await exec.executeRaw(WORKTREE_MEMBER_SQL, [id])).length > 0,
    hostBinding: (worktreeId, hostId) => first(HOST_BINDING_SQL, [worktreeId, hostId]),
    canonicalStamp: async id => (await first<{ stamp: string }>(CANONICAL_STAMP_SQL, [id]))!.stamp,
    unsettledRequests: (sources, worktrees) => exec.executeRaw<WriteRequest>(UNSETTLED_REQUESTS_SQL, [sources, worktrees]),
    blockingEffect: (sources, worktrees) => first(BLOCKING_EFFECT_SQL, [sources, worktrees]),
    sharePrincipal: (kind, id) => run(kind === 'oauth_client' ? SHARE_OAUTH_CLIENT_SQL : kind === 'legacy_token' ? SHARE_ACCESS_TOKEN_SQL : SHARE_LOCAL_WRITER_SQL, [id]),
    async advanceGeneration(worktrees) {
      await exec.executeRaw(ADVANCE_WORKTREES_SQL, [worktrees]);
      await exec.executeRaw(ADVANCE_BINDINGS_SQL, [worktrees]);
    },
    hostBindingPaths: hostId => exec.executeRaw<{ local_path: string | null }>(HOST_BINDING_PATHS_SQL, [hostId]),
    chargeReceipt: (key, bytes) => run(CHARGE_RECEIPT_SQL, [key, bytes]),
    settleRetire: (id, state, outcome, terminalBytes) => first<TopologyChange>(SETTLE_RETIRE_SQL, [id, state, JSON.stringify(outcome), terminalBytes]),
    addTerminalBytes: (key, delta) => run(ADD_TERMINAL_BYTES_SQL, [key, delta]),
    supersedableRetires: (sourceId, incarnation, principal, requestId) =>
      exec.executeRaw<TopologyChange>(SUPERSEDABLE_RETIRES_SQL, [sourceId, incarnation, principal, requestId]),
    shareLocalWriter: id => run(SHARE_LOCAL_WRITER_SQL, [id]),
    lockChange: id => first<TopologyChange>(LOCK_CHANGE_SQL, [id]),
    releaseIntent: (key, intentBytes) => run(RELEASE_INTENT_SQL, [key, intentBytes]),
    releaseRecoveryBytes: (key, bytes) => run(RELEASE_RECOVERY_SQL, [key, bytes]),
    clearChangeRecovery: id => run(CLEAR_CHANGE_RECOVERY_SQL, [id]),
    readSource: id => first<TopologySourceRow>(READ_SOURCE_SQL, [id]),
    supersededRetire: (requestId, sourceId, principal, incarnation) => first<TopologyChange>(SUPERSEDED_RETIRE_SQL, [requestId, sourceId, principal, incarnation]),
    bindingDigests: sourceId => exec.executeRaw<{ digest: string | null }>(BINDING_DIGESTS_SQL, [sourceId]),
    retireState: (sourceId, expiredOnly) => first(expiredOnly ? RETIRE_STATE_EXPIRED_SQL : RETIRE_STATE_SQL, [sourceId]),
    oauthClientOf: async sourceId => (await first<{ client_id: string }>(OAUTH_CLIENT_OF_SQL, [sourceId]))?.client_id ?? null,
    deletePageBatch: async (sourceId, limit) => (await exec.executeRaw(DELETE_PAGE_BATCH_SQL, [sourceId, limit])).length,
    isExpiredArchive: async sourceId => (await exec.executeRaw(EXPIRED_ARCHIVE_ROW_SQL, [sourceId])).length > 0,
    updateSourceRoot: (id, localPath, name, config) => run(UPDATE_SOURCE_ROOT_SQL, [id, localPath, name, JSON.stringify(config)]),
    insertSource: (id, name, localPath, config, incarnation) => run(INSERT_SOURCE_SQL, [id, name, localPath, JSON.stringify(config), incarnation]),
    archiveSource: (id, config) => run(ARCHIVE_SOURCE_SQL, [id, JSON.stringify(config)]),
    restoreSource: (id, config) => run(RESTORE_SOURCE_SQL, [id, JSON.stringify(config)]),
    setSourceLocalPath: (id, localPath) => run(SET_SOURCE_PATH_SQL, [id, localPath]),
    setHostBindingPath: (worktreeId, hostId, localPath) => run(SET_HOST_BINDING_PATH_SQL, [worktreeId, hostId, localPath]),
    setBindingRelativePath: (sourceId, relativePath) => run(SET_BINDING_RELATIVE_PATH_SQL, [sourceId, relativePath]),
    countSourcePages: async sourceId => Number((await first<{ count: string }>(COUNT_SOURCE_PAGES_SQL, [sourceId]))!.count),
    async deleteSourceIncarnation(sourceId, incarnation) {
      const gone = sourceIncarnationDeleteStatement(sourceId, incarnation);
      await exec.executeRaw(gone.text, gone.params);
    },
    async rescrubRemovedSource(sourceId) {
      const rescrub = removedSourceRescrubStatement(sourceId);
      await exec.executeRaw(rescrub.text, rescrub.params);
    },
    deleteSourceBinding: (sourceId, incarnation) => run(DELETE_SOURCE_BINDING_SQL, [sourceId, incarnation]),
    deleteManagedSyncCursors: sourceId => run(DELETE_SYNC_CURSORS_SQL, [sourceId]),
    setWorktreeManifest: (id, manifest) => run(SET_MANIFEST_SQL, [id, JSON.stringify(manifest)]),
    mergeCanonicalStamp: (id, stamp) => run(MERGE_STAMP_SQL, [id, stamp]),
    otherHostBindings: (hostId, sourceId) => exec.executeRaw(OTHER_HOST_BINDINGS_SQL, [hostId, sourceId]),
    worktreeExists: async id => (await exec.executeRaw(WORKTREE_EXISTS_SQL, [id])).length > 0,
    insertWorktree: (id, hostId) => run(INSERT_WORKTREE_SQL, [id, hostId]),
    insertHostBinding: (worktreeId, hostId, localPath, coordinationPath) => run(INSERT_HOST_BINDING_SQL, [worktreeId, hostId, localPath, coordinationPath]),
    upsertSourceBinding: (sourceId, incarnation, worktreeId, relativePath) => run(UPSERT_SOURCE_BINDING_SQL, [sourceId, incarnation, worktreeId, relativePath]),
    async retirableState(sourceId) {
      const row = (await first<{ pages: number; members: number }>(RETIRABLE_STATE_SQL, [sourceId]))!;
      return { pages: Number(row.pages), members: Number(row.members) };
    },
    movedRootRow: (worktreeId, hostId) => first(MOVED_ROOT_SQL, [worktreeId, hostId]),
    worktreeMembers: worktreeId => exec.executeRaw(WORKTREE_MEMBERS_SQL, [worktreeId]),
    brainId: async () => (await first<{ brain_id: string }>(BRAIN_ID_SQL, []))?.brain_id ?? null,
    worktreeOwner: id => first(WORKTREE_OWNER_SQL, [id]),
    worktreeManifest: id => first(WORKTREE_MANIFEST_SQL, [id]),
    lockWorktreeManifest: id => first(LOCK_WORKTREE_MANIFEST_SQL, [id]),
    readChange: id => first<TopologyChange>(READ_CHANGE_SQL, [id]),
    lockRecoveringChanges: worktreeId => exec.executeRaw(LOCK_RECOVERING_CHANGES_SQL, [worktreeId]),
    insertRecoveringWorktree: (id, hostId) => run(INSERT_RECOVERING_WORKTREE_SQL, [id, hostId]),
    markWorktreeRecovering: id => run(MARK_WORKTREE_RECOVERING_SQL, [id]),
    markWorktreeActive: id => run(MARK_WORKTREE_ACTIVE_SQL, [id]),
    recoverWorktreeWithManifest: (id, manifest) => run(RECOVER_WORKTREE_WITH_MANIFEST_SQL, [id, JSON.stringify(manifest)]),
    insertCloneBinding: (sourceId, incarnation, worktreeId) => run(INSERT_CLONE_BINDING_SQL, [sourceId, incarnation, worktreeId]),
    setChangeRecovery: (id, recovery) => run(SET_CHANGE_RECOVERY_SQL, [id, JSON.stringify(recovery)]),
    restampChangeRecovery: (id, recovery) => run(RESTAMP_CHANGE_RECOVERY_SQL, [id, JSON.stringify(recovery)]),
    closeChange: (id, state, outcome) => run(CLOSE_CHANGE_SQL, [id, state, JSON.stringify(outcome)]),
    commitChange: (id, outcome) => run(COMMIT_CHANGE_SQL, [id, JSON.stringify(outcome)]),
    resetSourceSync: (id, incarnation) => run(RESET_SOURCE_SYNC_SQL, [id, incarnation]),
    readCloneSource: id => first(READ_CLONE_SOURCE_SQL, [id]),
    readSourceHead: id => first(READ_SOURCE_HEAD_SQL, [id]),
    cloneHostBindingPath: (worktreeId, hostId) => first(CLONE_HOST_BINDING_PATH_SQL, [worktreeId, hostId]),
    lockCloneWorktree: id => first(LOCK_CLONE_WORKTREE_SQL, [id]),
    boundSourceIds: async worktreeId => (await exec.executeRaw<{ source_id: string }>(BOUND_SOURCE_IDS_SQL, [worktreeId])).map(row => row.source_id),
    insertCloneHostBinding: (worktreeId, hostId, localPath, coordinationPath) => run(INSERT_CLONE_HOST_BINDING_SQL, [worktreeId, hostId, localPath, coordinationPath]),
    ownerActivity: (ids, lapsedMs, opts) => exec.executeRaw<OwnerActivityRow>(OWNER_ACTIVITY_SQL, [[...ids], lapsedMs], opts),
    openWrites: () => exec.executeRaw<OpenWritesRow>(OPEN_WRITES_SQL),
  };
}

/** The statements `sqlTopologyStore` sends whose text is pinned by a test against the callers' fragments. */
export const TOPOLOGY_STORE_STATEMENTS = {
  ACTIVE_REFRESH_SQL, RETIRE_STATE_EXPIRED_SQL, EXPIRED_ARCHIVE_ROW_SQL,
  LOCK_WORKTREE_MANIFEST_SQL, LOCK_RECOVERING_CHANGES_SQL, CLOSE_CHANGE_SQL, COMMIT_CHANGE_SQL, OWNER_ACTIVITY_SQL, OPEN_WRITES_SQL,
  READ_CLONE_SOURCE_SQL, READ_SOURCE_HEAD_SQL, CLONE_HOST_BINDING_PATH_SQL, LOCK_CLONE_WORKTREE_SQL, BOUND_SOURCE_IDS_SQL, INSERT_CLONE_HOST_BINDING_SQL,
} as const;
