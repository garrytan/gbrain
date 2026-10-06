import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicStagingPath, validateAtomicStagingPath } from '../atomic-write.ts';
import { flushDirectory } from '../fs-durable.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { sha256 } from './digest.ts';
import type { BrainEngine } from '../engine.ts';
import { readJournalLimits } from './limits.ts';
import { declarePersistenceProtocol } from './protocol.ts';

export interface RecoveryStagingFile { path: string; hash: string; bytes: number }
export interface RecoveryStaging { publication?: RecoveryStagingFile; restoration?: RecoveryStagingFile }
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
    try { validateAtomicStagingPath(record.path, stage.path); } catch { throw blocked(); }
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

/** Called under the owner lock. Partial/unknown stages are preserved, never guessed. */
export function cleanupRecoveryStaging(record: StagedRecovery): void {
  for (const stage of stages(record)) {
    const leaf = statIfPresent(stage.path);
    if (!leaf) { flushParent(stage.path); continue; }
    if (!leaf.isFile() || leaf.nlink !== 1 || leaf.size !== stage.bytes) throw blocked();
    const fd = openSync(stage.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== leaf.dev || opened.ino !== leaf.ino || opened.birthtimeMs !== leaf.birthtimeMs
        || opened.size !== stage.bytes || sha256(readFileSync(fd)) !== stage.hash) throw blocked();
      const current = statIfPresent(stage.path);
      if (!current?.isFile() || current.dev !== opened.dev || current.ino !== opened.ino
        || current.birthtimeMs !== opened.birthtimeMs || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs) throw blocked();
      unlinkSync(stage.path);
    } finally { closeSync(fd); }
    flushParent(stage.path);
  }
}

/** The final accounting fence also protects direct terminal-cleanup callers. */
export function assertRecoveryStagingAbsent(record: StagedRecovery): void {
  for (const stage of stages(record)) {
    if (statIfPresent(stage.path)) throw blocked();
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
