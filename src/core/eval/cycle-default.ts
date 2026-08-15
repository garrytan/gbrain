/**
 * v0.42.11.0 (#1784) — single source of truth for the eval cycle-count default.
 *
 * Several eval commands (`eval cross-modal`, `eval takes-quality run/regress`)
 * and the takes-quality runner core resolved their cycle default as
 * `process.stdout.isTTY ? 3 : 1`. The non-TTY value of 1 is a deliberate
 * cost-conservative default (each cycle calls frontier models), but the split
 * was SILENT — a subagent / pipe / cron run got 1 with nothing explaining why,
 * which is the surprise issue #1784 names.
 *
 * The fix is NOT a new stderr notice line — those commands already print the
 * resolved cycle count in their existing banner. Instead, callers ANNOTATE that
 * existing banner via `cycleDefaultSuffix` when the value came from the non-TTY
 * default, so the operator sees `cycles: 1 (non-interactive default; --cycles N
 * for more)` instead of a bare `cycles: 1`.
 *
 * The runner CORE (`takes-quality-eval/runner.ts`) consumes only
 * `DEFAULT_CYCLES_NONTTY` — library code stays TTY-agnostic; the CLI layer owns
 * the TTY=3 upgrade + the banner annotation.
 *
 * Deliberately NOT shared with `resolveWorkersWithClamp` (sync-concurrency.ts):
 * different domain, no engine, no per-process dedup. Sharing would be premature.
 */

/** Interactive (TTY) default: deeper eval, more model calls. */
export const DEFAULT_CYCLES_TTY = 3;

/** Non-interactive (pipe / cron / subagent) default: cost-conservative. */
export const DEFAULT_CYCLES_NONTTY = 1;

export interface CycleResolution {
  /** The effective cycle count. */
  cycles: number;
  /**
   * True ONLY when no explicit value was given AND we are non-TTY — i.e. the
   * caller fell through to `DEFAULT_CYCLES_NONTTY`. This is the case worth
   * annotating in the banner so the 1-vs-3 difference isn't silent.
   */
  usedNonTtyDefault: boolean;
}

/**
 * Resolve the cycle count from an explicit value + TTY-ness.
 *
 *   explicit set  → {explicit, false}        (caller asked; no annotation)
 *   undefined+TTY → {3, false}               (interactive default; visible live)
 *   undefined+!TTY→ {1, true}                (cost-safe default; ANNOTATE)
 */
export function resolveCycleDefault(
  explicit: number | undefined,
  isTty: boolean,
): CycleResolution {
  if (explicit !== undefined) return { cycles: explicit, usedNonTtyDefault: false };
  if (isTty) return { cycles: DEFAULT_CYCLES_TTY, usedNonTtyDefault: false };
  return { cycles: DEFAULT_CYCLES_NONTTY, usedNonTtyDefault: true };
}

/**
 * Banner suffix to append to an EXISTING stderr line that already prints the
 * cycle count. Empty string unless the non-TTY default was applied, so the
 * common (TTY or explicit) cases get no extra text.
 */
export function cycleDefaultSuffix(r: CycleResolution): string {
  return r.usedNonTtyDefault ? ' (non-interactive default; --cycles N for more)' : '';
}
