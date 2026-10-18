/**
 * `gbrain repair stuck-recovery` (#6650 §1.10, #6640 §B; GBRA-130 C-1, C-4): resolve a publication recovery that the
 * owner's recovery pass refuses with `unexpected_file_bytes` (a canonical file matches neither its recorded prior nor its
 * published bytes, usually a human edit made while the write was publishing). Until it is resolved its worktree
 * claims nothing, and the resident consumer re-parks it every 30 s. Three record kinds resolve: a page write's
 * recovery, a shared-skill bundle publication's (version 2, every file of the bundle) and a withdrawal-mirror effect's.
 *
 * The preview starts from the head blocker's `request_recovery` ids (the recovery records on the source's
 * worktree) plus every effect recovery on it, lists every file of each record with its recorded and disk
 * fingerprints, and writes a private diff of the two into the owner host's backup directory. Its hash binds each
 * record's identity, each file's disk bytes and the page's database revision.
 *
 * Only a live (non-terminal) request is resolved: its database transaction never committed, so neither choice rolls back
 * committed bytes. `--keep prior` writes the prior bytes back through the coordinator's confined durable publication
 * (`publishPersistenceFile`, staged at the record's reserved restoration path, which `upgradeRecoveryStaging` reserves
 * and accounts for older records) and recovery finishes by its own rule (a request with no recorded failure is requeued
 * and its write publishes again; one with a failure ends terminal; recovery restores every other file of a bundle).
 * `--keep disk` (#6640's `drop`) keeps the bytes on disk (every file of a bundle) and abandons the publication: it
 * completes the request terminal (`completeWrite`; `source_changed`, so `conflict`, when it recorded no failure, else
 * that failure by the owner's rule via `finishUnpublishedFailure`), and recovery's terminal path then only cleans its
 * staging and clears the record (`clearResolvedRecovery`), releasing its reserved bytes. The record is never rewritten,
 * so no recovery bytes move outside the accounting.
 * A terminal request whose recovery record is still set is refused (`recovery_choice_refused`): its outcome is immutable,
 * recovery never restores its canonical file, and `--keep prior` would roll back a committed write. So is a bundle
 * record this binary cannot read (`recovery_bundle_unsupported`).
 *
 * A page recovery whose prior file is over the single-string ceiling (large-file.ts) embeds no prior bytes: its prior is
 * the staged copy beside the file (`staging.before`, by path and SHA-256). It resolves the same way in bounded memory: the
 * disk file and the staged copy are hashed in pieces, both are backed up by kernel copy checked by streamed hash, the
 * preview's diff is a summary (both fingerprints, the first differing byte and a window of at most a kilobyte), and
 * `--keep prior` renames the verified staged copy back as recovery's own restoration does (`restoreBeforeStage`: verified,
 * mode set, atomic rename, directory flushed). A staged copy that is missing or does not match refuses `--keep prior`
 * (`recovery_prior_stage_unavailable`, whose fix is the `--keep disk` apply); `--keep disk` backs a mismatched copy up and
 * removes it, because recovery's cleanup never deletes a copy it cannot verify. The hash also binds the staged copy's state.
 *
 * A withdrawal-mirror effect only finishes forward: its withdrawal is committed, and keeping the edited file (or the
 * pre-withdrawal bytes) would leave the forgotten fact on disk for the next sync to import again. Its only choice is
 * `--keep withdrawn`: the edited bytes are backed up, the recorded post-withdrawal bytes are written through the
 * record's reserved publication stage, and the effect's own `recoverEffectPublication` finishes it. When a later
 * withdrawal moved the page past the record, its bytes would put that fact back on disk, so before anything is written
 * `rebaseStaleEffectRecovery` rebases the record under its page lock on the latest snapshot's rendering (the bytes the
 * mirror itself writes) and the journal records the rebased identity, so a rerun after any interruption resumes it; a
 * page deleted, replaced or segmented meanwhile has no current bytes and is refused (`recovery_effect_unsupported`). A record without
 * usable post-withdrawal bytes (a streamed version 2 record of a segmented page embeds none) or bound to another owner,
 * root or incarnation stays refused (`recovery_effect_unsupported`) with an ask_user fix naming the exact preview.
 *
 * The apply runs on the owner host under the worktree lock, so the resident recovery pass cannot interleave. Each
 * record moves through a journal (`op_checkpoints`, op `stuck-recovery-resolution`, keyed by record and preview
 * hash): `backed_up` (the disk and recorded bytes are in the backup directory, always), then `written` (`--keep
 * prior`: the prior bytes are back on disk, an absent prior unlinked; `--keep withdrawn`: the withdrawn bytes are on
 * disk) or `abandoned` (`--keep disk`: the request is terminal), then `done` once the owner's recovery finished it by
 * its unchanged rule. Every step is idempotent, so a run killed at any boundary resumes, and an older resident consumer
 * can finish a resolution this command started. The finished journal row is the resolution's audit entry; a terminal
 * receipt is never rewritten.
 */
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { catalogueError } from '../error-catalogue.ts';
import { gbrainPath } from '../config.ts';
import { mkdirPrivate } from '../atomic-write.ts';
import { flushDirectory } from '../fs-durable.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { unifiedDiff } from '../skillpack/diff-text.ts';
import { digest, sha256 } from './digest.ts';
import { localHostId } from './identity.ts';
import { acquireWorktree, containsPath, getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { canonicalFilesystemPath } from './root-registry.ts';
import { completeWrite, getWriteRequestById } from './journal.ts';
import { isTerminal, recoveryFiles, type FileRecoveryRecord, type RecoveryRecord, type WriteRequest } from './model.ts';
import type { EffectRecovery } from './effect-model.ts';
import { finishUnpublishedFailure, publishPersistenceFile, recoverPublication, transientDatabaseFailure } from './coordinator.ts';
import { claimAndRecoverEffect } from './effects.ts';
import { rebaseStaleEffectRecovery } from './effect-recovery.ts';
import { trueUpRequests } from './receipt-true-up.ts';
import { bundleFileHash } from './bundle-files.ts';
import { mayReprepare } from './semantic.ts';
import { cleanupRecoveryStaging, restoreBeforeStage, upgradeRecoveryStaging } from './staging.ts';
import { FileBytes, hashDescriptor, hashFile, LARGE_FILE_MIN_BYTES, largeFileWork, validateBeforeStagePath } from './large-file.ts';
import { SEGMENT_MAX_BYTES } from '../page-body/limits.ts';
import { withFilesystemPublication } from './filesystem-guard.ts';
import { readHeadBlockers } from './head-blocker.ts';
import { previewChangedError } from './preview-approval.ts';
import { faultPoint } from './fault-points.ts';
import { KEEP_DISK_ABANDONED_PREFIX } from './verb-errors.ts';

export const RESOLUTION_OP = 'stuck-recovery-resolution';
export type KeepChoice = 'prior' | 'disk' | 'withdrawn';
export const KEEP_CHOICES: readonly KeepChoice[] = ['prior', 'disk', 'withdrawn'];
/** What the record publishes: one page file, every file of a shared-skill bundle, or a withdrawal mirror of a page file. */
export type RecoveryTarget = 'page' | 'skill_bundle' | 'withdrawal_mirror';

/**
 * A prior file over the single-string ceiling is not in the record: it is the staged copy beside the canonical file
 * (`staging.before`). `verified`: that copy is a regular file of the recorded length and SHA-256; `missing`: no file there;
 * `mismatched`: anything else (`sha256` is what it holds now, null when it is not a single-link regular file).
 */
export interface PriorStageView { state: 'verified' | 'missing' | 'mismatched'; path: string; sha256: string | null; size: number | null }
export type PriorView = { absent: true } | { absent: false; sha256: string; size: number | null; mode: number | null; stored: boolean; stage?: PriorStageView };
export type DiskView = { deleted: true } | { deleted: false; kind: 'file' | 'symlink' | 'directory' | 'other'; sha256: string | null; size: number; mode: number };
export interface RecoveryFileView {
  path: string; root: string; relative: string; prior: PriorView; disk: DiskView;
  /** What recovery itself makes of the disk bytes: the prior, the published bytes, or neither (the blocked case). */
  matches: 'prior' | 'published' | 'neither';
  /** A withdrawal-mirror effect only: the recorded post-withdrawal bytes `--keep withdrawn` writes (`prior` is the pre-withdrawal file). */
  withdrawn?: { sha256: string; size: number };
  /** Preview only: the private diff and the command that reproduces it (absent for a remote caller). */
  diff_path?: string; diff_command?: string;
  /** The diff is a bounded summary (a version is over the single-string ceiling), not a full diff. */
  diff_summary?: true;
}
/** The identity the hash binds: the publication attempt, its owner epoch and each file's path and published hash. */
export interface RecoveryIdentity { attempt: string; owner_epoch: string; files: Array<{ path: string; after_hash: string | null }> }
export interface StuckRecovery {
  /** The request's internal id, or `effect:<id>` for a withdrawal-mirror effect recovery. */
  id: string; target: RecoveryTarget; effect_id?: string;
  request_id: string; source_id: string; slug: string; operation: string; state: string; blocked_reason: string | null;
  worktree_id: string; sequence: string; page_revision: string | null; identity: RecoveryIdentity;
  /** The failure the request already recorded, if any: with one, either choice ends the request terminal with it. */
  recorded_error: string | null;
  /** Each file's recorded prior hash, so an apply can tell its own write from a later edit. */
  prior_hashes: Array<string | null>; files: RecoveryFileView[]; choices: Record<KeepChoice, boolean>;
  /** Digest of the identity, each file's disk bytes and the page revision: what an apply re-verifies. */
  digest: string;
}
/** A blocked terminal request, or an unusable withdrawal-mirror effect or bundle record: listed, never resolved (see the module comment). */
export interface RefusedRecovery { code: 'recovery_choice_refused' | 'recovery_effect_unsupported' | 'recovery_bundle_unsupported';
  request_id: string; source_id: string; slug: string; state: string; blocked_reason: string | null; reason: string; effect_id?: string;
  /** The next step when it is not the read-only writer status: an ask_user action naming the exact preview. */
  fix?: Action }
export interface StuckRecoveryScan { items: StuckRecovery[]; residuals: Record<string, number>; refused: RefusedRecovery[];
  heads: Array<{ source_id: string; queued_request_id: string | null; blocked_by: string | null }> }

interface Journal {
  id: string; request_id: string; source_id: string; slug: string; preview_hash: string; keep: KeepChoice;
  phase: 'backed_up' | 'written' | 'abandoned' | 'done'; backup_dir: string; original: { state: string; blocked_reason: string | null; prior_hashes: Array<string | null>; disk_hashes: Array<string | null> };
  /** A withdrawal-mirror record rebased on a later page revision: the identity it now has (the preview bound the original). */
  identity?: RecoveryIdentity;
  result?: ResolutionResult;
}
export interface ResolutionResult {
  outcome: 'resolved' | 'still_blocked'; keep: KeepChoice; request_state: string; blocked_reason: string | null;
  finished_by: 'this_run' | 'another_pass'; backup_dir: string; next: string;
}
interface EffectRow { id: string; request_ref: string; request_id: string | null; kind: string; state: string; error_code: string | null; worktree_id: string;
  recovery: EffectRecovery | null }

const statusFix = (sourceId: string) => readFix(`Shows source ${sourceId}'s canonical owner with its recovering write requests, read-only.`,
  { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });
export const stuckRecoveryPreviewArgv = (sourceIds: string[], requestId?: string) =>
  ['gbrain', 'repair', 'stuck-recovery', ...(sourceIds.length === 1 ? ['--source', sourceIds[0]!] : []), ...(requestId ? ['--request-id', requestId] : [])];
export const stuckRecoveryPreviewCommand = (sourceIds: string[], requestId?: string) => stuckRecoveryPreviewArgv(sourceIds, requestId).join(' ');
const backupRoot = () => gbrainPath('backups', 'stuck-recovery');
const fileMode = (mode: number) => mode & 0o777;

function identityOf(files: FileRecoveryRecord[], record: { attempt: string; ownerEpoch: string }): RecoveryIdentity {
  return { attempt: record.attempt, owner_epoch: String(record.ownerEpoch), files: files.map(file => ({ path: file.path, after_hash: file.afterHash })) };
}
function effectIdentity(effectId: string, record: EffectRecovery): RecoveryIdentity {
  return { attempt: `effect:${effectId}:${record.revision}`, owner_epoch: String(record.ownerEpoch), files: [{ path: record.path, after_hash: record.afterHash }] };
}
/** The record's files, or null for a bundle record this binary cannot read. */
function filesOf(record: RecoveryRecord): FileRecoveryRecord[] | null {
  try { return recoveryFiles(record); } catch { return null; }
}

/** Where one version's bytes are read from: held in memory (at most the single-string ceiling), a file read in pieces, or nowhere. */
type Bytes = { bytes: Buffer } | { path: string } | null;

/** The disk version: a file over the single-string ceiling is hashed in pieces and never read whole. */
function diskView(path: string): { view: DiskView; source: Bytes } {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { view: { deleted: true }, source: null }; throw error; }
  if (!stat.isFile()) return { view: { deleted: false, kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'other', sha256: null, size: stat.size, mode: fileMode(stat.mode) }, source: null };
  if (stat.size > LARGE_FILE_MIN_BYTES) {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const { hash, bytes } = hashDescriptor(fd);
      return { view: { deleted: false, kind: 'file', sha256: hash, size: bytes, mode: fileMode(stat.mode) }, source: { path } };
    } finally { closeSync(fd); }
  }
  const bytes = readFileSync(path);
  return { view: { deleted: false, kind: 'file', sha256: sha256(bytes), size: bytes.length, mode: fileMode(stat.mode) }, source: { bytes } };
}
const diskHash = (view: DiskView) => view.deleted ? null : view.sha256;

