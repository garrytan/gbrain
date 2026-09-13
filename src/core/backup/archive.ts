/** Private, bounded, streaming backup container. Paths are data, never shell arguments. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, fstatSync, linkSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { AgentInstallError, assertNoSymlinks, confinedPath } from '../agent-install/state.ts';

const MAGIC = Buffer.from('GBRAIN-BACKUP-1\n');
const MAX_MANIFEST = 8 * 1024 * 1024;
const MAX_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_FILES = 100_000;
export interface ArchiveEntry { path: string; size: number; sha256: string }
export interface ArchiveManifest { format_version: 1; entries: ArchiveEntry[]; [key: string]: unknown }
export interface ArchiveInput { path: string; file: string; expected?: { size: number; sha256: string } }

/** Recognize an existing backup even when its filename has no extension. */
export function isBackupArchiveFile(file: string): boolean {
  assertNoSymlinks(file);
  const fd = openSync(file, 'r');
  try {
    const header = Buffer.alloc(MAGIC.length);
    return readSync(fd, header, 0, header.length, 0) === header.length && header.equals(MAGIC);
  } finally { closeSync(fd); }
}

function fail(message: string): never { throw new AgentInstallError('invalid_backup', message); }
function readExactly(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const n = readSync(fd, buffer, offset, length - offset, position + offset);
    if (n === 0) fail('Truncated backup archive.');
    offset += n;
  }
  return buffer;
}
function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

export function hashFile(file: string): { size: number; sha256: string } {
  assertNoSymlinks(file);
  const fd = openSync(file, 'r');
  const hash = createHash('sha256');
  let size = 0;
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      size += n;
      if (size > MAX_BYTES) fail('Backup file exceeds the 8 GiB limit.');
      hash.update(buffer.subarray(0, n));
    }
  } finally { closeSync(fd); }
  return { size, sha256: hash.digest('hex') };
}

/** Publication uses link(2), which refuses an existing target atomically. */
export function writeBackupArchive(output: string, metadata: Record<string, unknown>, files: ArchiveInput[]): ArchiveManifest {
  assertNoSymlinks(output);
  const paths = new Set<string>();
  const entries = files.map(input => {
    confinedPath('/archive', input.path);
    if (paths.has(input.path)) fail('Duplicate archive entry.');
    paths.add(input.path);
    const actual = hashFile(input.file);
    if (input.expected && (actual.size !== input.expected.size || actual.sha256 !== input.expected.sha256)) fail('A file changed after the database snapshot; quiesce writers and retry.');
    return { path: input.path, ...actual };
  });
  const manifest: ArchiveManifest = { ...metadata, format_version: 1, entries };
  validateManifest(manifest);
  const encoded = Buffer.from(JSON.stringify(manifest));
  if (encoded.length > MAX_MANIFEST) fail('Backup manifest is too large.');
  const sizeHeader = Buffer.alloc(4); sizeHeader.writeUInt32BE(encoded.length);
  const temporary = `${output}.partial-${randomUUID()}`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeAll(fd, MAGIC); writeAll(fd, sizeHeader); writeAll(fd, encoded);
    const buffer = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < files.length; i++) {
      const source = openSync(files[i].file, 'r');
      const hash = createHash('sha256'); let copied = 0;
      try {
        for (;;) {
          const n = readSync(source, buffer, 0, buffer.length, null);
          if (!n) break;
          copied += n;
          if (copied > entries[i].size) fail('A file changed during backup; quiesce writers and retry.');
          hash.update(buffer.subarray(0, n)); writeAll(fd, buffer.subarray(0, n));
        }
      } finally { closeSync(source); }
      if (copied !== entries[i].size || hash.digest('hex') !== entries[i].sha256) fail('A file changed during backup; quiesce writers and retry.');
    }
    fsyncSync(fd);
    linkSync(temporary, output);
    const parent = openSync(dirname(output), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { closeSync(fd); unlinkSync(temporary); }
  return manifest;
}

