import { chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { materializePageSnapshot } from '../page-state/materialize.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import type { JournalLimits } from './model.ts';
import { journalLimitKey, readJournalLimits } from './limits.ts';
import { lockCounters } from './journal.ts';
import { digest, sha256 } from './digest.ts';
import { getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { withFilesystemPublication } from './filesystem-guard.ts';
import { persistenceFileHash, publishPersistenceFile } from './coordinator.ts';
import type { EffectRecovery, PersistenceEffect } from './effect-model.ts';
import { tryAcquirePublicationCapacity } from './pool-capacity.ts';
import { assertRecoveryStagingAbsent, cleanupRecoveryStaging, discardStreamingStage, publishStreamedStage, recoveryStagingFile, upgradeRecoveryStaging } from './staging.ts';
import { existsAt, stageStreamedContent, streamingStagePath, type StreamedFileContent } from './large-file.ts';
import { unreadPageFile } from './page-prepare.ts';
import { declarePersistenceProtocol } from './protocol.ts';
import { advanceEffectCursor } from './effect-journal.ts';
import { faultPoint } from './fault-points.ts';
import { assertRecoveryVersion } from './recovery-version.ts';

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
      `Mirroring this withdrawal into its file in source ${effect.source_id} needs ${bytes} bytes of recovery space, more than the recovery budget (${journalLimitKey('worktreeRecoveryBytes')} ${limits.worktreeRecoveryBytes}, ${journalLimitKey('brainRecoveryBytes')} ${limits.brainRecoveryBytes}), so the file was not touched. Inspect the owner's effects and tell the user: a configured budget is theirs to raise (an unset worktree budget holds the largest page stored in segments); the canonical file still holds the withdrawn text until it is mirrored.`,
      { fix: effectStatusFix(effect) });
  }
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    await guardEffectSource(tx, effect, hostId);
    const counters = await lockCounters(tx, ['brain', `worktree:${effect.worktree_id}`]);
    const current = await lockedEffect(tx, effect);
    if (current.recovery) {
      assertRecoveryVersion('persistence_effects', current.recovery, current.source_id);
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

/** The bytes a withdrawal mirror writes for a page: its current markdown rendering (callers skip or refuse a segmented page first). */
export function mirrorContent(snapshot: PageSnapshot): string {
  return serializePageToMarkdown(snapshot.page, snapshot.tags);
}

/**
 * Under the native lock, before anything publishes a stuck withdrawal-mirror record's `after` bytes (`gbrain repair
 * stuck-recovery --keep withdrawn`): when the page moved past the record (a later withdrawal committed), the recorded bytes
 * would put that withdrawal's fact back on disk, so the record is rebased on the latest snapshot under its page lock: `after`
 * becomes the bytes `mirrorPage` renders for it, `pageId`/`revision` follow the snapshot, and the publication stage and
 * reserved recovery bytes grow to fit the new bytes (`queue_capacity` when they do not). `persist` runs in the same
 * transaction. Returns the current record (unchanged when it was not stale), null when it holds none, or 'unrenderable'
 * when the page was deleted, replaced or segmented, so there are no current bytes to write.
 */
export async function rebaseStaleEffectRecovery(engine: BrainEngine, effectId: string | number, hostId: string,
  persist: (tx: BrainEngine, record: EffectRecovery) => Promise<void>): Promise<EffectRecovery | null | 'unrenderable'> {
  const [effect] = await engine.executeRaw<PersistenceEffect>('SELECT * FROM persistence_effects WHERE id=$1', [effectId]);
  if (!effect?.recovery) return null;
  const limits = await readJournalLimits(engine);
  return engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    await guardEffectSource(tx, effect, hostId);
    const counters = await lockCounters(tx, ['brain', `worktree:${effect.worktree_id}`]);
    const [current] = await tx.executeRaw<PersistenceEffect>('SELECT * FROM persistence_effects WHERE id=$1 FOR UPDATE', [effectId]);
    const record = current?.recovery;
    if (!record) return null;
    assertRecoveryVersion('persistence_effects', record, current.source_id);
    await tx.lockPageKeys([{ sourceId: current.source_id, slug: record.slug }]);
    const snapshot = await tx.readPageSnapshot(record.slug, { sourceId: current.source_id, includeDeleted: true });
    if (snapshot?.page.id === record.pageId && snapshot.revision === record.revision) return record;
    if (!snapshot || snapshot.page.id !== record.pageId || snapshot.page.deleted_at || isSegmentedPage(snapshot.page)) return 'unrenderable';
    const after = Buffer.from(mirrorContent(snapshot));
    const rebased: EffectRecovery = { ...record, version: 1, after: after.toString('base64'), afterHash: sha256(after), revision: snapshot.revision,
      staging: { publication: recoveryStagingFile(record.path, after) } };
    const extra = Math.max(0, Buffer.byteLength(JSON.stringify(rebased)) * 2 + 4096 - Number(current.recovery_bytes));
    for (const counter of counters) if (Number(counter.recovery_bytes) + extra > (counter.key === 'brain' ? limits.brainRecoveryBytes : limits.worktreeRecoveryBytes)) {
      throw opError('queue_capacity', 'Other publications hold the recovery capacity the current mirror bytes need.',
        `Page ${record.slug} in source ${current.source_id} changed after its withdrawal mirror stopped, and writing its current version needs ${extra} more bytes of recovery space than other publications leave free, so nothing was written. Run the same apply again once they finish.`,
        { fix: effectStatusFix(current) });
    }
    await withFilesystemPublication([record.root], async () => cleanupRecoveryStaging(record));
    await tx.executeRaw('UPDATE persistence_effects SET recovery=$2::text::jsonb,recovery_bytes=recovery_bytes+$3,updated_at=now() WHERE id=$1', [current.id, JSON.stringify(rebased), extra]);
    for (const counter of counters) await tx.executeRaw('UPDATE persistence_counters SET recovery_bytes=recovery_bytes+$2 WHERE key=$1', [counter.key, extra]);
    await persist(tx, rebased);
    return rebased;
  });
}

