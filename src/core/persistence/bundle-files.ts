import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { flushDirectory, sameFileMode } from '../fs-durable.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { sha256 } from './digest.ts';
import type { BundleRecoveryRecord, FileRecoveryRecord, WriteRequest } from './model.ts';
import type { WorktreeBinding } from './ownership.ts';
import { recoveryStagingFile } from './staging.ts';

export interface MutationFile {
  path: string;
  root: string;
  content: string | Uint8Array | null;
  expectedBeforeHash?: string | null;
}
export const BUNDLE_FILE_LIMITS = Object.freeze({ files: 128, fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024, depth: 16 });

const ownersFix = (): Action => readFix('Shows each source\'s canonical root and owner with any pending or recovering skill publication, read-only.',
  { argv: ['gbrain', 'sources', 'writer', 'status', '--json'] });
const requestFix = (row: WriteRequest): Action => row.principal_kind === 'local_cli'
  ? readFix(`Reads skill request ${row.request_id}'s durable receipt: its state and recorded error, read-only.`, { argv: ['gbrain', 'write-request', '--', row.request_id] })
  : readFix(`Shows source ${row.source_id}'s owner and its pending or recovering requests, read-only.`, { argv: ['gbrain', 'sources', 'writer', 'status', '--source', row.source_id, '--json'] });

function unsafe(): OperationError {
  return opError('storage_error', 'Skill publication requires bounded regular files without aliases, links, or special files.',
    `A skill bundle path is a symlink, hard link or special file, sits under a symlinked directory, is deeper than ${BUNDLE_FILE_LIMITS.depth} levels, or holds a file over ${BUNDLE_FILE_LIMITS.fileBytes} bytes, so it was not published or restored. Replace it with a regular file inside the source's canonical root, then publish the skill again as a new request; during recovery the owner keeps the files fenced and re-checks them on each pass.`,
    { fix: ownersFix() });
}

/**
 * #5776: check each path segment, not the joined relative path. On Windows the
 * separator is a backslash, so testing the whole relative path for one
 * rejected every nested bundle file there.
 */
export function bundleRelativePathIsSafe(rel: string, pathSep: string = sep): boolean {
  const parts = rel.split(pathSep);
  return parts.length <= BUNDLE_FILE_LIMITS.depth && parts.every(part => part !== '' && !/[\\/\x00-\x1f:]/.test(part));
}

export function readBundleFile(path: string, root: string): { bytes: Buffer; mode: number } | null {
  if (!path.isWellFormed() || path !== path.normalize('NFC')) throw unsafe();
  const rel = relative(root, path);
  if (!isAbsolute(path) || path !== resolve(path) || !rel || isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === '..'
    || !rel.isWellFormed() || rel !== rel.normalize('NFC')
    || !bundleRelativePathIsSafe(rel)) throw unsafe();
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw unsafe();
  const parts = rel.split(sep);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (index < parts.length - 1) { if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafe(); continue; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > BUNDLE_FILE_LIMITS.fileBytes) throw unsafe();
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1 || opened.size > BUNDLE_FILE_LIMITS.fileBytes) throw unsafe();
      const buffer = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < buffer.byteLength) {
        const size = readSync(fd, buffer, length, buffer.byteLength - length, null);
        if (!size) break;
        length += size;
      }
      const bytes = buffer.subarray(0, length);
      const final = fstatSync(fd);
      if (final.size !== bytes.byteLength || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || bytes.byteLength > BUNDLE_FILE_LIMITS.fileBytes) throw unsafe();
      return { bytes, mode: final.mode & 0o7777 };
    } finally { closeSync(fd); }
  }
  throw unsafe();
}

