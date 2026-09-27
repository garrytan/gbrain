/** Trusted local administration, shared by direct CLI and its authenticated resident proxy. */
import { isAbsolute, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { isValidSourceId } from '../source-id.ts';
import { assertValidSlugPrefixes } from '../grants/encoding.ts';
import { isWriteRequestId } from './types.ts';
import { writerDiagnostics } from './control.ts';
import { acceptWriterTransfer, claimWorktree, getWorktreeBinding, prepareWriterTransfer, worktreeManifest } from './ownership.ts';
import { localHostId, persistenceHome, readLocalWriter, registerLocalWriter, revokeLocalWriter, type LocalGrant } from './identity.ts';
import type { PersistenceAdminOperation } from './admin-contract.ts';

const invalid = (message: string) => new OperationError('invalid_params', message);
function source(value: unknown): string {
  if (typeof value !== 'string' || !isValidSourceId(value)) throw invalid('An explicit active source ID is required.');
  return value;
}
function path(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw invalid('path must be an absolute directory path on this host.');
  return value;
}
function uuid(value: unknown): string {
  if (!isWriteRequestId(value)) throw invalid('A valid local writer UUID is required.');
  return value;
}
function strings(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) throw invalid(`${key} must be an array of non-empty strings.`);
  return [...new Set(value)];
}
function keys(params: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(params).filter(key => !allowed.includes(key));
  if (unknown.length) throw invalid(`Unsupported administration parameters: ${unknown.join(', ')}.`);
  if (params.dry_run !== undefined && typeof params.dry_run !== 'boolean') throw invalid('dry_run must be a boolean.');
}

async function registrationGrant(engine: BrainEngine, params: Record<string, unknown>): Promise<LocalGrant> {
  const sourceIds = params.source_ids === undefined ? ['*'] : strings(params.source_ids, 'source_ids');
  if (!sourceIds.length || sourceIds.includes('*') && sourceIds.length !== 1 || sourceIds.some(id => id !== '*' && !isValidSourceId(id))) throw invalid('source_ids must name active sources, or contain only "*".');
  if (!sourceIds.includes('*')) {
    const rows = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id=ANY($1::text[]) AND NOT archived', [sourceIds]);
    if (rows.length !== sourceIds.length) throw invalid('Every source_ids entry must name an active source.');
  }
  const scopes = params.scopes === undefined ? ['read', 'write'] : strings(params.scopes, 'scopes');
  if (!scopes.length || scopes.some(scope => !['read', 'write'].includes(scope))) throw invalid('Local writer scopes may contain read and write only.');
  const operations = params.allowed_operations === undefined ? null : strings(params.allowed_operations, 'allowed_operations');
  if (operations) {
    const { operations: registry } = await import('../operations.ts');
    if (operations.some(name => !registry.some(op => op.name === name && !op.localOnly && (op.scope === undefined || scopes.includes(op.scope))))) {
      throw invalid('allowed_operations must name public operations within the requested read/write scope.');
    }
  }
  const slugPrefixes = params.slug_prefixes === undefined ? null : strings(params.slug_prefixes, 'slug_prefixes');
  if (slugPrefixes) assertValidSlugPrefixes(slugPrefixes);
  return { sourceIds, scopes, operations, slugPrefixes };
}

