import { chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { materializePageSnapshot } from '../page-state/materialize.ts';
import type { JournalLimits } from './model.ts';
import { readJournalLimits } from './limits.ts';
import { lockCounters } from './journal.ts';
import { digest, sha256 } from './digest.ts';
import { getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { withFilesystemPublication } from './filesystem-guard.ts';
import { persistenceFileHash, publishPersistenceFile } from './coordinator.ts';
import type { EffectRecovery, PersistenceEffect } from './effect-model.ts';
import { tryAcquirePublicationCapacity } from './pool-capacity.ts';
import { assertRecoveryStagingAbsent, cleanupRecoveryStaging, upgradeRecoveryStaging } from './staging.ts';

export async function guardEffectSource(tx: BrainEngine, effect: PersistenceEffect, hostId: string): Promise<WorktreeBinding | null> {
  if (effect.worktree_id) {
    const [owner] = await tx.executeRaw<{ owner_host_id: string; state: string }>('SELECT owner_host_id,state FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [effect.worktree_id]);
    if (!owner || owner.owner_host_id !== hostId || owner.state !== 'active') throw new OperationError('owner_unavailable', 'The effect requires its active canonical owner.');
  }
  const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE', [effect.source_id]);
  if (!source || source.archived || source.incarnation !== effect.source_incarnation) throw new OperationError('source_changed', 'The effect source was archived or replaced.');
  const binding = await getWorktreeBinding(tx, effect.source_id, hostId);
  if (effect.worktree_id && (!binding || binding.worktree_id !== effect.worktree_id || binding.source_incarnation !== effect.source_incarnation)) {
    throw new OperationError('source_changed', 'The effect canonical binding changed.');
  }
  return binding;
}

async function lockedEffect(tx: BrainEngine, effect: PersistenceEffect): Promise<PersistenceEffect> {
  const [current] = await tx.executeRaw<PersistenceEffect>('SELECT * FROM persistence_effects WHERE id=$1 FOR UPDATE', [effect.id]);
  if (!current || current.execution_token !== effect.execution_token || current.state !== 'running') throw new OperationError('write_claim_lost', 'The effect claim changed.');
  return current;
}

export async function reserveEffectRecovery(engine: BrainEngine, effect: PersistenceEffect, record: EffectRecovery,
  bytes: number, hostId: string, overrides?: Partial<JournalLimits>): Promise<void> {
  const limits = await readJournalLimits(engine, overrides);
  if (!effect.worktree_id) throw new OperationError('owner_unavailable', 'Physical mirror recovery requires a worktree.');
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > limits.brainRecoveryBytes || bytes > limits.worktreeRecoveryBytes) {
    throw new OperationError('request_too_large', 'The physical mirror exceeds recovery capacity; the withdrawal remains committed.');
  }
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    await guardEffectSource(tx, effect, hostId);
    const counters = await lockCounters(tx, ['brain', `worktree:${effect.worktree_id}`]);
    const current = await lockedEffect(tx, effect);
    if (current.recovery) {
      if (digest(current.recovery) !== digest(record)) throw new OperationError('recovery_required', 'The prior mirror publication must be reconciled first.');
      return;
    }
    for (const counter of counters) if (Number(counter.recovery_bytes) + bytes > (counter.key === 'brain' ? limits.brainRecoveryBytes : limits.worktreeRecoveryBytes)) {
      throw new OperationError('queue_capacity', 'Other publications hold the mirror recovery capacity.');
    }
    await tx.executeRaw('UPDATE persistence_effects SET recovery=$2::text::jsonb,recovery_bytes=$3,updated_at=now() WHERE id=$1', [effect.id, JSON.stringify(record), bytes]);
    for (const counter of counters) await tx.executeRaw('UPDATE persistence_counters SET recovery_bytes=recovery_bytes+$2 WHERE key=$1', [counter.key, bytes]);
  });
}

