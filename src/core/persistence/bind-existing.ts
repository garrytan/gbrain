import { randomUUID } from 'node:crypto';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { trustedCliRequired } from '../ops/op-fix.ts';
import { isValidSourceId } from '../source-id.ts';
import { discoverGitRoot } from '../sync-git.ts';
import { NOT_PAGE_EMBEDDING_LEASE } from '../page-embedding-lease.ts';
import { assertWriterAdminState, requireWriterAdminIntent, writerAdminState } from './admin-intent.ts';
import { assertWriterAdminUnlocked } from './admin-lock.ts';
import { currentVerifiedLocalWriter, existingLocalHostId } from './identity.ts';
import { digest, jsonBytes } from './digest.ts';
import { isWriteRequestId } from './types.ts';
import { containsPath, worktreeManifest } from './ownership.ts';
import { compactStoredManifest, type WorktreeManifest } from './worktree-manifest.ts';
import { PHYSICAL_ROOT_MARKER, abortMovedReservation, cleanMovedReservation, discardMovedReservationPreparation, inspectMovedReservation, physicalRootReservationPath, prepareMovedReservationAbort, prepareMovedReservationPublication, publishMovedReservation, publishedMovedReservationProof, verifyAbortedMovedReservation, verifyMovedReservation, type MovedReservationProof } from './physical-root-record.ts';
import { advanceTopology, assertSourceKeyUnreserved, lockTopologyPrincipal, topologyCanonicalStamp, withExistingWorktreeLocks } from './topology-locks.ts';
import { priorTopologyChange, recordTopologyChange, releaseTopologyReservation, topologyReceipt, type TopologyChange } from './topology-receipts.ts';
import { topologyTransaction } from './topology-transaction.ts';
import { withCoordinatedWrite } from './context.ts';
import { principalAttribution } from './attribution.ts';
import { installExistingTopologyBinding } from './source-lifecycle.ts';
import { managedFilesystemDatastorePath, refreshManagedFilesystemRoots } from './filesystem-guard.ts';
import { ACTIVE_REFRESH_STATES_SQL } from './worktree-refresh-schema.ts';

