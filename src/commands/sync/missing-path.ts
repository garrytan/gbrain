/** `sync --all --missing-path`: classify sources whose checkout is absent here. */

/** Mode for `sync --all --missing-path`: what to do when a source's
 * local_path does not exist on this machine. */
export type MissingPathMode = 'fail' | 'skip';

/**
 * Parse `--missing-path <fail|skip>` (default: fail).
 *
 * Why the flag exists: `sources.local_path` is machine-specific state in a
 * brain-wide table. Any brain whose sources were registered from more than
 * one machine — or a sanctioned setup mid-migration (topologies.md Topology 2,
 * or the system-of-record git flow before every repo is cloned here) — has
 * sources whose checkout simply is not present on the machine running
 * `sync --all`. Each used to surface as a hard failure ("Not a git
 * repository: <path>") and force rc=1 on every run; on one observed fleet
 * that was 12 phantom failures per hour, which trains operators to ignore
 * the exit code.
 *
 * The DEFAULT stays `fail`: on a single-machine brain a missing local_path
 * usually means an unmounted volume or a deleted checkout, and silently
 * skipping it would hide real data loss. Skip is an explicit opt-in.
 *
 * Throws on a bad/absent value with a paste-ready hint (caller converts to
 * stderr + exit 2, same as other flag-misuse exits).
 */
export function parseMissingPathMode(args: string[]): MissingPathMode {
  const idx = args.indexOf('--missing-path');
  if (idx === -1) return 'fail';
  const val = args[idx + 1];
  if (val === 'fail' || val === 'skip') return val;
  throw new Error(
    `--missing-path expects 'fail' or 'skip', got: ${val ?? '(nothing)'}. ` +
    `Use \`--missing-path skip\` to classify sources whose local_path is not ` +
    `present on this machine as skipped instead of failed, or \`--missing-path ` +
    `fail\` (the default) to keep them loud.`,
  );
}

/**
 * Partition `--all` sources by whether their local_path exists on THIS
 * machine. Classification is driven only by the injected predicate so tests
 * never touch the filesystem. A null local_path passes through as runnable —
 * pure-DB sources are already excluded from `--all` by the
 * `local_path IS NOT NULL` SELECT; this is defensive, not load-bearing.
 */
export function partitionMissingPathSources<T extends { local_path: string | null }>(
  sources: T[],
  pathExists: (p: string) => boolean,
): { runnable: T[]; missing: T[] } {
  const runnable: T[] = [];
  const missing: T[] = [];
  for (const s of sources) {
    if (s.local_path != null && !pathExists(s.local_path)) missing.push(s);
    else runnable.push(s);
  }
  return { runnable, missing };
}
