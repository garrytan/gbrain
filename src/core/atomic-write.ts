/**
 * Atomic file write for brain-repo markdown writers.
 *
 * Write path: unique tmp sibling → write → fsync → close → (optional verify
 * of the on-disk bytes) → chmod to the original mode → rename over the target.
 * The rename is atomic on POSIX filesystems, so readers never observe a torn
 * file; a crash mid-write leaves only a tmp sibling, never a corrupt target.
 *
 * The tmp name embeds pid + random bytes so concurrent writers (two fixers,
 * a fixer racing a render) can never collide on the tmp path itself. Note the
 * rename does NOT prevent lost updates between two read-modify-write writers —
 * callers that need that take the per-page lock (src/core/page-lock.ts).
 *
 * Every module used to roll its own copy of this pattern (write-through,
 * skillopt, schema-pack/mutate, self-upgrade, …). This is the shared home;
 * migrating the older copies is tracked in TODOS.md.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { randomBytes } from 'crypto';
import { dirname } from 'path';

export interface AtomicWriteOpts {
  /**
   * Called with the bytes read back from the tmp file BEFORE the rename.
   * Throw to abort the write — the tmp file is removed and the target is
   * left untouched. Use this to validate that what actually landed on disk
   * still parses (backlinks uses parseMarkdown here).
   */
  verify?: (onDisk: string) => void;
}

export function atomicWriteFileSync(filePath: string, content: string, opts?: AtomicWriteOpts): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;

  // Preserve the target's mode across the rename (a fresh tmp file gets the
  // process umask, which can silently drop e.g. group-write bits).
  let mode: number | null = null;
  try {
    if (existsSync(filePath)) mode = statSync(filePath).mode & 0o7777;
  } catch {
    /* stat raced a delete — fall through with default mode */
  }

  try {
    const fd = openSync(tmpPath, 'w', mode ?? 0o644);
    try {
      // Loop until every byte lands: writeSync may legally return a short
      // count under disk pressure/quotas, and a silent short write that
      // truncates AFTER valid frontmatter would pass a frontmatter-only
      // verifier and atomically install truncated content.
      const buf = Buffer.from(content, 'utf-8');
      let off = 0;
      while (off < buf.length) {
        const n = writeSync(fd, buf, off, buf.length - off);
        if (n <= 0) throw new Error(`atomic-write: short write at offset ${off}/${buf.length}`);
        off += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // open(2)'s mode argument is masked by the process umask (0664 & ~022 →
    // 0644), so an explicit chmod is required to actually PRESERVE the
    // target's mode across the rename — the pre-wave in-place write kept the
    // inode's mode exactly; this keeps that property.
    if (mode !== null) chmodSync(tmpPath, mode);
    if (opts?.verify) {
      opts.verify(readFileSync(tmpPath, 'utf-8'));
    }
    renameSync(tmpPath, filePath);
    // Durability of the RENAME itself: fsync the parent directory so a power
    // loss can't silently drop the new directory entry (the target is never
    // corrupt either way — this closes the write-vanished window). Dir fsync
    // is unsupported on some platforms; best-effort by design.
    try {
      const dfd = openSync(dirname(filePath), 'r');
      try { fsyncSync(dfd); } finally { closeSync(dfd); }
    } catch {
      /* best-effort */
    }
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}
