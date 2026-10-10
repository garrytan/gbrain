/**
 * Whether a directory is positively NOT inside a Git checkout, decided from
 * the filesystem alone (fix wave 12, W1.1 / #6210; shared with the writer
 * manifest scope check).
 *
 * Git's own "not a git repository" answer is exit 128 with locale-dependent
 * stderr, and exit 128 also means a damaged HEAD, a bad gitdir file or a
 * refused ("dubious ownership") checkout. Callers that turn "not a checkout"
 * into a softer outcome (durability not enabled, hash the plain tree) must
 * not inherit those failures, so this reads only the filesystem:
 *
 * - `not_git`: no `.git` entry (directory or gitdir file) at the directory or
 *   any ancestor below the first world-writable ancestor owned by someone else
 *   (POSIX). Git refuses a repository found there ("dubious ownership"), and
 *   any local user can plant one in a shared directory such as `/tmp` (CSO G3).
 *   An inherited `GIT_DIR` is not trusted: every Git spawn drops it
 *   (`git-env.ts`, CSO G4), so it can't make a plain directory a checkout.
 * - `git`: a `.git` entry exists at or above the directory, within that
 *   boundary; whether Git can use it is the Git probe's question.
 * - `unknown`: the directory itself is missing or not a directory, or a
 *   lookup failed for any reason other than absence (EACCES, ELOOP, I/O).
 *   Callers treat it like a failed Git probe.
 *
 * Git can stop discovery earlier (GIT_CEILING_DIRECTORIES, a filesystem
 * boundary); this reports `git` there and the Git probe then fails, which
 * callers treat as unavailable: fail closed, never "not a checkout".
 */
import { lstatSync, statSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type GitCheckoutClass = 'git' | 'not_git' | 'unknown';

export function classifyGitCheckout(dir: string, stat: (path: string) => Pick<Stats, 'uid' | 'mode' | 'isDirectory'> = statSync): GitCheckoutClass {
  let current = resolve(dir);
  let owner: number;
  try {
    const start = stat(current);
    if (!start.isDirectory()) return 'unknown';
    owner = start.uid;
  } catch {
    return 'unknown';
  }
  for (;;) {
    try {
      lstatSync(join(current, '.git'));
      return 'git';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return 'unknown';
    }
    const parent = dirname(current);
    if (parent === current) return 'not_git';
    current = parent;
    if (process.platform === 'win32') continue;
    try {
      const ancestor = stat(current);
      if (ancestor.uid !== owner && (ancestor.mode & 0o002) !== 0) return 'not_git';
    } catch {
      return 'unknown';
    }
  }
}
