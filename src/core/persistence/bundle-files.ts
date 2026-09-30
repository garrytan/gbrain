import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { OperationError } from '../ops/contract.ts';
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

function unsafe(): OperationError {
  return new OperationError('storage_error', 'Skill publication requires bounded regular files without aliases, links, or special files.');
}

export function readBundleFile(path: string, root: string): { bytes: Buffer; mode: number } | null {
  if (!path.isWellFormed() || path !== path.normalize('NFC')) throw unsafe();
  const rel = relative(root, path);
  if (!isAbsolute(path) || path !== resolve(path) || !rel || isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === '..'
    || !rel.isWellFormed() || rel !== rel.normalize('NFC')
    || rel.split(sep).length > BUNDLE_FILE_LIMITS.depth || /[\\\x00-\x1f:]/.test(rel)) throw unsafe();
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
    if (nextSize > BUNDLE_FILE_LIMITS.fileBytes) throw new OperationError('request_too_large', 'Skill file exceeds the publication byte limit.');
    const before = readBundleFile(file.path, root);
    const beforeHash = before ? sha256(before.bytes) : null;
    if (beforeHash !== file.expectedBeforeHash) throw new OperationError('source_changed', 'A canonical skill file changed after preparation.');
    beforeBytes += before?.bytes.byteLength ?? 0;
    afterBytes += nextSize;
    if (beforeBytes > BUNDLE_FILE_LIMITS.totalBytes || afterBytes > BUNDLE_FILE_LIMITS.totalBytes) throw new OperationError('request_too_large', 'Skill bundle exceeds the publication byte limit.');
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
  const refuse = () => new OperationError('recovery_required', 'Skill recovery identity or before-image is invalid; canonical files remain fenced.');
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
  if (current && expectedMode !== null && current.mode !== expectedMode) throw new OperationError('unexpected_file_bytes', 'A canonical skill file mode changed outside publication.');
  return hash;
}

function flushBundleDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function stageBundleFile(file: MutationFile, record: FileRecoveryRecord): void {
  if (file.content === null) return;
  readBundleFile(file.path, file.root);
  let parent = file.root;
  for (const part of relative(file.root, dirname(file.path)).split(sep).filter(Boolean)) {
    const next = join(parent, part);
    try { mkdirSync(next); flushBundleDirectory(parent); }
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
      if (written <= 0) throw new OperationError('storage_error', 'Skill staging did not write the complete file.');
      offset += written;
    }
    const mode = record.afterMode ?? record.mode;
    if (mode !== null) chmodSync(stage.path, mode);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  flushBundleDirectory(parent);
}

export function publishStagedBundleFile(record: FileRecoveryRecord, boundary?: (phase: 'file_replaced' | 'directory_flushed') => void): void {
  if (bundleFileHash(record) !== record.beforeHash) throw new OperationError('source_changed', 'The canonical skill file changed before publication.');
  if (record.afterHash === null) {
    if (record.beforeHash === null) return;
    unlinkSync(record.path);
  } else {
    const stage = record.staging?.publication;
    if (!stage) throw unsafe();
    const staged = readBundleFile(stage.path, record.root);
    if (!staged || staged.bytes.byteLength !== stage.bytes || sha256(staged.bytes) !== stage.hash
      || stage.hash !== record.afterHash || staged.mode !== (record.afterMode ?? record.mode)) throw unsafe();
    renameSync(stage.path, record.path);
  }
  boundary?.('file_replaced');
  flushBundleDirectory(dirname(record.path));
  boundary?.('directory_flushed');
}
