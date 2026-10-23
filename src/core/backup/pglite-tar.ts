/** Stream the locked PGlite mounted cluster without retaining its file bodies. */
import type { PGlite } from '@electric-sql/pglite';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { AgentInstallError, assertNoSymlinks } from '../agent-install/state.ts';

export type PgliteDumpFS = Pick<PGlite['Module']['FS'], 'readdir' | 'lstat' | 'stat' | 'isFile' | 'isDir' | 'open' | 'read' | 'close'>;
const ROOT = '/pglite/data';
const BLOCK = 1024 * 1024;
// The unchanged outer container and extractor enforce these recovery bounds too.
const MAX_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_FILES = 100_000;

function fail(message: string): never { throw new AgentInstallError('invalid_backup', message); }

function octal(header: Buffer, offset: number, width: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) fail('Invalid PGlite tar number.');
  const text = value.toString(8);
  if (text.length > width - 1) fail('Oversized PGlite tar number.');
  header.write(text.padStart(width - 1, '0') + '\0', offset, width, 'ascii');
}

function tarHeader(path: string, mode: number, size: number, modified: Date | number, directory: boolean): Buffer {
  if (!path.startsWith('/') || path.slice(1).split('/').some(p => !p || p === '.' || p === '..') ||
      /[^\x20-\x7e]|\\/.test(path)) fail('Unsupported PGlite tar path.');
  const header = Buffer.alloc(512);
  let name = path, prefix = '';
  if (name.length > 99) {
    const at = name.lastIndexOf('/', name.length - 2);
    prefix = name.slice(0, at); name = name.slice(at + 1);
    if (!prefix || prefix.length > 154 || name.length > 99) fail('PGlite tar path exceeds ustar bounds.');
  }
  header.write(name, 0, 100, 'ascii');
  header.write(prefix, 345, 155, 'ascii');
  octal(header, 100, 8, (mode || 0o777) & 0o777);
  // PGlite/tinytar does not supply uid/gid or owner/group: its dump uses zero.
  octal(header, 108, 8, 0); octal(header, 116, 8, 0);
  octal(header, 124, 12, size);
  octal(header, 136, 12, modified instanceof Date ? Math.floor(modified.getTime() / 1000) : modified);
  header.fill(32, 148, 156);
  header[156] = directory ? 53 : 48;
  header.write('ustar\0' + '00', 257, 8, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

/** Narrow sink seam permits a virtual >4 GiB fixture without allocating that tar. */
export function streamPgliteTar(fs: PgliteDumpFS, write: (bytes: Uint8Array) => void): void {
  const block = Buffer.alloc(BLOCK), zero = Buffer.alloc(512);
  let files = 0, total = 0;
  const emit = (bytes: Uint8Array) => {
    total += bytes.length;
    if (total > MAX_BYTES) fail('PGlite tar exceeds the 8 GiB recovery limit.');
    write(bytes);
  };
  const walk = (directory: string) => {
    for (const name of fs.readdir(directory)) {
      if (name === '.' || name === '..') continue;
      if (!name || name.includes('/') || name.includes('\\')) fail('Unsupported PGlite directory entry.');
      const path = directory + '/' + name;
      const before = fs.lstat(path);
      const isFile = fs.isFile(before.mode), isDir = fs.isDir(before.mode);
      if (!isFile && !isDir) fail('PGlite tar contains an unsupported entry type.');
      if (++files > MAX_FILES) fail('PGlite tar exceeds the file inventory bound.');
      const size = isFile ? before.size : 0;
      if (!Number.isSafeInteger(size) || size < 0 || total + 512 + Math.ceil(size / 512) * 512 + 1024 > MAX_BYTES)
        fail('PGlite tar exceeds the 8 GiB recovery limit.');
      emit(tarHeader(path.slice(ROOT.length), before.mode, size, before.mtime, isDir));
      if (isFile) {
        const stream = fs.open(path, 'r');
        try {
          for (let position = 0; position < size;) {
            const wanted = Math.min(block.length, size - position);
            const count = fs.read(stream, block, 0, wanted, position);
            if (!Number.isInteger(count) || count <= 0 || count > wanted) fail('Truncated PGlite tar source.');
            emit(block.subarray(0, count)); position += count;
          }
          const after = fs.stat(path);
          if (after.size !== before.size || after.mode !== before.mode || Number(after.mtime) !== Number(before.mtime) ||
              after.ino !== before.ino) fail('PGlite source changed during backup.');
        } finally { fs.close(stream); }
        const padding = (512 - size % 512) % 512;
        if (padding) emit(zero.subarray(0, padding));
      } else walk(path);
    }
  };
  walk(ROOT);
  emit(zero); emit(zero);
}

/** Caller owns bootstrap + database writer locks and a private temporary directory. */
export function writePgliteDump(fs: PgliteDumpFS, output: string): void {
  assertNoSymlinks(output);
  const fd = openSync(output, 'wx', 0o600);
  try {
    streamPgliteTar(fs, bytes => {
      let offset = 0;
      while (offset < bytes.length) {
        const n = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!n) fail('PGlite dump write made no progress.');
        offset += n;
      }
    });
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
