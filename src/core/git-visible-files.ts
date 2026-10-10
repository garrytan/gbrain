import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'child_process';
import { lstatSync } from 'fs';
import { join, resolve } from 'path';

interface GitScope {
  listings: Map<string, string | null>;
  /** Directories git reported outside any repository. */
  outside: Set<string>;
}

const gitScope = new AsyncLocalStorage<GitScope>();

/**
 * Run `fn` with `git ls-files` listings memoized per directory and arguments
 * for every `gitLsFiles` call inside it, plus the "not a git repository"
 * verdict per directory. Doctor wraps its check run in one so the checks that
 * each list or probe the same source checkout (frontmatter scan, fence census,
 * slug collisions, the frontmatter hook) spawn git once instead of once per
 * check; code outside the scope always spawns. A git command that changes a
 * repository through sync-git.ts drops the scope's memo
 * (`invalidateGitListingCache`).
 */
export function withGitListingCache<T>(fn: () => Promise<T>): Promise<T> {
  return gitScope.run({ listings: new Map(), outside: new Set() }, fn);
}

/** Drop every listing and verdict memoized in the current scope (no-op outside one): call after changing a checkout inside it. */
export function invalidateGitListingCache(): void {
  const scope = gitScope.getStore();
  scope?.listings.clear();
  scope?.outside.clear();
}

/** True when the current scope already saw git report `dir` outside any repository. */
export function knownOutsideGitRepo(dir: string): boolean {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- resolve() only normalizes a memo key for a directory git already ran in; nothing is read or written at the path
  return gitScope.getStore()?.outside.has(resolve(dir)) ?? false;
}

/** Record a failed git command run in `dir`: its stderr saying "not a git repository" is remembered for the current scope. */
export function noteGitFailure(dir: string, error: unknown): void {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- resolve() only normalizes a memo key for a directory git already ran in; nothing is read or written at the path
  if (/not a git repository/i.test(String(stderr ?? ''))) gitScope.getStore()?.outside.add(resolve(dir));
}

/** `git -C <dir> ls-files <args>` stdout, or null when git fails (memoized inside withGitListingCache). */
export function gitLsFiles(dir: string, args: string[]): string | null {
  const cache = gitScope.getStore()?.listings;
  const key = `${dir}\0${args.join('\0')}`;
  if (cache?.has(key)) return cache.get(key)!;
  let stdout: string | null = null;
  if (!knownOutsideGitRepo(dir)) {
    try {
      stdout = execFileSync('git', ['-C', dir, 'ls-files', ...args], {
        encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      noteGitFailure(dir, error);
    }
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