function priorBytes(record: FileRecoveryRecord): Buffer | null { return record.before === null ? null : Buffer.from(record.before, 'base64'); }
/** The staged copy of a prior file over the single-string ceiling, checked by its streamed SHA-256 (see PriorStageView). */
function priorStageView(record: FileRecoveryRecord): PriorStageView {
  const stage = record.staging!.before!;
  let named = isWriteTargetContained(stage.path, record.root);
  try { validateBeforeStagePath(record.path, stage.path); } catch { named = false; }
  if (!named) return { state: 'mismatched', path: stage.path, sha256: null, size: null };
  let leaf;
  try { leaf = lstatSync(stage.path); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return { state: 'missing', path: stage.path, sha256: null, size: null }; throw error; }
  if (!leaf.isFile() || leaf.nlink !== 1) return { state: 'mismatched', path: stage.path, sha256: null, size: leaf.size };
  const hash = hashFile(stage.path);
  const verified = hash === stage.hash && leaf.size === stage.bytes && stage.hash === record.beforeHash;
  return { state: verified ? 'verified' : 'mismatched', path: stage.path, sha256: hash, size: leaf.size };
}
function priorView(record: FileRecoveryRecord): PriorView {
  if (record.beforeHash === null) return { absent: true };
  if (record.staging?.before) {
    const stage = priorStageView(record);
    return { absent: false, sha256: record.beforeHash, size: record.staging.before.bytes, mode: record.mode, stored: stage.state === 'verified', stage };
  }
  const bytes = priorBytes(record);
  return { absent: false, sha256: record.beforeHash, size: bytes?.length ?? null, mode: record.mode, stored: bytes !== null && sha256(bytes) === record.beforeHash };
}
function priorSource(record: FileRecoveryRecord, view: PriorView): Bytes {
  if (view.absent) return null;
  if (view.stage) return view.stage.state === 'verified' ? { path: view.stage.path } : null;
  const bytes = priorBytes(record);
  return bytes === null ? null : { bytes };
}

