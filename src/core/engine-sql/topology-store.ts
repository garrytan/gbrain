/**
 * The reads a source lifecycle change (sources add --url, reclone, remove, set-path, refresh) makes before its first
 * write, and the writes of a managed clone's transactions, its commit and the lifecycle receipts, as
 * `BrainEngine.topologyStore()` (Rust engine lane 7, steps A and B). The statements are the ones
 * persistence/source-lifecycle.ts, topology-clone.ts, topology-locks.ts and topology-transaction.ts ran through executeRaw, kept
 * byte-identical: tests and benches match their text, and each runs on the engine the caller holds (the root engine
 * before the locks, the transaction engine inside them), so a wrapper of that engine sees it. What the rows mean
 * (an overlapping root, a draining owner, a busy request) stays with the callers.
 *
 * The store holds no state and takes no lock when it is made. A Rust brain serves the same store over its own records
 * (src/core/rust-engine/store-members/topology-store.ts).
 */
import type { BrainEngine } from '../engine.ts';
import type { WriteRequest } from '../persistence/model.ts';
import type { TopologyChange } from './persistence-claims.ts';

type RawSql = Pick<BrainEngine, 'executeRaw'>;

/** A source as a clone reads it before its locks; null when it is not registered. */
export interface TopologySourceRow { incarnation: string; config: Record<string, unknown>; last_commit: string | null; local_path: string | null }
/** A source as a lifecycle change (source-lifecycle.ts) reads it first; null when it is not registered. */
export interface TopologyLifecycleSourceRow {
  id: string; incarnation: string; archived: boolean; local_path: string | null; config: Record<string, unknown>; name: string; last_commit: string | null;
}
/** A source as a clone re-reads it under its locks. */
export interface LockedTopologySourceRow { incarnation: string; last_commit: string | null; config: unknown }
/** One worktree host `hostId` binds, with its owner, epoch, state, generation and paths on that host. */
export interface TopologyHostWorktreeRow {
  worktree_id: string; owner_host_id: string; owner_epoch: string; state: string; topology_generation: string;
  local_path: string; coordination_path: string;
}
/** A worktree's owner, state, epoch and generation. */
export interface TopologyOwnerRow { id: string; owner_host_id: string; state: string; owner_epoch: string; topology_generation: string }
/** An active worktree refresh. */
export interface TopologyRefreshRow { id: string; state: string; source_ids: string[] }
/** A worktree's paths on one host. */
export interface TopologyHostBindingRow { local_path: string; coordination_path: string }
/** A publication effect that blocks a topology change. */
export interface TopologyBlockingEffectRow { id: string; source_id: string | null }
/** A request principal a topology change holds a share lock on. */
export interface TopologyPrincipalRef { kind: string; id: string }
/** A worktree's owner host and state. */
export interface TopologyWorktreeRow { owner_host_id: string | null; state: string }
/** The source a managed clone's commit creates, with the incarnation the clone recorded. */
export interface TopologyCloneSource { id: string; name: string; localPath: string; config: Record<string, unknown>; incarnation: string }

