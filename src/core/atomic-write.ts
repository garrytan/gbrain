/**
 * Atomic file write for brain-repo markdown writers.
 *
 * Write path: unique tmp sibling opened with the requested (or the target's
 * original) mode and fchmod-ed to it → write → fsync → close → (optional
 * verify of the on-disk bytes) → rename over the target.
 * The rename is atomic on POSIX filesystems, so readers never observe a torn
 * file; a crash mid-write leaves only a tmp sibling, never a corrupt target.
 *
 * The tmp name is a short hidden sibling, `.<sha256(target)>.tmp.<uuid>`, so
 * a valid target basename near NAME_MAX still gets a valid stage name (#5861),
 * the stage stays bound to its full target path, and concurrent writers (two fixers,
 * a fixer racing a render) can never collide on the tmp path itself. Note the
 * rename does NOT prevent lost updates between two read-modify-write writers —
 * callers that need that take the per-page lock (src/core/page-lock.ts).
 *
 * Every module used to roll its own copy of this pattern (write-through,
 * skillopt, schema-pack/mutate, self-upgrade, …). This is the shared home;
 * migrating the older copies is tracked in TODOS.md.
 */

import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { createHash, randomUUID } from 'crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { assertManagedFilesystemWrite } from './persistence/filesystem-guard.ts';
import { flushDirectory } from './fs-durable.ts';

export interface AtomicWriteOpts {
  /** Preallocated by a durable recovery journal before any filesystem sink. */
  stagingPath?: string;
  /** Synchronous boundary after the staging file is flushed and closed. */
  afterStagingFlush?: () => void;
  /** Required by journaled publication: real directory durability errors propagate. */
  durable?: boolean;
  /**
   * Called with the bytes read back from the tmp file BEFORE the rename.
   * Throw to abort the write — the tmp file is removed and the target is
   * left untouched. Use this to validate that what actually landed on disk
   * still parses (backlinks uses parseMarkdown here).
   */
  verify?: (onDisk: string) => void;
  /**
   * Exact permission bits for the written file. The stage is opened with this
   * mode and then fchmod-ed on its descriptor past the umask before any byte is
   * written, so content never sits in a looser file; a rewrite reasserts it over
   * the existing target's mode. Omitted: preserve the existing target's mode,
   * else 0644 & ~umask.
   */
  mode?: number;
}

function createPrivateDir(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  if (process.platform === 'win32') return;
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fchmodSync(fd, 0o700); } finally { closeSync(fd); }
}

/**
 * Create `dir` for gbrain-private files. A missing `root` is created with
 * default-permission ancestors and only `root` itself made exactly 0700 (past
 * the umask); each missing directory between `root` and `dir` is gbrain's own
 * layout and is created 0700 too. A directory that already exists, which may
 * be one the user chose, is never chmod-ed.
 */
export function mkdirPrivate(dir: string, root: string = dir): void {
  if (existsSync(dir)) return;
  const below = relative(root, dir);
  if (below === '..' || below.startsWith(`..${sep}`) || isAbsolute(below)) throw new Error(`mkdirPrivate: ${dir} is outside ${root}`);
  if (!existsSync(root)) {
    mkdirSync(dirname(root), { recursive: true });
    createPrivateDir(root);
  }
  let current = root;
  for (const part of below ? below.split(sep) : []) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- `below` is relative(root, dir), rejected above when it escapes root; parts walk only between root and dir.
    current = join(current, part);
    createPrivateDir(current);
  }
}

export function atomicStagingPath(filePath: string): string {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- internal name allocation only; coordinator checks owner-root containment before staging and publication.
  return `${stagingPrefix(resolve(filePath))}${randomUUID()}`;
}

function stagingPrefix(target: string): string {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- the second segment is a fixed-shape name built from a sha256 hex digest (no separators or ..); dirname is the already-resolved target's own directory.
  return join(dirname(target), `.${createHash('sha256').update(target).digest('hex')}.tmp.`);
}

export function validateAtomicStagingPath(filePath: string, stagingPath: string): void {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- normalization for the exact sibling check below; callers authorize and confine the target before filesystem use.
  const target = resolve(filePath);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- normalized only to reject non-sibling stages below; recovery also checks symlink-aware root containment before file access.
  const staged = resolve(stagingPath);
  const prefix = [stagingPrefix(target), `${target}.tmp.`].find(candidate => staged.startsWith(candidate));
  if (dirname(target) !== dirname(staged) || !prefix
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(staged.slice(prefix.length))) {
    throw new Error('atomic-write: invalid journaled staging path');
  }
}

export function atomicWriteFileSync(filePath: string, content: string | Uint8Array, opts?: AtomicWriteOpts): void {
  assertManagedFilesystemWrite(filePath);
  if (opts?.stagingPath) validateAtomicStagingPath(filePath, opts.stagingPath);
  const tmpPath = opts?.stagingPath ?? atomicStagingPath(filePath);
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
  let created: ReturnType<typeof fstatSync> | undefined;

  // Preserve the target's mode across the rename (a fresh tmp file gets the
  // process umask, which can silently drop e.g. group-write bits). open(2)'s
  // mode argument is masked by the umask, so the descriptor is fchmod-ed to
  // the exact mode; a path chmod could follow a swapped stage.
  let mode: number | null = null;
  try {
    if (existsSync(filePath)) mode = statSync(filePath).mode & 0o7777;
  } catch {
    /* stat raced a delete — fall through with default mode */
  }

  const finalMode = opts?.mode ?? mode;
  try {
    const fd = openSync(tmpPath, 'wx', finalMode ?? 0o644);
    try {
      if (finalMode !== null) fchmodSync(fd, finalMode);
      created = fstatSync(fd);
      // Loop until every byte lands: writeSync may legally return a short
      // count under disk pressure/quotas, and a silent short write that
      // truncates AFTER valid frontmatter would pass a frontmatter-only
      // verifier and atomically install truncated content.
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
    opts?.afterStagingFlush?.();
    if (opts?.verify) {
      opts.verify(readFileSync(tmpPath, 'utf-8'));
    }
    renameSync(tmpPath, filePath);
    // Durability of the RENAME itself: fsync the parent directory so a power
    // loss can't silently drop the new directory entry (the target is never
    // corrupt either way — this closes the write-vanished window). Journaled
    // publication (`durable`) needs it; other writers keep it best-effort.
    flushDirectory(dirname(filePath), { bestEffort: !opts?.durable });
  } catch (err) {
    try {
      // A failed exclusive create owns nothing. A callback or another process
      // may also have replaced/changed our stage; never remove those bytes.
      const current = created ? lstatSync(tmpPath) : undefined;
      if (created && current?.isFile() && current.dev === created.dev && current.ino === created.ino
        && current.birthtimeMs === created.birthtimeMs && current.size <= buf.length) {
        const attempted = readFileSync(tmpPath);
        if (attempted.equals(buf.subarray(0, attempted.length))) unlinkSync(tmpPath);
      }
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}
