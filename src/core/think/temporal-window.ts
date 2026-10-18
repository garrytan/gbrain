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
    if (day) {
      const parsed = new Date(12 * 3600_000); // setUTCFullYear, not Date.UTC: Date.UTC maps years 0-99 to 1900-1999
      parsed.setUTCFullYear(+day[1], +day[2] - 1, +day[3]);
      return parsed.getUTCFullYear() === +day[1] && parsed.getUTCMonth() === +day[2] - 1 && parsed.getUTCDate() === +day[3]
        ? parsed.getTime() : null;
    }
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

// PR #5086 (@tarush1989), wave 14 P3.17: a window from exactly one explicit date in the question.
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_NAME_YEAR = new RegExp(`\\b(${MONTH_NAMES.join('|')})\\s+(\\d{4})\\b`, 'gi');

/**
 * The one explicit date a question names, as `since`/`until` bounds spanning it: an ISO day (`2026-09-15`), an ISO
 * month (`2026-09`) or an English month name with a four-digit year ("September 2026"). Fail closed to null on
 * anything else: no token, a bare year ("in 2026", "GPT-4"), two or more distinct tokens (a range the caller must
 * spell out), a token `parseTemporalWindow` refuses (`2026-13`, `2026-02-30`), a relative phrase ("next week").
 * Deterministic: no clock, no timezone.
 */
export function parseQuestionWindow(question: string | null | undefined): { since: string; until: string } | null {
  if (typeof question !== 'string' || !question) return null;
  const tokens = new Set<string>();
  for (const m of question.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) tokens.add(m[1]);
  for (const m of question.matchAll(/\b(\d{4}-\d{2})\b(?!-\d)/g)) tokens.add(m[1]);
  for (const m of question.matchAll(MONTH_NAME_YEAR)) tokens.add(`${m[2]}-${String(MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}`);
  if (tokens.size !== 1) return null;
  const [token] = tokens;
  try { parseTemporalWindow(token, token); } catch { return null; }
  return { since: token, until: token };
}

export interface ResolvedThinkWindow {
  window: TemporalWindow;
  /** Who bounded the synthesis: the caller's `since`/`until`, or the one explicit date the question named. */
  source: 'caller' | 'question';
  since: string | undefined;
  until: string | undefined;
}

/** `runThink`'s window: a caller bound is authoritative (and still validated); only when both are absent does the question's one explicit date apply. */
export function resolveThinkWindow(question: string, since?: string | null, until?: string | null): ResolvedThinkWindow | null {
  const caller = parseTemporalWindow(since, until);
  if (caller) return { window: caller, source: 'caller', since: since?.trim() || undefined, until: until?.trim() || undefined };
  const derived = parseQuestionWindow(question);
  if (!derived) return null;
  return { window: parseTemporalWindow(derived.since, derived.until)!, source: 'question', ...derived };
}
