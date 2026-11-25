/**
 * One regular file, read safely: the bench import and the stored bench summary both go through this, so a typo that
 * names a pipe, a device or a directory can never hang or flood the command (plan decision 11).
 *
 * The path is opened `O_NOFOLLOW | O_NONBLOCK` (a symlink as the last component is refused, and opening a pipe with no
 * writer returns at once), then the OPEN descriptor is checked with `fstat`, so there is no check-then-open race. Bytes
 * are counted as they arrive and the read stops at the cap plus one even when the file grows while it is read; the
 * `fstat` size is only an early refusal.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

export type BoundedReadFailure = 'not_found' | 'symlink' | 'not_regular' | 'permission' | 'too_large' | 'io';
export type BoundedRead = { ok: true; bytes: Buffer } | { ok: false; failure: BoundedReadFailure; detail: string };

const CHUNK = 1 << 20;

function kindOf(st: ReturnType<typeof fstatSync>): string {
  if (st.isDirectory()) return 'a directory';
  if (st.isFIFO()) return 'a named pipe';
  if (st.isSocket()) return 'a socket';
  if (st.isCharacterDevice() || st.isBlockDevice()) return 'a device';
  return 'not a regular file';
}

export function readBoundedFile(path: string, maxBytes: number): BoundedRead {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'error';
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, failure: 'not_found', detail: code };
    if (code === 'ELOOP') return { ok: false, failure: 'symlink', detail: 'a symbolic link' };
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, failure: 'permission', detail: code };
    return { ok: false, failure: 'io', detail: code };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, failure: 'not_regular', detail: kindOf(st) };
    if (st.size > maxBytes) return { ok: false, failure: 'too_large', detail: `${st.size} bytes` };
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, maxBytes + 1 - total));
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) return { ok: false, failure: 'too_large', detail: `more than ${maxBytes} bytes` };
      chunks.push(n === buf.length ? buf : buf.subarray(0, n));
    }
    return { ok: true, bytes: Buffer.concat(chunks, total) };
  } catch (e) {
    return { ok: false, failure: 'io', detail: (e as NodeJS.ErrnoException).code ?? 'error' };
  } finally {
    closeSync(fd);
  }
}