/** The private backup directory, refused when it is not a private directory of this user or sits inside a canonical checkout. */
async function privateBackupDir(engine: BrainEngine, ...segments: string[]): Promise<string> {
  const root = backupRoot();
  const dir = join(root, ...segments);
  mkdirPrivate(dir, root);
  const stat = lstatSync(root);
  const owned = process.platform === 'win32' || ((stat.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || stat.uid === process.getuid()));
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned) throw opError('permission_denied', 'The stuck-recovery backup directory must be private, owned and free of symlinks.',
    `Nothing was written. Ask the user to make ${root} a real directory they own with mode 0700 (not a symlink), then run the same command again.`);
  const roots = await engine.executeRaw<{ local_path: string }>(`SELECT local_path FROM sources WHERE local_path IS NOT NULL
    UNION SELECT local_path FROM persistence_host_bindings WHERE local_path IS NOT NULL`);
  const resolved = canonicalFilesystemPath(dir);
  if (roots.some(row => existsSync(row.local_path) && containsPath(canonicalFilesystemPath(row.local_path), resolved))) {
    throw opError('permission_denied', 'Stuck-recovery backups must be stored outside every canonical source checkout.',
      `Nothing was written: ${root} sits inside a source checkout. The user must move the gbrain config directory (GBRAIN_HOME) out of the checkout, then run the same command again.`);
  }
  return dir;
}

/** Writes `bytes` to `path` 0600 and durable, then reads it back; an existing identical file is kept. */
function writePrivateFile(path: string, bytes: Buffer): void {
  if (existsSync(path) && sha256(readFileSync(path)) === sha256(bytes)) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); } catch (error) { try { unlinkSync(temporary); } catch { /* already gone */ } throw error; }
  flushDirectory(dirname(path));
  if (sha256(readFileSync(path)) !== sha256(bytes)) throw opError('storage_error', 'A stuck-recovery backup did not read back as written.',
    `Nothing was changed on disk or in the journal. Check free space and the filesystem under ${dirname(path)}, then run the same command again.`);
}

/**
 * Copies the file at `from` to `path` 0600 and durable: the kernel copies it to a temporary name, the copy is hashed in
 * pieces and must hold `expected`, then it is fsynced and renamed. An existing copy holding `expected` is kept. A copy
 * that does not hold `expected` (the file changed since it was fingerprinted) is removed and `changed()` is thrown.
 */
function copyPrivateFile(path: string, from: string, expected: string, changed: () => OperationError): void {
  if (existsSync(path) && hashFile(path) === expected) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  let copied = false;
  try {
    copyFileSync(from, temporary, constants.COPYFILE_EXCL);
    const fd = openSync(temporary, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      fchmodSync(fd, 0o600);
      const copy = hashDescriptor(fd);
      largeFileWork.bytesCopied += copy.bytes;
      if (copy.hash !== expected) throw changed();
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, path);
    copied = true;
  } finally {
    if (!copied) try { unlinkSync(temporary); } catch { /* never created */ }
  }
  flushDirectory(dirname(path));
}

