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

// Question→temporal-window support. Full month names only (no abbreviations,
// no bare year, no "in + year"), matched case-insensitively.
const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Derive a temporal window from EXACTLY ONE unambiguous explicit date token in a
 * free-text question, reusing the shipped
 * `parseTemporalWindow`/`parseBound` contract (this adds no new date semantics).
 *
 * Supported tokens (the ONLY forms; no relative civil-time semantics):
 *   - ISO day     `YYYY-MM-DD`                 → that calendar day
 *   - ISO month   `YYYY-MM`                    → that month
 *   - month-name + 4-digit year (e.g. "September 2026") → that month
 *
 * Fail-closed to null (no invented dates, no silent narrowing): zero tokens,
 * two or more DISTINCT tokens, a bare 4-digit year ("GPT-4 in 2024", "v2026"),
 * or any partial/invalid token (`2026-13`, `2026-9`) all return null. Explicit
 * caller `since`/`until` remain authoritative — the `runThink` call site tries
 * `parseTemporalWindow(since, until)` first and only falls back to this when both
 * are absent. Deterministic (no `now`), so no timezone/DST ambiguity.
 */
export function parseQuestionWindow(question: string | null | undefined): TemporalWindow | null {
  if (typeof question !== 'string' || !question) return null;
  const tokens: string[] = [];
  // ISO day: YYYY-MM-DD.
  for (const m of question.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    tokens.push(`${m[1]}-${m[2]}-${m[3]}`);
  }
  // ISO month: YYYY-MM NOT immediately followed by -DD (so a day token is not
  // double-counted as a month).
  for (const m of question.matchAll(/\b(\d{4})-(\d{2})\b(?!-\d)/g)) {
    tokens.push(`${m[1]}-${m[2]}`);
  }
  // Full month name + 4-digit year, e.g. "September 2026".
  const monthRe = new RegExp(`\\b(${Object.keys(MONTH_NAMES).join('|')})\\s+(\\d{4})\\b`, 'gi');
  for (const m of question.matchAll(monthRe)) {
    const mm = String(MONTH_NAMES[m[1].toLowerCase()]).padStart(2, '0');
    tokens.push(`${m[2]}-${mm}`);
  }
  const distinct = [...new Set(tokens)];
  if (distinct.length !== 1) return null; // zero, or 2+ distinct tokens → ambiguous → null
  try {
    // A single token spans itself: since=token (start), until=token (end).
    return parseTemporalWindow(distinct[0], distinct[0]);
  } catch {
    return null; // partial/invalid (e.g. 2026-13) → null, never throw into synthesis
  }
}

/**
 * The production temporal-window resolver used by `runThink`.
 * Explicit caller `since`/`until` are AUTHORITATIVE; only when BOTH are absent does an
 * explicit date token in the question derive a window. Exported (not an inline `??` at
 * the call site) so the precedence/fallback contract is tested directly and cannot
 * silently drift from production. Pure — no engine, no LLM, no `now`.
 */
export function resolveTemporalWindow(
  question: string | null | undefined,
  since?: string | null,
  until?: string | null,
): TemporalWindow | null {
  return parseTemporalWindow(since, until) ?? parseQuestionWindow(question);
}
