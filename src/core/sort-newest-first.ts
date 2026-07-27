/**
 * Sort brain paths newest-first by lexicographic descending.
 *
 * Brain paths are date-prefixed by convention (meetings/2026-05-13-*,
 * daily/2026-05-13.md), so descending lex order naturally prioritizes recent
 * content. For non-date-prefixed paths (concepts/, wiki/, people/, etc.) the
 * order is deterministic but reverse-alphabetical — there is no salience
 * signal to optimize for there, but consistency keeps logs and progress
 * output predictable across runs.
 *
 * Mutates in place AND returns the same array, so callers can chain or
 * just rely on the side effect:
 *
 *   sortNewestFirst(allFiles);          // mutate-only
 *   const sorted = sortNewestFirst(xs); // chain
 *
 * Used at `import.ts` (full directory walk) and `sync.ts` (git-diff
 * addsAndMods). The same helper at both call sites keeps the policy in
 * one place; future ordering changes flip one line.
 */
export function sortNewestFirst(paths: string[]): string[] {
  return paths.sort((a, b) => b.localeCompare(a));
}
