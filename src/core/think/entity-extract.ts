/**
 * v0.40.2.0 — Shared candidate-entity extraction for trajectory routing.
 *
 * Consumed by both `gbrain think` (Commit 2) and the LongMemEval harness
 * (Commit 4). Both surfaces need to derive entity candidates from a
 * question + the slugs that came back from retrieval — extracting twice
 * was a Codex DRY concern, so this is the single implementation.
 *
 * Two sources, in priority order:
 *
 *   1. Retrieved slugs that look like entity pages (`people/`,
 *      `companies/`, `organizations/`). High precision — these slugs
 *      came back from hybridSearch, so we know the brain has them.
 *
 *   2. Noun-phrase extraction from the question text. Lower-cased so it
 *      catches "coffee maker" and "Marco" alike. Medium precision —
 *      stop-word filtering keeps the candidate list short, but some
 *      noise is unavoidable. The downstream `resolveEntitySlug`
 *      `resolution_source` check (skip 'fallback_slugify' results)
 *      filters non-matches before any trajectory call fires.
 *
 * Cap of 5 candidates per question — beyond that, the additional
 * trajectory calls dilute the prompt with low-relevance blocks. The cap
 * + 5s per-call timeout from runThink bound total added latency at
 * ~5s × ceil(5 / concurrency=3) ≈ ~10s worst-case for a question with 5
 * resolvable candidates.
 */