export interface BindExistingInput {
  sourceId: string; path: string; worktreeId: string; reservationFile: string;
  expectedEpoch: string; expectedGeneration: string; requestId: string;
}
export interface BindExistingHooks { boundary?: (name: string) => void | Promise<void>; }
interface Owner { id: string; owner_host_id: string; owner_epoch: string; topology_generation: string; state: string; manifest: Record<string, unknown> | null; }
interface BindPlan {
  input: BindExistingInput; brainId: string; hostId: string; owner: Owner; host: Record<string, unknown>;
  physical: MovedReservationProof; manifest: WorktreeManifest; adminState: string;
}
interface BindRecovery {
  version: 1; kind: 'bind_existing'; phase: 'reserved' | 'physical_ready' | 'sql_committed' | 'aborting';
  worktreeId: string; sourceId: string; ownerHostId: string; ownerEpoch: string; generation: string;
  input: BindExistingInput; brainId: string; host: Record<string, unknown>; ownerManifest: Record<string, unknown> | null;
  physical: MovedReservationProof; manifest: WorktreeManifest; incarnation: string; failureCode?: string;
}
function refusal(code: 'recovery_required' | 'source_changed' | 'write_pending' | 'invalid_params', message: string): OperationError {
  return opError(code, message, 'Inspect the reviewed existing-worktree binding. Do not remove metadata, force ownership, or substitute another identity.');
}
function inputFor(params: Record<string, unknown>): BindExistingInput {
  for (const key of ['path', 'reservation_file']) if (typeof params[key] !== 'string' || !isAbsolute(params[key] as string) || resolve(params[key] as string) !== params[key] || (params[key] as string).includes('\0')) throw refusal('invalid_params', `${key} must be an explicit canonical absolute path.`);
  if (!isValidSourceId(params.source_id as string) || !isWriteRequestId(params.worktree_id) || !isWriteRequestId(params.request_id)
    || !['expected_epoch', 'expected_generation'].every(key => typeof params[key] === 'string' && /^[1-9]\d{0,17}$/.test(params[key] as string))) throw refusal('invalid_params', 'Explicit source, worktree UUID, request UUID, epoch and generation are required.');
  return { sourceId: params.source_id as string, path: params.path as string, worktreeId: params.worktree_id as string, reservationFile: params.reservation_file as string,
    expectedEpoch: params.expected_epoch as string, expectedGeneration: params.expected_generation as string, requestId: params.request_id as string };
}
function principal(): string {
  const writer = currentVerifiedLocalWriter();
  if (!writer || writer.remote || writer.principal.kind !== 'local_cli') throw trustedCliRequired('Existing-worktree binding requires the authenticated resident local CLI lane.');
  return writer.principal.id;
}
async function principalRead(engine: BrainEngine, id: string): Promise<void> {
  const [writer] = await engine.executeRaw<{ lane: string; revoked_at: unknown }>('SELECT lane,revoked_at FROM persistence_local_writers WHERE id=$1::uuid', [id]);
  if (!writer || writer.lane !== 'cli' || writer.revoked_at != null) throw opError('permission_denied', 'The administering CLI registration is revoked or unavailable.', 'Use the existing authorized administration lane; no credentials were changed.');
}
async function quiet(engine: BrainEngine, input: BindExistingInput, ownId?: string): Promise<void> {
  const [pending] = await engine.executeRaw(`SELECT id FROM persistence_requests WHERE (worktree_id=$1::uuid OR source_id=$2)
    AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) LIMIT 1`, [input.worktreeId, input.sourceId]);
  const [effect] = await engine.executeRaw(`SELECT id FROM persistence_effects WHERE (worktree_id=$1::uuid OR source_id=$2)
    AND (state IN ('queued','running') OR recovery IS NOT NULL) LIMIT 1`, [input.worktreeId, input.sourceId]);
  const [refresh] = await engine.executeRaw(`SELECT id FROM persistence_worktree_refreshes WHERE worktree_id=$1::uuid AND state IN ${ACTIVE_REFRESH_STATES_SQL} LIMIT 1`, [input.worktreeId]);
  const [change] = await engine.executeRaw(`SELECT id FROM persistence_topology_changes WHERE ($1::uuid=ANY(worktree_ids) OR source_id=$2)
    AND (state='recovering' OR recovery IS NOT NULL) AND ($3::uuid IS NULL OR id<>$3::uuid) LIMIT 1`, [input.worktreeId, input.sourceId, ownId ?? null]);
  const [lease] = await engine.executeRaw(`SELECT id FROM gbrain_cycle_locks WHERE ${NOT_PAGE_EMBEDDING_LEASE} LIMIT 1`);
  if (pending || effect || refresh || change || lease) throw refusal('write_pending', 'Existing-worktree binding requires quiescent requests, effects, refreshes, transfers and maintenance leases.');
}
async function readOwner(engine: BrainEngine, input: BindExistingInput, lock = false): Promise<{ owner: Owner; hosts: Record<string, unknown>[] }> {
  const [owner] = await engine.executeRaw<Owner>(`SELECT id,owner_host_id,owner_epoch::text,topology_generation::text,state,manifest FROM persistence_worktrees WHERE id=$1::uuid${lock ? ' FOR UPDATE' : ''}`, [input.worktreeId]);
  const hosts = await engine.executeRaw<Record<string, unknown>>(`SELECT * FROM persistence_host_bindings WHERE worktree_id=$1::uuid ORDER BY host_id${lock ? ' FOR UPDATE' : ''}`, [input.worktreeId]);
  if (!owner || hosts.length !== 1) throw refusal('recovery_required', 'The worktree UUID must have exactly one host binding.');
  return { owner, hosts };
}
async function assertNoBinding(engine: BrainEngine, input: BindExistingInput, ownId?: string): Promise<void> {
  await assertSourceKeyUnreserved(engine, input.sourceId, ownId);
  const [source] = await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [input.sourceId]);
  const [member] = await engine.executeRaw('SELECT source_id FROM persistence_source_bindings WHERE worktree_id=$1::uuid OR source_id=$2 LIMIT 1', [input.worktreeId, input.sourceId]);
  if (source || member) throw refusal('source_changed', 'The source ID must be absent, including archived sources, and this worktree must be unbound.');
}
async function overlaps(engine: BrainEngine, input: BindExistingInput, hostId: string): Promise<void> {
  const roots = await engine.executeRaw<{ local_path: string }>(`SELECT h.local_path FROM persistence_host_bindings h JOIN persistence_worktrees w ON w.id=h.worktree_id
    WHERE h.worktree_id<>$1::uuid AND h.host_id=$2::uuid AND w.state IN ('active','draining','recovering')`, [input.worktreeId, hostId]);
  if (roots.some(row => containsPath(row.local_path, input.path) || containsPath(input.path, row.local_path))) throw refusal('recovery_required', 'The current root overlaps another retained worktree.');
}
async function makePlan(engine: BrainEngine, input: BindExistingInput, id: string): Promise<BindPlan> {
  await principalRead(engine, id); await assertWriterAdminUnlocked(engine);
  const adminState = await writerAdminState(engine), hostId = existingLocalHostId();
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  if (!brain || !hostId) throw refusal('recovery_required', 'The existing brain and host identities are required.');
  const { owner, hosts } = await readOwner(engine, input), host = hosts[0];
  if (owner.owner_host_id !== hostId || host.host_id !== hostId || owner.owner_epoch !== input.expectedEpoch || owner.topology_generation !== input.expectedGeneration || owner.state !== 'active' || owner.manifest?.prepared_at) throw refusal('source_changed', 'The existing owner, epoch, generation or active state does not match.');
  if (realpathSync(input.path) !== input.path || realpathSync(discoverGitRoot(input.path)) !== input.path) throw refusal('recovery_required', 'The source path must be the discovered canonical Git worktree root.');
  if (typeof host.coordination_path !== 'string') throw refusal('recovery_required', 'The recorded coordination path is required.');
  const physical = inspectMovedReservation(input.path, input.reservationFile, { brainId: brain.brain_id, worktreeId: input.worktreeId, hostId, coordinationPath: host.coordination_path });
  if (host.local_path !== input.path && host.local_path !== physical.historicalRoot) throw refusal('source_changed', 'The complete host binding names neither the current nor historical root.');
  await assertNoBinding(engine, input); await overlaps(engine, input, hostId); await quiet(engine, input);
  const manifest = compactStoredManifest(worktreeManifest(input.path));
  if (digest(physical) !== digest(inspectMovedReservation(input.path, input.reservationFile, { brainId: brain.brain_id, worktreeId: input.worktreeId, hostId, coordinationPath: host.coordination_path })) || adminState !== await writerAdminState(engine)) throw refusal('source_changed', 'The preview changed while it was read.');
  return { input, brainId: brain.brain_id, hostId, owner, host, physical, manifest, adminState };
}
function planHash(plan: BindPlan): string { return digest(plan); }
function intentFor(input: BindExistingInput, params: Record<string, unknown>): unknown { return { operation: 'writer_bind_existing', ...input, requestId: undefined, expect: params.expect, expectedState: params.expected_state }; }
async function change(engine: BrainEngine, id: string): Promise<TopologyChange> {
  const [row] = await engine.executeRaw<TopologyChange>('SELECT * FROM persistence_topology_changes WHERE id=$1::uuid', [id]);
  if (!row) throw refusal('recovery_required', 'The durable binding request cannot be read.');
  return row;
}
function recoveryOf(row: TopologyChange): BindRecovery {
  const record = row.recovery as unknown as BindRecovery;
  if (!record || record.version !== 1 || record.kind !== 'bind_existing' || !['reserved', 'physical_ready', 'sql_committed', 'aborting'].includes(record.phase)
    || record.sourceId !== row.source_id || record.worktreeId !== record.input?.worktreeId || record.ownerHostId !== existingLocalHostId()
    || record.physical?.worktreeId !== record.worktreeId || record.physical?.brainId !== record.brainId || record.physical?.hostId !== record.ownerHostId
    || record.physical?.root !== record.input?.path || record.physical?.reservationFile !== record.input?.reservationFile) throw refusal('recovery_required', 'The durable existing-worktree recovery record is invalid.');
  return record;
}
async function guard(engine: BrainEngine, row: TopologyChange, record: BindRecovery, committed: boolean): Promise<void> {
  await engine.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  const { owner, hosts } = await readOwner(engine, record.input, true), expectedHost = committed ? { ...record.host, local_path: record.input.path } : record.host;
  if (brain?.brain_id !== record.brainId || owner.owner_host_id !== record.ownerHostId || owner.owner_epoch !== record.ownerEpoch || owner.state !== 'recovering'
    || owner.topology_generation !== (committed ? String(BigInt(record.generation) + 1n) : record.generation) || digest(hosts[0]) !== digest(expectedHost)
    || !committed && digest(owner.manifest) !== digest(record.ownerManifest)) throw refusal('source_changed', 'The recovering worktree ownership or complete host binding changed.');
  await engine.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [record.sourceId]);
  await assertSourceKeyUnreserved(engine, record.sourceId, row.id);
  if (!committed) await assertNoBinding(engine, record.input, row.id);
  else {
    const [source] = await engine.executeRaw<{ incarnation: string; local_path: string; archived: boolean }>('SELECT incarnation,local_path,archived FROM sources WHERE id=$1', [record.sourceId]);
    const members = await engine.executeRaw<{ source_id: string; source_incarnation: string; relative_path: string; topology_generation: string }>('SELECT source_id,source_incarnation,relative_path,topology_generation::text FROM persistence_source_bindings WHERE worktree_id=$1::uuid', [record.worktreeId]);
    if (!source || source.incarnation !== record.incarnation || source.local_path !== record.input.path || source.archived || members.length !== 1
      || members[0].source_id !== record.sourceId || members[0].source_incarnation !== record.incarnation || members[0].relative_path !== '' || members[0].topology_generation !== owner.topology_generation
      || owner.manifest?.digest !== record.manifest.digest) throw refusal('source_changed', 'The committed existing-worktree binding changed before cleanup.');
  }
}
function recoveryCapacity(record: BindRecovery): number {
  // Native stat integers fit well inside 64 decimal characters. Model the longest
  // phase with all three actual JSON-escaped stage paths before reserving quota.
  const number = '9'.repeat(64);
  const identity = { device: number, inode: number, birth: number, mode: number, uid: number, size: number };
  const stage = (parent: string) => join(parent, `${PHYSICAL_ROOT_MARKER}.${'0'.repeat(36)}.tmp`);
  return jsonBytes({ ...record, phase: 'physical_ready', failureCode: '_'.repeat(64), physical: {
    ...record.physical,
    published: { reservation: identity, stamp: identity },
    staged: { reservation: stage(dirname(record.physical.root)), stamp: stage(record.physical.root) },
    abortStamp: { path: stage(record.physical.root), identity },
  } });
}
async function storePhase(engine: BrainEngine, row: TopologyChange, record: BindRecovery): Promise<void> {
  if (jsonBytes(record) > Number(row.recovery_bytes)) throw opError('request_too_large', 'The binding recovery exceeds its reserved capacity.', 'Keep the exact request for recovery; do not publish unaccounted ownership metadata.');
  await engine.executeRaw("UPDATE persistence_topology_changes SET recovery=$2::text::jsonb,updated_at=now() WHERE id=$1::uuid AND state='recovering'", [row.id, JSON.stringify(record)]);
}
async function checkpointPhysical(engine: BrainEngine, row: TopologyChange, record: BindRecovery, physical: MovedReservationProof, kind: 'publication' | 'abort'): Promise<BindRecovery> {
  if (physical === record.physical) return record;
  const next = { ...record, physical };
  try { await topologyTransaction(engine, async tx => { await guard(tx, row, next, false); await storePhase(tx, row, next); }); }
  catch (error) {
    let durable: TopologyChange;
    try { durable = await change(engine, row.id); } catch { throw error; }
    const paths = kind === 'abort' ? [physical.abortStamp!.path] : Object.values(physical.staged!);
    if (!paths.some(path => JSON.stringify(durable.recovery).includes(JSON.stringify(path)))) discardMovedReservationPreparation(physical, kind);
    throw error;
  }
  return next;
}
async function abort(engine: BrainEngine, row: TopologyChange, record: BindRecovery, code: string, hooks: BindExistingHooks): Promise<TopologyChange> {
  record = { ...record, phase: 'aborting', failureCode: /^[a-z_]{1,64}$/.test(code) ? code : 'recovery_required' };
  await topologyTransaction(engine, async tx => { await guard(tx, row, record, false); await storePhase(tx, row, record); });
  record = await checkpointPhysical(engine, row, record, prepareMovedReservationAbort(record.physical), 'abort');
  await hooks.boundary?.('abort_prepared');
  await abortMovedReservation(record.physical, hooks.boundary);
  await hooks.boundary?.('before_abort_cleanup');
  await topologyTransaction(engine, async tx => {
    await guard(tx, row, record, false); verifyAbortedMovedReservation(record.physical); await releaseTopologyReservation(tx, row);
    await tx.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [record.worktreeId]);
    await tx.executeRaw("UPDATE persistence_topology_changes SET state='failed',outcome=outcome||$2::text::jsonb WHERE id=$1::uuid", [row.id, JSON.stringify({ phase: 'cleaned', write_error: record.failureCode })]);
  });
  return change(engine, row.id);
}
async function finishLocked(engine: BrainEngine, id: string, hooks: BindExistingHooks): Promise<TopologyChange> {
  let row = await change(engine, id); if (!row.recovery) return row;
  let record = recoveryOf(row);
  if (record.phase === 'aborting') return abort(engine, row, record, record.failureCode ?? 'recovery_required', hooks);
  if (record.phase !== 'sql_committed') {
    try {
      await topologyTransaction(engine, async tx => { await guard(tx, row, record, false); await assertWriterAdminUnlocked(tx); await quiet(tx, record.input, row.id); await lockTopologyPrincipal(tx, row.principal_id); });
      if (record.phase === 'reserved') {
        record = await checkpointPhysical(engine, row, record, prepareMovedReservationPublication(record.physical), 'publication');
        await hooks.boundary?.('publication_prepared');
        await publishMovedReservation(record.physical, hooks.boundary);
        record = { ...record, phase: 'physical_ready', physical: publishedMovedReservationProof(record.physical) };
        await topologyTransaction(engine, async tx => { await guard(tx, row, record, false); await storePhase(tx, row, record); });
        await hooks.boundary?.('physical_ready');
      }
      await hooks.boundary?.('before_sql_commit');
      await topologyTransaction(engine, async tx => {
        await guard(tx, row, record, false); await assertWriterAdminUnlocked(tx); await quiet(tx, record.input, row.id); await lockTopologyPrincipal(tx, row.principal_id); await overlaps(tx, record.input, record.ownerHostId);
        verifyMovedReservation(record.physical);
        if (digest(compactStoredManifest(worktreeManifest(record.input.path))) !== digest(record.manifest)) throw refusal('source_changed', 'The canonical manifest changed before binding.');
        await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
        await withCoordinatedWrite(tx, [record.sourceId], async () => {
          await installExistingTopologyBinding(tx, { sourceId: record.sourceId, incarnation: record.incarnation, worktreeId: record.worktreeId, root: record.input.path, host: record.host });
          await advanceTopology(tx, [record.worktreeId]);
          await tx.executeRaw('UPDATE persistence_worktrees SET manifest=$2::text::jsonb WHERE id=$1::uuid', [record.worktreeId, JSON.stringify({ ...record.manifest, canonical_stamp: await topologyCanonicalStamp(tx, record.worktreeId) })]);
        }, principalAttribution({ kind: 'local_cli', id: row.principal_id }));
        await storePhase(tx, row, { ...record, phase: 'sql_committed' });
      });
      row = await change(engine, id); record = recoveryOf(row);
    } catch (error) {
      row = await change(engine, id); if (!row.recovery) return row;
      record = recoveryOf(row);
      if (record.phase !== 'sql_committed') {
        const code = (error as { code?: string }).code;
        if (['permission_denied', 'source_changed', 'writer_admin_locked'].includes(code ?? '')) return abort(engine, row, record, code!, hooks);
        throw error;
      }
    }
  }
  await hooks.boundary?.('sql_committed');
  await topologyTransaction(engine, async tx => { await guard(tx, row, record, true); });
  verifyMovedReservation(record.physical, true);
  if (digest(compactStoredManifest(worktreeManifest(record.input.path))) !== digest(record.manifest)) throw refusal('source_changed', 'The committed canonical manifest changed before cleanup.');
  cleanMovedReservation(record.physical); await hooks.boundary?.('historical_removed');
  await hooks.boundary?.('before_cleanup');
  try {
    await topologyTransaction(engine, async tx => {
      await guard(tx, row, record, true); verifyMovedReservation(record.physical, true);
      await refreshManagedFilesystemRoots(tx, managedFilesystemDatastorePath(engine));
      await releaseTopologyReservation(tx, row);
      await tx.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [record.worktreeId]);
      await tx.executeRaw("UPDATE persistence_topology_changes SET state='committed',outcome=outcome||$2::text::jsonb,updated_at=now() WHERE id=$1::uuid", [row.id,
        JSON.stringify({ phase: 'cleaned', bound: true, worktree_id: record.worktreeId, source_id: record.sourceId, source_incarnation: record.incarnation, owner_epoch: record.ownerEpoch, topology_generation: String(BigInt(record.generation) + 1n), local_path: record.input.path })]);
    });
  } catch (error) {
    const durable = await change(engine, id);
    if (durable.state !== 'committed' || durable.recovery) throw error;
    return durable;
  }
  await hooks.boundary?.('cleaned');
  return change(engine, id);
}
/** Explicit replay and background recovery share the same native lock order and exact durable request. */
export async function finishBindExisting(engine: BrainEngine, id: string, hooks: BindExistingHooks = {}, waitMs = 5000): Promise<TopologyChange> {
  const row = await change(engine, id); if (!row.recovery) return row;
  const record = recoveryOf(row);
  return withExistingWorktreeLocks(engine, record.worktreeId, async () => finishLocked(engine, id, hooks), { waitMs, reservationGuard: `${physicalRootReservationPath(record.input.path)}.repair.lock` });
}
export async function bindExistingWorktree(engine: BrainEngine, params: Record<string, unknown>, hooks: BindExistingHooks = {}): Promise<Record<string, unknown>> {
  const input = inputFor(params), id = principal(), intent = intentFor(input, params);
  await principalRead(engine, id);
  if (!params.dry_run) {
    const prior = await priorTopologyChange(engine, id, input.requestId, intent);
    if (prior) return topologyReceipt(prior.recovery ? await finishBindExisting(engine, prior.id, hooks) : prior);
    await requireWriterAdminIntent(engine, 'writer_bind_existing', params);
    if (typeof params.expect !== 'string' || !/^[a-f0-9]{64}$/.test(params.expect)) throw refusal('invalid_params', 'Apply requires the exact reviewed preview plan hash.');
  }
  let plan: BindPlan;
  try { plan = await makePlan(engine, input, id); }
  catch (error) {
    if (!params.dry_run) throw error;
    return { dry_run: true, action: 'writer_bind_existing', eligible: false, blockers: [{ code: (error as { code?: string }).code ?? 'recovery_required' }], expected_admin_state: await writerAdminState(engine) };
  }
  if (params.dry_run) return { dry_run: true, action: 'writer_bind_existing', eligible: true, blockers: [], expected_admin_state: plan.adminState, plan_hash: planHash(plan),
    before: { worktree_id: input.worktreeId, owner_host_id: plan.hostId, owner_epoch: input.expectedEpoch, topology_generation: input.expectedGeneration, local_path: plan.host.local_path, source_id_absent: true },
    after: { worktree_id: input.worktreeId, owner_host_id: plan.hostId, owner_epoch: input.expectedEpoch, topology_generation: String(BigInt(input.expectedGeneration) + 1n), local_path: input.path, source_id: input.sourceId },
    physical_preimage: digest(plan.physical), manifest: plan.manifest };
  if (params.expect !== planHash(plan)) throw refusal('source_changed', 'The reviewed existing-worktree plan changed.');
  return withExistingWorktreeLocks(engine, input.worktreeId, async () => {
    const current = await makePlan(engine, input, id);
    if (planHash(current) !== params.expect) throw refusal('source_changed', 'The plan changed while acquiring native locks.');
    await hooks.boundary?.('before_reserved');
    let row: TopologyChange;
    try { row = await topologyTransaction(engine, async tx => {
      await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
      await assertWriterAdminState(tx, params.expected_state as string); await assertWriterAdminUnlocked(tx);
      await readOwner(tx, input, true); await assertNoBinding(tx, input); await quiet(tx, input); await lockTopologyPrincipal(tx, id);
      if (planHash(await makePlan(tx, input, id)) !== params.expect) throw refusal('source_changed', 'The reviewed plan no longer matches under SQL guards.');
      const record: BindRecovery = { version: 1, kind: 'bind_existing', phase: 'reserved', worktreeId: input.worktreeId, sourceId: input.sourceId,
        ownerHostId: current.hostId, ownerEpoch: input.expectedEpoch, generation: input.expectedGeneration, input, brainId: current.brainId, host: current.host, ownerManifest: current.owner.manifest,
        physical: current.physical, manifest: current.manifest, incarnation: randomUUID() };
      const result = await recordTopologyChange(tx, { principal: id, requestId: input.requestId, intent, operation: 'writer_bind_existing', sourceId: input.sourceId, incarnation: record.incarnation, worktrees: [input.worktreeId] },
        { operation: 'writer_bind_existing', source_id: input.sourceId, worktree_id: input.worktreeId }, record as unknown as Record<string, unknown>, recoveryCapacity(record));
      await tx.executeRaw("UPDATE persistence_worktrees SET state='recovering' WHERE id=$1::uuid", [input.worktreeId]);
      return result;
    }); } catch (error) {
      const durable = await priorTopologyChange(engine, id, input.requestId, intent);
      if (!durable) throw error;
      if (!durable.recovery) return topologyReceipt(durable);
      row = durable;
    }
    await hooks.boundary?.('reserved');
    return topologyReceipt(await finishLocked(engine, row.id, hooks));
  }, { reservationGuard: `${physicalRootReservationPath(input.path)}.repair.lock` });
}