const SUMMARY_CONTEXT_BYTES = 256, SUMMARY_WINDOW_BYTES = 768;
const MIB = 1024 * 1024;
const view = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function newlines(bytes: Buffer): number {
  let count = 0;
  for (let at = bytes.indexOf(10); at >= 0; at = bytes.indexOf(10, at + 1)) count++;
  return count;
}
const prefixed = (prefix: string, bytes: Uint8Array) => {
  const text = view(bytes).toString('utf8');
  return text ? (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').map(line => `${prefix}${line}`) : [];
};
/**
 * The bounded stand-in for a diff when a version is over the single-string ceiling: both fingerprints, the first byte
 * where the two differ (found by comparing them a segment at a time) and a window of at most a kilobyte around it.
 */
function diffSummary(file: RecoveryFileView, priorPath: string | null, diskPath: string | null): string {
  const prior = priorPath ? FileBytes.open(priorPath) : null;
  const disk = diskPath ? FileBytes.open(diskPath) : null;
  try {
    const label = file.withdrawn ? 'withdrawn' : 'prior';
    const reference = file.withdrawn ?? (file.prior.absent ? null : { sha256: file.prior.sha256, size: file.prior.size });
    const shared = Math.min(prior?.length ?? 0, disk?.length ?? 0);
    let offset = shared, line = 1;
    for (let at = 0; at < shared; at += SEGMENT_MAX_BYTES) {
      const end = Math.min(at + SEGMENT_MAX_BYTES, shared);
      const a = view(prior!.subarray(at, end)), b = view(disk!.subarray(at, end));
      if (a.equals(b)) { line += newlines(a); continue; }
      let index = 0;
      while (a[index] === b[index]) index++;
      offset = at + index;
      line += newlines(a.subarray(0, index));
      break;
    }
    const start = Math.max(0, offset - SUMMARY_CONTEXT_BYTES);
    const side = (bytes: FileBytes | null, from: number, to: number) => bytes ? bytes.subarray(from, to) : new Uint8Array();
    const context = side(prior ?? disk, start, offset);
    const removed = side(prior, offset, offset + SUMMARY_WINDOW_BYTES), added = side(disk, offset, offset + SUMMARY_WINDOW_BYTES);
    const describe = (label: string, version: { sha256: string | null; size: number | null } | null) => version
      ? `${label}  sha256 ${version.sha256}  ${version.size} bytes` : `${label}  absent`;
    return [
      `# summary only, no full diff: a version is over the ${LARGE_FILE_MIN_BYTES / MIB} MiB single-string ceiling, so neither is read whole`,
      describe(`--- ${label}/${file.relative}`, reference ? { sha256: reference.sha256, size: prior?.length ?? reference.size } : null),
      describe(`+++ disk/${file.relative}`, file.disk.deleted ? null : { sha256: file.disk.sha256, size: file.disk.size }),
      offset === shared && (prior?.length ?? 0) === (disk?.length ?? 0) ? '# the two versions hold the same bytes'
        : `# first difference at byte ${offset} (line ${line}); the window below is cut at byte offsets, not lines`,
      `@@ bytes ${start}..${offset + removed.length} of ${label}, ${start}..${offset + added.length} of disk @@`,
      ...prefixed(' ', context), ...prefixed('-', removed), ...prefixed('+', added),
      `# reproduce: cmp ${priorPath ?? '/dev/null'} ${diskPath ?? '/dev/null'}`, '',
    ].join('\n');
  } finally { prior?.close(); disk?.close(); }
}

/**
 * Both versions of every file (and their diff) under `dir`; returns the paths by file index. The recorded side is the
 * prior (`<index>.prior`), or a withdrawal mirror's withdrawn bytes (`<index>.withdrawn`). A version over the
 * single-string ceiling is copied by the kernel and checked by its streamed hash, and its diff is a bounded summary.
 * A staged prior copy that matches nothing recorded is kept too (`<index>.prior-stage`): `--keep disk` removes it.
 */
function writeArtifacts(dir: string, item: { files: RecoveryFileView[] }, sources: Array<{ prior: Bytes; disk: Bytes }>, changed: () => OperationError) {
  return item.files.map((file, index) => {
    const { prior, disk } = sources[index];
    const keep = (path: string, source: NonNullable<Bytes>, expected: string | null) => 'bytes' in source ? writePrivateFile(path, source.bytes) : copyPrivateFile(path, source.path, expected!, changed);
    const label = file.withdrawn ? 'withdrawn' : 'prior';
    const priorPath = prior === null ? null : join(dir, `${index}.${label}`);
    const diskPath = disk === null ? null : join(dir, `${index}.disk`);
    if (priorPath) keep(priorPath, prior!, file.withdrawn?.sha256 ?? (file.prior.absent ? null : file.prior.sha256));
    if (diskPath) keep(diskPath, disk!, file.disk.deleted ? null : file.disk.sha256);
    const stage = file.prior.absent ? undefined : file.prior.stage;
    if (stage?.state === 'mismatched' && stage.sha256) copyPrivateFile(join(dir, `${index}.prior-stage`), stage.path, stage.sha256, changed);
    const diffPath = join(dir, `${index}.diff`);
    if ((prior === null || 'bytes' in prior) && (disk === null || 'bytes' in disk)) {
      writePrivateFile(diffPath, Buffer.from(unifiedDiff(prior?.bytes.toString('utf8') ?? '', disk?.bytes.toString('utf8') ?? '',
        { oldPath: `${label}/${file.relative}`, newPath: `disk/${file.relative}` })));
      return { diff_path: diffPath, diff_command: `diff -u ${priorPath ?? '/dev/null'} ${diskPath ?? '/dev/null'}` };
    }
    writePrivateFile(diffPath, Buffer.from(diffSummary(file, priorPath, diskPath)));
    return { diff_path: diffPath, diff_command: `cmp ${priorPath ?? '/dev/null'} ${diskPath ?? '/dev/null'}`, diff_summary: true as const };
  });
}

/** What recovery makes of a file's disk bytes; a bundle file also needs its recorded mode and a regular, unaliased file. */
function recoveryMatch(record: FileRecoveryRecord, view: DiskView, bundle: boolean): RecoveryFileView['matches'] {
  if (!view.deleted && view.kind !== 'file') return 'neither';
  const hash = diskHash(view);
  const match = hash === record.beforeHash ? 'prior' : hash === record.afterHash ? 'published' : 'neither';
  if (match === 'neither' || !bundle) return match;
  try { bundleFileHash(record); return match; } catch (error) {
    if (error instanceof OperationError && ['unexpected_file_bytes', 'storage_error'].includes(error.code)) return 'neither';
    throw error;
  }
}

/** One page or bundle record's current view: its files with disk fingerprints, the page revision and the state digest. */
async function readItem(engine: BrainEngine, row: WriteRequest, binding: WorktreeBinding): Promise<{ item: StuckRecovery; records: FileRecoveryRecord[]; sources: Array<{ prior: Bytes; disk: Bytes }> }> {
  const records = filesOf(row.recovery!);
  if (!records) throw refusalError(bundleRefusal(row));
  const bundle = row.recovery!.version === 2;
  const [page] = await engine.executeRaw<{ revision: string | null }>('SELECT knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND slug=$2', [row.source_id, row.slug]);
  const sources: Array<{ prior: Bytes; disk: Bytes }> = [];
  const files = records.map(record => {
    const contained = isWriteTargetContained(record.path, record.root) && !!binding.local_path && isWriteTargetContained(record.path, binding.local_path);
    const { view, source } = contained ? diskView(record.path) : { view: { deleted: false, kind: 'other', sha256: null, size: 0, mode: 0 } as DiskView, source: null };
    const prior = priorView(record);
    sources.push({ prior: priorSource(record, prior), disk: source });
    return { path: record.path, root: record.root, relative: relative(binding.local_path ?? record.root, record.path), prior, disk: view,
      matches: recoveryMatch(record, view, bundle) } as RecoveryFileView;
  });
  const writable = (file: RecoveryFileView) => file.disk.deleted || file.disk.kind === 'file';
  // --keep disk leaves the staged prior to recovery's cleanup, which refuses a copy it cannot verify: a mismatched copy is
  // backed up and removed first, so it must be a regular file this command can hash.
  const stageRemovable = (file: RecoveryFileView) => file.prior.absent || file.prior.stage?.state !== 'mismatched' || file.prior.stage.sha256 !== null;
  const unexpected = files.filter(file => file.matches === 'neither');
  const choices = { prior: unexpected.every(file => writable(file) && (file.prior.absent || file.prior.stored)), disk: unexpected.every(file => writable(file) && stageRemovable(file)), withdrawn: false };
  const identity = identityOf(records, row.recovery!);
  const page_revision = page?.revision ?? null;
  const priorStages = files.map(file => file.prior.absent ? null : file.prior.stage ?? null);
  return { records, sources, item: { id: row.id, target: bundle ? 'skill_bundle' : 'page', request_id: row.request_id, source_id: row.source_id, slug: row.slug, operation: row.operation, state: row.state,
    blocked_reason: row.blocked_reason ?? null, worktree_id: row.worktree_id!, sequence: String(row.sequence),
    page_revision, identity, recorded_error: row.error_code ?? null, prior_hashes: records.map(record => record.beforeHash), files, choices,
    digest: digest({ v: 'stuck-recovery-item-v1', id: row.id, request_id: row.request_id, identity, prior_hashes: records.map(record => record.beforeHash),
      disk: files.map(file => file.disk), page_revision, ...(priorStages.some(Boolean) ? { prior_stages: priorStages } : {}) }) } };
}

const EFFECT_SQL = `SELECT e.id::text AS id, e.request_id::text AS request_ref, r.request_id::text AS request_id, e.kind, e.state, e.error_code,
  e.worktree_id::text AS worktree_id, e.recovery FROM persistence_effects e LEFT JOIN persistence_requests r ON r.id=e.request_id`;

/**
 * One withdrawal-mirror effect recovery's view: null when its file holds a recorded version (it recovers on its own),
 * a refusal when the record cannot be written forward on this binding, else the item with its withdrawn and disk bytes.
 */
async function readEffectItem(engine: BrainEngine, effect: EffectRow, binding: WorktreeBinding, sourceId: string):
Promise<{ item: StuckRecovery; sources: Array<{ prior: Bytes; disk: Bytes }> } | RefusedRecovery | null> {
  const record = effect.recovery;
  const slug = typeof record?.slug === 'string' ? record.slug : '';
  const refused: RefusedRecovery = { code: 'recovery_effect_unsupported', request_id: effect.request_id ?? '', effect_id: effect.id, source_id: sourceId, slug,
    state: effect.state, blocked_reason: effect.error_code, reason: effectReason(effect.kind), fix: effectFix(sourceId, effect.request_id) };
  if (!record || effect.kind !== 'withdrawal-mirror' || record.kind !== 'withdrawal-mirror' || record.version !== 1 || typeof record.after !== 'string' || typeof record.afterHash !== 'string'
    || typeof record.path !== 'string' || typeof record.root !== 'string' || !binding.local_path) return refused;
  const after = Buffer.from(record.after, 'base64');
  if (sha256(after) !== record.afterHash || record.ownerEpoch !== String(binding.owner_epoch) || record.sourceIncarnation !== binding.source_incarnation
    || !isWriteTargetContained(record.path, record.root) || !isWriteTargetContained(record.path, binding.local_path)
    || resolve(record.root) !== resolve(join(binding.local_path, binding.relative_path))) return refused;
  const { view, source } = diskView(record.path);
  const regular = !view.deleted && view.kind === 'file';
  if (regular && (diskHash(view) === record.beforeHash || diskHash(view) === record.afterHash)) return null;
  const [page] = await engine.executeRaw<{ revision: string | null }>('SELECT knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  const identity = effectIdentity(effect.id, record);
  const page_revision = page?.revision ?? null;
  const file: RecoveryFileView = { path: record.path, root: record.root, relative: relative(binding.local_path, record.path),
    prior: record.beforeHash === null ? { absent: true } : { absent: false, sha256: record.beforeHash, size: null, mode: record.mode, stored: false },
    disk: view, matches: 'neither', withdrawn: { sha256: record.afterHash, size: after.length } };
  return { sources: [{ prior: { bytes: after }, disk: source }], item: { id: `effect:${effect.id}`, target: 'withdrawal_mirror', effect_id: effect.id, request_id: effect.request_id ?? '',
    source_id: sourceId, slug, operation: 'withdrawal-mirror', state: effect.state, blocked_reason: effect.error_code, worktree_id: effect.worktree_id,
    sequence: effect.id, page_revision, identity, recorded_error: null, prior_hashes: [record.beforeHash], files: [file],
    choices: { prior: false, disk: false, withdrawn: regular },
    digest: digest({ v: 'stuck-recovery-effect-v1', id: effect.id, identity, disk: view, page_revision }) } };
}

function ownerBinding(binding: WorktreeBinding | null, sourceId: string, hostId: string): WorktreeBinding {
  if (binding?.owner_host_id === hostId && binding.local_path) return binding;
  throw opError('owner_unavailable', `Source ${sourceId}'s canonical worktree is not owned by this host, so its recovery files cannot be read or resolved here.`,
    `Nothing was changed. Run gbrain repair stuck-recovery --source ${sourceId} on the host that owns the source (gbrain sources writer status --source ${sourceId} --json names it).`,
    { fix: statusFix(sourceId) });
}

/**
 * The resolvable recoveries in `sourceIds` (owner host only): every non-terminal page or bundle recovery record on each
 * source's worktree that is blocked on unexpected bytes or whose file matches neither recorded version, and every
 * withdrawal-mirror effect recovery whose file matches neither. `requestId` narrows to one request. `artifacts` writes
 * each file's private diff (a remote caller's preview never does).
 */
export async function scanStuckRecoveries(engine: BrainEngine, sourceIds: string[], opts: { requestId?: string; artifacts?: boolean; hostId?: string } = {}): Promise<StuckRecoveryScan> {
  const hostId = opts.hostId ?? localHostId();
  const scan: StuckRecoveryScan = { items: [], residuals: {}, refused: [], heads: [] };
  const residual = (key: string) => { scan.residuals[key] = (scan.residuals[key] ?? 0) + 1; };
  for (const sourceId of sourceIds) {
    const found = await getWorktreeBinding(engine, sourceId, hostId);
    if (!found?.worktree_id) continue;
    const rows = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE worktree_id=$1::uuid AND recovery IS NOT NULL ORDER BY sequence', [found.worktree_id]);
    const effects = await engine.executeRaw<EffectRow>(`${EFFECT_SQL} WHERE e.worktree_id=$1::uuid AND e.recovery IS NOT NULL ORDER BY e.id`, [found.worktree_id]);
    if (!rows.length && !effects.length) continue;
    const binding = sourceIds.length === 1 || opts.requestId ? ownerBinding(found, sourceId, hostId) : found.owner_host_id === hostId && found.local_path ? found : null;
    if (!binding) { residual('owned_by_other_host'); continue; }
    for (const effect of effects) {
      if (opts.requestId && effect.request_id !== opts.requestId) continue;
      const read = await readEffectItem(engine, effect, binding, sourceId);
      if (!read) { residual('recovers_on_its_own'); continue; }
      if ('code' in read) {
        if (opts.requestId) throw refusalError(read);
        scan.refused.push(read);
        residual('effect_recovery');
        continue;
      }
      if (opts.artifacts) {
        const paths = writeArtifacts(await privateBackupDir(engine, read.item.request_id || read.item.id, read.item.digest.slice(0, 16)), read.item, read.sources,
          () => opError('source_changed', `A file of withdrawal-mirror effect ${read.item.effect_id} changed while the preview copied it.`, `Nothing was changed. Run the preview again: ${stuckRecoveryPreviewCommand(sourceIds)}`));
        read.item.files = read.item.files.map((file, index) => ({ ...file, ...paths[index] }));
      }
      scan.items.push(read.item);
    }
    if (!rows.length) continue;
    const [head] = await engine.executeRaw<{ id: string; request_id: string }>("SELECT id::text, request_id::text FROM persistence_requests WHERE worktree_id=$1::uuid AND state='queued' ORDER BY sequence LIMIT 1", [binding.worktree_id]);
    const read = head ? (await readHeadBlockers(engine, [head.id], hostId).catch(() => null))?.get(head.id) : undefined;
    const blocker = read?.status === 'blocked' ? read.blocker : null;
    scan.heads.push({ source_id: sourceId, queued_request_id: head?.request_id ?? null, blocked_by: blocker ? blocker.predicate : null });
    const ids = blocker?.predicate === 'request_recovery' ? new Set(blocker.ids) : null;
    for (const row of rows) {
      if (opts.requestId && row.request_id !== opts.requestId) continue;
      if (ids && !ids.has(row.request_id)) continue;
      if (isTerminal(row)) {
        if (!row.blocked_reason) { residual('terminal_cleanup'); continue; }
        const refused: RefusedRecovery = { code: 'recovery_choice_refused', request_id: row.request_id, source_id: row.source_id, slug: row.slug, state: row.state,
          blocked_reason: row.blocked_reason, reason: terminalReason(row) };
        if (opts.requestId) throw choiceRefused(refused.reason, row.source_id);
        scan.refused.push(refused);
        residual('terminal_refused');
        continue;
      }
      if (row.blocked_reason === 'unexpected_staging_bytes') { residual('unexpected_staging_bytes'); continue; }
      if (row.recovery?.version === 2 && !filesOf(row.recovery)) {
        const refused = bundleRefusal(row);
        if (opts.requestId) throw refusalError(refused);
        scan.refused.push(refused);
        residual('bundle_refused');
        continue;
      }
      const { item, sources } = await readItem(engine, row, binding);
      if (row.blocked_reason !== 'unexpected_file_bytes' && item.files.every(file => file.matches !== 'neither')) { residual('recovers_on_its_own'); continue; }
      if (opts.artifacts) {
        const paths = writeArtifacts(await privateBackupDir(engine, row.request_id, item.digest.slice(0, 16)), item, sources,
          () => opError('source_changed', `A file of request ${row.request_id} changed while the preview copied it.`, `Nothing was changed. Run the preview again: ${stuckRecoveryPreviewCommand(sourceIds)}`));
        item.files = item.files.map((file, index) => ({ ...file, ...paths[index] }));
      }
      scan.items.push(item);
    }
  }
  if (opts.requestId && !scan.items.length) throw opError('invalid_params', `Request ${opts.requestId} holds no resolvable recovery record in ${sourceIds.length === 1 ? `source ${sourceIds[0]}` : 'the selected sources'}.`,
    `Nothing was changed. Preview without the request id to list the stuck recoveries: ${stuckRecoveryPreviewCommand(sourceIds)}`);
  return scan;
}

function terminalReason(row: WriteRequest): string {
  return `Request ${row.request_id} already ended ${row.state}; a terminal outcome is immutable and its recovery never restores the canonical file, so `
    + `--keep prior would roll back ${row.state === 'committed' ? 'a committed write' : 'the outcome it recorded'} and --keep disk has nothing to abandon. Its recovery only waits `
    + `for staging cleanup (${row.blocked_reason}), which this command does not perform.`;
}
function effectReason(kind: string): string {
  return `A ${kind} effect recovery blocks the worktree, and its record does not hold usable withdrawn bytes for this canonical binding (missing, corrupt, `
    + 'or recorded for another owner epoch, root or source incarnation), so gbrain repair stuck-recovery cannot write them back; it never restores the bytes from before a withdrawal.';
}
const effectFix = (sourceId: string, requestId: string | null): Action => ({ ask_user: true, argv: stuckRecoveryPreviewArgv([sourceId], requestId ?? undefined), consent: [],
  actor: 'agent', requires_exclusive: false,
  why: `A withdrawal mirror in source ${sourceId} stopped with its file edited, and its recovery record cannot write the withdrawn version back, so every write on the worktree waits. `
    + 'The preview (read-only) lists the effect and its file; only the user can decide how the file is put back.',
  user_message: `A file in source ${sourceId} was edited while gbrain was removing a forgotten fact from it, and gbrain cannot finish that on its own, so writes to the source are paused. `
    + 'Copy the edited file somewhere safe and put it back to its committed version (do not delete it); gbrain then finishes removing the forgotten fact. Make the edit again afterwards, leaving that fact out.' });
function bundleRefusal(row: WriteRequest): RefusedRecovery {
  return { code: 'recovery_bundle_unsupported', request_id: row.request_id, source_id: row.source_id, slug: row.slug, state: row.state, blocked_reason: row.blocked_reason ?? null,
    reason: `Request ${row.request_id} in source ${row.source_id} holds a shared-skill bundle recovery record this binary cannot read (an unknown shape or more files than a bundle holds).`,
    fix: { ask_user: true, argv: stuckRecoveryPreviewArgv([row.source_id], row.request_id), consent: [], actor: 'agent', requires_exclusive: false,
      why: `Shared-skill request ${row.request_id} is stuck in recovery with a record gbrain repair stuck-recovery cannot read, so every write on source ${row.source_id} waits. `
        + 'The preview (read-only) lists it; which version of each skill file to keep is the user\'s call.',
      user_message: `A shared-skill publication in source ${row.source_id} is stuck and this gbrain cannot resolve it. Upgrade gbrain on the brain host and run the preview again; `
        + 'or decide which version of each skill file to keep and put those bytes in place by hand.' } };
}
/** A listed refusal as the error a request-id preview throws. */
function refusalError(refused: RefusedRecovery): OperationError {
  const error = catalogueError(refused.code, refused.reason, `Nothing was changed. ${refused.fix?.user_message ?? `Inspect it read-only with gbrain sources writer status --source ${refused.source_id} --json.`}`);
  if (refused.fix) error.fix = refused.fix;
  return error;
}
const choiceRefused = (reason: string, sourceId: string) => catalogueError('recovery_choice_refused', reason,
  `Nothing was changed. Inspect the request read-only with gbrain sources writer status --source ${sourceId} --json and follow the guidance for its blocked reason.`);

async function readJournal(engine: BrainEngine, key: string): Promise<Journal | null> {
  const [row] = await engine.executeRaw<{ completed_keys: Journal[] }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [RESOLUTION_OP, key]);
  return row?.completed_keys?.[0] ?? null;
}
async function writeJournal(engine: BrainEngine, key: string, journal: Journal): Promise<void> {
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`, [RESOLUTION_OP, key, JSON.stringify([journal])]);
}
/** The finished resolutions recorded under one preview hash (the audit entries an identical apply replays). */
export async function readResolutions(engine: BrainEngine, previewHash: string): Promise<Journal[]> {
  const rows = await engine.executeRaw<{ completed_keys: Journal[] }>("SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'preview_hash'=$2 ORDER BY fingerprint",
    [RESOLUTION_OP, previewHash]);
  return rows.map(row => row.completed_keys[0]);
}

/**
 * The refusal of a choice the staged prior copy cannot support (null when the copy is not why): `--keep prior` needs a
 * verified copy, and `--keep disk` a copy it can back up and remove. Its fix is the remaining exit, the `--keep disk`
 * apply under the same preview hash (destructive, so the user agrees first), or the read-only owner status when none is left.
 */
export function priorStageUnavailable(item: StuckRecovery, keep: KeepChoice, previewHash: string): OperationError | null {
  if (keep === 'withdrawn') return null;
  const stage = item.files.filter(file => file.matches === 'neither').map(file => file.prior.absent ? undefined : file.prior.stage)
    .find(found => found && (keep === 'prior' ? found.state !== 'verified' : found.state === 'mismatched' && found.sha256 === null));
  if (!stage) return null;
  const docs = 'docs/guides/repair.md#recovery-prior-stage-unavailable';
  const status = ['gbrain', 'sources', 'writer', 'status', '--source', item.source_id, '--json'];
  const what = stage.state === 'missing' ? 'is missing' : stage.sha256 === null ? 'is not a regular file' : 'does not match its recorded SHA-256';
  const message = `The staged copy of the prior file of request ${item.request_id} in source ${item.source_id} ${what} (${stage.path}), so --keep ${keep} `
    + `cannot ${keep === 'prior' ? 'restore the prior bytes' : 'back it up and remove it'}.`;
  if (keep === 'prior' && item.choices.disk) {
    const argv = ['gbrain', 'repair', 'stuck-recovery', '--source', item.source_id, '--keep', 'disk', '--apply', '--expect', previewHash, '--yes'];
    return opError('recovery_prior_stage_unavailable', message,
      `Nothing was changed. The prior bytes cannot be put back, so the remaining exit keeps the edited file and abandons the write. Ask the user, then run: ${argv.join(' ')}`,
      { docs, fix: { argv, consent: ['destructive'], actor: 'agent', requires_exclusive: false, verify: { argv: status },
        why: 'Keeps the bytes on disk and abandons the write after backing up both versions; the recovery is then cleared and the worktree claims writes again.',
        user_message: `gbrain's saved copy of the previous version of ${item.slug} ${what}, so that version cannot be put back. `
          + 'Keep the file as it is on disk now and drop the write that was interrupted?' } });
  }
  return opError('recovery_prior_stage_unavailable', message,
    `Nothing was changed. Something other than gbrain replaced the staged copy at ${stage.path}. Show the user the owner status (gbrain sources writer status --source ${item.source_id} --json) and that path; once it is a regular file again, preview again (${stuckRecoveryPreviewCommand([item.source_id], item.request_id)}).`,
    { docs, fix: { ...statusFix(item.source_id), verify: { argv: status } } });
}

