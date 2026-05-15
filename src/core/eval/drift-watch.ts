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

/**
 * Return repo-relative paths that have changed in the working tree since
 * the given commit (or HEAD if no commit). Best-effort: returns [] when
 * git is unavailable, the repo lacks the commit, or any other failure.
 *
 * `commitSha` is a full or short SHA. When omitted, compares HEAD against
 * working tree (uncommitted changes only).
 */
export function filesDriftedSince(repoRoot: string, commitSha?: string): string[] {
  if (!existsSync(repoRoot)) return [];
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
    return [];
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
): string[] {
  return filesDriftedSince(repoRoot, commitSha).filter((p) => matchesWatchPattern(p, patterns));
}
