/**
 * The error registry of shadow capture and replay (docs/guides/shadow-replay.md#errors). Each code names what
 * happened, the fix, what the failed command already changed and whether a retry is safe. Fatal command errors exit
 * non-zero with one stderr line; per-call engine errors during a replay are report outcomes, not command failures.
 * Cleanup after any of these touches only paths the replay owns (its run directory, its work copies, its scratch
 * database), never the brain or a recording.
 */
export interface ReplayErrorInfo { what: string; fix: string; changed: string; retry: 'safe' | 'after_fix' | 'never' }

export const REPLAY_ERRORS = {
  shadow_capture_off: { what: 'Capture is off, so there is nothing to replay.', fix: 'Turn capture on (engine shadow capture on --yes), restart resident brain processes, and wait one night.', changed: 'nothing', retry: 'after_fix' },
  shadow_replay_no_epoch: { what: 'No recording epoch with seeded copies exists yet; this run started one.', fix: 'Nothing: the next nightly run replays it.', changed: 'started an epoch and seeded its copies', retry: 'safe' },
  shadow_replay_seed_failed: { what: 'Seeding the copies failed; the new epoch was invalidated and its partial copies deleted.', fix: 'Read the stderr cause, fix it, rerun; the next run starts a new epoch.', changed: 'deleted the partial copies', retry: 'after_fix' },
  shadow_replay_purged: { what: 'The purge log changed (or cannot be read) since the epoch began, so its recording and copies were deleted and nothing was replayed.', fix: 'Nothing: the next run seeds a new epoch from the purged brain. If the purge log is unreadable, make it a readable file owned by the brain\'s user.', changed: 'deleted the epoch\'s recording and copies', retry: 'safe' },
  shadow_replay_postgres_not_local: { what: 'The scratch Postgres URL could send rows off this machine (a host other than localhost or a Unix socket, several hosts, or a host override).', fix: `Point ${'GBRAIN_SHADOW_REPLAY_POSTGRES_URL'} at a database on this machine, or unset it to run without the Postgres arm.`, changed: 'nothing; no row was sent', retry: 'after_fix' },
  shadow_replay_postgres_not_owned: { what: 'The scratch database holds tables a replay did not create, or is the brain itself.', fix: 'Create an empty database for the replay and point the variable at it.', changed: 'nothing', retry: 'after_fix' },
  shadow_replay_postgres_privilege: { what: 'The scratch role cannot reset its own database schema or create the vector extension.', fix: 'Give the scratch role ownership of its database and the right to create the vector extension there (not on the brain).', changed: 'nothing on the brain; the scratch database may be empty', retry: 'after_fix' },
  shadow_replay_network_blocked: { what: 'A replayed call tried to open a network connection; the replay child blocks every connection except the local scratch database.', fix: 'Nothing: the call is reported as uncomparable.', changed: 'nothing', retry: 'never' },
  shadow_replay_addon_unavailable: { what: 'The Rust engine addon is not installed or does not match this release.', fix: 'Install the addon for this release (or set GBRAIN_RUST_ENGINE_ADDON to a build), then rerun.', changed: 'nothing', retry: 'after_fix' },
  shadow_replay_busy: { what: 'Another replay is running for this brain.', fix: 'Wait for it to end; a lock older than its budget is stale and is cleared by the next run.', changed: 'nothing', retry: 'safe' },
  shadow_replay_budget: { what: 'The replay ran past its time budget and was stopped; its work copies were deleted.', fix: 'Raise --budget-minutes or replay on a quieter night.', changed: 'deleted the run\'s work copies', retry: 'safe' },
} as const satisfies Record<string, ReplayErrorInfo>;

export type ReplayErrorCode = keyof typeof REPLAY_ERRORS;

export class ReplayError extends Error {
  constructor(readonly code: ReplayErrorCode, readonly detail: string) {
    super(`${code}: ${REPLAY_ERRORS[code].what} (${detail}) Fix: ${REPLAY_ERRORS[code].fix}`);
  }
}