export function prepareBundleRecovery(files: MutationFile[], binding: WorktreeBinding, row: WriteRequest): { record: BundleRecoveryRecord; bytes: number } {
  if (!files.length || files.length > BUNDLE_FILE_LIMITS.files || !binding.local_path) throw unsafe();
  const root = realpathSync(join(binding.local_path, binding.relative_path));
  const seen = new Set<string>();
  let beforeBytes = 0;
  let afterBytes = 0;
  const records: FileRecoveryRecord[] = [];
  for (const file of files) {
    if (file.root !== root || file.expectedBeforeHash === undefined) throw unsafe();
    const normalized = file.path.normalize('NFC').toLowerCase();
    if (seen.has(normalized)) throw unsafe();
    for (const path of seen) if (path.startsWith(`${normalized}${sep}`) || normalized.startsWith(`${path}${sep}`)) throw unsafe();
    seen.add(normalized);
    const nextSize = file.content === null ? 0 : typeof file.content === 'string' ? Buffer.byteLength(file.content) : file.content.byteLength;
    if (nextSize > BUNDLE_FILE_LIMITS.fileBytes) throw opError('request_too_large', 'Skill file exceeds the publication byte limit.',
      `A file of skill request ${row.request_id} in source ${row.source_id} is over the ${BUNDLE_FILE_LIMITS.fileBytes}-byte per-file limit, so nothing was published. Shrink or split it, then publish the skill again as a new request with a new request_id.`,
      { fix: requestFix(row) });
    const before = readBundleFile(file.path, root);
    const beforeHash = before ? sha256(before.bytes) : null;
    if (beforeHash !== file.expectedBeforeHash) throw opError('source_changed', 'A canonical skill file changed after preparation.',
      `A canonical file of skill request ${row.request_id} in source ${row.source_id} changed on disk after the request was prepared, so nothing was published. Read the skill as it is now and publish again against it with a new request_id.`,
      { fix: requestFix(row) });
    beforeBytes += before?.bytes.byteLength ?? 0;
    afterBytes += nextSize;
    if (beforeBytes > BUNDLE_FILE_LIMITS.totalBytes || afterBytes > BUNDLE_FILE_LIMITS.totalBytes) throw opError('request_too_large', 'Skill bundle exceeds the publication byte limit.',
      `Skill request ${row.request_id} in source ${row.source_id} would hold more than ${BUNDLE_FILE_LIMITS.totalBytes} bytes before or after publication, so nothing was published. Shrink the bundle, then publish it again as a new request with a new request_id.`,
      { fix: requestFix(row) });
    records.push({ version: 1, path: file.path, root,
      before: before?.bytes.toString('base64') ?? null, beforeHash,
      afterHash: file.content === null ? null : sha256(file.content), mode: before?.mode ?? null,
      afterMode: before?.mode ?? (0o644 & ~process.umask()),
      ownerEpoch: String(binding.owner_epoch), attempt: row.execution_token!,
      staging: {
        ...(file.content === null ? {} : { publication: recoveryStagingFile(file.path, file.content) }),
        ...(before === null ? {} : { restoration: recoveryStagingFile(file.path, before.bytes) }),
      },
    });
  }
  const record: BundleRecoveryRecord = { version: 2, target: 'skill_bundle', root,
    ownerEpoch: String(binding.owner_epoch), attempt: row.execution_token!, files: records };
  return { record, bytes: Math.max(beforeBytes * 3 + afterBytes * 2,
    Buffer.byteLength(JSON.stringify(record)) + beforeBytes + afterBytes) + files.length * 4096 };
}

export function assertBundleRecoveryBinding(record: BundleRecoveryRecord, binding: WorktreeBinding, attempt: string | null): void {
  const refuse = () => opError('recovery_required', 'Skill recovery identity or before-image is invalid; canonical files remain fenced.',
    `The recovery record for skill files under ${record.root} does not match this owner (root, owner epoch ${binding.owner_epoch} or claim) or carries a malformed before-image, so recovery stopped and the files stay fenced; nothing was restored or deleted. Show the user the owner status; never delete the files or the record to force progress.`,
    { fix: ownersFix() });
  if (!binding.local_path || record.root !== resolve(binding.local_path, binding.relative_path)
    || record.ownerEpoch !== String(binding.owner_epoch) || record.attempt !== attempt) throw refuse();
  const seen = new Set<string>();
  let total = 0;
  for (const file of record.files) {
    if (file.root !== record.root || file.ownerEpoch !== record.ownerEpoch || file.attempt !== record.attempt
      || seen.has(file.path.normalize('NFC').toLowerCase()) || !file.staging) throw refuse();
    seen.add(file.path.normalize('NFC').toLowerCase());
    if (file.before === null) { if (file.beforeHash !== null || file.mode !== null) throw refuse(); continue; }
    if (typeof file.before !== 'string' || file.before.length > Math.ceil(BUNDLE_FILE_LIMITS.fileBytes / 3) * 4) throw refuse();
    const bytes = Buffer.from(file.before, 'base64');
    total += bytes.byteLength;
    if (bytes.toString('base64') !== file.before || sha256(bytes) !== file.beforeHash || total > BUNDLE_FILE_LIMITS.totalBytes
      || !Number.isInteger(file.mode) || file.mode! < 0 || file.mode! > 0o7777) throw refuse();
  }
}

