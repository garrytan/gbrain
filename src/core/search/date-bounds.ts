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
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const day = new Date(`${s}T00:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== s || s.startsWith('0000-')) {
      throw new Error(`Invalid ${boundary} date: expected a real calendar date.`);
    }
    return boundary === 'until' ? `${s}T23:59:59.999Z` : s;
  }
  if (Number.isFinite(Date.parse(s))) return s;
  throw new Error(`Invalid ${boundary} value "${s}" — expected ISO-8601 (YYYY-MM-DD or timestamp) or a relative duration like '7d', '2w', '1y'.`);
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
