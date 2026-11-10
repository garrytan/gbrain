/**
 * Plain durable file writes for files under the skill-index directory: a
 * unique temp sibling, write, fsync, rename, then a best-effort directory
 * fsync. Readers never see a torn file. (src/core/atomic-write.ts guards
 * brain-repo writes and pulls in the persistence layer; these files are a
 * derived cache under GBRAIN_HOME, so the resolver keeps its own leaf copy.)
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync, fstatSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { flushDirectory } from '../../fs-durable.ts';

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function writeFileDurable(path: string, data: string | Uint8Array, mode = 0o600): void {
  replaceFile(path, data, mode, true);
}

/**
 * The same atomic replace without the fsyncs, for a hint a reader can lose:
 * the turn path's last-check stamp. A cloud disk's fsync can stall for tens
 * of milliseconds, which a 50 ms hook deadline cannot absorb every turn.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o600): void {
  replaceFile(path, data, mode, false);
}

function replaceFile(path: string, data: string | Uint8Array, mode: number, sync: boolean): void {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.tmp-${randomBytes(6).toString('hex')}`);
  const fd = openSync(tmp, 'wx', mode);
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    if (sync) fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
  if (sync) flushDirectory(dir, { bestEffort: true });
}

/** The first `max` bytes of a file, plus its full size. */
export function readHead(path: string, max: number): { bytes: Buffer; size: number } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const n = Math.min(size, max);
    const bytes = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      const r = readSync(fd, bytes, off, n - off, off);
      if (r === 0) break;
      off += r;
    }
    return { bytes: off === n ? bytes : bytes.subarray(0, off), size };
  } finally {
    closeSync(fd);
  }
}

/** A whole file, refusing one over `max` bytes. */
export function readBounded(path: string, max: number): Buffer | 'too_large' {
  if (statSync(path).size > max) return 'too_large';
  const { bytes, size } = readHead(path, max + 1);
  return size > max ? 'too_large' : bytes;
}
