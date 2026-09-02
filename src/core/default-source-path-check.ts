/**
 * default-source-path-check — detect a null/missing local_path on the
 * `default` source.
 *
 * The `default` source is the implicit write-through target for any unscoped
 * `gbrain put` / `gbrain capture` call that doesn't name a `--source`. If its
 * `local_path` is null, that write-through target is unresolvable from the
 * sources row alone. Reported incident: a brain's `default` source sat with
 * `local_path: null` for months with nothing surfacing it, during which
 * unscoped `gbrain put` calls silently misrouted content into an unrelated
 * source's git repo instead. `gbrain doctor` had no check that would have
 * caught this — the existing multi-source-drift check (#1881/D8/D17)
 * deliberately excludes the `default` source from its own local_path
 * filtering (it detects content misrouted INTO default, not default's own
 * config), so a null `default.local_path` was invisible to every doctor run.
 *
 * Pure assessment helper (no DB/FS access — caller supplies the row) so
 * `gbrain doctor` can warn with receipts, in the same shape as
 * npm-squat-check.ts / pglite-leftovers-check.ts.
 */
export interface DefaultSourcePathAssessment {
  status: 'skip' | 'ok' | 'warn';
  message: string;
}

export function assessDefaultSourcePath(
  defaultSource: { id: string; local_path: string | null } | undefined,
): DefaultSourcePathAssessment {
  if (!defaultSource) {
    // No `default` row at all is a different, more fundamental problem than
    // this check's scope — leave it to whatever check owns sources-table
    // integrity.
    return { status: 'skip', message: '' };
  }
  if (defaultSource.local_path) {
    return {
      status: 'ok',
      message: `default source local_path is set: ${defaultSource.local_path}`,
    };
  }
  return {
    status: 'warn',
    message:
      'default source has local_path: null. Unscoped `gbrain put`/`gbrain capture` calls ' +
      '(no --source given) write through this source — with no local_path set, that write-' +
      "through target is unresolvable from this row and writes can silently misroute into " +
      'another source\'s repo. Fix with `gbrain sources set-path default <path>`.',
  };
}
