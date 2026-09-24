import { randomBytes, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { AgentInstallError } from '../agent-install/state.ts';
import { completeWrite } from '../persistence/journal.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { declarePersistenceProtocol } from '../persistence/protocol.ts';

export interface SharedSkillRestoreOptions {
  mode?: 'new_brain' | 'recovery';
  confirmQuiesced?: boolean;
  confirmBackupCompatible?: boolean;
  confirmAuthorityReviewed?: boolean;
}

export interface SharedSkillRestore {
  mode: 'new_brain' | 'recovery';
  previous_brain_id: string;
  brain_id: string;
  recovery_attestation?: {
    old_service_quiesced: true;
    compatible_backup_reviewed: true;
    authority_reviewed: true;
    external_enforcement: 'operator_required_unverified';
  };
}

export function validateSharedSkillRestoreMode(options: SharedSkillRestoreOptions): 'new_brain' | 'recovery' {
  const mode = options.mode ?? 'new_brain';
  if (mode !== 'new_brain' && mode !== 'recovery') throw new AgentInstallError('invalid_restore_mode', 'Restore mode must be new_brain or recovery.');
  if (mode === 'recovery' && (options.confirmQuiesced !== true || options.confirmBackupCompatible !== true || options.confirmAuthorityReviewed !== true)) {
    throw new AgentInstallError('restore_attestation_required', 'Recovery requires --confirm-quiesced, --confirm-backup-compatible and --confirm-authority-reviewed. These are operator attestations, not proof that the old service is stopped. Keep it externally excluded; all archived credentials and enrollments will still be revoked.');
  }
  if (mode === 'new_brain' && (options.confirmQuiesced || options.confirmBackupCompatible || options.confirmAuthorityReviewed)) throw new AgentInstallError('invalid_restore_mode', 'Recovery attestations require explicit --mode recovery.');
  return mode;
}

export async function quarantineSharedSkillRestore(tx: BrainEngine, restoreId: string, options: SharedSkillRestoreOptions = {}): Promise<SharedSkillRestore | null> {
  const mode = validateSharedSkillRestoreMode(options);
  if (tx.kind !== 'pglite') throw new AgentInstallError('pglite_required', 'External PostgreSQL restores are not managed by local backup restore. Keep restored services offline, validate revocations with the owner, and reissue authority before serving.');
  const [schema] = await tx.executeRaw<{ present: boolean }>("SELECT to_regclass('shared_skill_state') IS NOT NULL AS present");
  if (!schema?.present) {
    if (mode === 'recovery') throw new AgentInstallError('restore_recovery_unsupported', 'Identity recovery requires a compatible operational backup with shared-skill authority metadata. Validate and migrate older backups offline before creating a current operational backup.');
    return null;
  }
  const [brain] = await tx.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE');
  if (!brain) throw new AgentInstallError('invalid_backup', 'The archived shared brain has no persistence identity.');
  const [recovery] = await tx.executeRaw<{ pending: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM persistence_requests WHERE recovery IS NOT NULL OR recovery_bytes<>0 OR state='recovering' OR publication_started AND state IN ('queued','running'))
    OR EXISTS(SELECT 1 FROM persistence_effects WHERE recovery IS NOT NULL OR recovery_bytes<>0)
    OR EXISTS(SELECT 1 FROM persistence_topology_changes WHERE recovery IS NOT NULL OR recovery_bytes<>0 OR state='recovering')
    OR EXISTS(SELECT 1 FROM persistence_worktrees WHERE state='recovering') AS pending`);
  if (recovery.pending) throw new AgentInstallError('restore_recovery_required', 'This shared brain backup contains unresolved file recovery. Preserve the archive and source installation; reconcile recovery with the current canonical owner and create a new backup before restoring.');

  const restored: SharedSkillRestore = { mode, previous_brain_id: brain.brain_id, brain_id: mode === 'recovery' ? brain.brain_id : randomUUID(),
    ...(mode === 'recovery' ? { recovery_attestation: { old_service_quiesced: true as const, compatible_backup_reviewed: true as const,
      authority_reviewed: true as const, external_enforcement: 'operator_required_unverified' as const } } : {}) };
  const policies = await tx.executeRaw('SELECT * FROM shared_skill_policies');
  const sourceBindings = await tx.executeRaw('SELECT * FROM persistence_source_bindings');
  const hostBindings = await tx.executeRaw('SELECT * FROM persistence_host_bindings');
  const worktrees = await tx.executeRaw('SELECT * FROM persistence_worktrees');
  const protocols = await tx.executeRaw('SELECT * FROM persistence_writer_protocols');
  await tx.executeRaw('INSERT INTO config(key,value) VALUES($1,$2)', [`restore.${restoreId}.shared_skills`, JSON.stringify({ ...restored, policies, source_bindings: sourceBindings, host_bindings: hostBindings, worktrees, writer_protocols: protocols })]);
  await declarePersistenceProtocol(tx);
  const pending = await tx.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE state IN ('queued','running') ORDER BY sequence FOR UPDATE");
  for (const request of pending) await completeWrite(tx, request, 'cancelled', {}, { code: mode === 'recovery' ? 'restore_recovery' : 'restore_new_brain', message: 'Restored with archived authority revoked; submit with new authority.' });
  await tx.executeRaw('UPDATE persistence_requests SET execution_token=NULL,claim_expires_at=NULL WHERE execution_token IS NOT NULL OR claim_expires_at IS NOT NULL');
  await tx.executeRaw("UPDATE persistence_effects SET state='failed',execution_token=NULL,claim_expires_at=NULL,error_code=$1,updated_at=now() WHERE state IN ('queued','running')", [mode === 'recovery' ? 'restore_recovery' : 'restore_new_brain']);
  await tx.executeRaw('UPDATE persistence_brain SET brain_id=$1::uuid,skill_bundles_enabled=false WHERE singleton=1', [restored.brain_id]);
  const state = await tx.executeRaw('UPDATE shared_skill_state SET token_secret=$1,serving_epoch=$2::uuid WHERE singleton=1 RETURNING singleton', [randomBytes(32).toString('hex'), randomUUID()]);
  if (state.length !== 1) throw new AgentInstallError('invalid_backup', 'The archived shared brain has no serving identity.');
  await tx.executeRaw("UPDATE shared_skill_policies SET epoch=gen_random_uuid(),policy=policy||'{\"enabled\":false,\"allow_follow\":false}'::jsonb,updated_at=now()");
  await tx.executeRaw("INSERT INTO config(key,value) VALUES('mcp.publish_skills','false') ON CONFLICT(key) DO UPDATE SET value='false'");
  await tx.executeRaw('UPDATE shared_skill_members SET active=false,epoch=epoch+1,desired_view=NULL,acknowledged_view=NULL');
  await tx.executeRaw('UPDATE shared_skill_revision_leases SET expires_at=LEAST(expires_at,now())');
  await tx.executeRaw('UPDATE access_tokens SET revoked_at=COALESCE(revoked_at,now())');
  await tx.executeRaw('UPDATE oauth_clients SET deleted_at=COALESCE(deleted_at,now()),grant_revision=grant_revision+1');
  await tx.executeRaw('UPDATE oauth_tokens SET expires_at=0');
  await tx.executeRaw('UPDATE oauth_codes SET expires_at=0');
  await tx.executeRaw('UPDATE persistence_local_writers SET revoked_at=COALESCE(revoked_at,now())');
  await tx.executeRaw('DELETE FROM persistence_writer_protocols');
  await tx.executeRaw('DELETE FROM persistence_host_bindings');
  await tx.executeRaw('DELETE FROM persistence_source_bindings');
  await tx.executeRaw("UPDATE persistence_worktrees SET owner_host_id=NULL,owner_epoch=owner_epoch+1,topology_generation=topology_generation+1,state='draining',manifest=NULL,heartbeat_at=NULL");
  return restored;
}
