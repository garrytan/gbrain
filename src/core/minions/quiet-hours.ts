/**
 * Quiet-hours gate for Minions — evaluated at claim time, not dispatch.
 *
 * The codex correction from the CEO review: dispatch-time gating is wrong
 * because a job queued outside a quiet window can become claimable during
 * the window. Claim-time enforcement is correct: every time the worker
 * asks "can I run this now?", we re-check against the current wall clock.
 *
 * Wall clock comes from Intl.DateTimeFormat with the job's configured tz
 * (IANA). The gate returns one of:
 *   - 'allow'   — job can run
 *   - 'skip'    — job is inside a `skip`-policy quiet window; drop it
 *   - 'defer'   — job is inside a `defer`-policy quiet window; re-queue
 *
 * Pure function: no engine, no side effects. Worker consumes the verdict.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuietHoursConfig {
  /** 0-23; window starts at this local hour inclusive. */
  start: number;
  /** 0-23; window ends at this local hour exclusive. */
  end: number;
  /** IANA timezone, e.g. "America/Los_Angeles". */
  tz: string;
  /** 'skip' drops the event; 'defer' re-queues for later. Default: 'defer'. */
  policy?: 'skip' | 'defer';
}

export type QuietHoursVerdict = 'allow' | 'skip' | 'defer';

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Evaluate a quiet-hours config against a reference wall time. Returns
 * 'allow' when `now` is outside the configured window, or 'skip'/'defer'
 * according to policy when inside.
 *
 * Windows may wrap midnight: `{start: 22, end: 7}` means 10pm–7am next
 * morning. The comparator handles both straight-line and wrap-around
 * windows.
 */
export function evaluateQuietHours(
  cfg: QuietHoursConfig | null | undefined,
  now: Date = new Date(),
): QuietHoursVerdict {
  if (!cfg) return 'allow';
  if (!isValidConfig(cfg)) return 'allow';

  const hour = localHour(now, cfg.tz);
  if (hour === null) return 'allow'; // unknown tz → fail-open; safer than hard-blocking every job

  const inWindow = cfg.start <= cfg.end
    ? hour >= cfg.start && hour < cfg.end
    : hour >= cfg.start || hour < cfg.end; // wrap-around

  if (!inWindow) return 'allow';
  return cfg.policy === 'skip' ? 'skip' : 'defer';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidConfig(cfg: QuietHoursConfig): boolean {
  if (!Number.isInteger(cfg.start) || cfg.start < 0 || cfg.start > 23) return false;
  if (!Number.isInteger(cfg.end) || cfg.end < 0 || cfg.end > 23) return false;
  if (cfg.start === cfg.end) return false; // zero-width window is ambiguous
  if (typeof cfg.tz !== 'string' || cfg.tz.length === 0) return false;
  return true;
}

/** Return the hour (0-23) of `when` in the given IANA timezone, or null. */
export function localHour(when: Date, tz: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      hour: 'numeric',
    }).formatToParts(when);
    const hh = parts.find(p => p.type === 'hour')?.value ?? '';
    // en-US hour12:false yields '24' for midnight in some Node/Bun versions
    const n = parseInt(hh, 10);
    if (!Number.isFinite(n)) return null;
    return n % 24;
  } catch {
    return null;
  }
}
