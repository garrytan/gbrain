/**
 * Spend-gate constants for `gbrain dream retriage` (#4152, outside-voice C12).
 * Split from dream-retriage.ts so tests can pin them without importing the
 * command's engine-bearing module graph. The chars→tokens ratio lives in
 * synthesize.ts (`CHARS_PER_TOKEN`, exported) — the command imports it from
 * there so the two estimates can't drift.
 */

/** Estimated sweeps above this ask for confirmation unless --yes. */
export const SPEND_CONFIRM_USD = 5;

/** When the model has no CANONICAL_PRICING entry, gate on file count instead. */
export const UNPRICED_CONFIRM_FILES = 500;
