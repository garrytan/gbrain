/**
 * v0.32.3 — curated drift-watch list for the eval_drift doctor check.
 *
 * Per [CDX-6]: a "search code changed since last eval" warning needs a
 * precise definition. Too narrow (e.g. only src/core/search/) misses real
 * regressions like a chunker change. Too wide (every file) trains the
 * operator to ignore the warning.
 *
 * The curated allowlist below names every file whose change MEANINGFULLY
 * affects retrieval quality. Adding to this list REQUIRES a CHANGELOG line
 * so coverage grows deliberately.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * Glob-ish patterns watched for retrieval drift. Each pattern is matched
 * against repo-relative paths via simple `startsWith` semantics (no real
 * glob expansion) so the matcher is fast + dependency-free.
 *
 * If you add a pattern: also add a CHANGELOG line documenting why.
 */
export const RETRIEVAL_WATCH_PATTERNS: ReadonlyArray<string> = Object.freeze([
  // Search pipeline core
  'src/core/search/',
  // Embedding shape (changing dim or chunker shape moves every result)
  'src/core/embedding.ts',
  // Chunkers (recursive + semantic + LLM-guided) — chunk granularity is retrieval
  'src/core/chunkers/',
  // AI recipes that drive expansion / embedding choices
  'src/core/ai/recipes/anthropic.ts',
  'src/core/ai/recipes/openai.ts',
  // The query op itself
  'src/core/operations.ts',
]);

/** Path equality / prefix matcher for the curated list. */
export function matchesWatchPattern(path: string, patterns: ReadonlyArray<string> = RETRIEVAL_WATCH_PATTERNS): boolean {
  for (const p of patterns) {
    // Trailing-slash pattern = directory prefix
    if (p.endsWith('/')) {
      if (path.startsWith(p)) return true;
    } else {
      // Bare-file pattern = exact equality
      if (path === p) return true;
    }
  }
  return false;
}

/** Files that mark a gbrain source checkout (vs an installed package or compiled binary). */
const CHECKOUT_MARKERS = ['src/cli.ts', 'skills/RESOLVER.md', '.git'] as const;

/**
 * Locate the gbrain SOURCE CHECKOUT this module was loaded from, or null
 * when gbrain is running as an installed package (no `.git`) or a compiled
 * binary (virtual `/$bunfs/` URL). The drift check only means something
 * against a checkout: an installed CLI has no git diff to inspect.
 */
export function resolveGbrainSourceRoot(moduleUrl: string = import.meta.url): string | null {
  try {
    let dir = dirname(fileURLToPath(moduleUrl));
    for (let i = 0; i < 10; i++) {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- dir walks up from this module's own file URL (import.meta.url), never from user input; the markers are literals
      if (CHECKOUT_MARKERS.every((marker) => existsSync(join(dir, marker)))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Non-file: module URL (bundler / compiled binary) — not a checkout.
  }
  return null;
}

/**
 * Return repo-relative paths that have changed in the working tree since
 * the given commit (or HEAD if no commit). Returns `null` when the probe
 * itself failed (repo root missing, git unavailable, not a work tree,
 * timeout) so callers never mistake "could not check" for "clean".
 *
 * `commitSha` is a full or short SHA. When omitted, compares HEAD against
 * working tree (uncommitted changes only).
 */
export function filesDriftedSince(repoRoot: string, commitSha?: string): string[] | null {
  if (!existsSync(repoRoot)) return null;
  try {
    const range = commitSha ? `${commitSha}..HEAD` : 'HEAD';
    const args = commitSha
      ? ['diff', '--name-only', range]
      : ['diff', '--name-only', 'HEAD'];
    const out = execSync(`git ${args.join(' ')}`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return out
      .split('\n')
      .map(s => s.trim())
      .filter((s): s is string => s.length > 0);
  } catch {
    return null;
  }
}

/**
 * Identify only the changed files that match the retrieval watch list.
 * Convenience wrapper for the doctor check + future CI gate.
 */
export function watchedFilesDrifted(
  repoRoot: string,
  commitSha?: string,
  patterns: ReadonlyArray<string> = RETRIEVAL_WATCH_PATTERNS,
): string[] | null {
  const files = filesDriftedSince(repoRoot, commitSha);
  return files === null ? null : files.filter((p) => matchesWatchPattern(p, patterns));
}