function validateManifest(input: unknown): asserts input is ArchiveManifest {
  const value = input as ArchiveManifest;
  if (!value || value.format_version !== 1 || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > MAX_FILES) fail('Unsupported backup format or file inventory.');
  let total = 0;
  const paths = new Set<string>();
  for (const entry of value.entries) {
    if (!entry || typeof entry.path !== 'string' || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail('Invalid backup entry.');
    confinedPath('/archive', entry.path);
    if (paths.has(entry.path)) fail('Duplicate backup path.');
    paths.add(entry.path);
    total += entry.size;
  }
  if (total > MAX_BYTES) fail('Backup exceeds the 8 GiB recovery limit.');
}

/** Extract ONLY into a caller-created private, empty staging directory. */
export function readBackupArchive(archive: string, destination: string): ArchiveManifest {
  assertNoSymlinks(archive);
  const fd = openSync(archive, 'r');
  try {
    if (!readExactly(fd, MAGIC.length, 0).equals(MAGIC)) fail('Not a GBrain backup archive.');
    const length = readExactly(fd, 4, MAGIC.length).readUInt32BE();
    if (length > MAX_MANIFEST) fail('Backup manifest exceeds its size limit.');
    let value: unknown;
    try { value = JSON.parse(readExactly(fd, length, MAGIC.length + 4).toString('utf8')); }
    catch { fail('Unreadable backup manifest.'); }
    validateManifest(value);
    let position = MAGIC.length + 4 + length;
    const total = position + value.entries.reduce((n, e) => n + e.size, 0);
    if (total !== fstatSync(fd).size) fail('Backup length does not match its inventory.');
    for (const entry of value.entries) {
      const target = confinedPath(destination, entry.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const out = openSync(target, 'wx', 0o600);
      const hash = createHash('sha256');
      try {
        let left = entry.size;
        while (left) {
          const block = readExactly(fd, Math.min(left, 1024 * 1024), position);
          writeAll(out, block); hash.update(block); position += block.length; left -= block.length;
        }
        fsyncSync(out);
      } finally { closeSync(out); }
      if (hash.digest('hex') !== entry.sha256) fail(`Backup checksum mismatch: ${entry.path}`);
    }
    return value;
  } finally { closeSync(fd); }
}

/**
 * PGLite dumpDataDir emits ustar with /-prefixed cluster-relative paths.
 * Parse its narrow format ourselves: never hand an unchecked tar to a runtime.
 * Reject links/devices/PAX/duplicates and verify checksums before writing.
 */
export function extractPgliteDump(file: string, destination: string): void {
  const fd = openSync(file, 'r');
  const length = fstatSync(fd).size;
  let offset = 0;
  const seen = new Set<string>();
  try {
    while (offset + 512 <= length) {
      const header = readExactly(fd, 512, offset); offset += 512;
      if (header.every(n => n === 0)) {
        while (offset < length) {
          const block = readExactly(fd, Math.min(1024 * 1024, length - offset), offset);
          if (!block.every(n => n === 0)) fail('Data after the PGLite tar terminator.');
          offset += block.length;
        }
        break;
      }
      const field = (start: number, end: number) => header.subarray(start, end).toString('utf8').split('\0')[0];
      const octal = (start: number, end: number): number => {
        const text = field(start, end).trim();
        if (!/^[0-7]+$/.test(text)) fail('Invalid PGLite tar number.');
        const value = parseInt(text, 8);
        if (!Number.isSafeInteger(value)) fail('Oversized PGLite tar entry.');
        return value;
      };
      const checksum = octal(148, 156);
      const sum = header.reduce((n, byte, i) => n + (i >= 148 && i < 156 ? 32 : byte), 0);
      if (checksum !== sum) fail('PGLite tar header checksum mismatch.');
      const prefix = field(345, 500);
      const raw = (prefix ? prefix + '/' : '') + field(0, 100);
      const path = raw.replace(/^\//, '').replace(/\/$/, '');
      const type = header[156]; const size = octal(124, 136);
      if (type !== 48 && type !== 53 && type !== 0) fail('PGLite tar contains an unsupported entry type.');
      if (!path && type === 53) continue;
      const target = confinedPath(destination, path);
      if (seen.has(path)) fail('Duplicate PGLite tar entry.');
      seen.add(path);
      if (seen.size > MAX_FILES || offset + size > length) fail('PGLite tar exceeds bounds.');
      // Node-backed dumpDataDir also sees GBrain's live owner lock. It is a
      // process lease, not database state: importing it would either wait on
      // the source process or invite unsafe stale-lock removal in recovery.
      if (path === 'postmaster.pid' || ['.gbrain-lock', '.gbrain-lock.reap-claim'].some(p => path === p || path.startsWith(p + '/'))) {
        offset += Math.ceil(size / 512) * 512;
        continue;
      }
      if (type === 53) {
        if (size) fail('Nonempty PGLite tar directory.');
        mkdirSync(target, { recursive: true, mode: 0o700 });
      } else {
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        const out = openSync(target, 'wx', 0o600);
        try {
          for (let copied = 0; copied < size;) {
            const block = readExactly(fd, Math.min(size - copied, 1024 * 1024), offset + copied);
            writeAll(out, block); copied += block.length;
          }
          fsyncSync(out);
        } finally { closeSync(out); }
      }
      offset += Math.ceil(size / 512) * 512;
    }
    if (offset !== length || !seen.has('PG_VERSION') || !seen.has('global/pg_control')) fail('Incomplete PGLite cluster archive.');
  } finally { closeSync(fd); }
}
