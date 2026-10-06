import { chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
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
import { declarePersistenceProtocol } from './protocol.ts';
import { advanceEffectCursor } from './effect-journal.ts';
import { faultPoint } from './fault-points.ts';

const effectStatusFix = (effect: Pick<PersistenceEffect, 'source_id'>): Action => readFix(
  `Shows source ${effect.source_id}'s canonical owner with its blocking, retrying and parked effects, read-only.`,
  { argv: ['gbrain', 'sources', 'writer', 'status', '--source', effect.source_id, '--json'] });

export async function guardEffectSource(tx: BrainEngine, effect: PersistenceEffect, hostId: string): Promise<WorktreeBinding | null> {
  await declarePersistenceProtocol(tx);
  // Lock order is brain row, then source row: the effect-row protocol trigger share-locks the brain row,
  // and a worktree claim holds the brain row while it locks the source (#6007 deadlock).
  await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR SHARE');
  if (effect.worktree_id) {
    const [owner] = await tx.executeRaw<{ owner_host_id: string; state: string }>('SELECT owner_host_id,state FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [effect.worktree_id]);
    if (!owner || owner.owner_host_id !== hostId || owner.state !== 'active') throw opError('owner_unavailable', 'The effect requires its active canonical owner.',
      `This host is not the active canonical owner of source ${effect.source_id}'s worktree, so its ${effect.kind} effect waits for the owner; the committed write is unaffected. Inspect the owner; the effect runs there.`,
      { fix: effectStatusFix(effect) });
  }
  const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE', [effect.source_id]);
  if (!source || source.archived || source.incarnation !== effect.source_incarnation) throw opError('source_changed', 'The effect source was archived or replaced.',
    `Source ${effect.source_id} was archived, removed or re-created after this ${effect.kind} effect was recorded, so it no longer applies and nothing was done for it. Inspect the source before acting on its old effects.`,
    { fix: effectStatusFix(effect) });
  const binding = await getWorktreeBinding(tx, effect.source_id, hostId);
  if (effect.worktree_id && (!binding || binding.worktree_id !== effect.worktree_id || binding.source_incarnation !== effect.source_incarnation)) {
    throw opError('source_changed', 'The effect canonical binding changed.',
      `Source ${effect.source_id}'s canonical worktree binding changed (a transfer, re-claim or new incarnation) after this ${effect.kind} effect was recorded, so nothing was done for it. Inspect the owner; do not claim or transfer the source to force the effect through.`,
      { fix: effectStatusFix(effect) });
  }
  return binding;
}

async function lockedEffect(tx: BrainEngine, effect: PersistenceEffect): Promise<PersistenceEffect> {
  const [current] = await tx.executeRaw<PersistenceEffect>('SELECT * FROM persistence_effects WHERE id=$1 FOR UPDATE', [effect.id]);
  if (!current || current.execution_token !== effect.execution_token || current.state !== 'running') throw opError('write_claim_lost', 'The effect claim changed.',
    `Another worker took over this ${effect.kind} effect of source ${effect.source_id} (its claim expired or was reassigned), so this attempt stopped without changing it; the current holder finishes it. Inspect the owner's effects rather than retrying by hand.`,
    { fix: effectStatusFix(effect) });
  return current;
}

export async function reserveEffectRecovery(engine: BrainEngine, effect: PersistenceEffect, record: EffectRecovery,
  bytes: number, hostId: string, overrides?: Partial<JournalLimits>): Promise<void> {
  const limits = await readJournalLimits(engine, overrides);
  if (!effect.worktree_id) throw opError('owner_unavailable', 'Physical mirror recovery requires a worktree.',
    `This ${effect.kind} effect of source ${effect.source_id} has no canonical worktree, so there is no file to mirror and nothing was reserved; the withdrawal remains committed. Inspect the source's owner binding.`,
    { fix: effectStatusFix(effect) });
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > limits.brainRecoveryBytes || bytes > limits.worktreeRecoveryBytes) {
    throw opError('request_too_large', 'The physical mirror exceeds recovery capacity; the withdrawal remains committed.',
      `Mirroring this withdrawal into its file in source ${effect.source_id} needs ${bytes} bytes of recovery space, more than the brain or worktree recovery limit (${Math.min(limits.brainRecoveryBytes, limits.worktreeRecoveryBytes)} bytes), so the file was not touched. Inspect the owner's effects and tell the user; the canonical file still holds the withdrawn text until it is mirrored.`,
      { fix: effectStatusFix(effect) });
  }
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    await guardEffectSource(tx, effect, hostId);
    const counters = await lockCounters(tx, ['brain', `worktree:${effect.worktree_id}`]);
    const current = await lockedEffect(tx, effect);
    if (current.recovery) {
      if (digest(current.recovery) !== digest(record)) throw opError('recovery_required', 'The prior mirror publication must be reconciled first.',
        `This effect of source ${effect.source_id} still holds an earlier mirror publication's recovery record, so a new one was not reserved; the worker recovers the earlier one first. Inspect the owner's effects rather than resubmitting anything.`,
        { fix: effectStatusFix(effect) });
      return;
    }
    for (const counter of counters) if (Number(counter.recovery_bytes) + bytes > (counter.key === 'brain' ? limits.brainRecoveryBytes : limits.worktreeRecoveryBytes)) {
      throw opError('queue_capacity', 'Other publications hold the mirror recovery capacity.',
        `In-flight publications hold the recovery space this mirror of source ${effect.source_id} needs (${bytes} bytes), so nothing was reserved; the worker tries again once they finish. Inspect the owner if it stays blocked.`,
        { fix: effectStatusFix(effect) });
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
  await faultPoint('effect_recovery:before_clear', { effectId: effect.id, requestId: effect.request_id, sourceId: effect.source_id });
  await tx.executeRaw('UPDATE persistence_effects SET recovery=NULL,recovery_bytes=0 WHERE id=$1', [effect.id]);
}

/** Under the native lock: finish forward, never restore withdrawn bytes. */
export async function recoverEffectPublication(engine: BrainEngine, effect: PersistenceEffect, hostId: string,
  hooks: { boundary?: (name: 'before_mirror_file' | 'after_mirror_file' | 'before_mirror_commit') => Promise<void> } = {}): Promise<void> {
  const releaseCapacity = tryAcquirePublicationCapacity(engine);
  if (!releaseCapacity) throw opError('writer_pool_capacity', 'Mirror recovery is waiting for publication capacity.',
    `Every publication slot of the writer pool is busy, so mirror recovery for source ${effect.source_id} has not started; the worker tries again once a slot frees. Nothing needs resubmitting.`,
    { fix: effectStatusFix(effect) });
  try {
    if (effect.recovery) await upgradeRecoveryStaging(engine, 'persistence_effects', effect.id, effect.worktree_id!, 'forward');
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
      || sha256(Buffer.from(record.after, 'base64')) !== record.afterHash) throw opError('recovery_required', 'Mirror recovery no longer belongs to this canonical binding.',
      `The recorded mirror recovery for page ${record.slug} no longer matches source ${current.source_id}'s current canonical binding (owner epoch, root or file path changed), so recovery left the file untouched and the effect stays blocked. Inspect the owner and tell the user; repairing the binding is their decision.`,
      { fix: effectStatusFix(current) });
    await withFilesystemPublication([record.root], async () => cleanupRecoveryStaging(record));
    const actual = persistenceFileHash(record.path);
    if (actual !== record.beforeHash && actual !== record.afterHash) {
      throw opError('unexpected_file_bytes', 'Physical mirror recovery found unexpected bytes; the root remains blocked.',
        `The file of page ${record.slug} in source ${current.source_id} holds bytes that match neither its pre-withdrawal nor its mirrored version, so recovery did not overwrite it and the root stays blocked. Inspect the owner and ask the user which version to keep; do not delete the file to unblock it.`,
        { fix: effectStatusFix(current) });
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
    // One page per transaction/cursor checkpoint bounds work and restart cost;
    // a retried parked target is consumed without rewinding the cursor.
    await advanceEffectCursor(tx, current, record.slug);
    await hooks.boundary?.('before_mirror_commit');
  }); } finally { releaseCapacity(); }
}
