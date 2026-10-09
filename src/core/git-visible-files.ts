import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'child_process';
import { lstatSync } from 'fs';
import { join } from 'path';

const listingCache = new AsyncLocalStorage<Map<string, string | null>>();

/**
 * Run `fn` with `git ls-files` listings memoized per directory and arguments
 * for every `gitLsFiles` call inside it. Doctor wraps its check run in one so
 * the checks that each list the same source checkout (frontmatter scan, fence
 * census, slug collisions) spawn git once per listing instead of once per
 * check; code outside the scope always spawns.
 */
export function withGitListingCache<T>(fn: () => Promise<T>): Promise<T> {
  return listingCache.run(new Map(), fn);
}

/** `git -C <dir> ls-files <args>` stdout, or null when git fails (memoized inside withGitListingCache). */
export function gitLsFiles(dir: string, args: string[]): string | null {
  const cache = listingCache.getStore();
  const key = `${dir}\0${args.join('\0')}`;
  if (cache?.has(key)) return cache.get(key)!;
  let stdout: string | null;
  try {
    stdout = execFileSync('git', ['-C', dir, 'ls-files', ...args], {
      encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    stdout = null;
  }
  cache?.set(key, stdout);
  return stdout;
}

/**
 * Return files visible to git from `dir`, respecting .gitignore,
 * .git/info/exclude, and global git excludes. Returns null when `dir` is not
 * inside a git work tree or git is unavailable, so callers can keep their
 * existing filesystem-walk fallback.
 */
export function collectGitVisibleFiles(
  dir: string,
  acceptRelPath: (relPath: string) => boolean,
): string[] | null {
  const stdout = gitLsFiles(dir, ['--cached', '--others', '--exclude-standard', '-z']);
  if (stdout === null) return null;

  const ignoredTracked = new Set<string>();
  for (const rel of (gitLsFiles(dir, ['-ci', '--exclude-standard', '-z']) ?? '').split('\0')) {
    if (rel) ignoredTracked.add(rel);
  }

  const files: string[] = [];
  for (const rel of stdout.split('\0')) {
    if (!rel) continue;
    if (ignoredTracked.has(rel)) continue;
    const normalizedRel = rel.replace(/\\/g, '/');
    if (!acceptRelPath(normalizedRel)) continue;

    const full = join(dir, rel);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    files.push(full);
  }

  return files.sort();
}