export async function runPersistenceAdministration(engine: BrainEngine, operation: PersistenceAdminOperation,
  params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (operation === 'writer_sync') return (await import('./sync-administration.ts')).runAuthenticatedSyncSlice(engine, params);
  if (operation === 'source_add' || operation === 'source_lifecycle') {
    const { managedPersistenceEnabled } = await import('./ownership.ts');
    if (!await managedPersistenceEnabled(engine)) throw new OperationError('writer_coordinator_required',
      'Resident source administration requires activated managed persistence.',
      'Complete the writer upgrade and activation, or stop the resident owner before using legacy source commands.');
  }
  if (operation === 'source_add') {
    keys(params, ['options', 'request_id', 'dry_run', 'legacy_hardening']);
    if (params.legacy_hardening !== undefined) throw new OperationError('writer_coordinator_required',
      'Source creation cannot install legacy Git hardening on a managed worktree.', 'Create the source without --pat-file.');
    if (!params.options || typeof params.options !== 'object' || Array.isArray(params.options)) throw invalid('Source add requires typed options.');
    const { managedSourceAddInput } = await import('./managed-sources.ts');
    const { runManagedSourceLifecycle } = await import('./source-lifecycle.ts');
    const options = params.options as import('../sources-ops.ts').AddSourceOpts;
    if (options.requestId !== params.request_id || !isWriteRequestId(params.request_id)) throw invalid('Source add request identity must match its options.');
    return runManagedSourceLifecycle(engine, { ...managedSourceAddInput(options), dryRun: params.dry_run === true });
  }
  if(operation==='source_lifecycle') {
    keys(params,['action','source_id','request_id','expected_incarnation','path','name','config','refederate','confirm_destructive','dry_run','remote_url','create_directory','expired_only']);
    const { runManagedSourceLifecycle }=await import('./source-lifecycle.ts');
    return runManagedSourceLifecycle(engine,{operation:params.action as import('./source-lifecycle.ts').SourceLifecycleInput['operation'],sourceId:source(params.source_id),
      requestId:params.request_id as string|undefined,expectedIncarnation:params.expected_incarnation as string|undefined,
      path:params.path===undefined?undefined:path(params.path),name:params.name as string|undefined,config:params.config as Record<string,unknown>|undefined,
      refederate:params.refederate as boolean|undefined,confirmDestructive:params.confirm_destructive as boolean|undefined,dryRun:params.dry_run===true,
      remoteUrl:params.remote_url as string|undefined,createDirectory:params.create_directory as boolean|undefined,expiredOnly:params.expired_only as boolean|undefined});
  }
  if (operation === 'writer_status') {
    keys(params, ['source_id', 'probe']);
    if (params.probe !== undefined && typeof params.probe !== 'boolean') throw invalid('probe must be a boolean.');
    const diagnostics = await writerDiagnostics(engine);
    const bindings = await engine.executeRaw(`SELECT b.source_id,b.source_incarnation,b.worktree_id,b.relative_path,b.topology_generation,
      w.owner_host_id,w.owner_epoch,w.state,w.manifest->>'digest' AS manifest_digest,h.local_path FROM persistence_source_bindings b
      JOIN persistence_worktrees w ON w.id=b.worktree_id
      LEFT JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$1::uuid
      WHERE ($2::text IS NULL OR b.source_id=$2) ORDER BY b.source_id`, [localHostId(), params.source_id === undefined ? null : source(params.source_id)]);
    let native: unknown;
    if (params.probe === true) {
      const { nativeLockCapability, tryAcquireNativeLock } = await import('./native-lock.ts');
      const capability = await nativeLockCapability();
      const lock = await tryAcquireNativeLock(join(persistenceHome(), 'locks', 'admin-status-probe.lock'));
      if (!lock) throw new OperationError('writer_lock_unavailable', 'The native lock probe is busy.');
      await lock.release();
      native = { ...capability, acquired: true, released: lock.released };
    }
    return { ...diagnostics, host_id: localHostId(), bindings, ...(native ? { native_lock: native } : {}) };
  }
  if (operation === 'writer_claim') {
    keys(params, ['source_id', 'path', 'dry_run']);
    const sourceId = source(params.source_id), root = path(params.path);
    if (params.dry_run) return { dry_run: true, action: operation, source_id: sourceId, path: root, current: await getWorktreeBinding(engine, sourceId) };
    return { claimed: true, binding: await claimWorktree(engine, sourceId, root) };
  }
  if (operation === 'writer_activate') {
    keys(params, ['confirm_quiesced', 'dry_run']);
    if (params.confirm_quiesced !== true) throw invalid('Activation requires --confirm-quiesced after upgrading and stopping older writers on every host.');
    const { activatePersistence } = await import('./activation.ts');
    return { ...await activatePersistence(engine, { confirmQuiesced: true, dryRun: params.dry_run === true }),
      ...(params.dry_run ? { dry_run: true, action: operation } : {}) };
  }
  if (operation === 'writer_transfer_prepare') {
    keys(params, ['source_id', 'dry_run']);
    const sourceId = source(params.source_id);
    if (params.dry_run) {
      const binding = await getWorktreeBinding(engine, sourceId);
      if (!binding || binding.owner_host_id !== localHostId() || !binding.local_path) throw new OperationError('permission_denied', 'Only the current owner can prepare a transfer.');
      const manifest = worktreeManifest(binding.local_path);
      return { dry_run: true, action: operation, binding, manifest: { digest: manifest.digest, file_count: Object.keys(manifest.files).length } };
    }
    const prepared = await prepareWriterTransfer(engine, sourceId);
    return { prepared: true, source_id: sourceId, worktree_id: prepared.worktree_id, owner_epoch: prepared.owner_epoch,
      manifest: { digest: prepared.manifest.digest, file_count: Object.keys(prepared.manifest.files).length } };
  }
  if (operation === 'writer_transfer_accept') {
    keys(params, ['source_id', 'path', 'expected_epoch', 'manifest', 'dry_run']);
    const sourceId = source(params.source_id), root = path(params.path);
    if (typeof params.expected_epoch !== 'string' || !/^[1-9]\d{0,18}$/.test(params.expected_epoch)
      || BigInt(params.expected_epoch) > 9_223_372_036_854_775_807n) throw invalid('expected_epoch must be the prepared positive owner epoch.');
    if (typeof params.manifest !== 'string' || !/^[a-f0-9]{64}$/.test(params.manifest)) throw invalid('manifest must be the prepared SHA-256 manifest digest.');
    if (params.dry_run) return { dry_run: true, action: operation, source_id: sourceId, current: await getWorktreeBinding(engine, sourceId),
      manifest_matches: worktreeManifest(root).digest === params.manifest, expected_epoch: params.expected_epoch };
    await acceptWriterTransfer(engine, sourceId, root, params.expected_epoch, params.manifest);
    return { transferred: true, binding: await getWorktreeBinding(engine, sourceId) };
  }
  if (operation === 'local_writer_list') {
    keys(params, ['limit', 'before']);
    const limit = params.limit ?? 100;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw invalid('limit must be an integer from 1 to 1000.');
    const before = params.before === undefined ? null : uuid(params.before);
    const rows = await engine.executeRaw<{ id: string }>(`SELECT id,lane,grant_ceiling,revoked_at,created_at FROM persistence_local_writers
      WHERE ($1::uuid IS NULL OR id<$1::uuid) ORDER BY id DESC LIMIT $2`, [before, limit + 1]);
    return { writers: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1].id : null };
  }
  if (operation === 'local_writer_register') {
    keys(params, ['lane', 'source_ids', 'scopes', 'allowed_operations', 'slug_prefixes', 'replace', 'dry_run']);
    if (params.lane !== 'cli' && params.lane !== 'stdio') throw invalid('lane must be cli or stdio.');
    if (params.replace !== undefined && typeof params.replace !== 'boolean') throw invalid('replace must be a boolean.');
    const grant = await registrationGrant(engine, params);
    // Register is idempotent. Changing an existing ceiling is an explicit replacement.
    if (!params.replace) {
      let existing;
      try { existing = await readLocalWriter(engine, params.lane); }
      catch (error) { if (!(error instanceof OperationError && error.code === 'writer_registration_required')) throw error; }
      if (existing) {
        const [row] = await engine.executeRaw<{ grant_ceiling: LocalGrant }>('SELECT grant_ceiling FROM persistence_local_writers WHERE id=$1::uuid', [existing.id]);
        const sameSet = (a: string[] | null, b: string[] | null) => a === null || b === null ? a === b : JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
        if (!sameSet(row.grant_ceiling.sourceIds, grant.sourceIds) || !sameSet(row.grant_ceiling.scopes, grant.scopes)
          || !sameSet(row.grant_ceiling.operations, grant.operations) || !sameSet(row.grant_ceiling.slugPrefixes, grant.slugPrefixes)) {
          throw new OperationError('writer_regrant_required', 'This lane already has a different grant.', 'Use register --replace with the complete reviewed grant; the previous registration will be revoked.');
        }
      }
    }
    if (params.dry_run) return { dry_run: true, action: operation, lane: params.lane, grant, replace: params.replace === true };
    const local = await registerLocalWriter(engine, params.lane, grant, params.replace === true);
    // Credentials remain in the private local file, never in output or on the socket.
    return { registered: true, id: local.id, lane: local.lane, grant, replaced: params.replace === true };
  }
  if (operation !== 'local_writer_revoke') throw invalid('Unknown local administration operation.');
  keys(params, ['id', 'dry_run']);
  const id = uuid(params.id);
  if (params.dry_run) return { dry_run: true, action: 'local_writer_revoke', id };
  return { id, revoked: await revokeLocalWriter(engine, id) };
}