/**
 * `--keep disk` with a staged prior copy that matches nothing recorded: recovery's cleanup never deletes such a copy, so
 * once it is in the backup directory (`<index>.prior-stage`) it is removed here, only while it still holds the bytes the
 * preview hashed. Idempotent: an absent copy was already removed.
 */
function removeMismatchedStage(stage: PriorStageView, item: StuckRecovery, command: string): void {
  let leaf;
  try { leaf = lstatSync(stage.path); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return; throw error; }
  if (!leaf.isFile() || hashFile(stage.path) !== stage.sha256) throw opError('unexpected_staging_bytes', `The staged prior copy of request ${item.request_id} changed after the preview, so the resolution stopped before removing it.`,
    `Nothing more was changed; the copy from the preview is backed up. Preview again (${command}), show the user the new state and apply the new hash.`, { fix: statusFix(item.source_id) });
  unlinkSync(stage.path);
  flushDirectory(dirname(stage.path));
}

/**
 * `--keep disk`: ends the live request terminal without touching its record. With no recorded failure it ends `conflict`
 * (`source_changed`); a recorded failure ends it by the owner's rule (`finishUnpublishedFailure`), except the two
 * reprepare codes, which that helper would requeue and which are conflicts.
 */
async function abandonWrite(engine: BrainEngine, row: WriteRequest, previewHash: string): Promise<void> {
  if (!row.error_code) {
    await engine.transaction(tx => completeWrite(tx, row, 'conflict', {}, { code: 'source_changed',
      message: `${KEEP_DISK_ABANDONED_PREFIX} (preview ${previewHash.slice(0, 12)}): the canonical file was kept as edited on disk.` }));
    return;
  }
  const recorded = new OperationError(row.error_code, row.error_message ?? 'Publication failed before database completion.',
    `Read request ${row.request_id}'s receipt with gbrain write-request -- ${row.request_id}; the canonical file was kept as edited on disk.`);
  if (!mayReprepare(row, recorded) && !transientDatabaseFailure(recorded)) { await finishUnpublishedFailure(engine, row, recorded); return; }
  await engine.transaction(tx => completeWrite(tx, row, mayReprepare(row, recorded) ? 'conflict' : 'failed', {}, { code: recorded.code, message: recorded.message }));
}

