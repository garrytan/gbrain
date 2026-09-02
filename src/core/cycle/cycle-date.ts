/**
 * #4348 — dream-cycle calendar-date policy.
 *
 * The synthesize phase buckets its summary page (and child provenance) by
 * calendar day. Pre-fix the default was `new Date().toISOString().slice(0,10)`
 * — the UTC day — so a run after local midnight but before UTC midnight
 * rewrote the PREVIOUS day's summary. Resolution order:
 *
 *   explicit --date  >  cycle.timezone config  >  host IANA timezone  >  UTC
 *
 * The host timezone default is the actual fix; `cycle.timezone` is the
 * escape hatch for servers pinned to UTC whose operator lives elsewhere.
 * An invalid configured timezone falls back loudly instead of killing the
 * cycle (config.ts also validates at `gbrain config set` time).
 */

import type { BrainEngine } from '../engine.ts';

export interface ResolveCycleDateOpts {
  explicitDate?: string;
  now?: () => Date;
  systemTimeZone?: () => string | undefined;
  warn?: (message: string) => void;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

/** UTC date projection retained for source-date fallbacks and legacy pages. */
export function utcDate(instant = new Date()): string {
  return instant.toISOString().slice(0, 10);
}

function formatDateInTimeZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(value => value.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Resolve the calendar date that owns one dream-cycle run. */
export async function resolveCycleDate(
  engine: Pick<BrainEngine, 'getConfig'>,
  opts: ResolveCycleDateOpts = {},
): Promise<string> {
  if (opts.explicitDate) return opts.explicitDate;
  const configured = (await engine.getConfig('cycle.timezone'))?.trim();
  const instant = opts.now?.() ?? new Date();
  const systemTimeZone = opts.systemTimeZone?.()
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'UTC';

  if (configured) {
    try {
      return formatDateInTimeZone(instant, configured);
    } catch {
      const fallback = (() => {
        try {
          formatDateInTimeZone(instant, systemTimeZone);
          return systemTimeZone;
        } catch {
          return 'UTC';
        }
      })();
      (opts.warn ?? (message => process.stderr.write(`${message}\n`)))(
        `[dream] invalid cycle.timezone "${configured}"; using ${fallback}`,
      );
      return formatDateInTimeZone(instant, fallback);
    }
  }

  try {
    return formatDateInTimeZone(instant, systemTimeZone);
  } catch {
    return formatDateInTimeZone(instant, 'UTC');
  }
}
