/**
 * Retrieval Reflex — pure entity-salience extractor (issue #1981, Layer 1).
 *
 * Zero-LLM, zero-DB, SDK-free. Scans ONE turn's user text for candidate entity
 * surface-forms (capitalized token runs, @handles) that are worth resolving
 * against the brain index. The context engine runs this on every turn before
 * touching the brain, so it must be fast (one regex pass) and precision-biased:
 * a false candidate costs a wasted resolve and, worse, a misleading pointer.
 *
 * DELIBERATE v1 limits (documented, not bugs — see issue #1981 / eng-review):
 *   - Proper-case + ASCII biased. Misses lowercase names ("garry") and many
 *     non-Latin scripts.
 *   - Current-user-message only. No pronoun follow-ups ("what about her?"), no
 *     entities the assistant introduced.
 * These are TODOs, not v1 scope. Do NOT market this as full "human-like recall".
 *
 * Resolution (alias/slug lookup) lives in retrieval-reflex.ts; this module only
 * decides WHAT to look up.
 */

import { normalizeAlias } from '../search/alias-normalize.ts';

export interface EntityCandidate {
  /** Surface form for the pointer label, e.g. "Garry Tan" or "@garry". */
  display: string;
  /** Text fed to alias-normalize / slugify for resolution (no leading @, no possessive). */
  query: string;
}

/** Max candidates returned per turn — bounds downstream DB work regardless of pointer cap. */
export const MAX_CANDIDATES = 12;

/**
 * HARD stopwords — function words that are never an entity, even capitalized
 * mid-sentence. Pronouns, articles/determiners, auxiliaries, conjunctions,
 * and the most common sentence openers. Compared in lowercase.
 */
const STOPWORDS = new Set<string>([
  // pronouns
  'i', "i'm", "i've", "i'll", 'you', "you're", 'he', 'she', 'it', "it's", 'we', "we're",
  'they', "they're", 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'their', 'our',
  'mine', 'yours', 'hers', 'theirs', 'ours', 'this', 'that', 'these', 'those', 'who', 'whom',
  // articles / determiners / conjunctions / prepositions (common openers)
  'the', 'a', 'an', 'and', 'or', 'but', 'so', 'if', 'as', 'at', 'by', 'for', 'in', 'of',
  'on', 'to', 'up', 'with', 'from', 'into', 'over', 'than', 'then', 'also', 'just',
  // question words / auxiliaries
  'what', 'when', 'where', 'why', 'how', 'which', 'whose',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'do', 'does', 'did', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being',
  'has', 'have', 'had',
  // greetings / discourse markers / polite openers
  'hi', 'hey', 'hello', 'thanks', 'thank', 'please', 'yes', 'no', 'ok', 'okay', 'sure',
  'maybe', 'well', 'oh', 'let', "let's", 'lets',
]);

/**
 * SOFT common words — frequent non-entity words that DO get capitalized at
 * sentence start. Dropped only when a single-token candidate appears solely at
 * sentence start (and is never seen capitalized mid-sentence, which would be a
 * strong name signal). Weekdays/months/time words live here. Compared lowercase.
 */
const COMMON_WORDS = new Set<string>([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'today', 'tomorrow', 'yesterday', 'now', 'soon', 'later', 'tonight', 'morning',
  'afternoon', 'evening', 'week', 'month', 'year', 'meeting', 'call', 'note', 'task',
  'here', 'there', 'every', 'some', 'any', 'all', 'one', 'two', 'three', 'first', 'last',
  'next', 'new', 'old', 'good', 'bad', 'great', 'nice', 'thing', 'something', 'anything',
]);