const sameIdentity = (row: WriteRequest | null, item: StuckRecovery) => {
  const files = row?.recovery ? filesOf(row.recovery) : null;
  return !!files && digest(identityOf(files, row!.recovery!)) === digest(item.identity);
};

function nextStep(item: StuckRecovery, keep: KeepChoice, request: WriteRequest): string {
  const state = request.state;
  const sync = `gbrain sync --source ${item.source_id} --no-pull`;
  if (item.target === 'skill_bundle') return keep === 'disk'
    ? `Every skill file is kept as it is on disk and the bundle's publication was abandoned (request ${state}); the shared-skill records keep the version from before it. `
      + `The backup holds each file's prior and disk bytes. Read the receipt with gbrain write-request -- ${item.request_id}; publish the skill again if the files on disk should become its new version.`
    : state === 'queued' ? 'The prior bytes of every skill file are back on disk and the publication was requeued: the resident writer publishes it again on its next pass.'
      : `The prior bytes of every skill file are back on disk and the publication ended ${state}; read its receipt with gbrain write-request -- ${item.request_id}.`;
  // #6858: a managed sync import is the next sync's to finish: it retries the page after the manifest end (sync-page-fault.ts fileChangedAfterAdmission).
  if (keep === 'disk' && request.intent?.kind === 'managed_sync_import') return `The bytes on disk are kept and the sync import's publication was abandoned (request ${state}). This command does not mark the page repaired. `
    + `Next: ${sync}. That sync retries ${item.slug} after the rest of its run and imports the kept file when it is committed at the run's target; an uncommitted edit is held (worktree_dirty) and the rest of the source syncs. `
    + `If a hold remains, gbrain sync status --source ${item.source_id} --json names it and its exit (commit the file, or gbrain sources reconcile ${item.source_id} ${item.slug} --brain host --preview).`;
  if (keep === 'disk') return `The bytes on disk are kept and the write's publication was abandoned (request ${state}); the database page still holds the content before the write, `
    + 'so the page shows as file/database drift until it is reconciled. This command does not mark the page repaired. Next, in order: '
    + `1) gbrain sources reconcile ${item.source_id} ${item.slug} --brain host --preview --auto-additive (writes nothing; when the file only adds to the page it fills the decisions in, `
    + 'and you apply the written preview with --from after the user agrees; anything else lists the decisions a person makes); '
    + `2) ${sync}, so a sync run that waits on this source resumes.`;
  return state === 'queued' ? 'The prior bytes are back on disk and the write was requeued: the resident writer publishes it again on its next pass.'
    : `The prior bytes are back on disk and the write ended ${state}; read its receipt with gbrain write-request -- ${item.request_id}.`;
}

