/**
 * Deterministic time-expression grammar shared by the query time-range
 * parser (search/time-range.ts) and content date extraction
 * (event-dates.ts). No LLM, no network: a fixed set of English patterns
 * resolved against a reference day.
 *
 * Precision over recall. A phrase resolves only when it names a time
 * explicitly ("last month", "two weeks ago", "in June", "March 15th",
 * "last Saturday", "in 2022"). Vague or question-shaped phrases ("how many
 * months ago", "how long", "recently", "currently") resolve to nothing, and
 * so do weekday or month words inside quotes or used as plurals
 * ("Turbocharged Tuesdays").
 *
 * All dates are calendar days (YYYY-MM-DD, UTC arithmetic on whole days);
 * ranges are inclusive. Weeks run Monday to Sunday.
 */

export interface DayRange {
  start: string;
  end: string;
}

export interface TimeMention extends DayRange {
  /** The matched text, as written. */
  cue: string;
  /** Character offset of the match in the input. */
  index: number;
  /** relative = resolved against the reference day; absolute = the text names the date. */
  kind: 'relative' | 'absolute';
  /** A bare month or weekday whose year/week was chosen by direction, not stated. */
  qualified: boolean;
}

export type Direction = 'past' | 'future' | 'either';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR: Record<string, number> = {};
MONTHS.forEach((m, i) => { MONTH_ABBR[m] = i; MONTH_ABBR[m.slice(0, 3)] = i; });
MONTH_ABBR.sept = 8;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SEASONS: Record<string, [number, number]> = { spring: [2, 4], summer: [5, 7], fall: [8, 10], autumn: [8, 10], winter: [11, 1] };
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, couple: 2, 'a couple of': 2, 'a few': 3, few: 3, several: 3,
};

const DAY_MS = 86_400_000;

export function toDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

export function addDays(day: string, n: number): string {
  return toDay(new Date(parseDay(day).getTime() + n * DAY_MS));
}

function ymd(y: number, m: number, d: number): string {
  return toDay(new Date(Date.UTC(y, m, d)));
}

function monthRange(y: number, m: number): DayRange {
  return { start: ymd(y, m, 1), end: ymd(y, m + 1, 0) };
}