export interface TopologyStore {
  /** Turns on durable commit and bounds the lock and statement waits of the topology transaction (the transaction's first statement). */
  durable(): Promise<void>;
  /** Turns on durable commit for this transaction. */
  syncCommit(): Promise<void>;
  /** Locks the persistence brain row until the transaction ends. */
  lockBrain(): Promise<void>;
  /** The source before the topology locks; null when it is not registered. */
  source(sourceId: string): Promise<TopologySourceRow | null>;
  /** The source as a lifecycle change reads it before anything else (id, incarnation, archived, path, config, name, last commit); null when it is not registered. */
  lifecycleSource(sourceId: string): Promise<TopologyLifecycleSourceRow | null>;
  /** The source re-read under the topology locks; null when it is not registered. */
  lockedSource(sourceId: string): Promise<LockedTopologySourceRow | null>;
  /** Every worktree host `hostId` binds. */
  hostWorktrees(hostId: string): Promise<TopologyHostWorktreeRow[]>;
  /** The local paths of the worktrees host `hostId` binds. */
  hostLocalPaths(hostId: string): Promise<Array<{ local_path: string | null }>>;
  /** The first source bound to the worktree, in source order; null when it has none. */
  firstMember(worktreeId: string): Promise<string | null>;
  /** Some source bound to the worktree; null when it has none. */
  anyMember(worktreeId: string): Promise<string | null>;
  /** The worktree's paths on host `hostId`; null when that host does not bind it. */
  hostBinding(worktreeId: string, hostId: string): Promise<TopologyHostBindingRow | null>;
  /** The worktree's owner, locked; null when the worktree is missing. */
  lockOwner(worktreeId: string): Promise<Pick<TopologyOwnerRow, 'owner_host_id' | 'owner_epoch' | 'state'> | null>;
  /** The worktrees' owners, locked, in id order; a missing worktree has no row. */
  lockOwners(worktreeIds: string[]): Promise<TopologyOwnerRow[]>;
  /** One active refresh of the worktrees other than `excludeId`; null when there is none. */
  activeRefresh(worktreeIds: string[], excludeId: string | null): Promise<TopologyRefreshRow | null>;
  /** The source ids bound to the worktrees, in order. */
  members(worktreeIds: string[]): Promise<string[]>;
  /** Locks the source rows that exist among `sourceIds`. */
  lockSources(sourceIds: string[]): Promise<void>;
  /** The md5 stamp of every page of every source bound to the worktree (topologyCanonicalStamp). */
  canonicalStamp(worktreeId: string): Promise<string>;
  /** The requests of the sources or worktrees that are not settled, in sequence order. */
  unsettledRequests(sourceIds: string[], worktreeIds: string[]): Promise<WriteRequest[]>;
  /** One effect of the sources or worktrees that blocks a topology change; null when there is none. */
  blockingEffect(sourceIds: string[], worktreeIds: string[]): Promise<TopologyBlockingEffectRow | null>;
  /** Holds the principal's row (OAuth client, legacy token or local writer) until the transaction ends. */
  sharePrincipal(principal: TopologyPrincipalRef): Promise<void>;

  /** The persistence brain id; null before the persistence identity exists. */
  brainId(): Promise<string | null>;
  /** The worktree's owner host and state; null when it is missing. */
  worktree(worktreeId: string): Promise<TopologyWorktreeRow | null>;
  /** The topology change with this id; null when there is none. */
  change(changeId: string): Promise<TopologyChange | null>;
  /** The topology change with this id, locked; null when there is none. */
  lockChange(changeId: string): Promise<TopologyChange | null>;
  /** The other recovering remove and purge admissions of the source incarnation with no recovery record, in id order. */
  retireAdmissions(sourceId: string, incarnation: string, principalId: string, requestId: string): Promise<TopologyChange[]>;

  /** Puts the worktree in the recovering state (a prepared owner the clone takes over). */
  recoverWorktree(worktreeId: string): Promise<void>;
  /** Puts the worktree in the recovering state with this manifest (a reclone). */
  recoverWorktreeWithManifest(worktreeId: string, manifest: unknown): Promise<void>;
  /** Sets the worktree's manifest. */
  setWorktreeManifest(worktreeId: string, manifest: unknown): Promise<void>;
  /** Puts the worktree back in the active state. */
  activateWorktree(worktreeId: string): Promise<void>;
  /** Creates the clone's worktree, owned by `hostId` at epoch 1, recovering. */
  insertCloneWorktree(worktreeId: string, hostId: string): Promise<void>;
  /** Binds the worktree on `hostId` at these paths; an existing binding is kept. */
  bindCloneHost(worktreeId: string, hostId: string, localPath: string, coordinationPath: string): Promise<void>;
  /** Binds the source incarnation to the worktree. */
  bindCloneSource(sourceId: string, incarnation: string, worktreeId: string): Promise<void>;
  /** Deletes the source incarnation's worktree binding. */
  unbindSource(sourceId: string, incarnation: string): Promise<void>;
  /** Raises each worktree's topology generation by one; its source bindings take the new generation. */
  advanceGeneration(worktreeIds: string[]): Promise<void>;
  /** Marks this transaction as a topology change, which the source triggers allow. */
  markTopologyChange(): Promise<void>;
  /** Creates the clone's source. */
  insertCloneSource(source: TopologyCloneSource): Promise<void>;
  /** Clears the last commit and last sync time of the source incarnation. */
  resetSourceCheckpoint(sourceId: string, incarnation: string): Promise<void>;