async function startedJournal(engine: BrainEngine, key: string, item: StuckRecovery, opts: { keep: KeepChoice; previewHash: string }, command: string): Promise<Journal | null> {
  const journal = await readJournal(engine, key);
  if (journal && journal.keep !== opts.keep) throw opError('idempotency_conflict', `Preview ${opts.previewHash.slice(0, 12)} of request ${item.request_id} was ${journal.phase === 'done' ? 'resolved' : 'started'} with --keep ${journal.keep}.`,
    `Nothing was changed. ${journal.phase === 'done' ? 'That resolution is final' : `Finish it with the same choice: rerun the apply with --keep ${journal.keep}`}; for a different choice, preview again (${command}) and apply the new hash.`);
  return journal;
}
async function lockOwner(engine: BrainEngine, item: StuckRecovery, hostId: string, lockWaitMs: number | undefined) {
  const binding = ownerBinding(await getWorktreeBinding(engine, item.source_id, hostId), item.source_id, hostId);
  const lock = await acquireWorktree(binding, lockWaitMs ?? 10_000, undefined, engine, { yieldLanes: true });
  if (!lock) throw opError('writer_lock_unavailable', `Source ${item.source_id}'s worktree lock is held by another writer, so the recovery of request ${item.request_id} was not resolved.`,
    `Nothing was changed. Rerun the same apply in a few seconds; if it stays busy, inspect the holder with gbrain sources writer status --source ${item.source_id} --json.`, { fix: statusFix(item.source_id) });
  return { binding, lock };
}
const changedAgain = (item: StuckRecovery, backupDir: string, command: string) => opError('unexpected_file_bytes',
  `A canonical file of request ${item.request_id} changed again after the preview, so the resolution stopped before touching it.`,
  `Nothing more was changed; the bytes from the preview are backed up under ${backupDir}. Preview again (${command}), show the user the new diff and apply the new hash.`, { fix: statusFix(item.source_id) });

/**
 * Resolves one approved record (see the module comment). Runs on the owner host under the worktree lock; a run
 * killed at any step resumes from its journal, and an identical apply after success returns the recorded result.
 */
export async function resolveStuckRecovery(engine: BrainEngine, item: StuckRecovery, opts: { keep: KeepChoice; previewHash: string; hostId?: string; lockWaitMs?: number }):
Promise<ResolutionResult & { replayed: boolean }> {
  if (item.target === 'withdrawal_mirror') return resolveEffectRecovery(engine, item, opts);
  const hostId = opts.hostId ?? localHostId();
  const key = `${item.id}:${opts.previewHash}`;
  const command = stuckRecoveryPreviewCommand([item.source_id], item.request_id);
  let journal = await startedJournal(engine, key, item, opts, command);
  if (journal?.phase === 'done' && journal.result) return { ...journal.result, replayed: true };
  const { binding, lock } = await lockOwner(engine, item, hostId, opts.lockWaitMs);
  try {
    let row = await getWriteRequestById(engine, item.id);
    if (!journal) {
      if (!sameIdentity(row, item)) throw previewChangedError(opts.previewHash, command);
      if (isTerminal(row!)) throw choiceRefused(terminalReason(row!), item.source_id);
      const current = await readItem(engine, row!, binding);
      if (current.item.digest !== item.digest) throw previewChangedError(opts.previewHash, command);
      if (!current.item.choices[opts.keep]) throw priorStageUnavailable(current.item, opts.keep, opts.previewHash) ?? catalogueError('recovery_choice_refused', `--keep ${opts.keep} is not available for request ${item.request_id}: `
        + (opts.keep === 'prior' ? 'the recovery record does not hold the prior bytes, or a blocked file is not a regular file.'
          : opts.keep === 'withdrawn' ? 'only a withdrawal-mirror effect recovery has withdrawn bytes to write.' : 'a blocked file is not a regular file.'),
        `Nothing was changed. The preview lists the available choices; run it again (${command}) and apply one of those.`);
      const dir = await privateBackupDir(engine, item.request_id, item.digest.slice(0, 16));
      writeArtifacts(dir, current.item, current.sources, () => previewChangedError(opts.previewHash, command));
      await faultPoint('stuck_recovery:backed_up', { requestId: item.request_id, sourceId: item.source_id });
      journal = { id: item.id, request_id: item.request_id, source_id: item.source_id, slug: item.slug, preview_hash: opts.previewHash, keep: opts.keep, phase: 'backed_up',
        backup_dir: dir, original: { state: row!.state, blocked_reason: row!.blocked_reason ?? null, prior_hashes: item.prior_hashes,
          disk_hashes: item.files.map(file => diskHash(file.disk)) } };
      await writeJournal(engine, key, journal);
    }
    if (journal.phase === 'backed_up' && sameIdentity(row, item)) {
      const records = recoveryFiles(row!.recovery!);
      const unexpected = records.map((record, index) => ({ record, index })).filter(({ index }) => item.files[index]!.matches === 'neither');
      for (const { record, index } of unexpected) {
        const now = diskHash(diskView(record.path).view);
        const allowed = opts.keep === 'prior' ? [journal.original.disk_hashes[index], item.prior_hashes[index]] : [journal.original.disk_hashes[index]];
        if (!allowed.includes(now)) throw changedAgain(item, journal.backup_dir, command);
      }
      if (opts.keep === 'prior') {
        await upgradeRecoveryStaging(engine, 'persistence_requests', item.id, item.worktree_id, 'restore');
        const staged = recoveryFiles((await getWriteRequestById(engine, item.id))!.recovery!);
        await withFilesystemPublication([...new Set(staged.map(record => record.root))], async () => {
          for (const { index } of unexpected) {
            const record = staged[index];
            if (record.staging?.before) {
              // A prior over the single-string ceiling: recovery's own restoration renames the verified staged copy back.
              cleanupRecoveryStaging(record, { keepBefore: true });
              if (hashFile(record.path) !== record.beforeHash) restoreBeforeStage(record);
              continue;
            }
            cleanupRecoveryStaging(record);
            publishPersistenceFile({ path: record.path, root: record.root, content: priorBytes(record) }, record.staging?.restoration?.path, undefined, record.mode);
          }
        });
        await faultPoint('stuck_recovery:written', { requestId: item.request_id, sourceId: item.source_id });
        journal = { ...journal, phase: 'written' };
        await writeJournal(engine, key, journal);
      } else {
        const mismatched = unexpected.map(({ record, index }) => ({ record, stage: item.files[index].prior.absent ? undefined : item.files[index].prior.stage }))
          .filter(({ stage }) => stage?.state === 'mismatched' && stage.sha256 !== null);
        if (mismatched.length) await withFilesystemPublication([...new Set(mismatched.map(({ record }) => record.root))], async () => {
          for (const { stage } of mismatched) removeMismatchedStage(stage!, item, command);
        });
        if (!isTerminal(row!)) await abandonWrite(engine, row!, opts.previewHash);
        journal = { ...journal, phase: 'abandoned' };
        await writeJournal(engine, key, journal);
        await faultPoint('stuck_recovery:abandoned', { requestId: item.request_id, sourceId: item.source_id });
      }
      row = await getWriteRequestById(engine, item.id);
    }
    const ours = sameIdentity(row, item);
    const recovered = ours ? await recoverPublication(engine, item.id, hostId, true) : row!;
    await faultPoint('stuck_recovery:recovered', { requestId: item.request_id, sourceId: item.source_id });
    const blocked = sameIdentity(recovered, item);
    const result: ResolutionResult = { outcome: blocked ? 'still_blocked' : 'resolved', keep: opts.keep, request_state: recovered.state,
      blocked_reason: blocked ? recovered.blocked_reason ?? null : null, finished_by: ours ? 'this_run' : 'another_pass', backup_dir: journal.backup_dir,
      next: blocked ? `The recovery is still blocked (${recovered.blocked_reason ?? 'recovering'}); rerun the same apply, or inspect it with gbrain sources writer status --source ${item.source_id} --json.`
        : nextStep(item, opts.keep, recovered) };
    if (!blocked) await writeJournal(engine, key, { ...journal, phase: 'done', result });
    return { ...result, replayed: false };
  } finally { await lock.release(); }
}