function weekStart(day: string): string {
  const dow = parseDay(day).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

function isRealDay(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m && t.getUTCDate() === d;
}

/** Spans inside straight or curly quotes; mentions there are names, not times. */
function quotedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /(["“'‘])([^"”'’\n]{1,80})(["”'’])/g;
  for (const m of text.matchAll(re)) {
    const open = m[1];
    const close = m[3];
    const pair = (open === '"' && close === '"') || (open === '“' && close === '”') || (open === "'" && close === "'") || (open === '‘' && close === '’');
    if (!pair) continue;
    if (open === "'" && /\w/.test(text[(m.index ?? 0) - 1] ?? '')) continue;
    spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  return spans;
}

function inSpans(i: number, spans: Array<[number, number]>): boolean {
  return spans.some(([a, b]) => i >= a && i < b);
}

function numberValue(raw: string): number | null {
  const v = raw.toLowerCase().trim();
  if (/^\d{1,3}$/.test(v)) return parseInt(v, 10);
  return NUMBER_WORDS[v] ?? null;
}

const NUM = String.raw`(\d{1,3}|a couple of|a few|couple of|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|an?)`;
const MONTH_RE = String.raw`(january|february|march|april|may|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?`;
const WEEKDAY_RE = String.raw`(monday|tuesday|wednesday|thursday|friday|saturday|sunday)`;

interface Rule {
  re: RegExp;
  resolve: (m: RegExpMatchArray, ref: string, dir: Direction) => (DayRange & { kind: 'relative' | 'absolute'; qualified?: boolean }) | null;
}

/** Most recent (past) / next (future) occurrence of month `m` relative to ref; `either` keeps past. */
function pickYearForMonth(m: number, ref: string, dir: Direction): { year: number; qualified: boolean } {
  const r = parseDay(ref);
  const y = r.getUTCFullYear();
  const rm = r.getUTCMonth();
  if (dir === 'future') return { year: m >= rm ? y : y + 1, qualified: true };
  return { year: m <= rm ? y : y - 1, qualified: true };
}

const RULES: Rule[] = [
  // ISO date 2023-05-20 / 2023/05/20
  { re: /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g, resolve: (m) => {
    const y = +m[1]; const mo = +m[2] - 1; const d = +m[3];
    if (!isRealDay(y, mo, d) || y < 1900 || y > 2199) return null;
    const day = ymd(y, mo, d);
    return { start: day, end: day, kind: 'absolute' };
  } },
  // March 15th, 2023 / March 15 / 15 March 2023 / the 15th of March
  { re: new RegExp(String.raw`\b${MONTH_RE}\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`, 'gi'), resolve: (m, ref, dir) => {
    const mo = MONTH_ABBR[m[1].toLowerCase()]; const d = +m[2];
    if (mo === undefined || d < 1 || d > 31) return null;
    let year: number; let qualified = false;
    if (m[3]) year = +m[3];
    else { ({ year } = pickYearForMonth(mo, ref, dir)); qualified = true; }
    if (!isRealDay(year, mo, d)) return null;
    const day = ymd(year, mo, d);
    return { start: day, end: day, kind: m[3] ? 'absolute' : 'relative', qualified };
  } },
  { re: new RegExp(String.raw`\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_RE}(?:,?\s+(\d{4}))?\b`, 'gi'), resolve: (m, ref, dir) => {
    const d = +m[1]; const mo = MONTH_ABBR[m[2].toLowerCase()];
    if (mo === undefined || d < 1 || d > 31) return null;
    let year: number; let qualified = false;
    if (m[3]) year = +m[3];
    else { ({ year } = pickYearForMonth(mo, ref, dir)); qualified = true; }
    if (!isRealDay(year, mo, d)) return null;
    const day = ymd(year, mo, d);
    return { start: day, end: day, kind: m[3] ? 'absolute' : 'relative', qualified };
  } },
  // between March and April / in March and April / from March to April
  { re: new RegExp(String.raw`\b(?:between|in|during|from)\s+${MONTH_RE}\s+(?:and|to|through|-)\s+${MONTH_RE}(?:,?\s+(\d{4}))?\b`, 'gi'), resolve: (m, ref, dir) => {
    const a = MONTH_ABBR[m[1].toLowerCase()]; const b = MONTH_ABBR[m[2].toLowerCase()];
    if (a === undefined || b === undefined) return null;
    const yb = m[3] ? +m[3] : pickYearForMonth(b, ref, dir).year;
    const ya = a <= b ? yb : yb - 1;
    return { start: monthRange(ya, a).start, end: monthRange(yb, b).end, kind: m[3] ? 'absolute' : 'relative', qualified: !m[3] };
  } },
  // in/during/of/last/this <Month> [year]
  { re: new RegExp(String.raw`\b(in|during|of|since|by|last|this|early|mid|late)\s+(?:early\s+|mid\s+|late\s+)?${MONTH_RE}(?:,?\s+(\d{4}))?\b`, 'gi'), resolve: (m, ref, dir) => {
    const mo = MONTH_ABBR[m[2].toLowerCase()];
    if (mo === undefined) return null;
    if (m[1].toLowerCase() === 'since' || m[1].toLowerCase() === 'by') return null;
    if (m[3]) return { ...monthRange(+m[3], mo), kind: 'absolute' };
    const lead = m[1].toLowerCase();
    if (lead === 'this') return { ...monthRange(parseDay(ref).getUTCFullYear(), mo), kind: 'relative', qualified: true };
    const { year } = pickYearForMonth(mo, ref, lead === 'last' ? 'past' : dir);
    return { ...monthRange(year, mo), kind: 'relative', qualified: true };
  } },
  // Month YYYY (no preposition)
  { re: new RegExp(String.raw`\b${MONTH_RE}\s+(\d{4})\b`, 'gi'), resolve: (m) => {
    const mo = MONTH_ABBR[m[1].toLowerCase()];
    if (mo === undefined) return null;
    return { ...monthRange(+m[2], mo), kind: 'absolute' };
  } },
  // a capitalized bare month name ("the June deadline"); "May" needs a preposition (modal verb)
  { re: /\b(January|February|March|April|June|July|August|September|October|November|December)\b/g, resolve: (m, ref, dir) => {
    const mo = MONTH_ABBR[m[1].toLowerCase()];
    const { year } = pickYearForMonth(mo, ref, dir);
    return { ...monthRange(year, mo), kind: 'relative', qualified: true };
  } },
  // in 2022 / during 2022
  { re: /\b(?:in|during|throughout)\s+((?:19|20|21)\d{2})\b(?!\s*(?:%|kg|km|mi|\$))/gi, resolve: (m) => {
    const y = +m[1];
    return { start: ymd(y, 0, 1), end: ymd(y, 11, 31), kind: 'absolute' };
  } },
  // Q3 2022
  { re: /\bQ([1-4])\s*(?:of\s+)?((?:19|20|21)\d{2})\b/gi, resolve: (m) => {
    const q = +m[1] - 1; const y = +m[2];
    return { start: ymd(y, q * 3, 1), end: ymd(y, q * 3 + 3, 0), kind: 'absolute' };
  } },
  // yesterday / today / tonight / last night / tomorrow
  { re: /\b(yesterday|today|tonight|last night|this morning|this afternoon|this evening|tomorrow)\b/gi, resolve: (m, ref) => {
    const w = m[1].toLowerCase();
    const offset = w === 'yesterday' || w === 'last night' ? -1 : w === 'tomorrow' ? 1 : 0;
    const day = addDays(ref, offset);
    return { start: day, end: day, kind: 'relative' };
  } },
  // last/this/next week|weekend|month|year ; the past week|weekend|month|year
  { re: /\b(last|this|next|the past|this past|the last|in the past|over the past|during the past)\s+(week|weekend|month|year)\b/gi, resolve: (m, ref) => {
    const lead = m[1].toLowerCase(); const unit = m[2].toLowerCase();
    const r = parseDay(ref); const y = r.getUTCFullYear(); const mo = r.getUTCMonth();
    const rolling = /past|the last/.test(lead) && lead !== 'this past';
    if (unit === 'weekend') {
      const ws = weekStart(ref);
      const thisSat = addDays(ws, 5);
      if (lead === 'next') return { start: addDays(thisSat, 7), end: addDays(thisSat, 8), kind: 'relative' };
      if (lead === 'this') return { start: thisSat, end: addDays(thisSat, 1), kind: 'relative' };
      const dow = r.getUTCDay();
      const sat = dow === 6 || dow === 0 ? (dow === 6 ? addDays(ref, -7) : addDays(ref, -8)) : addDays(thisSat, -7);
      return { start: sat, end: addDays(sat, 1), kind: 'relative' };
    }
    if (rolling) {
      const days = unit === 'week' ? 7 : unit === 'month' ? 30 : 365;
      return { start: addDays(ref, -days), end: ref, kind: 'relative' };
    }
    if (unit === 'week') {
      const ws = weekStart(ref);
      if (lead === 'next') return { start: addDays(ws, 7), end: addDays(ws, 13), kind: 'relative' };
      if (lead === 'this') return { start: ws, end: addDays(ws, 6), kind: 'relative' };
      return { start: addDays(ws, -7), end: addDays(ws, -1), kind: 'relative' };
    }
    if (unit === 'month') {
      if (lead === 'next') return { ...monthRange(y, mo + 1), kind: 'relative' };
      if (lead === 'this') return { ...monthRange(y, mo), kind: 'relative' };
      return { ...monthRange(y, mo - 1), kind: 'relative' };
    }
    if (lead === 'next') return { start: ymd(y + 1, 0, 1), end: ymd(y + 1, 11, 31), kind: 'relative' };
    if (lead === 'this') return { start: ymd(y, 0, 1), end: ymd(y, 11, 31), kind: 'relative' };
    return { start: ymd(y - 1, 0, 1), end: ymd(y - 1, 11, 31), kind: 'relative' };
  } },
  // last/this/next <season>
  { re: /\b(last|this|next|in the|this past)\s+(spring|summer|fall|autumn|winter)\b/gi, resolve: (m, ref, dir) => {
    const lead = m[1].toLowerCase(); const [a, b] = SEASONS[m[2].toLowerCase()];
    const r = parseDay(ref); const y = r.getUTCFullYear(); const mo = r.getUTCMonth();
    const span = (startYear: number) => ({ start: ymd(startYear, a, 1), end: b < a ? ymd(startYear + 1, b + 1, 0) : ymd(startYear, b + 1, 0) });
    const containing = a <= b ? (mo >= a && mo <= b ? y : null) : (mo >= a ? y : mo <= b ? y - 1 : null);
    const lastCompleted = () => { let sy = a <= b ? y : y - 1; for (let i = 0; i < 3; i++) { const s = span(sy); if (s.end < ref) return s; sy -= 1; } return span(sy); };
    if (lead === 'this') return { ...(containing !== null ? span(containing) : lastCompleted()), kind: 'relative', qualified: true };
    if (lead === 'next') { let sy = a <= b ? y : y; for (let i = 0; i < 3; i++) { const s = span(sy); if (s.start > ref) return { ...s, kind: 'relative', qualified: true }; sy += 1; } return null; }
    if (lead === 'in the' && dir === 'future') return null;
    return { ...lastCompleted(), kind: 'relative', qualified: true };
  } },
  // last <weekday> / this past <weekday>
  { re: new RegExp(String.raw`\b(last|this past|this|next|on)\s+${WEEKDAY_RE}\b(?!s)`, 'gi'), resolve: (m, ref, dir) => {
    const lead = m[1].toLowerCase(); const target = WEEKDAYS.indexOf(m[2].toLowerCase());
    const dow = parseDay(ref).getUTCDay();
    if (lead === 'next') { const ahead = ((target - dow + 7) % 7) || 7; const day = addDays(ref, ahead); return { start: day, end: day, kind: 'relative' }; }
    if (lead === 'on' || lead === 'this') {
      if (dir === 'future') { const ahead = (target - dow + 7) % 7; const day = addDays(ref, ahead); return { start: day, end: day, kind: 'relative', qualified: true }; }
      const back = (dow - target + 7) % 7; const day = addDays(ref, -back); return { start: day, end: day, kind: 'relative', qualified: true };
    }
    const back = ((dow - target + 7) % 7) || 7;
    const day = addDays(ref, -back);
    return { start: day, end: day, kind: 'relative' };
  } },
  // N days/weeks/months/years ago ; (the <weekday>) N units ago
  { re: new RegExp(String.raw`\b(?:(?:the|a)\s+${WEEKDAY_RE}\s+)?${NUM}\s+(day|week|month|year)s?\s+ago\b`, 'gi'), resolve: (m, ref) => {
    const n = numberValue(m[2]); if (n === null || n <= 0) return null;
    const unit = m[3].toLowerCase();
    const fuzzy = /few|couple|several/i.test(m[2]);
    if (unit === 'day') { const c = addDays(ref, -n); const s = fuzzy ? 1 : 0; return { start: addDays(c, -s - 1), end: addDays(c, s + 1), kind: 'relative' }; }
    if (unit === 'week') { const c = addDays(ref, -7 * n); return { start: addDays(c, -3), end: addDays(c, 3), kind: 'relative' }; }
    if (unit === 'month') {
      const r = parseDay(ref);
      const c = toDay(new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() - n, Math.min(r.getUTCDate(), 28))));
      const w = m[1] ? 7 : 15;
      return { start: addDays(c, -w), end: addDays(c, w), kind: 'relative' };
    }
    const y = parseDay(ref).getUTCFullYear() - n;
    return { start: ymd(y, 0, 1), end: ymd(y, 11, 31), kind: 'relative' };
  } },
  // in N days/weeks (future)
  { re: new RegExp(String.raw`\bin\s+${NUM}\s+(day|week|month)s?\b(?!\s+ago)`, 'gi'), resolve: (m, ref, dir) => {
    if (dir === 'past') return null;
    const n = numberValue(m[1]); if (n === null || n <= 0) return null;
    const unit = m[2].toLowerCase();
    const c = addDays(ref, unit === 'day' ? n : unit === 'week' ? 7 * n : 30 * n);
    const s = unit === 'day' ? 1 : unit === 'week' ? 3 : 15;
    return { start: addDays(c, -s), end: addDays(c, s), kind: 'relative' };
  } },
];