/** Whether a mirror record belongs to the effect's current canonical binding (owner epoch, root and file path). */
function recordBelongs(record: EffectRecovery, effect: PersistenceEffect, binding: WorktreeBinding | null): binding is WorktreeBinding & { local_path: string } {
  return !!binding?.local_path && record.kind === 'withdrawal-mirror' && record.sourceIncarnation === effect.source_incarnation
    && String(binding.owner_epoch) === record.ownerEpoch && isWriteTargetContained(record.path, binding.local_path)
    && isWriteTargetContained(record.path, record.root) && isWriteTargetContained(record.root, binding.local_path)
    && resolve(record.root) === resolve(join(binding.local_path, binding.relative_path));
}

/**
 * A version 2 record's publication stage (effect-model.ts) is written before the recovery transaction, as a streamed
 * publication's is (coordinator.ts `stageLargeFiles`), one piece at a time: from `content`, the file the effect measured,
 * or after a crash from the page's segments at the recorded revision (`unreadPageFile`). Nothing is staged when the file
 * no longer holds its prior bytes, a leaf already holds the stage's name (the transaction verifies or refuses it), the
 * record no longer belongs to the binding (the transaction refuses it) or the page moved on (the transaction clears it).
 */
async function stageStreamedMirror(engine: BrainEngine, effect: PersistenceEffect, hostId: string, content?: StreamedFileContent,
  between?: () => Promise<void>): Promise<void> {
  const [row] = await engine.executeRaw<{ recovery: EffectRecovery | null }>(
    'SELECT recovery FROM persistence_effects WHERE id=$1 AND execution_token=$2::uuid', [effect.id, effect.execution_token]);
  const record = row?.recovery;
  const stage = record?.version === 2 ? record.staging?.publication : undefined;
  if (!record || !stage || !recordBelongs(record, effect, await getWorktreeBinding(engine, effect.source_id, hostId))) return;
  const detail = { effectId: effect.id, requestId: effect.request_id, sourceId: effect.source_id, slug: record.slug, path: stage.path };
  await faultPoint('effect_recovery:before_stage', detail);
  try { await withFilesystemPublication([record.root], async () => {
    // A stream a crash cut short is still under its in-progress name; it is discarded and the stage produced again.
    discardStreamingStage(record);
    if (existsAt(stage.path) || record.beforeHash === record.afterHash || persistenceFileHash(record.path) !== record.beforeHash) return;
    let file = content;
    if (!file) {
      const snapshot = await engine.readPageSnapshot(record.slug, { sourceId: effect.source_id, includeDeleted: true });
      if (!snapshot || snapshot.page.id !== record.pageId || snapshot.revision !== record.revision) return;
      file = await unreadPageFile(engine, snapshot, between);
    }
    await stageStreamedContent(engine, record.path, file, stage, record.mode);
  }); } catch (error) {
    if (stagingReported(error)) await releaseUnstagedRecord(engine, effect, hostId, record).catch(() => undefined);
    throw error;
  }
  await faultPoint('effect_recovery:staged', detail);
}

/**
 * The stage write ended with an error this process saw (a filesystem error such as EIO or ENOSPC, or a gbrain refusal),
 * not with its death: the writer removed its in-progress file, so nothing of the stage is on disk.
 */
function stagingReported(error: unknown): boolean {
  if (error instanceof OperationError) return true;
  const { code, syscall } = (error ?? {}) as { code?: unknown; syscall?: unknown };
  return typeof code === 'string' && typeof syscall === 'string';
}

/**
 * A version 2 record whose stage could not be written while the canonical file still holds its prior bytes protects
 * nothing: no file changed and no stage, whole or in progress, exists. It is cleared with its reserved capacity in one
 * transaction, so the worktree's other writes and effects are no longer held behind it and this effect retries (and
 * parks) as any failed mirror does. A record whose file moved, or whose stage or in-progress stream is still on disk
 * (the writer could not remove it), is kept for recovery, as it is when the release itself fails (the staging error is
 * the one reported).
 */
