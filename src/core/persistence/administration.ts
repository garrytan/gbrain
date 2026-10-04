/** Trusted local administration, shared by direct CLI and its authenticated resident proxy. */
import { isAbsolute, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { UNSUPPORTED_MANAGED_BULK_WRITERS } from './maintenance.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { isValidSourceId } from '../source-id.ts';
import { assertValidSlugPrefixes } from '../grants/encoding.ts';
import { isWriteRequestId } from './types.ts';
import { writerDiagnostics } from './control.ts';
import { acceptWriterTransfer, claimWorktree, getWorktreeBinding, humanManifestProgress, prepareWriterTransfer, worktreeManifest } from './ownership.ts';
import { existingLocalHostId, currentVerifiedLocalWriter, persistenceHome, readLocalWriter, registerLocalWriter, revokeLocalWriter, type LocalGrant } from './identity.ts';
import type { PersistenceAdminOperation } from './admin-contract.ts';
import { operationScopesAllowed } from '../scope.ts';
import { assertWriterAdminState, requireWriterAdminIntent, writerAdminState, WRITER_INSPECTION_HINT } from './admin-intent.ts';
import { writerOnboardingPreflight } from './onboarding.ts';
import { assertWriterAdminUnlocked, readWriterAdminLock, setWriterAdminLock } from './admin-lock.ts';
import { listBlockingEffects } from './blocking-effects.ts';
import { listWriterVersions } from './writer-versions.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';

const invalid = (message: string, suggestion = 'Correct that parameter and run the command again; gbrain sources writer --help and gbrain auth local-writer --help list each option and its accepted values.') =>
  opError('invalid_params', message, suggestion);
function source(value: unknown): string {
  if (typeof value !== 'string' || !isValidSourceId(value)) throw invalid('An explicit active source ID is required.', 'Name the source explicitly with its id; gbrain sources list --json shows the active sources.');
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
  if (!scopes.length || scopes.some(scope => !['read', 'write', 'skill_editor', 'skills_member_self'].includes(scope))) throw invalid('Local writer scopes may contain read, write, skill_editor and skills_member_self only.');
  const operations = params.allowed_operations === undefined ? null : strings(params.allowed_operations, 'allowed_operations');
  if (scopes.some(scope => scope === 'skill_editor' || scope === 'skills_member_self') && !operations?.length) {
    throw invalid('Shared-skill capabilities require an explicit nonempty allowed_operations snapshot.');
  }
  if (operations) {
    const { operations: registry } = await import('../operations.ts');
    if (operations.some(name => !registry.some(op => op.name === name && !op.localOnly && operationScopesAllowed(scopes, op)))) {
      throw invalid('allowed_operations must name public operations within the requested read/write scope.');
    }
  }
  const slugPrefixes = params.slug_prefixes === undefined ? null : strings(params.slug_prefixes, 'slug_prefixes');
  if (slugPrefixes) assertValidSlugPrefixes(slugPrefixes);
  return { sourceIds, scopes, operations, slugPrefixes };
}

/** Shown by `writer claim` (and its dry run) while persistence is not activated. */
export const CLAIM_BEFORE_ACTIVATION_NOTICE = 'Persistence is not activated. After this claim, gbrain sync refuses this source with '
  + 'writer_coordinator_required until activation, and legacy file writers in its checkout (sources push, lint --fix and other '
  + 'file-writing maintenance) refuse while the checkout is managed. Stop older writers, review gbrain sources writer status, '
  + 'then activate deliberately.';

export async function runPersistenceAdministration(engine: BrainEngine, operation: PersistenceAdminOperation,
  params: Record<string, unknown>, config?: GBrainConfig, embeddingRetryPolicy: 'owner' | 'mounted_database' = 'owner'): Promise<Record<string, unknown>> {
  if (operation === 'writer_reconcile_preview') return (await import('./reconcile.ts')).runReconcilePreview(engine, params);
  if (operation === 'writer_reconcile_apply') return (await import('./reconcile.ts')).runReconcileApply(engine, params);
  if (operation === 'writer_reconcile_audit') return (await import('./reconcile-audit.ts')).runReconcileAudit(engine, params);
  if (operation === 'writer_reconcile_backups') return (await import('./reconcile.ts')).runReconcileBackups(engine, params);
  if (operation === 'company_brain_preview' || operation === 'company_brain_connect' || operation === 'company_brain_resume') {
    const writer = currentVerifiedLocalWriter();
    if (!writer || writer.remote || writer.principal.kind !== 'local_cli') throw trustedCliRequired('Company source administration requires an authenticated local CLI registration.');
    keys(params, ['brain_id', 'source_id', 'path', 'plan', 'request_id']);
    if (typeof params.brain_id !== 'string' || !params.brain_id.trim()) throw invalid('An explicit brain_id is required.');
    const destination = { brainId: params.brain_id, sourceId: source(params.source_id), remote: false };
    const runtime = await import('../company-brain/runtime.ts');
    if (operation === 'company_brain_resume') return { ...await runtime.resumeCompanyBrain(engine, destination) };
    const input = { ...destination, path: path(params.path), plan: params.plan as import('../company-brain/types.ts').CompanyBrainPlan,
      ...(params.request_id === undefined ? {} : { requestId: uuid(params.request_id) }) };
    if (operation === 'company_brain_preview') return { ...await runtime.previewCompanyBrain(engine, input) };
    return { ...await runtime.connectCompanyBrain(engine, input) };
  }
  if (currentVerifiedLocalWriter()?.remote) throw trustedCliRequired('Writer administration requires a trusted local CLI caller.');
  if (operation === 'writer_lock' || operation === 'writer_unlock') {
    keys(params, []);
    return { ...await setWriterAdminLock(engine, operation === 'writer_lock') };
  }
  // Early refusal before any native lock or preview; the checks inside each transaction stay authoritative.
  if (['writer_claim', 'writer_activate', 'writer_transfer_prepare', 'writer_transfer_accept'].includes(operation)) await assertWriterAdminUnlocked(engine);
  if (operation === 'writer_sync') return (await import('./sync-administration.ts')).runAuthenticatedSyncSlice(engine, params);
  if (operation === 'writer_extract_stale') {
    keys(params, ['source_id', 'dry_run']);
    const writer = currentVerifiedLocalWriter();
    if (!writer || writer.remote || writer.principal.kind !== 'local_cli') throw trustedCliRequired('Stale extraction requires a trusted CLI registration.');
    const { managedPersistenceEnabled } = await import('./ownership.ts');
    if (!await managedPersistenceEnabled(engine)) throw new OperationError('writer_coordinator_required', 'Owner-delegated stale extraction requires activated managed persistence.', WRITER_INSPECTION_HINT);
    return { ...await (await import('./links-maintenance.ts')).runManagedStaleExtraction(engine,
      { sourceId: params.source_id === undefined ? undefined : source(params.source_id), dryRun: params.dry_run === true }) };
  }
  if (operation === 'writer_reindex_code') return (await import('./reindex-administration.ts')).runAuthenticatedCodeReindex(engine, params);
  if (operation === 'writer_embed_facts') return (await import('./embed-facts-administration.ts')).runAuthenticatedFactEmbedding(engine, params, config);
  if (operation === 'writer_retry_effects') {
    keys(params, ['source_id', 'request_id', 'dry_run']);
    if (params.dry_run !== undefined && typeof params.dry_run !== 'boolean') throw invalid('dry_run must be a boolean.');
    if (!isWriteRequestId(params.request_id)) throw invalid('A valid original write request UUID is required.',
      'Pass --request-id with the original write\'s request id (a UUID); gbrain sources writer status for that source lists blocked effects with their request ids.');
    return (await import('./effect-retry.ts')).retryRequestEffects(engine, source(params.source_id), params.request_id, params.dry_run === true, config, embeddingRetryPolicy);
  }
  if (operation === 'source_add' || operation === 'source_lifecycle') {
    const { managedPersistenceEnabled } = await import('./ownership.ts');
    if (!await managedPersistenceEnabled(engine)) throw new OperationError('writer_coordinator_required',
      'Resident source administration requires activated managed persistence.',
      WRITER_INSPECTION_HINT);
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
    if (params.action === 'claim') throw new OperationError('writer_admin_intent_required', 'Claims require the dedicated state-bound writer administration surface.', WRITER_INSPECTION_HINT);
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
    const adminState = await writerAdminState(engine);
    const diagnostics = await writerDiagnostics(engine);
    const bindings = await engine.executeRaw(`SELECT b.source_id,b.source_incarnation,b.worktree_id,b.relative_path,b.topology_generation::text AS topology_generation,
      w.owner_host_id,w.owner_epoch::text AS owner_epoch,w.state,w.manifest->>'digest' AS manifest_digest,h.local_path FROM persistence_source_bindings b
      JOIN persistence_worktrees w ON w.id=b.worktree_id
      LEFT JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$1::uuid
      WHERE ($2::text IS NULL OR b.source_id=$2) ORDER BY b.source_id`, [existingLocalHostId(), params.source_id === undefined ? null : source(params.source_id)]);
    let native: unknown;
    if (params.probe === true) {
      const { nativeLockCapability, tryAcquireNativeLock } = await import('./native-lock.ts');
      const capability = await nativeLockCapability();
      const lock = await tryAcquireNativeLock(join(persistenceHome(), 'locks', 'admin-status-probe.lock'));
      if (!lock) {
        throw opError('writer_lock_unavailable', 'The native lock probe is busy.',
          'Another writer status probe or activation holds the native probe lock on this host. Run the status again without --probe, or probe again once the other command finishes; both are read-only.');
      }
      await lock.release();
      native = { ...capability, acquired: true, released: lock.released };
    }
    const onboarding = await writerOnboardingPreflight(engine, params.source_id as string | undefined);
    const [sharedSkills] = await engine.executeRaw<{ writer_protocol_floor: number; skill_bundles_enabled: boolean }>(
      'SELECT writer_protocol_floor,skill_bundles_enabled FROM persistence_brain WHERE singleton=1');
    const adminLock = await readWriterAdminLock(engine);
    const blockingEffects = await listBlockingEffects(engine, { sourceId: params.source_id as string | undefined, limit: 20 });
    const writerVersions = await listWriterVersions(engine);
    await assertWriterAdminState(engine, adminState, false);
    const { cleanupRetiredManagedMarkers } = await import('./deactivation.ts');
    const [mode] = await engine.executeRaw<{ enabled: boolean; mode_epoch: string | null }>(
      "SELECT enabled, to_jsonb(persistence_brain)->>'mode_epoch' AS mode_epoch FROM persistence_brain WHERE singleton=1");
    return { ...diagnostics, mode: mode?.enabled ? 'managed' : 'classic', mode_epoch: Number(mode?.mode_epoch ?? 1),
      local_markers: await cleanupRetiredManagedMarkers(engine),
      host_id: existingLocalHostId(), local_host_id: existingLocalHostId(), bindings, admin_state: adminState,
      admin_lock: { locked: adminLock.locked, set_at: adminLock.set_at, host_id: adminLock.host_id }, blocking_effects: blockingEffects,
      writer_versions: writerVersions, onboarding, shared_skills: sharedSkills, ...(native ? { native_lock: native } : {}),
      worktree_refreshes: await (await import('./worktree-refresh.ts')).activeWorktreeRefreshes(engine, params.source_id as string | undefined) };
  }
  if (operation === 'writer_claim') {
    keys(params, ['source_id', 'path', 'dry_run', 'admin_intent', 'expected_state']);
    const sourceId = source(params.source_id), root = path(params.path);
    // #5198: say at claim time what the claim retires, before and after the fact.
    const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
    const notice = brain?.enabled ? {} : { activation_required: CLAIM_BEFORE_ACTIVATION_NOTICE };
    if (params.dry_run) return { dry_run: true, action: operation, source_id: sourceId, path: root, current: await getWorktreeBinding(engine, sourceId, existingLocalHostId()), ...notice };
    const expectedState = await requireWriterAdminIntent(engine, operation, params);
    return { claimed: true, binding: await claimWorktree(engine, sourceId, root, undefined, expectedState), ...notice };
  }
  if (operation === 'writer_activate') {
    keys(params, ['confirm_quiesced', 'dry_run', 'shared_skills', 'admin_intent', 'expected_state', 'cleanup_dead_local_locks']);
    if (params.cleanup_dead_local_locks !== undefined && typeof params.cleanup_dead_local_locks !== 'boolean') throw invalid('cleanup_dead_local_locks must be a boolean.');
    if (params.confirm_quiesced !== true) throw invalid('Activation requires --confirm-quiesced after upgrading and stopping older writers on every host.');
    if (params.shared_skills !== undefined && typeof params.shared_skills !== 'boolean') throw invalid('shared_skills must be a boolean.');
    const expectedState = await requireWriterAdminIntent(engine, operation, params);
    if (params.shared_skills === true) {
      const { activateSharedSkillPersistence } = await import('./skill-activation.ts');
      return { ...await activateSharedSkillPersistence(engine, { confirmQuiesced: true, dryRun: params.dry_run === true, expectedState }),
        ...(params.dry_run ? { dry_run: true, action: operation } : {}) };
    }
    const { activatePersistence } = await import('./activation.ts');
    return { ...await activatePersistence(engine, { confirmQuiesced: true, dryRun: params.dry_run === true, expectedState, cleanupDeadLocalLocks: params.cleanup_dead_local_locks === true }),
      unsupported_maintenance: [...UNSUPPORTED_MANAGED_BULK_WRITERS],
      ...(params.dry_run ? { dry_run: true, action: operation } : {}) };
  }
  if (operation === 'writer_deactivate') {
    if (params.source_id !== undefined) throw invalid('Deactivate is brain-wide: it converts every source of this brain back to classic mode. Omit the <source> argument.');
    keys(params, ['dry_run', 'admin_intent', 'expected_state', 'request_id']);
    const { deactivatePersistence } = await import('./deactivation.ts');
    if (params.dry_run === true) {
      // DX-O13: a clean preview prints the state-bound command that applies exactly what it reviewed, so the
      // state is read before the preview and the command is printed only when nothing moved while it ran.
      const state = await writerAdminState(engine);
      const report = await deactivatePersistence(engine, { dryRun: true });
      const unchanged = state === await writerAdminState(engine);
      return { ...report, action: operation, ...(report.mode === 'managed' && report.blockers.length === 0 && unchanged
        ? { apply_command: `gbrain sources writer deactivate --admin-intent writer_deactivate --expected-state ${state}` } : {}) };
    }
    let expectedState: string | undefined;
    try { expectedState = await requireWriterAdminIntent(engine, operation, params); }
    catch (error) {
      if (!(error instanceof OperationError) || error.code !== 'writer_admin_state_changed') throw error;
      error.suggestion = `The current admin_state is ${await writerAdminState(engine)}. Review gbrain sources writer status --json, then rerun with --expected-state <that admin_state>.`;
      throw error;
    }
    return { ...await deactivatePersistence(engine, { expectedState, requestId: params.request_id === undefined ? undefined : uuid(params.request_id) }) };
  }
  if (operation === 'writer_transfer_prepare') {
    keys(params, ['source_id', 'dry_run', 'admin_intent', 'expected_state', 'self_transfer']);
    const sourceId = source(params.source_id);
    if (params.self_transfer !== undefined && typeof params.self_transfer !== 'boolean') throw invalid('self_transfer must be a boolean.');
    if (params.dry_run) {
      const binding = await getWorktreeBinding(engine, sourceId, existingLocalHostId());
      if (!binding || binding.owner_host_id !== existingLocalHostId() || !binding.local_path) {
        throw opError('permission_denied', 'Only the current owner can prepare a transfer.',
          `This host is not source ${sourceId}'s current owner. Run the transfer prepare on the owner host that writer status names; a transfer is a deliberate topology change the operator reviews.`,
          { fix: readFix(`Shows which host owns source ${sourceId}, read-only.`, { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] }) });
      }
      const { manifest } = await prepareWriterTransfer(engine, sourceId, existingLocalHostId()!, undefined, { selfTransfer: params.self_transfer === true, dryRun: true });
      return { dry_run: true, action: operation, binding, manifest: { digest: manifest.digest, file_count: manifest.file_count } };
    }
    const expectedState = await requireWriterAdminIntent(engine, operation, params);
    const prepared = await prepareWriterTransfer(engine, sourceId, undefined, expectedState, { selfTransfer: params.self_transfer === true });
    return { prepared: true, source_id: sourceId, worktree_id: prepared.worktree_id, owner_epoch: prepared.owner_epoch,
      manifest: { digest: prepared.manifest.digest, file_count: prepared.manifest.file_count } };
  }
  if (operation === 'writer_transfer_accept') {
    keys(params, ['source_id', 'path', 'expected_epoch', 'manifest', 'dry_run', 'admin_intent', 'expected_state', 'self_transfer']);
    if (params.self_transfer !== undefined && typeof params.self_transfer !== 'boolean') throw invalid('self_transfer must be a boolean.');
    const sourceId = source(params.source_id), root = path(params.path);
    if (typeof params.expected_epoch !== 'string' || !/^[1-9]\d{0,18}$/.test(params.expected_epoch)
      || BigInt(params.expected_epoch) > 9_223_372_036_854_775_807n) throw invalid('expected_epoch must be the prepared positive owner epoch.');
    if (typeof params.manifest !== 'string' || !/^[a-f0-9]{64}$/.test(params.manifest)) throw invalid('manifest must be the prepared SHA-256 manifest digest.');
    if (params.dry_run && params.self_transfer === true) await acceptWriterTransfer(engine, sourceId, root, params.expected_epoch, params.manifest, existingLocalHostId()!, undefined, { selfTransfer: true, dryRun: true });
    if (params.dry_run) return { dry_run: true, action: operation, source_id: sourceId, current: await getWorktreeBinding(engine, sourceId, existingLocalHostId()),
      manifest_matches: worktreeManifest(root, { progress: humanManifestProgress() }).digest === params.manifest, expected_epoch: params.expected_epoch };
    const expectedState = await requireWriterAdminIntent(engine, operation, params);
    await acceptWriterTransfer(engine, sourceId, root, params.expected_epoch, params.manifest, undefined, expectedState, { selfTransfer: params.self_transfer === true });
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
