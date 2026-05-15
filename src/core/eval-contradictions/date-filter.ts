/**
 * eval-contradictions/date-filter — A1 three-rule date pre-filter.
 *
 * Goal: skip the obvious quarterly-update case (Acme MRR $50K in 2024 vs
 * Acme MRR $2M in 2026) before paying for an LLM judge call. Without this,
 * timeline-shaped content dominates judge calls and inflates cost on a
 * brain with lots of /daily/, /meetings/, or quarterly snapshots.
 *
 * Codex flagged the naive rule ("both have dates AND dates differ → skip")
 * as too blunt: "Alice is CFO in Jan / Alice is not CFO in Mar" is a real
 * contradiction-or-update that the pre-filter must NOT silently kill. So
 * the rules layer:
 *
 *   1. BOTH chunks contain explicit YYYY-like dates AND the dates differ
 *      by more than DATE_SEPARATION_DAYS → SKIP (the obvious case).
 *   2. EITHER chunk lacks an explicit date → DO NOT skip; let judge decide.
 *   3. SAME paragraph in either chunk contains two distinct dates → DO NOT
 *      skip; this is the flip-flop case ("in Jan I said X, in Mar I said not-X"
 *      written in a single paragraph). Judge sees it.
 *
 * The detector is intentionally conservative. False negatives (NOT skipping
 * when we could have) cost LLM tokens. False positives (skipping a real
 * contradiction) cost the whole point of the probe. Errs toward FN.
 */

const DATE_SEPARATION_DAYS = 30;

/**
 * Permissive date matcher. Recognized shapes (priority order):
 *   YYYY-MM-DD                    → groups 1,2,3
 *   YYYY/MM/DD                    → groups 4,5,6
 *   Mon DD YYYY (e.g. Jan 15 2024) → groups 7 (month), 8 (day), 9 (year)
 *   Mon YYYY    (e.g. Jan 2024)    → groups 10 (month), 11 (year)
 *   Q1-4 YYYY                     → group 12
 *   bare YYYY                     → group 13
 *
 * The Mon-DD-YYYY alternative must come BEFORE Mon-YYYY so we capture the day
 * when it's present. Bare YYYY comes last to avoid stealing the year from a
 * fuller pattern.
 */
const DATE_REGEX =
  /\b(?:(\d{4})-(\d{2})-(\d{2})|(\d{4})\/(\d{2})\/(\d{2})|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+(\d{1,2}),?\s+(\d{4})|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+(\d{4})|Q[1-4]\s+(\d{4})|(\d{4}))\b/g;

const MONTH_INDEX: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

export interface DateFilterDecision {
  skip: boolean;
  reason:
    | 'both_explicit_separated'
    | 'one_or_both_missing_dates'
    | 'same_paragraph_dual_date'
    | 'overlapping_or_close';
}

export interface DateFilterInput {
  textA: string;
  textB: string;
}

/** Extract date tokens from text. Returns parsed Date objects (UTC midnight). */
export function extractDates(text: string): Date[] {
  if (!text) return [];
  const dates: Date[] = [];
  // Reset lastIndex because the regex has the /g flag and is reused across calls.
  DATE_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATE_REGEX.exec(text)) !== null) {
    const parsed = parseDateMatch(m);
    if (parsed) dates.push(parsed);
  }
  return dates;
}

function parseDateMatch(m: RegExpExecArray): Date | null {
  let year: number;
  let month = 0;
  let day = 1;
  if (m[1] && m[2] && m[3]) {
    // YYYY-MM-DD
    year = +m[1]; month = +m[2] - 1; day = +m[3];
  } else if (m[4] && m[5] && m[6]) {
    // YYYY/MM/DD
    year = +m[4]; month = +m[5] - 1; day = +m[6];
  } else if (m[7] && m[8] && m[9]) {
    // Mon DD YYYY
    year = +m[9]; month = MONTH_INDEX[m[7]] ?? 0; day = +m[8];
  } else if (m[10] && m[11]) {
    // Mon YYYY (no day) — assume first of month
    year = +m[11]; month = MONTH_INDEX[m[10]] ?? 0; day = 1;
  } else if (m[12]) {
    // Q1-4 YYYY
    year = +m[12];
  } else if (m[13]) {
    // bare YYYY
    year = +m[13];
  } else {
    return null;
  }
  if (year < 1900 || year > 2100) return null;
  return new Date(Date.UTC(year, month, day));
}

/**
 * Does any paragraph in the text contain two distinct dates? "Distinct" means
 * dates whose UTC-day differs. A paragraph is split on blank lines.
 */
export function hasSameParagraphDualDate(text: string): boolean {
  if (!text) return false;
  const paragraphs = text.split(/\n\s*\n/);
  for (const p of paragraphs) {
    const dates = extractDates(p);
    if (dates.length < 2) continue;
    const days = new Set(dates.map((d) => Math.floor(d.getTime() / 86400000)));
    if (days.size >= 2) return true;
  }
  return false;
}

/**
 * Return the absolute difference in days between the latest date in A
 * and the latest date in B. Returns Infinity if either side has no dates.
 */
function maxDateSeparationDays(a: Date[], b: Date[]): number {
  if (a.length === 0 || b.length === 0) return Infinity;
  const maxA = Math.max(...a.map((d) => d.getTime()));
  const maxB = Math.max(...b.map((d) => d.getTime()));
  return Math.abs(maxA - maxB) / 86400000;
}

/**
 * The decision function called by the runner. Returns `{ skip, reason }`.
 *
 * Order matters: same-paragraph dual-date wins over the separation rule
 * because flip-flops are exactly what we DO want the judge to see, even
 * when other dates in the chunks are far apart.
 */
export function shouldSkipForDateMismatch(input: DateFilterInput): DateFilterDecision {
  if (
    hasSameParagraphDualDate(input.textA) ||
    hasSameParagraphDualDate(input.textB)
  ) {
    return { skip: false, reason: 'same_paragraph_dual_date' };
  }
  const datesA = extractDates(input.textA);
  const datesB = extractDates(input.textB);
  if (datesA.length === 0 || datesB.length === 0) {
    return { skip: false, reason: 'one_or_both_missing_dates' };
  }
  const sep = maxDateSeparationDays(datesA, datesB);
  if (sep > DATE_SEPARATION_DAYS) {
    return { skip: true, reason: 'both_explicit_separated' };
  }
  return { skip: false, reason: 'overlapping_or_close' };
}
