export interface TemporalWindow {
  startMs: number | null;
  endMs: number | null;
}

export class TemporalWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemporalWindowError';
  }
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;

function parseBound(raw: string, end: boolean, label: string): number {
  const value = raw.trim();
  const day = DAY.exec(value);
  if (day) {
    const [, year, month, date] = day;
    const ms = Date.UTC(+year, +month - 1, +date, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0);
    const parsed = new Date(ms);
    if (parsed.getUTCFullYear() !== +year || parsed.getUTCMonth() !== +month - 1 || parsed.getUTCDate() !== +date) {
      throw new TemporalWindowError(`THINK_INVALID_WINDOW: ${label} is not a real calendar date: "${raw}"`);
    }
    return ms;
  }
  const month = MONTH.exec(value);
  if (month) {
    const [, year, number] = month;
    if (+number < 1 || +number > 12) {
      throw new TemporalWindowError(`THINK_INVALID_WINDOW: ${label} has an invalid month: "${raw}"`);
    }
    return end
      ? Date.UTC(+year, +number, 0, 23, 59, 59, 999)
      : Date.UTC(+year, +number - 1, 1);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new TemporalWindowError(`THINK_INVALID_WINDOW: ${label} is not a parseable date: "${raw}"`);
  }
  return ms;
}

export function parseTemporalWindow(since?: string | null, until?: string | null): TemporalWindow | null {
  const lower = since?.trim();
  const upper = until?.trim();
  if (!lower && !upper) return null;
  const startMs = lower ? parseBound(lower, false, 'since') : null;
  const endMs = upper ? parseBound(upper, true, 'until') : null;
  if (startMs !== null && endMs !== null && startMs > endMs) {
    throw new TemporalWindowError(`THINK_INVALID_WINDOW: since (${since}) is after until (${until})`);
  }
  return { startMs, endMs };
}

export interface DatedPage { slug?: string; effective_date?: string | Date | null }

export function resolvePageDateMs(page: DatedPage): number | null {
  const value = page.effective_date;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'string' && value.trim()) {
    const day = DAY.exec(value.trim());
    if (day) return Date.UTC(+day[1], +day[2] - 1, +day[3], 12);
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  const match = page.slug?.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const ms = Date.UTC(+match[1], +match[2] - 1, +match[3], 12);
  const parsed = new Date(ms);
  return parsed.getUTCFullYear() === +match[1] && parsed.getUTCMonth() === +match[2] - 1 && parsed.getUTCDate() === +match[3]
    ? ms : null;
}

export function filterPagesToWindow<T extends DatedPage>(pages: T[], window: TemporalWindow) {
  const kept: T[] = [];
  let droppedOutOfWindow = 0;
  let undatedKept = 0;
  for (const page of pages) {
    const ms = resolvePageDateMs(page);
    if (ms === null) { undatedKept++; kept.push(page); continue; }
    if ((window.startMs !== null && ms < window.startMs) || (window.endMs !== null && ms > window.endMs)) {
      droppedOutOfWindow++;
    } else kept.push(page);
  }
  return { kept, droppedOutOfWindow, undatedKept };
}