// Compiled once at module load. Single-word tokenizer: letters,
// hyphens, apostrophes (length 1-40). The caller stitches consecutive
// non-stop-word tokens into phrases so "Blue Bottle" stays together
// while "I last meet Marco" splits at the stop-word boundaries.
const WORD_RX = /\b[a-zA-Z][a-zA-Z\-']{0,40}\b/g;

// Lowercased entity-prefix paths the brain uses for canonical entity pages.
// Slugs starting with one of these prefixes are high-precision candidates.
const ENTITY_PREFIXES = [
  'people/',
  'companies/',
  'organizations/',
  'orgs/',
  'deals/',
] as const;

// Stop-word set — common English words that would otherwise produce
// noise candidates. Curated to ~200 words from typical question vocab.
// Lowercased; comparison happens after the candidate is lowercased.
const STOP_WORDS = new Set([
  // Articles + pronouns
  'a', 'an', 'the', 'i', 'you', 'he', 'she', 'we', 'they', 'it', 'me',
  'us', 'them', 'my', 'your', 'his', 'her', 'our', 'their', 'this',
  'that', 'these', 'those',
  // Common auxiliary + question verbs
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'doing',
  'can', 'could', 'will', 'would', 'should', 'may', 'might', 'must',
  // Question words
  'what', 'when', 'where', 'who', 'whom', 'whose', 'why', 'how', 'which',
  // Prepositions + conjunctions
  'of', 'in', 'on', 'at', 'to', 'from', 'with', 'without', 'by',
  'for', 'about', 'against', 'between', 'through', 'during',
  'before', 'after', 'above', 'below', 'and', 'or', 'but', 'nor',
  'so', 'yet', 'because', 'if', 'as', 'than', 'into', 'onto',
  // Temporal nouns
  'time', 'date', 'day', 'week', 'month', 'year', 'today', 'yesterday',
  'tomorrow', 'now', 'then', 'ago', 'since', 'until', 'long',
  // Generic head nouns + relatives
  'thing', 'things', 'something', 'anything', 'nothing', 'one', 'ones',
  'kind', 'sort', 'type', 'sort', 'lot', 'lots',
  // Common verbs that show up in questions
  'last', 'first', 'next', 'previous', 'recent', 'latest', 'current',
  'still', 'just', 'also', 'only', 'such', 'much', 'many', 'most',
  'more', 'less', 'few', 'some', 'any', 'all', 'no', 'not', 'each',
  'every', 'both', 'either', 'neither', 'same', 'different', 'other',
  'others', 'another',
  // Misc
  'said', 'say', 'says', 'told', 'tell', 'tells', 'asked', 'ask',
  'know', 'knew', 'known', 'think', 'thought',
  'changed', 'switched', 'moved', 'updated',
  'good', 'bad', 'better', 'worse', 'best', 'worst',
  'new', 'old', 'big', 'small', 'high', 'low',
]);

export type ResolutionSource = 'exact_page' | 'fuzzy_match' | 'fallback_slugify';

export interface EntityCandidate {
  /**
   * The raw candidate text. Source depends on origin: for retrieved-slug
   * candidates this is the slug itself (already canonical); for
   * noun-phrase candidates this is the lowercase phrase from the question.
   */
  raw: string;
  /**
   * 'retrieved' = came from a retrieval result's slug (`people/marco`).
   * 'extracted' = derived from question text via noun-phrase scan.
   */
  origin: 'retrieved' | 'extracted';
}

const MAX_CANDIDATES = 5;

/**
 * Extract candidate entities from a question + retrieval-result slugs.
 *
 * Output is deterministic order: retrieved-slug candidates first (in input
 * order, deduped), then noun-phrase candidates (in question-text order,
 * deduped against the retrieved set + each other). Capped at
 * MAX_CANDIDATES total.
 *
 * The caller is responsible for `resolveEntitySlug` → `findTrajectory`
 * with the `resolution_source !== 'fallback_slugify'` gate. This module
 * is pure (no engine access).
 */
export function extractCandidateEntities(
  question: string,
  retrievedSlugs: ReadonlyArray<string>,
): EntityCandidate[] {
  const out: EntityCandidate[] = [];
  const seen = new Set<string>();

  // Source 1: retrieved slugs matching known entity prefixes.
  for (const slug of retrievedSlugs) {
    if (out.length >= MAX_CANDIDATES) break;
    if (typeof slug !== 'string') continue;
    const lower = slug.toLowerCase();
    if (!ENTITY_PREFIXES.some(p => lower.startsWith(p))) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push({ raw: slug, origin: 'retrieved' });
  }

  // Source 2: noun-phrase extraction from question text. Tokenize the
  // question into single words, then stitch runs of CONSECUTIVE non-
  // stop-words into multi-word phrases. "When did I last meet Marco at
  // Blue Bottle" tokenizes as
  //   when did I last meet marco at blue bottle
  // and stitches into ["meet marco", "blue bottle"] because "at" is a
  // stop-word boundary between "marco" and "blue".
  if (out.length < MAX_CANDIDATES && typeof question === 'string') {
    const tokens = (question.match(WORD_RX) ?? []).map(t => t.toLowerCase());
    const phrases: string[] = [];
    let current: string[] = [];
    const flush = () => {
      if (current.length > 0) {
        const joined = current.join(' ');
        if (joined.length >= 2 && joined.length <= 40) phrases.push(joined);
      }
      current = [];
    };
    for (const tok of tokens) {
      if (STOP_WORDS.has(tok)) {
        flush();
      } else {
        current.push(tok);
      }
    }
    flush();
    for (const phrase of phrases) {
      if (out.length >= MAX_CANDIDATES) break;
      // Strip "meet" → "marco". The first word of a phrase like "meet
      // marco" is often a verb that's not a stop-word per the list (we
      // can't enumerate every verb) but is also not the entity. Heuristic:
      // when the phrase has 2+ words, strip a leading single-syllable verb.
      const core = stripLeadingVerb(phrase);
      if (core.length < 2) continue;
      if (seen.has(core)) continue;
      seen.add(core);
      out.push({ raw: core, origin: 'extracted' });
    }
  }

  return out;
}

// Common verbs that precede entity references in questions ("meet marco",
// "saw alice", "got the new laptop"). Limited list — kept tight so we
// don't strip legitimate entity-name first words like "Apple". When in
// doubt, leave the candidate intact and let downstream resolution decide.
const LEADING_VERBS = new Set([
  'meet', 'met', 'saw', 'see', 'seen', 'visit', 'visited',
  'spoke', 'speak', 'spoken', 'talked', 'talk', 'called', 'call', 'wrote', 'write',
  'got', 'get', 'gotten', 'bought', 'buy', 'received', 'sold',
  'pinged', 'emailed', 'texted', 'reached',
]);

/**
 * If the first word of a multi-word phrase is a common preceding verb
 * AND the remaining phrase is non-empty, return just the remaining
 * phrase. Otherwise return the phrase unchanged.
 */
function stripLeadingVerb(phrase: string): string {
  const words = phrase.split(/\s+/);
  if (words.length < 2) return phrase;
  if (!LEADING_VERBS.has(words[0])) return phrase;
  return words.slice(1).join(' ');
}
