/**
 * check_claims (agent-platform C3): checks the number-bearing claims in a draft against the allowed-claims pages the
 * caller can read. Deterministic, no model call: a claim is a sentence holding a number (an ISO date is not one), and an
 * allowed claim is a dated line (`- 2026-01-01: 12 paying customers. Source: billing export.`) on a page with
 * type: facts and claims: allowed.
 *
 * Per claim:
 *   supported  a line shares one of its numbers and at least one content word, and no newer line about the same thing
 *              says a different number (the newest supporting line is cited);
 *   conflicts  a line about the same thing (it shares content words) says a different number, or a newer one does;
 *   not_found  no allowed line covers it. That means "no allowed claim covers this", never "this is false".
 *
 * A sentence with several numbers is checked number by number, each with the words of its own clause: supported only
 * when every number is, conflicts when any number is contradicted, otherwise not_found. Every number is checked, a year
 * included, so a skipped number can never let a contradicted one read as supported. A percent
 * never matches a plain number, digits inside a word (Q3) are not numbers, and a comma between digits ($2,100,000) is
 * a thousands separator, not a clause break.
 */

export interface AllowedLine { slug: string; source_id: string; line: number; date: string; text: string }
export interface ClaimCheck {
  claim: string;
  status: 'supported' | 'conflicts' | 'not_found';
  cited?: AllowedLine;
  conflicting?: AllowedLine[];
}

interface Num { value: number; unit: string }

const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const NUMBER = /([$€£])?\s?(?<![A-Za-z0-9_])(\d[\d,]*(?:\.\d+)?)\s?(%|percent\b|k\b|m\b|bn\b|b\b|thousand\b|million\b|billion\b)?/gi;
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };
const DATED_LINE = /^\s*(?:[-*]\s+)?(\d{4}-\d{2}-\d{2})\s*[:\u2013\u2014-]\s*(.+)$/;
const STOPWORDS = new Set(('the and for with that this from have has had our are was were will been about into than then they them their '
  + 'you your per each every over under more less most least now not but all any its it\'s which who whom what when where how').split(' '));
const MAX_CONFLICTS = 3;

function numbers(text: string): Num[] {
  const out: Num[] = [];
  for (const m of text.replace(ISO_DATE, ' ').matchAll(NUMBER)) {
    const raw = Number(m[2]!.replace(/,/g, ''));
    if (!Number.isFinite(raw)) continue;
    const suffix = m[3]?.toLowerCase();
    const unit = m[1] ? 'currency' : suffix === '%' || suffix === 'percent' ? 'percent' : '';
    out.push({ value: raw * (suffix ? SCALE[suffix] ?? 1 : 1), unit });
  }
  return out;
}

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().replace(ISO_DATE, ' ').match(/[a-z][a-z'-]+/g) ?? []) {
    if (w.length < 3 || STOPWORDS.has(w) || w in SCALE || w === 'percent') continue;
    out.add(w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  }
  return out;
}

const sameNumber = (a: Num, b: Num) => Math.abs(a.value - b.value) <= 1e-9 * Math.max(Math.abs(a.value), Math.abs(b.value))
  && (a.unit === b.unit || ((a.unit === '' || b.unit === '') && a.unit !== 'percent' && b.unit !== 'percent'));

/** The sentences of a draft that hold a number, trimmed. */
export function extractClaims(text: string): string[] {
  return text.split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9$€£])/)
    .map(s => s.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim())
    .filter(s => s.length > 0 && numbers(s).length > 0);
}

/** The dated lines of an allowed-claims page body. */
export function allowedLines(page: { slug: string; source_id: string; body: string }): AllowedLine[] {
  const out: AllowedLine[] = [];
  page.body.split('\n').forEach((line, i) => {
    const m = DATED_LINE.exec(line);
    if (m) out.push({ slug: page.slug, source_id: page.source_id, line: i + 1, date: m[1]!, text: line.trim() });
  });
  return out;
}

export function checkClaim(claim: string, lines: readonly AllowedLine[]): ClaimCheck {
  const units = numberClauses(claim).flatMap(part => numbers(part).map(n => ({ part, n })));
  if (units.length < 2) return checkPart(claim, claim, numbers(claim), lines);
  const results = units.map(u => checkPart(claim, u.part, [u.n], lines));
  const conflicting = results.filter(r => r.status === 'conflicts');
  if (conflicting.length) {
    return { claim, status: 'conflicts', conflicting: conflicting.flatMap(r => r.conflicting ?? []).slice(0, MAX_CONFLICTS) };
  }
  return results.every(r => r.status === 'supported') ? { claim, status: 'supported', cited: results[0]!.cited } : { claim, status: 'not_found' };
}

/**
 * A sentence with two or more numbers, split so each number is checked with the words of its own clause; a clause with
 * no number joins the next one. One number: the whole sentence.
 */
function numberClauses(claim: string): string[] {
  if (numbers(claim).length < 2) return [claim];
  const out: string[] = [];
  let pending = '';
  for (const clause of claim.split(/(?<!\d),\s*|,(?!\d)\s*|;\s*|\s+(?:and|but|while|whereas)\s+/i)) {
    pending = pending ? `${pending} ${clause}` : clause;
    if (numbers(clause).length) { out.push(pending); pending = ''; }
  }
  if (pending && out.length) out[out.length - 1] += ` ${pending}`;
  return out;
}

function checkPart(claim: string, part: string, claimNums: readonly Num[], lines: readonly AllowedLine[]): ClaimCheck {
  const claimWords = words(part);
  const need = Math.min(2, claimWords.size);
  const scored = lines.map(l => {
    const body = l.text.replace(/\bsource:.*$/i, '');
    const lineWords = words(body);
    const overlap = [...claimWords].filter(w => lineWords.has(w)).length;
    const lineNums = numbers(body);
    return { l, overlap, shares: claimNums.some(c => lineNums.some(n => sameNumber(c, n))), numbered: lineNums.length > 0 };
  });
  const newestFirst = (a: typeof scored[number], b: typeof scored[number]) => b.l.date.localeCompare(a.l.date) || b.overlap - a.overlap;
  const support = scored.filter(s => s.shares && s.overlap >= 1).sort((a, b) => b.overlap - a.overlap || b.l.date.localeCompare(a.l.date))[0];
  const related = need === 0 ? [] : scored.filter(s => !s.shares && s.numbered && s.overlap >= need).sort(newestFirst);
  if (support) {
    const newer = related.filter(s => s.l.date > support.l.date && s.overlap >= support.overlap);
    return newer.length
      ? { claim, status: 'conflicts', cited: support.l, conflicting: newer.slice(0, MAX_CONFLICTS).map(s => s.l) }
      : { claim, status: 'supported', cited: support.l };
  }
  if (related.length) return { claim, status: 'conflicts', conflicting: related.slice(0, MAX_CONFLICTS).map(s => s.l) };
  return { claim, status: 'not_found' };
}
