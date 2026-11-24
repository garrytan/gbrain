/**
 * Evidence a plain-directory file is gone. A plain directory has no Git history to prove a deletion, so withdrawal acts
 * only on a per-file ENOENT/ENOTDIR: a walk that skipped an unreadable folder, a depth-limited subtree or a flaky
 * network mount is not proof, and an empty root is the shape of a volume that is not mounted, not of deleted notes.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

const GONE = new Set(['ENOENT', 'ENOTDIR']);

/** True when the root holds no visible entry (or cannot be read): withdraw nothing from it. */
export function plainRootLooksEmpty(root: string): boolean {
  try { return readdirSync(root).every(entry => entry.startsWith('.')); } catch { return true; }
}

/**
 * The subset of root-relative `paths` whose file is confirmed absent, or null when any check fails another way
 * (EACCES, EIO, ...), in which case the caller keeps every page. Paths that resolve outside the root are never returned.
 */
export function confirmedMissingPaths(root: string, paths: readonly string[]): Set<string> | null {
  const gone = new Set<string>();
  for (const path of paths) {
    const abs = join(root, path);
    const rel = relative(root, abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    try { lstatSync(abs); } catch (error) {
      if (!GONE.has((error as NodeJS.ErrnoException).code ?? '')) return null;
      gone.add(path);
    }
  }
  return gone;
}