async function releaseUnstagedRecord(engine: BrainEngine, effect: PersistenceEffect, hostId: string, record: EffectRecovery): Promise<void> {
  const stage = record.staging?.publication;
  if (!stage || existsAt(stage.path) || existsAt(streamingStagePath(stage.path)) || persistenceFileHash(record.path) !== record.beforeHash) return;
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    await guardEffectSource(tx, effect, hostId);
    await lockCounters(tx, ['brain', `worktree:${effect.worktree_id}`]);
    const current = await lockedEffect(tx, effect);
    if (digest(current.recovery) !== digest(record)) return;
    await clearRecovery(tx, current);
  });
}

/** Under the native lock: finish forward, never restore withdrawn bytes. */
export async function recoverEffectPublication(engine: BrainEngine, effect: PersistenceEffect, hostId: string,
  hooks: { boundary?: (name: 'before_mirror_file' | 'after_mirror_file' | 'before_mirror_commit') => Promise<void>; content?: StreamedFileContent;
    /** Called between the pieces of a streamed stage (the effect's claim renewal). */
    between?: () => Promise<void> } = {}): Promise<void> {
  const releaseCapacity = tryAcquirePublicationCapacity(engine);
  if (!releaseCapacity) throw opError('writer_pool_capacity', 'Mirror recovery is waiting for publication capacity.',
    `Every publication slot of the writer pool is busy, so mirror recovery for source ${effect.source_id} has not started; the worker tries again once a slot frees. Nothing needs resubmitting.`,
    { fix: effectStatusFix(effect) });
  try {
    assertRecoveryVersion('persistence_effects', effect.recovery, effect.source_id);
    if (effect.recovery) await upgradeRecoveryStaging(engine, 'persistence_effects', effect.id, effect.worktree_id!, 'forward');
    await stageStreamedMirror(engine, effect, hostId, hooks.content, hooks.between);
    await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    const binding = await guardEffectSource(tx, effect, hostId);
    await lockCounters(tx, ['brain', `worktree:${effect.worktree_id}`]);
    const current = await lockedEffect(tx, effect);
    const record = current.recovery;
    if (!record) return;
    assertRecoveryVersion('persistence_effects', record, current.source_id);
    const streamed = record.version === 2;
    if (!recordBelongs(record, current, binding) || (streamed ? record.staging?.publication?.hash !== record.afterHash
      : sha256(Buffer.from(record.after ?? '', 'base64')) !== record.afterHash)) throw opError('recovery_required', 'Mirror recovery no longer belongs to this canonical binding.',
      `The recorded mirror recovery for page ${record.slug} no longer matches source ${current.source_id}'s current canonical binding (owner epoch, root or file path changed), so recovery left the file untouched and the effect stays blocked. Inspect the owner and tell the user; repairing the binding is their decision.`,
      { fix: effectStatusFix(current) });
    const actual = persistenceFileHash(record.path);
    const forward = actual === record.beforeHash && actual !== record.afterHash;
    // A streamed record's verified publication stage holds the bytes a forward publication renames into place.
    const cleanup = () => withFilesystemPublication([record.root], async () => cleanupRecoveryStaging(record));
    if (!streamed || !forward) await cleanup();
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
      if (streamed && forward) await cleanup();
      await clearRecovery(tx, current);
      await tx.executeRaw(`UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,
        next_attempt_at=now(),error_code=NULL,updated_at=now() WHERE id=$1`, [current.id]);
      return;
    }
    if (forward) {
      await hooks.boundary?.('before_mirror_file');
      await withFilesystemPublication([record.root], async () => {
        if (streamed) publishStreamedStage(record);
        else publishPersistenceFile({ path: record.path, root: record.root, content: Buffer.from(record.after!, 'base64') }, record.staging?.publication?.path);
        if (record.mode !== null && existsSync(record.path)) chmodSync(record.path, record.mode);
      });
      await hooks.boundary?.('after_mirror_file');
    }
    // A segmented page's withdrawn rows were struck in its segments when the withdrawal committed: nothing to persist.
    if (!isSegmentedPage(snapshot.page)) await materializePageSnapshot(tx, snapshot);
    await clearRecovery(tx, current);
    // GBRA-130 A-12: the page's file now holds the mirrored bytes; Git may commit only pages recorded here.
    const published = [...new Set([...(current.data.published ?? []), record.slug])];
    const publishedFiles = { ...current.data.published_files, [record.slug]: { hash: record.afterHash, revision: record.revision } };
    await tx.executeRaw(`UPDATE persistence_effects SET data=jsonb_set(jsonb_set(data,'{published}',$2::text::jsonb),'{published_files}',$3::text::jsonb) WHERE id=$1`,
      [current.id, JSON.stringify(published), JSON.stringify(publishedFiles)]);
    // One page per transaction/cursor checkpoint bounds work and restart cost;
    // a retried parked target is consumed without rewinding the cursor.
    await advanceEffectCursor(tx, { ...current, data: { ...current.data, published, published_files: publishedFiles } }, record.slug);
    await hooks.boundary?.('before_mirror_commit');
  }); } finally { releaseCapacity(); }
}
