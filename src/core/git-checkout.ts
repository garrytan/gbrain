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
 *   any ancestor, and no `GIT_DIR` in the environment.
 * - `git`: a `.git` entry exists at or above the directory (or `GIT_DIR` is
 *   set); whether Git can use it is the Git probe's question.
 * - `unknown`: the directory itself is missing or not a directory, or a
 *   lookup failed for any reason other than absence (EACCES, ELOOP, I/O).
 *   Callers treat it like a failed Git probe.
 *
 * Git can stop discovery earlier (GIT_CEILING_DIRECTORIES, a filesystem
 * boundary); this reports `git` there and the Git probe then fails, which
 * callers treat as unavailable: fail closed, never "not a checkout".
 */
import { lstatSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type GitCheckoutClass = 'git' | 'not_git' | 'unknown';

export function classifyGitCheckout(dir: string, env: NodeJS.ProcessEnv = process.env): GitCheckoutClass {
  if (env.GIT_DIR) return 'git';
  let current = resolve(dir);
  try {
    if (!statSync(current).isDirectory()) return 'unknown';
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
  }
}