/**
 * Question shapes that ask for the length of an interval ("how long…", "how many
 * days ago / passed / before…"), where a mentioned date is an endpoint, not the
 * evidence window. Counting inside a window ("how many days did I spend camping
 * this year") still resolves.
 */
const NON_RANGE_QUESTION = /\bhow\s+long\b|\bhow\s+(?:many|much)\s+(?:days?|weeks?|months?|years?|time)\s+(?:ago|passed|elapsed|before|after|since|between|until|had|have|has|were|was|is|are)\b/i;

/**
 * Every explicit time mention in `text`, resolved against `ref`. Overlapping
 * matches keep the longest (first on ties). `dir` resolves bare months and
 * weekdays toward the past (content written about what happened), the future,
 * or past by default for `either`.
 */
export function findTimeMentions(text: string, ref: string, dir: Direction = 'past'): TimeMention[] {
  const quotes = quotedSpans(text);
  const found: TimeMention[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const index = m.index ?? 0;
      if (inSpans(index, quotes)) continue;
      const r = rule.resolve(m, ref, dir);
      if (!r || r.start > r.end) continue;
      found.push({ start: r.start, end: r.end, cue: m[0].trim(), index, kind: r.kind, qualified: r.qualified ?? false });
    }
  }
  found.sort((a, b) => a.index - b.index || b.cue.length - a.cue.length);
  const kept: TimeMention[] = [];
  for (const f of found) {
    const prev = kept[kept.length - 1];
    if (prev && f.index < prev.index + prev.cue.length) {
      if (f.cue.length > prev.cue.length) kept[kept.length - 1] = f;
      continue;
    }
    kept.push(f);
  }
  return kept;
}

/** True when the text asks "how long / how many days" — a duration, not a window. */
export function asksForDuration(text: string): boolean {
  return NON_RANGE_QUESTION.test(text);
}