  /** Saves the clone's recovery record while the change is recovering. */
  saveCloneRecovery(changeId: string, recovery: unknown): Promise<void>;
  /** Commits the change and adds `outcome` to its outcome. */
  commitChange(changeId: string, outcome: Record<string, unknown>): Promise<void>;
  /** Ends the change in `state`, drops its recovery and adds `outcome` to its outcome. */
  releaseChange(changeId: string, state: string, outcome: Record<string, unknown>): Promise<void>;
  /** Drops the change's recovery record and its reserved recovery and intent bytes. */
  clearChangeRecovery(changeId: string): Promise<void>;
  /** Settles a recovering retire admission with no recovery record; null when the change is not one. */
  settleRetire(changeId: string, state: string, outcome: Record<string, unknown>, terminalBytes: number): Promise<TopologyChange | null>;
}

/** The SQL store over an engine (the root engine before the locks, a transaction engine inside them). */
export function sqlTopologyStore(exec: RawSql): TopologyStore {
  return {
    async durable() {
      await exec.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    },
    async syncCommit() { await exec.executeRaw("SELECT set_config('synchronous_commit','on',true)"); },
    async lockBrain() { await exec.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE'); },
    async source(sourceId) {
      const [row] = await exec.executeRaw<TopologySourceRow>('SELECT incarnation,config,last_commit,local_path FROM sources WHERE id=$1', [sourceId]);
      return row ?? null;
    },
    async lifecycleSource(sourceId) {
      const [row] = await exec.executeRaw<TopologyLifecycleSourceRow>('SELECT id,incarnation,archived,local_path,config,name,last_commit FROM sources WHERE id=$1', [sourceId]);
      return row ?? null;
    },
    async lockedSource(sourceId) {
      const [row] = await exec.executeRaw<LockedTopologySourceRow>('SELECT incarnation,last_commit,config FROM sources WHERE id=$1', [sourceId]);
      return row ?? null;
    },
    hostWorktrees: hostId => exec.executeRaw<TopologyHostWorktreeRow>(`SELECT w.id AS worktree_id,w.owner_host_id,w.owner_epoch,w.state,w.topology_generation,
        h.local_path,h.coordination_path FROM persistence_host_bindings h JOIN persistence_worktrees w ON w.id=h.worktree_id WHERE h.host_id=$1::uuid`, [hostId]),
    hostLocalPaths: hostId => exec.executeRaw<{ local_path: string | null }>('SELECT local_path FROM persistence_host_bindings WHERE host_id=$1::uuid', [hostId]),
    async firstMember(worktreeId) {
      const [row] = await exec.executeRaw<{ source_id: string }>('SELECT source_id FROM persistence_source_bindings WHERE worktree_id=$1::uuid ORDER BY source_id LIMIT 1', [worktreeId]);
      return row?.source_id ?? null;
    },
    async anyMember(worktreeId) {
      const [row] = await exec.executeRaw<{ source_id: string }>('SELECT source_id FROM persistence_source_bindings WHERE worktree_id=$1::uuid LIMIT 1', [worktreeId]);
      return row?.source_id ?? null;
    },
    async hostBinding(worktreeId, hostId) {
      const [row] = await exec.executeRaw<TopologyHostBindingRow>(
        'SELECT local_path,coordination_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid AND host_id=$2::uuid', [worktreeId, hostId]);
      return row ?? null;
    },
    async lockOwner(worktreeId) {
      const [row] = await exec.executeRaw<{ owner_host_id: string; owner_epoch: string; state: string }>(
        'SELECT owner_host_id,owner_epoch,state FROM persistence_worktrees WHERE id=$1::uuid FOR UPDATE', [worktreeId]);
      return row ?? null;
    },
    lockOwners: worktreeIds => exec.executeRaw<TopologyOwnerRow>(
      'SELECT id,owner_host_id,state,owner_epoch,topology_generation FROM persistence_worktrees WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [worktreeIds]),
    // The states are ACTIVE_REFRESH_STATES_SQL (persistence/worktree-refresh-schema.ts), written out: engine-sql splices no text.
    async activeRefresh(worktreeIds, excludeId) {
      const [row] = await exec.executeRaw<TopologyRefreshRow>(`SELECT id,state,source_ids FROM persistence_worktree_refreshes
    WHERE worktree_id=ANY($1::uuid[]) AND state IN ('draining','fenced','merged','syncing','recovery_required') AND ($2::uuid IS NULL OR id<>$2::uuid) LIMIT 1`, [worktreeIds, excludeId]);
      return row ?? null;
    },
    async members(worktreeIds) {
      const rows = await exec.executeRaw<{ source_id: string }>('SELECT source_id FROM persistence_source_bindings WHERE worktree_id=ANY($1::uuid[]) ORDER BY source_id', [worktreeIds]);
      return rows.map(row => row.source_id);
    },
    async lockSources(sourceIds) { await exec.executeRaw('SELECT id FROM sources WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [sourceIds]); },
    async canonicalStamp(worktreeId) {
      const [row] = await exec.executeRaw<{ stamp: string }>(`SELECT md5(COALESCE(string_agg(p.id::text||':'||p.knowledge_revision::text||':'||b.source_incarnation::text,',' ORDER BY p.id),'')) AS stamp
    FROM persistence_source_bindings b LEFT JOIN pages p ON p.source_id=b.source_id WHERE b.worktree_id=$1::uuid`, [worktreeId]);
      return row.stamp;
    },
    unsettledRequests: (sourceIds, worktreeIds) => exec.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests
    WHERE (source_id=ANY($1::text[]) OR worktree_id=ANY($2::uuid[]))
      AND (state IN ('queued','deferred','running','recovering') OR recovery IS NOT NULL) ORDER BY sequence`, [sourceIds, worktreeIds]),
    async blockingEffect(sourceIds, worktreeIds) {
      const [row] = await exec.executeRaw<TopologyBlockingEffectRow>(`SELECT id,source_id FROM persistence_effects WHERE
    (source_id=ANY($1::text[]) OR worktree_id=ANY($2::uuid[])) AND
    (recovery IS NOT NULL OR state='running' OR (kind='withdrawal-mirror' AND state='queued')) LIMIT 1`, [sourceIds, worktreeIds]);
      return row ?? null;
    },
    async sharePrincipal(principal) {
      if (principal.kind === 'oauth_client') await exec.executeRaw('SELECT client_id FROM oauth_clients WHERE client_id=$1 FOR SHARE', [principal.id]);
      else if (principal.kind === 'legacy_token') await exec.executeRaw('SELECT id FROM access_tokens WHERE id=$1 FOR SHARE', [principal.id]);
      else await exec.executeRaw('SELECT id FROM persistence_local_writers WHERE id=$1::uuid FOR SHARE', [principal.id]);
    },

    async brainId() {
      const [brain] = await exec.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
      return brain?.brain_id ?? null;
    },
    async worktree(worktreeId) {
      const [row] = await exec.executeRaw<TopologyWorktreeRow>('SELECT owner_host_id,state FROM persistence_worktrees WHERE id=$1::uuid', [worktreeId]);
      return row ?? null;
    },
    async change(changeId) {
      const [row] = await exec.executeRaw<TopologyChange>('SELECT * FROM persistence_topology_changes WHERE id=$1::uuid', [changeId]);
      return row ?? null;
    },
    async lockChange(changeId) {
      const [row] = await exec.executeRaw<TopologyChange>('SELECT * FROM persistence_topology_changes WHERE id=$1::uuid FOR UPDATE', [changeId]);
      return row ?? null;
    },
    retireAdmissions: (sourceId, incarnation, principalId, requestId) => exec.executeRaw<TopologyChange>(`SELECT * FROM persistence_topology_changes WHERE source_id=$1 AND source_incarnation=$2::uuid
    AND state='recovering' AND recovery IS NULL AND operation IN ('remove','purge') AND NOT (principal_id=$3::uuid AND request_id=$4::uuid) ORDER BY id`,
      [sourceId, incarnation, principalId, requestId]),

    async recoverWorktree(worktreeId) { await exec.executeRaw("UPDATE persistence_worktrees SET state='recovering' WHERE id=$1::uuid", [worktreeId]); },
    async recoverWorktreeWithManifest(worktreeId, manifest) {
      await exec.executeRaw("UPDATE persistence_worktrees SET state='recovering',manifest=$2::text::jsonb WHERE id=$1::uuid", [worktreeId, JSON.stringify(manifest)]);
    },
    async setWorktreeManifest(worktreeId, manifest) {
      await exec.executeRaw('UPDATE persistence_worktrees SET manifest=$2::text::jsonb WHERE id=$1::uuid', [worktreeId, JSON.stringify(manifest)]);
    },
    async activateWorktree(worktreeId) { await exec.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [worktreeId]); },
    async insertCloneWorktree(worktreeId, hostId) {
      await exec.executeRaw("INSERT INTO persistence_worktrees(id,owner_host_id,owner_epoch,state) VALUES($1::uuid,$2::uuid,1,'recovering')", [worktreeId, hostId]);
    },
    async bindCloneHost(worktreeId, hostId, localPath, coordinationPath) {
      await exec.executeRaw('INSERT INTO persistence_host_bindings(worktree_id,host_id,local_path,coordination_path) VALUES($1::uuid,$2::uuid,$3,$4) ON CONFLICT(worktree_id,host_id) DO NOTHING',
        [worktreeId, hostId, localPath, coordinationPath]);
    },
    async bindCloneSource(sourceId, incarnation, worktreeId) {
      await exec.executeRaw('INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id) VALUES($1,$2::uuid,$3::uuid)', [sourceId, incarnation, worktreeId]);
    },
    async unbindSource(sourceId, incarnation) {
      await exec.executeRaw('DELETE FROM persistence_source_bindings WHERE source_id=$1 AND source_incarnation=$2::uuid', [sourceId, incarnation]);
    },
    async advanceGeneration(worktreeIds) {
      await exec.executeRaw('UPDATE persistence_worktrees SET topology_generation=topology_generation+1 WHERE id=ANY($1::uuid[])', [worktreeIds]);
      await exec.executeRaw(`UPDATE persistence_source_bindings b SET topology_generation=w.topology_generation
    FROM persistence_worktrees w WHERE b.worktree_id=w.id AND w.id=ANY($1::uuid[])`, [worktreeIds]);
    },
    async markTopologyChange() { await exec.executeRaw("SELECT set_config('gbrain.topology_change','on',true)"); },
    // Stores the clone's config (a database write, never printed): the receipt redacts it (source-lifecycle.ts).
    async insertCloneSource({ id, name, localPath, config, incarnation }) {
      await exec.executeRaw('INSERT INTO sources(id,name,local_path,config,incarnation) VALUES($1,$2,$3,$4::text::jsonb,$5::uuid)',
        [id, name, localPath, JSON.stringify(config), incarnation]);
    },
    async resetSourceCheckpoint(sourceId, incarnation) {
      await exec.executeRaw('UPDATE sources SET last_commit=NULL,last_sync_at=NULL WHERE id=$1 AND incarnation=$2::uuid', [sourceId, incarnation]);
    },

    async saveCloneRecovery(changeId, recovery) {
      await exec.executeRaw("UPDATE persistence_topology_changes SET recovery=$2::text::jsonb,updated_at=now() WHERE id=$1::uuid AND state='recovering'", [changeId, JSON.stringify(recovery)]);
    },
    async commitChange(changeId, outcome) {
      await exec.executeRaw("UPDATE persistence_topology_changes SET state='committed',outcome=outcome||$2::text::jsonb,updated_at=now() WHERE id=$1::uuid",
        [changeId, JSON.stringify(outcome)]);
    },
    async releaseChange(changeId, state, outcome) {
      await exec.executeRaw(`UPDATE persistence_topology_changes SET state=$2,recovery=NULL,recovery_bytes=0,updated_at=now(),
    outcome=COALESCE(outcome,'{}'::jsonb)||$3::text::jsonb WHERE id=$1::uuid`, [changeId, state, JSON.stringify(outcome)]);
    },
    async clearChangeRecovery(changeId) {
      await exec.executeRaw('UPDATE persistence_topology_changes SET recovery=NULL,recovery_bytes=0,intent_bytes=0,updated_at=now() WHERE id=$1::uuid', [changeId]);
    },
    async settleRetire(changeId, state, outcome, terminalBytes) {
      const [row] = await exec.executeRaw<TopologyChange>(`UPDATE persistence_topology_changes SET state=$2,outcome=$3::text::jsonb,terminal_bytes=$4,updated_at=now()
    WHERE id=$1::uuid AND state='recovering' AND recovery IS NULL RETURNING *`, [changeId, state, JSON.stringify(outcome), terminalBytes]);
      return row ?? null;
    },
  };
}

/** `topologyStore()` on PGLite and Postgres: the SQL store over the engine it is called on. */
export async function topologyStore(exec: RawSql): Promise<TopologyStore> {
  return sqlTopologyStore(exec);
}