/**
 * `--keep withdrawn` for a withdrawal-mirror effect recovery: back up the edited bytes, write the recorded
 * post-withdrawal bytes through the record's publication stage, then finish the effect forward with its own
 * `recoverEffectPublication` (it materializes the page, clears the record and advances the effect's cursor).
 */
async function resolveEffectRecovery(engine: BrainEngine, item: StuckRecovery, opts: { keep: KeepChoice; previewHash: string; hostId?: string; lockWaitMs?: number }):
Promise<ResolutionResult & { replayed: boolean }> {
  const hostId = opts.hostId ?? localHostId();
  const key = `${item.id}:${opts.previewHash}`;
  const command = stuckRecoveryPreviewCommand([item.source_id], item.request_id || undefined);
  let journal = await startedJournal(engine, key, item, opts, command);
  if (journal?.phase === 'done' && journal.result) return { ...journal.result, replayed: true };
  if (opts.keep !== 'withdrawn') throw catalogueError('recovery_choice_refused', `--keep ${opts.keep} is not available for the withdrawal-mirror effect recovery of request ${item.request_id}: `
    + 'the withdrawal is committed, and keeping the edited or pre-withdrawal bytes would leave the forgotten fact on disk for the next sync to import again.',
    `Nothing was changed. The only choice is --keep withdrawn; run the preview again (${command}) and apply its hash with --keep withdrawn after the user agrees.`);
  const { binding, lock } = await lockOwner(engine, item, hostId, opts.lockWaitMs);
  try {
    const read = async () => (await engine.executeRaw<EffectRow>(`${EFFECT_SQL} WHERE e.id=$1`, [item.effect_id]))[0] ?? null;
    const same = (effect: EffectRow | null) => !!effect?.recovery && digest(effectIdentity(effect.id, effect.recovery)) === digest(journal?.identity ?? item.identity);
    let effect = await read();
    if (!journal) {
      if (!same(effect)) throw previewChangedError(opts.previewHash, command);
      const current = await readEffectItem(engine, effect!, binding, item.source_id);
      if (!current || 'code' in current || current.item.digest !== item.digest) throw previewChangedError(opts.previewHash, command);
      if (!current.item.choices.withdrawn) throw catalogueError('recovery_choice_refused', `--keep withdrawn is not available for request ${item.request_id}: its file is not a regular file.`,
        `Nothing was changed. Put a regular file back at ${current.item.files[0]!.path} (the backup and the preview diff name the bytes), then preview again (${command}).`);
      const dir = await privateBackupDir(engine, item.request_id || item.id, item.digest.slice(0, 16));
      writeArtifacts(dir, current.item, current.sources, () => previewChangedError(opts.previewHash, command));
      await faultPoint('stuck_recovery:backed_up', { requestId: item.request_id, sourceId: item.source_id });
      journal = { id: item.id, request_id: item.request_id, source_id: item.source_id, slug: item.slug, preview_hash: opts.previewHash, keep: opts.keep, phase: 'backed_up',
        backup_dir: dir, original: { state: effect!.state, blocked_reason: effect!.error_code, prior_hashes: item.prior_hashes, disk_hashes: [diskHash(current.item.files[0]!.disk)] } };
      await writeJournal(engine, key, journal);
    }
    if (journal.phase === 'backed_up' && same(effect)) {
      const now = diskHash(diskView(effect!.recovery!.path).view);
      if (![journal.original.disk_hashes[0], effect!.recovery!.afterHash].includes(now)) throw changedAgain(item, journal.backup_dir, command);
      const started: Journal = journal;
      const rebased = await rebaseStaleEffectRecovery(engine, item.effect_id!, hostId, async (tx, record) => {
        journal = { ...started, identity: effectIdentity(item.effect_id!, record) };
        await writeJournal(tx, key, journal);
      });
      if (rebased === 'unrenderable') throw catalogueError('recovery_effect_unsupported', `Page ${item.slug} in source ${item.source_id} was deleted, replaced or segmented after its withdrawal mirror stopped, so it has no current version to write.`,
        `Nothing was written; the edited bytes are backed up under ${started.backup_dir}. ${effectFix(item.source_id, item.request_id || null).user_message}`);
      await upgradeRecoveryStaging(engine, 'persistence_effects', item.effect_id!, item.worktree_id, 'forward');
      const record = (await read())!.recovery!;
      const after = record.version === 1 ? record.after : null;
      if (after === null) throw catalogueError('recovery_effect_unsupported', effectReason('withdrawal-mirror'),
        `Nothing was written; the edited bytes are backed up under ${started.backup_dir}. ${effectFix(item.source_id, item.request_id || null).user_message}`);
      await withFilesystemPublication([record.root], async () => {
        cleanupRecoveryStaging(record);
        publishPersistenceFile({ path: record.path, root: record.root, content: Buffer.from(after, 'base64') }, record.staging?.publication?.path);
        if (record.mode !== null && existsSync(record.path)) chmodSync(record.path, record.mode);
      });
      await faultPoint('stuck_recovery:written', { requestId: item.request_id, sourceId: item.source_id });
      journal = { ...journal, phase: 'written' };
      await writeJournal(engine, key, journal);
      effect = await read();
    }
    const ours = same(effect);
    if (ours) {
      await claimAndRecoverEffect(engine, item.effect_id!, hostId);
      await trueUpRequests(engine, [effect!.request_ref]).catch(() => { /* idempotent; the request's next settlement retries it */ });
    }
    await faultPoint('stuck_recovery:recovered', { requestId: item.request_id, sourceId: item.source_id });
    const finished = await read();
    const blocked = same(finished);
    const result: ResolutionResult = { outcome: blocked ? 'still_blocked' : 'resolved', keep: opts.keep, request_state: finished?.state ?? 'committed',
      blocked_reason: blocked ? finished!.error_code : null, finished_by: ours ? 'this_run' : 'another_pass', backup_dir: journal.backup_dir,
      next: blocked ? `The effect recovery is still blocked (${finished!.error_code ?? 'recovering'}); rerun the same apply, or inspect it with gbrain sources writer status --source ${item.source_id} --json.`
        : `The withdrawn bytes are back in ${item.files[0]!.relative} and the withdrawal mirror finished it; the edited bytes are backed up under ${journal.backup_dir} (0.disk, with a diff against 0.withdrawn). `
          + `Writes queued on source ${item.source_id} resume on the resident writer's next pass. Commit the file before the next sync (an uncommitted change is held as worktree_dirty). `
          + 'If the edit held other changes, make them again from the backup, leaving the forgotten fact out.' };
    if (!blocked) await writeJournal(engine, key, { ...journal, phase: 'done', result });
    return { ...result, replayed: false };
  } finally { await lock.release(); }
}
