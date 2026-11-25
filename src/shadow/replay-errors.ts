/**
 * The error registry of shadow capture (docs/guides/shadow-capture.md#errors). Each code names what
 * happened, the fix, what the failed command already changed and whether a retry is safe. Fatal command errors exit
 * non-zero with one stderr line. None of these touches the brain.
 */
export interface ReplayErrorInfo { what: string; fix: string; changed: string; retry: 'safe' | 'after_fix' | 'never' }

export const REPLAY_ERRORS = {
  shadow_capture_off: { what: 'The capture command was not understood.', fix: 'Use engine shadow capture on --yes, off, status or delete --yes.', changed: 'nothing', retry: 'after_fix' },
  shadow_replay_purged: { what: 'A purge happened, a purge\'s deletion is not finished, or the purge log cannot be read (a purge capture cannot see), so the recordings and copies it covers were deleted and nothing was replayed or recorded.', fix: 'Nothing after a purge: the next run seeds a new epoch from the purged brain. If the purge log is unreadable, make it a readable file owned by the brain\'s user; if a deletion is unfinished, rerun.', changed: 'deleted the recordings and copies the purge covers', retry: 'safe' },
  shadow_replay_no_epoch: { what: 'The replay child was started without its run directory.', fix: 'Nothing: only the nightly replay starts the child.', changed: 'nothing', retry: 'never' },
  shadow_replay_seed_failed: { what: 'The brain could not be opened for the seed (nothing was retired), or seeding failed (the new epoch was invalidated and its partial copies deleted).', fix: 'On a PGLite brain stop resident serve or MCP processes for the run; otherwise read the stderr cause, fix it, rerun.', changed: 'nothing, or deleted the partial copies', retry: 'after_fix' },
  shadow_replay_postgres_unavailable: { what: 'postgres replay arm not in this release.', fix: `Unset ${'GBRAIN_SHADOW_REPLAY_POSTGRES_URL'}; replay runs on PGLite and Rust.`, changed: 'nothing', retry: 'after_fix' },
  shadow_replay_network_blocked: { what: 'A replayed call tried to open a network connection; the replay child blocks every network connection.', fix: 'Nothing: the call is reported as uncomparable.', changed: 'nothing', retry: 'never' },
  shadow_replay_addon_unavailable: { what: 'The Rust engine addon is not installed or does not match this release.', fix: 'Install the addon for this release (or set GBRAIN_RUST_ENGINE_ADDON to a build), then rerun.', changed: 'nothing', retry: 'after_fix' },
  shadow_replay_budget: { what: 'The replay ran past its time budget and was stopped; its work copies were deleted.', fix: 'Raise --budget-minutes or replay on a quieter night.', changed: 'deleted the run\'s work copies', retry: 'safe' },
  shadow_replay_key_invalid: { what: 'The per-brain hash key (capture/key) is empty, short or not hex, so no report or summary was written (its hashes would be guessable).', fix: 'Delete capture/key (the next run writes a new one; earlier summaries become incomparable), then rerun.', changed: 'nothing', retry: 'after_fix' },
  shadow_replay_busy: { what: 'Another replay holds the lock for this brain, or a crashed replay left its lock behind.', fix: 'Wait for the running replay to end. For a stale lock (the message says so: its process is gone and its deadline passed), remove the lock file it names, then rerun.', changed: 'nothing', retry: 'after_fix' },
} as const satisfies Record<string, ReplayErrorInfo>;

export type ReplayErrorCode = keyof typeof REPLAY_ERRORS;

export class ReplayError extends Error {
  constructor(readonly code: ReplayErrorCode, readonly detail: string) {
    super(`${code}: ${REPLAY_ERRORS[code].what} (${detail}) Fix: ${REPLAY_ERRORS[code].fix}`);
  }
}
