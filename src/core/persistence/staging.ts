import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicStagingPath, validateAtomicStagingPath } from '../atomic-write.ts';
import { flushDirectory } from '../fs-durable.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { sha256 } from './digest.ts';
import type { BrainEngine } from '../engine.ts';
import { readJournalLimits } from './limits.ts';
import { beforeStageCopyPath, hashDescriptor, streamingStagePath, validateBeforeStagePath } from './large-file.ts';
import { declarePersistenceProtocol } from './protocol.ts';

export interface RecoveryStagingFile { path: string; hash: string; bytes: number }
/**
 * `before` (model.ts): the staged copy of a prior canonical file over the single-string ceiling,
 * which recovery renames back instead of decoding an embedded before-image; kept until recovery decides.
 */
export interface RecoveryStaging { publication?: RecoveryStagingFile; restoration?: RecoveryStagingFile; before?: RecoveryStagingFile }
interface StagedRecovery { path: string; root: string; staging?: RecoveryStaging }
interface StoredFileRecovery extends StagedRecovery { before?: string | null; after?: string | null }
type StoredRecovery = StoredFileRecovery | { files: StoredFileRecovery[] };

/** Allocate names only. The caller durably reserves these before any open/mkdir. */
export function recoveryStagingFile(path: string, bytes: string | Uint8Array): RecoveryStagingFile {
  return { path: atomicStagingPath(path), hash: sha256(bytes), bytes: typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength };
}
function blocked(): OperationError {
  return opError('unexpected_staging_bytes', 'Recovery staging has unexpected bytes or identity; the root and its recovery capacity remain reserved.',
    'A recovery staging file changed outside gbrain. Inspect the pending recovery in writer status and tell the user; never delete or edit staging files by hand.',
    { fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--json'], consent: [], actor: 'agent', why: 'Shows pending recovery records and the capacity they hold, read-only.', requires_exclusive: false } });
}
function stages(record: StagedRecovery): RecoveryStagingFile[] {
  const result = Object.values(record.staging ?? {}).filter((stage): stage is RecoveryStagingFile => !!stage);
  if (new Set(result.map(stage => stage.path)).size !== result.length) throw blocked();
  for (const stage of result) {
    try { if (stage === record.staging?.before) validateBeforeStagePath(record.path, stage.path); else validateAtomicStagingPath(record.path, stage.path); } catch { throw blocked(); }
    if (!isWriteTargetContained(stage.path, record.root) || !Number.isSafeInteger(stage.bytes) || stage.bytes < 0
      || !/^[a-f0-9]{64}$/.test(stage.hash)) throw blocked();
  }
  return result;
}
function statIfPresent(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    // A regular-file ancestor also proves that this staging leaf is absent, and
    // a historical stage name longer than NAME_MAX can never have been created.
    if (['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}
function flushParent(path: string): void {
  try { flushDirectory(dirname(path)); }
  catch (error) {
    // Publication can fail because an ancestor is a file or missing. Flush the
    // nearest existing directory, rather than treating fsync(file) as fsync(dir).
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') && dirname(path) !== path) { flushParent(dirname(path)); return; }
    throw error;
  }
}

/**
 * Runs `settle` on a present stage leaf once it is proven the reserved file: a regular file with one link, its
 * recorded size and digest (read in pieces), unchanged while it was read. False when the leaf is absent.
 */
function withVerifiedStage(stage: RecoveryStagingFile, settle: (fd: number) => void): boolean {
  const leaf = statIfPresent(stage.path);
  if (!leaf) return false;
  if (!leaf.isFile() || leaf.nlink !== 1 || leaf.size !== stage.bytes) throw blocked();
  const fd = openSync(stage.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== leaf.dev || opened.ino !== leaf.ino || opened.birthtimeMs !== leaf.birthtimeMs
      || opened.size !== stage.bytes || hashDescriptor(fd).hash !== stage.hash) throw blocked();
    const current = statIfPresent(stage.path);
    if (!current?.isFile() || current.dev !== opened.dev || current.ino !== opened.ino
      || current.birthtimeMs !== opened.birthtimeMs || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs) throw blocked();
    settle(fd);
  } finally { closeSync(fd); }
  return true;
}

/**
 * Removes a regular file at `path` unread (a symlink, directory or other leaf refuses); flushes its directory.
 */
function removeUnread(path: string): void {
  const leaf = statIfPresent(path);
  if (leaf && !leaf.isFile()) throw blocked();
  if (leaf) unlinkSync(path);
  flushParent(path);
}

/**
 * Called under the owner lock. Partial/unknown stages are preserved, never guessed, with two exceptions that hold no
 * bytes recovery needs: a before stage's copy still under its temporary name (`beforeStageCopyPath`: the copy was never
 * renamed, so publication never started) is always removed, and `priorIntact` (the canonical file still holds the
 * recorded prior bytes, `beforeHash`) removes the before stage itself unread, so a copy a crash cut short at the stage's
 * name (a binary that copied in place) cannot block the worktree. `keepBefore`: a live request's recovery keeps the
 * prior file's copy until it has decided whether to rename it back (`restoreBeforeStage`).
 */
export function cleanupRecoveryStaging(record: StagedRecovery, opts: { keepBefore?: boolean; priorIntact?: boolean } = {}): void {
  const before = record.staging?.before;
  discardStreamingStage(record);
  for (const stage of stages(record)) {
    if (stage === before) {
      removeUnread(beforeStageCopyPath(stage.path));
      if (opts.keepBefore) continue;
      if (opts.priorIntact) { removeUnread(stage.path); continue; }
    }
    withVerifiedStage(stage, () => unlinkSync(stage.path));
    flushParent(stage.path);
  }
}

/**
 * Recovery's restoration of a version 3 record: the verified copy of the prior file is renamed over the canonical
 * path with its recorded mode. A missing copy refuses (`unexpected_staging_bytes`): the bytes cannot be guessed.
 */
export function restoreBeforeStage(record: StagedRecovery & { mode: number | null }, boundary?: (phase: 'file_replaced' | 'directory_flushed') => void): void {
  const stage = record.staging?.before;
  if (!stage || !stages(record).includes(stage)) throw blocked();
  const restored = withVerifiedStage(stage, fd => {
    if (record.mode !== null) fchmodSync(fd, record.mode);
    renameSync(stage.path, record.path);
  });
  if (!restored) throw blocked();
  boundary?.('file_replaced');
  flushDirectory(dirname(record.path));
  boundary?.('directory_flushed');
}

/**
 * Removes, unread, a publication stage's stream still under its in-progress name (`streamingStagePath`): a stream a crash
 * cut short. It was never renamed to the stage's name, so it was never published and holds no bytes recovery needs.
 */
export function discardStreamingStage(record: StagedRecovery): void {
  const publication = record.staging?.publication;
  if (publication && stages(record).includes(publication)) removeUnread(streamingStagePath(publication.path));
}

/**
 * A version 2 mirror record's forward publication (effect-recovery.ts): its verified publication stage, streamed from
 * the page's segments, is renamed over the canonical path. A missing stage refuses (`unexpected_staging_bytes`).
 */
export function publishStreamedStage(record: StagedRecovery): void {
  const stage = record.staging?.publication;
  if (!stage || !stages(record).includes(stage)) throw blocked();
  if (!withVerifiedStage(stage, () => renameSync(stage.path, record.path))) throw blocked();
  flushDirectory(dirname(record.path));
}

/** The final accounting fence also protects direct terminal-cleanup callers. */
export function assertRecoveryStagingAbsent(record: StagedRecovery): void {
  for (const stage of stages(record)) {
    if (statIfPresent(stage.path) || (stage === record.staging?.before && statIfPresent(beforeStageCopyPath(stage.path)))
      || (stage === record.staging?.publication && statIfPresent(streamingStagePath(stage.path)))) throw blocked();
    flushParent(stage.path);
  }
}

/** Reserve a stage for an unstaged record; replace only historical leaves the filesystem cannot name (#5861). */
function upgradeFileStaging(record: StoredFileRecovery, mode: 'restore' | 'forward'): StoredFileRecovery {
  if (!record.staging) {
    const encoded = mode === 'restore' ? record.before : record.after;
    return { ...record, staging: encoded == null ? {} : {
      [mode === 'restore' ? 'restoration' : 'publication']: recoveryStagingFile(record.path, Buffer.from(encoded, 'base64')),
    } };
  }
  stages(record);
  let changed = false;
  const staging = { ...record.staging };
  for (const key of ['publication', 'restoration'] as const) {
    const stage = staging[key];
    if (!stage) continue;
    try { lstatSync(stage.path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENAMETOOLONG') { staging[key] = { ...stage, path: atomicStagingPath(record.path) }; changed = true; }
      else if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }
  return changed ? { ...record, staging } : record;
}

/** Old records remain readable; reserve new names before an old recovery writes. */
export async function upgradeRecoveryStaging(engine: BrainEngine, table: 'persistence_requests' | 'persistence_effects',
  id: string | number, worktreeId: string, mode: 'restore' | 'forward'): Promise<void> {
  const limits = await readJournalLimits(engine);
  const { lockCounters } = await import('./journal.ts');
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    const counters = await lockCounters(tx, ['brain', `worktree:${worktreeId}`]);
    const [row] = await tx.executeRaw<{ recovery_bytes: number | string; recovery: StoredRecovery | null }>(
      `SELECT recovery,recovery_bytes FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
    if (!row?.recovery) return;
    const record = row.recovery;
    const prior = 'files' in record ? record.files : [record];
    const files = prior.map(file => upgradeFileStaging(file, mode));
    if (files.every((file, index) => file === prior[index])) return;
    const updated = 'files' in record ? { ...record, files } : files[0];
    const staged = files.reduce((sum, file) => sum + Object.values(file.staging ?? {}).reduce((bytes, stage) => bytes + stage.bytes, 0), 0);
    const minimum = Buffer.byteLength(JSON.stringify(updated)) + staged + 4096;
    const extra = Math.max(0, minimum - Number(row.recovery_bytes));
    for (const counter of counters) if (Number(counter.recovery_bytes) + extra > (counter.key === 'brain' ? limits.brainRecoveryBytes : limits.worktreeRecoveryBytes)) {
      throw opError('queue_capacity', 'Recovery is waiting for capacity to durably record its staging paths.',
        `Recovery needs ${extra} more bytes of the ${counter.key === 'brain' ? 'persistence.limits.brain_recovery_bytes' : 'persistence.limits.worktree_recovery_bytes'} budget to record its staging. Let other recovery settle; raising that limit is the user's call, and recovery records are never removed.`,
        { fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--json'], consent: [], actor: 'agent', why: 'Shows pending recovery records and the capacity they hold, read-only.', requires_exclusive: false } });
    }
    await tx.executeRaw(`UPDATE ${table} SET recovery=$2::text::jsonb,recovery_bytes=recovery_bytes+$3 WHERE id=$1`,
      [id, JSON.stringify(updated), extra]);
    for (const counter of counters) await tx.executeRaw('UPDATE persistence_counters SET recovery_bytes=recovery_bytes+$2 WHERE key=$1', [counter.key, extra]);
  });
}
