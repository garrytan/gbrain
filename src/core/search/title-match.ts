/**
 * Title-superstring matching for the T2 title boost (retrieval-maxpool incident).
 *
 * The disease: a query that is literally a phrase from a page's title
 * ("Greek amphitheater" → "The Mingtang — Indoor Greek amphitheater…") matched
 * a weak body chunk instead of being recognized as a title hit. Names of things
 * deserve weight. This module decides, deterministically and with zero I/O,
 * whether a query is a title-phrase match for a page.
 *
 * Guard rails (Codex#10 — avoid promoting generic pages on stopword-y queries):
 *   - require >= MIN_CONTENT_TOKENS non-stopword tokens in the query, OR an
 *     exact normalized full-title match (so a deliberate 1-word title still hits);
 *   - match at TOKEN BOUNDARIES (contiguous token run), never raw substring, so
 *     "art" doesn't match "Bartholomew";
 *   - stopwords ("the", "a", "of", …) don't count toward the content-token floor.
 *
 * Pure + exported so the NamedThingBench eval and unit tests share one definition
 * with the production boost (no drift).
 */

const MIN_CONTENT_TOKENS = 2;

// Small, deliberately conservative English stopword set. CJK has no whitespace
// stopword notion here; CJK queries fall through to the exact-match path.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'with',
  'at', 'by', 'from', 'as', 'is', 'it', 'this', 'that', 'my', 'your',
]);

/**
 * Normalize text to a token array: lowercase, split on any run of
 * non-alphanumeric (Unicode-aware for letters/numbers), drop empties.
 * CJK characters are letters under \p{L}, so a CJK title collapses to one
 * token per contiguous run — fine for the exact-match path.
 */
export function tokenizeTitle(s: string): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Content tokens = tokens that aren't stopwords. */
function contentTokens(tokens: string[]): string[] {
  return tokens.filter(t => !STOPWORDS.has(t));
}

/** True iff `needle` appears as a contiguous token run inside `haystack`. */
function containsTokenRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Decide whether `query` is a title-phrase match for `title`.
 *
 * Returns true when EITHER:
 *   (a) the normalized query token sequence is a contiguous run inside the
 *       normalized title AND the query has >= MIN_CONTENT_TOKENS content tokens; OR
 *   (b) the normalized query equals the full normalized title exactly (covers
 *       deliberate single-word titles / chosen names like "Mingtang").
 *
 * Order-insensitive matching is intentionally NOT done — a title-phrase signal
 * should reflect the author's phrasing, and bag-of-words matching is what the
 * vector/keyword paths already provide.
 */
export function isTitlePhraseMatch(query: string, title: string): boolean {
  const qTokens = tokenizeTitle(query);
  const tTokens = tokenizeTitle(title);
  if (qTokens.length === 0 || tTokens.length === 0) return false;

  // (b) exact full-title match (covers 1-word chosen names).
  if (qTokens.length === tTokens.length && qTokens.every((t, i) => t === tTokens[i])) {
    return true;
  }

  // (a) contiguous phrase match, gated by content-token floor.
  const qContent = contentTokens(qTokens);
  if (qContent.length < MIN_CONTENT_TOKENS) return false;
  return containsTokenRun(tTokens, qTokens);
}

/** A one-content-token title must be at least this long to count as mentioned. */
const MIN_SINGLE_TOKEN_TITLE_CHARS = 4;

/**
 * The reverse direction of `isTitlePhraseMatch`: is `title` mentioned INSIDE
 * `query` as a contiguous token run? "who is Alice Example" mentions the page
 * "Alice Example"; framed entity questions never equal a title, so the
 * exact-match boost needs this to fire at all. Guarded against generic titles:
 * the title needs >= MIN_CONTENT_TOKENS content tokens, or one content token of
 * at least MIN_SINGLE_TOKEN_TITLE_CHARS characters.
 */
export function isTitleMentionedInQuery(query: string, title: string): boolean {
  const qTokens = tokenizeTitle(query);
  const tTokens = tokenizeTitle(title);
  if (tTokens.length === 0 || tTokens.length > qTokens.length) return false;
  const tContent = contentTokens(tTokens);
  if (tContent.length === 0) return false;
  if (tContent.length < MIN_CONTENT_TOKENS && tContent[0].length < MIN_SINGLE_TOKEN_TITLE_CHARS) return false;
  return containsTokenRun(qTokens, tTokens);
}

/** Share of the query's distinct content tokens a title must supply to count as the query's subject. */
const TITLE_SUBJECT_MIN_COVERAGE = 0.5;

/**
 * The strict form used under intents without an exact-match boost (#4694):
 * returns the title's tokens when `title` (>= MIN_CONTENT_TOKENS content
 * tokens) is mentioned in `query` AND supplies at least half of the query's
 * distinct content tokens — the query asks for this document by name ("Which
 * document is <title>?"). A title mentioned inside a longer question about
 * something else ("Which amendment superseded the <title>?") does not
 * qualify: on the #4694 benchmark boosting those sent the mentioned page
 * above the right answer. Returns null otherwise.
 */
export function titleAsQuerySubject(query: string, title: string): string[] | null {
  const tTokens = tokenizeTitle(title);
  const tContent = contentTokens(tTokens);
  if (tContent.length < MIN_CONTENT_TOKENS || !isTitleMentionedInQuery(query, title)) return null;
  const qContent = new Set(contentTokens(tokenizeTitle(query)));
  return tContent.length / qContent.size >= TITLE_SUBJECT_MIN_COVERAGE ? tTokens : null;
}

export { containsTokenRun };