async function clearRecovery(tx: BrainEngine, effect: PersistenceEffect): Promise<void> {
  if (effect.recovery) assertRecoveryStagingAbsent(effect.recovery);
  if (effect.recovery_bytes) for (const key of ['brain', `worktree:${effect.worktree_id}`]) {
    await tx.executeRaw('UPDATE persistence_counters SET recovery_bytes=recovery_bytes-$2 WHERE key=$1', [key, Number(effect.recovery_bytes)]);
  }
  await tx.executeRaw('UPDATE persistence_effects SET recovery=NULL,recovery_bytes=0 WHERE id=$1', [effect.id]);
}

/** Under the native lock: finish forward, never restore withdrawn bytes. */
export async function recoverEffectPublication(engine: BrainEngine, effect: PersistenceEffect, hostId: string,
  hooks: { boundary?: (name: 'before_mirror_file' | 'after_mirror_file' | 'before_mirror_commit') => Promise<void> } = {}): Promise<void> {
  const releaseCapacity = tryAcquirePublicationCapacity(engine);
  if (!releaseCapacity) throw new OperationError('writer_pool_capacity', 'Mirror recovery is waiting for publication capacity.');
  try {
    if (effect.recovery && !effect.recovery.staging) await upgradeRecoveryStaging(engine, 'persistence_effects', effect.id, effect.worktree_id!, 'forward');
    await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    const binding = await guardEffectSource(tx, effect, hostId);
    await lockCounters(tx, ['brain', `worktree:${effect.worktree_id}`]);
    const current = await lockedEffect(tx, effect);
    const record = current.recovery;
    if (!record) return;
    if (!binding?.local_path || record.kind !== 'withdrawal-mirror' || record.sourceIncarnation !== current.source_incarnation
      || String(binding.owner_epoch) !== record.ownerEpoch || !isWriteTargetContained(record.path, binding.local_path)
      || !isWriteTargetContained(record.path, record.root) || !isWriteTargetContained(record.root, binding.local_path)
      || resolve(record.root) !== resolve(join(binding.local_path, binding.relative_path))
      || sha256(Buffer.from(record.after, 'base64')) !== record.afterHash) throw new OperationError('recovery_required', 'Mirror recovery no longer belongs to this canonical binding.');
    await withFilesystemPublication([record.root], async () => cleanupRecoveryStaging(record));
    const actual = persistenceFileHash(record.path);
    if (actual !== record.beforeHash && actual !== record.afterHash) {
      throw new OperationError('unexpected_file_bytes', 'Physical mirror recovery found unexpected bytes; the root remains blocked.');
    }
    await tx.lockPageKeys([{ sourceId: current.source_id, slug: record.slug }]);
    const snapshot = await tx.readPageSnapshot(record.slug, { sourceId: current.source_id, includeDeleted: true });
    // A newer withdrawal may have committed independently of this root. Do
    // not publish the older prepared representation; render the latest next.
    if (!snapshot || snapshot.page.id !== record.pageId || snapshot.revision !== record.revision) {
      await clearRecovery(tx, current);
      await tx.executeRaw(`UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,
        next_attempt_at=now(),error_code=NULL,updated_at=now() WHERE id=$1`, [current.id]);
      return;
    }
    if (actual === record.beforeHash && actual !== record.afterHash) {
      await hooks.boundary?.('before_mirror_file');
      await withFilesystemPublication([record.root], async () => {
        publishPersistenceFile({ path: record.path, root: record.root, content: Buffer.from(record.after, 'base64') }, record.staging?.publication?.path);
        if (record.mode !== null && existsSync(record.path)) chmodSync(record.path, record.mode);
      });
      await hooks.boundary?.('after_mirror_file');
    }
    await materializePageSnapshot(tx, snapshot);
    await clearRecovery(tx, current);
    // One page per transaction/cursor checkpoint bounds work and restart cost.
    await tx.executeRaw(`UPDATE persistence_effects SET state='queued',data=jsonb_set(data,'{after_slug}',to_jsonb($2::text)),
      execution_token=NULL,claim_expires_at=NULL,next_attempt_at=now(),error_code=NULL,updated_at=now() WHERE id=$1`, [current.id, record.slug]);
    await hooks.boundary?.('before_mirror_commit');
  }); } finally { releaseCapacity(); }
}
