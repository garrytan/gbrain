import type { SearchOpts } from '../types.ts';

export function resolveDateBoundary(raw: string | undefined, boundary: 'since' | 'until'): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  const rel = /^(\d+)\s*([dwmy])$/i.exec(s);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const days = unit === 'd' ? n : unit === 'w' ? n * 7 : unit === 'm' ? n * 30 : n * 365;
    return new Date(Date.now() - days * 86400000).toISOString();
  }
  // Only ISO-8601 is accepted: Date.parse also reads strings such as "May 5"
  // (Bun: 2001-05-05) that the database cast then rejects.
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/i.exec(s);
  if (!iso) {
    throw new Error(`Invalid ${boundary} value "${s}" — expected ISO-8601 (YYYY-MM-DD or timestamp) or a relative duration like '7d', '2w', '1y'.`);
  }
  const date = iso[1];
  const day = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== date || date.startsWith('0000-')) {
    throw new Error(`Invalid ${boundary} date: expected a real calendar date.`);
  }
  if (s === date) return boundary === 'until' ? `${date}T23:59:59.999Z` : date;
  if (!Number.isFinite(Date.parse(s.replace(' ', 'T')))) {
    throw new Error(`Invalid ${boundary} value "${s}" — expected ISO-8601 (YYYY-MM-DD or timestamp) or a relative duration like '7d', '2w', '1y'.`);
  }
  return s;
}

export function resolveSearchDateBounds(opts?: SearchOpts): Pick<SearchOpts, 'afterDate' | 'beforeDate' | 'afterDateInclusive' | 'beforeDateInclusive'> {
  const afterDate = resolveDateBoundary(opts?.since ?? opts?.afterDate, 'since');
  let beforeDate = resolveDateBoundary(opts?.until ?? opts?.beforeDate, 'until');
  let beforeDateInclusive = opts?.until !== undefined ? true : opts?.beforeDateInclusive;
  const untilDay = opts?.until?.trim();
  if (untilDay && /^\d{4}-\d{2}-\d{2}$/.test(untilDay)) {
    const nextDay = new Date(`${untilDay}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    beforeDate = nextDay.toISOString();
    beforeDateInclusive = false;
  }
  return {
    afterDate,
    beforeDate,
    afterDateInclusive: opts?.since !== undefined ? true : opts?.afterDateInclusive,
    beforeDateInclusive,
  };
}
