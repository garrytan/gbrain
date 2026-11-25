/**
 * The error registry of shadow capture (docs/guides/shadow-capture.md#errors). Each code names what
 * happened, the fix, what the failed command already changed and whether a retry is safe. Fatal command errors exit
 * non-zero with one stderr line. None of these touches the brain.
 */
export interface ReplayErrorInfo { what: string; fix: string; changed: string; retry: 'safe' | 'after_fix' | 'never' }

export const REPLAY_ERRORS = {
  shadow_capture_off: { what: 'The capture command was not understood.', fix: 'Use engine shadow capture on --yes, off, status or delete --yes.', changed: 'nothing', retry: 'after_fix' },
  shadow_replay_purged: { what: 'The purge log cannot be read, so no recording starts (a purge may have happened that capture cannot see).', fix: 'Make the purge log a readable file owned by the brain\'s user, then turn capture on again.', changed: 'nothing', retry: 'after_fix' },
  shadow_replay_busy: { what: 'Another replay holds the lock for this brain, or a crashed replay left its lock behind.', fix: 'Wait for the running replay to end. For a stale lock (the message says so: its process is gone and its deadline passed), remove the lock file it names, then rerun.', changed: 'nothing', retry: 'after_fix' },
} as const satisfies Record<string, ReplayErrorInfo>;

export type ReplayErrorCode = keyof typeof REPLAY_ERRORS;

export class ReplayError extends Error {
  constructor(readonly code: ReplayErrorCode, readonly detail: string) {
    super(`${code}: ${REPLAY_ERRORS[code].what} (${detail}) Fix: ${REPLAY_ERRORS[code].fix}`);
  }
}