const HANDLE_RE = /@([A-Za-z0-9_]{2,})/g;
// Capitalized token runs: an uppercase-initial word, up to 4 tokens total.
// A token allows internal letters/digits/apostrophes/hyphens, plus internal
// dots ONLY when followed by a letter (so "U.S." keeps its dot but a
// sentence-ending "Apple." does NOT glue into the next sentence's word).
const CAP_TOKEN = `\\p{Lu}[\\p{L}0-9'’\\-]*(?:\\.\\p{L}[\\p{L}0-9'’\\-]*)*`;
const CAP_RUN_RE = new RegExp(`${CAP_TOKEN}(?:\\s+${CAP_TOKEN}){0,3}`, 'gu');

/** Strip a trailing possessive ("Garry's" → "Garry", "Jones’" → "Jones"). */
function stripPossessive(s: string): string {
  return s.replace(/['’]s$/i, '').replace(/['’]$/i, '');
}

/** True when the match at `idx` is the first non-space char of the text or a sentence. */
function isAtSentenceStart(text: string, idx: number): boolean {
  let i = idx - 1;
  // skip immediate whitespace
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return true; // start of text
  // sentence-ending punctuation (or a list bullet / opening bracket) precedes
  return /[.!?:;\n\r•\-(["“]/.test(text[i]);
}

function isPureNumber(s: string): boolean {
  return /^[0-9][0-9.,]*$/.test(s);
}

/**
 * Extract candidate entity surface-forms from one turn's text.
 * Deterministic, precision-biased, capped at MAX_CANDIDATES. Deduped on the
 * normalizeAlias() form (so "Garry" and "garry" collapse), first display wins.
 */
export function extractCandidates(text: string): EntityCandidate[] {
  if (!text || typeof text !== 'string') return [];

  // Track, per normalized query, its display + whether it was ever seen
  // capitalized mid-sentence (a strong "this is a real name" signal) and how
  // many tokens it spans.
  interface Acc {
    display: string;
    query: string;
    multiToken: boolean;
    seenMidSentence: boolean;
    order: number;
  }
  const acc = new Map<string, Acc>();
  let order = 0;

  const consider = (rawDisplay: string, rawQuery: string, midSentence: boolean) => {
    const display = rawDisplay.trim();
    const query = stripPossessive(rawQuery.trim());
    if (!query) return;
    const norm = normalizeAlias(query);
    if (!norm) return;
    const existing = acc.get(norm);
    if (existing) {
      if (midSentence) existing.seenMidSentence = true;
      return;
    }
    acc.set(norm, {
      display,
      query,
      multiToken: /\s/.test(query),
      seenMidSentence: midSentence,
      order: order++,
    });
  };

  // 1. @handles — strong signal; resolved as aliases. Display keeps the @.
  for (const m of text.matchAll(HANDLE_RE)) {
    const handle = m[1];
    // handles are intentional references; treat as mid-sentence (never drop on
    // the sentence-start heuristic).
    consider(`@${handle}`, handle, true);
  }

  // 2. Capitalized token runs.
  for (const m of text.matchAll(CAP_RUN_RE)) {
    const surface = m[0];
    const idx = m.index ?? 0;
    consider(surface, surface, !isAtSentenceStart(text, idx));
  }

  // 3. Filter for precision.
  const out: EntityCandidate[] = [];
  for (const c of Array.from(acc.values()).sort((a, b) => a.order - b.order)) {
    const lc = c.query.toLowerCase();
    // Single bare tokens get the strict filters; multi-token runs ("Garry Tan",
    // "Initialized Capital") are inherently high-signal and skip the soft list.
    if (!c.multiToken) {
      if (c.query.length < 2) continue;            // single char
      if (isPureNumber(c.query)) continue;          // "2026"
      if (STOPWORDS.has(lc)) continue;              // hard: never an entity
      // soft: common word AND only seen at sentence start → drop. If it also
      // appeared capitalized mid-sentence, keep it (likely a real name like
      // "Apple" or a person whose name collides with a common word).
      if (COMMON_WORDS.has(lc) && !c.seenMidSentence) continue;
    }
    out.push({ display: c.display, query: c.query });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}