export function bundleFileHash(record: FileRecoveryRecord): string | null {
  const current = readBundleFile(record.path, record.root);
  const hash = current ? sha256(current.bytes) : null;
  const expectedMode = hash === record.beforeHash ? record.mode : record.afterMode ?? record.mode;
  if (current && expectedMode !== null && !sameFileMode(current.mode, expectedMode)) throw opError('unexpected_file_bytes', 'A canonical skill file mode changed outside publication.',
    `The permissions of ${record.path} changed outside skill publication, so it was neither published nor restored and stays fenced. Show the user the path; restoring its mode (${expectedMode.toString(8)}) is their decision, and the owner re-checks it on its next recovery pass.`,
    { fix: ownersFix() });
  return hash;
}

export function stageBundleFile(file: MutationFile, record: FileRecoveryRecord): void {
  if (file.content === null) return;
  readBundleFile(file.path, file.root);
  let parent = file.root;
  for (const part of relative(file.root, dirname(file.path)).split(sep).filter(Boolean)) {
    const next = join(parent, part);
    try { mkdirSync(next); flushDirectory(parent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = lstatSync(next);
    if (!info.isDirectory() || info.isSymbolicLink()) throw unsafe();
    parent = next;
  }
  const stage = record.staging?.publication;
  if (!stage) throw unsafe();
  const content = typeof file.content === 'string' ? Buffer.from(file.content) : file.content;
  if (content.byteLength !== stage.bytes || sha256(content) !== stage.hash) throw unsafe();
  const fd = openSync(stage.path, 'wx', record.mode ?? 0o644);
  try {
    let offset = 0;
    while (offset < content.byteLength) {
      const written = writeSync(fd, content, offset, content.byteLength - offset);
      if (written <= 0) throw opError('storage_error', 'Skill staging did not write the complete file.',
        `Staging ${file.path} stopped writing before the file was complete (a full disk or a failing volume), so it was not published; the canonical file is unchanged. Check free space on that volume, then inspect the request's receipt before publishing again.`,
        { fix: ownersFix() });
      offset += written;
    }
    const mode = record.afterMode ?? record.mode;
    if (mode !== null) fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  flushDirectory(parent);
}

export function publishStagedBundleFile(record: FileRecoveryRecord, boundary?: (phase: 'file_replaced' | 'directory_flushed') => void): void {
  if (bundleFileHash(record) !== record.beforeHash) throw opError('source_changed', 'The canonical skill file changed before publication.',
    `${record.path} no longer holds the bytes recorded for this skill publication (it was edited outside it), so it was not replaced. Read the skill as it is now and publish again against it with a new request_id; during recovery the owner re-checks it on each pass.`,
    { fix: ownersFix() });
  if (record.afterHash === null) {
    if (record.beforeHash === null) return;
    unlinkSync(record.path);
  } else {
    const stage = record.staging?.publication;
    if (!stage) throw unsafe();
    const staged = readBundleFile(stage.path, record.root);
    const mode = record.afterMode ?? record.mode;
    if (!staged || staged.bytes.byteLength !== stage.bytes || sha256(staged.bytes) !== stage.hash
      || stage.hash !== record.afterHash || mode === null || !sameFileMode(staged.mode, mode)) throw unsafe();
    renameSync(stage.path, record.path);
  }
  boundary?.('file_replaced');
  flushDirectory(dirname(record.path));
  boundary?.('directory_flushed');
}
