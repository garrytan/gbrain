/**
 * #6696 C7: the `--only` / `--skip` path matcher of `gbrain repair file-drift`. A pattern with no `*` is an exact
 * source-relative path, as every other kind's `--only` is; a pattern with `*` is a glob (`*` within one path segment,
 * `**` across segments, `?` one character, sync's `matchesAnyGlob`). File-drift is the only kind that takes globs;
 * another kind adopts them by calling this helper.
 */
import { matchesAnyGlob } from '../sync.ts';

export function matchesRepairPath(path: string, patterns: readonly string[] | undefined): boolean {
  return (patterns ?? []).some(pattern => pattern.includes('*') ? matchesAnyGlob(path, [pattern]) : path === pattern);
}
