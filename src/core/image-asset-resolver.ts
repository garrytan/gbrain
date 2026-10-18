/**
 * #6543 D3: resolves a recorded image path (`pages.source_path`, `files.storage_path`, or the lower-cased slug) to the
 * file under one source root. Shared by doctor `image_assets` and the `embed --stale --images` sweep.
 *
 * - The exact recorded path wins (candidates in order).
 * - Otherwise a bounded case-insensitive walk (one memoised `readdir` per path segment) finds the file and returns
 *   its real-case source-relative path, so the import and the recorded `source_path` use the case on disk.
 * - Two entries that fold to the same segment refuse as `ambiguous`; nothing is chosen.
 * - Containment is checked separately on the real path: a symlink that leaves the root is `outside_root`, and an
 *   absolute or `..` candidate is never joined. Only the given root is read, so one source never resolves another's file.
 */
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';

export type RecordedImageFile =
  | { status: 'found'; abs: string; relative: string; caseMismatch: boolean }
  | { status: 'missing'; tried: string }
  | { status: 'ambiguous'; tried: string; matches: string[] }
  | { status: 'outside_root'; tried: string };

/** Directory listings read so far (`null`: unreadable); pass one map across a sweep so each directory is read once. */
export type DirectoryListings = Map<string, string[] | null>;

export function resolveRecordedImageFile(root: string, candidates: Array<string | null | undefined>, listings: DirectoryListings = new Map()): RecordedImageFile {
  const paths = [...new Set(candidates.filter((path): path is string => !!path))]
    .filter(path => !isAbsolute(path) && !path.split(/[\\/]/).includes('..'));
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- absolute and `..` candidates were dropped above; containment is re-checked on the real path
  const tried = join(root, paths[0] ?? '');
  let realRoot: string | null = null;
  const contained = (abs: string): boolean => {
    try {
      realRoot ??= realpathSync(root);
      const real = realpathSync(abs);
      return real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
    } catch { return false; }
  };
  const found = (relative: string, caseMismatch: boolean): RecordedImageFile => {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- a filtered candidate or entries read from the root's own directories
    const abs = join(root, relative);
    return contained(abs) ? { status: 'found', abs, relative, caseMismatch } : { status: 'outside_root', tried: abs };
  };
  for (const relative of paths) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- filtered candidate under the source root
    if (existsSync(join(root, relative))) return found(relative, false);
  }
  for (const relative of paths) {
    const real: string[] = [];
    let directory = root;
    for (const segment of relative.split(/[\\/]/).filter(Boolean)) {
      if (!listings.has(directory)) {
        try { listings.set(directory, readdirSync(directory)); } catch { listings.set(directory, null); }
      }
      const hits = (listings.get(directory) ?? []).filter(entry => entry.toLowerCase() === segment.toLowerCase());
      if (hits.length > 1) return { status: 'ambiguous', tried: join(root, relative), matches: hits.map(hit => [...real, hit].join('/')) };
      if (hits.length === 0) { real.length = 0; break; }
      real.push(hits[0]!);
      directory = join(directory, hits[0]!);
    }
    if (real.length) return found(real.join('/'), real.join('/') !== relative);
  }
  return { status: 'missing', tried };
}
