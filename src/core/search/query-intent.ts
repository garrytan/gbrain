/**
 * v0.29.1 — merged query-intent classifier.
 *
 * Replaces v0.29.0's `intent.ts` (which only emitted a detail suggestion).
 * After D1 + D4 the codebase needs ONE classifier that returns three
 * suggestions from a single regex pass:
 *
 *   - intent:           original v0.29.0 type ('entity' | 'temporal' | 'event' | 'general')
 *   - suggestedDetail:  v0.29.0 mapping (entity→low, temporal/event→high)
 *   - suggestedSalience: NEW for v0.29.1 — 'off' | 'on' | 'strong'
 *   - suggestedRecency:  NEW for v0.29.1 — 'off' | 'on' | 'strong'
 *
 * Salience and recency are TRULY ORTHOGONAL (per D9):
 *   - salience boosts pages with high emotional_weight + take_count (mattering)
 *   - recency boosts pages with recent effective_date (per-prefix decay)
 * Both can fire, neither can fire, or just one.
 *
 * The classifier follows "current state → on. canonical truth → off." with
 * a NARROW exception per D6: explicit temporal bounds (today / this week /
 * right now / since X / last N days) override canonical-pattern wins. So
 * "who is X right now" → suggestedRecency='on' even though "who is" is a
 * canonical pattern.
 *
 * Pure module. No DB, no LLM, no async. Tested in test/query-intent.test.ts.
 */

export type QueryIntent = 'entity' | 'temporal' | 'event' | 'general';

export type SalienceMode = 'off' | 'on' | 'strong';
export type RecencyMode = 'off' | 'on' | 'strong';

/**
 * v0.36 cross-modal wave: modality axis (D6).
 *
 * - 'text' (default): existing text-embedding path, no behavior change
 * - 'image': route through the multimodal model + embedding_image column
 *   (visually-similar matching + image OCR text)
 * - 'both': run text + image searches in parallel and merge via
 *   weighted RRF (recall-leaning when the query is ambiguous)
 *
 * Parallel axis to intent/detail/salience/recency. Returned by
 * classifyQuery from one regex pass over the query.
 */
export type ModalityMode = 'text' | 'image' | 'both';

export interface QuerySuggestions {
  intent: QueryIntent;
  /** v0.29.0 detail mapping. entity→low, temporal/event→high, general→undefined. */
  suggestedDetail: 'low' | 'medium' | 'high' | undefined;
  /** v0.29.1 — emotional_weight + take_count boost. */
  suggestedSalience: SalienceMode;
  /** v0.29.1 — per-prefix age-decay boost. */
  suggestedRecency: RecencyMode;
  /** v0.36 — cross-modal routing axis. Defaults to 'text' when nothing matches. */
  suggestedModality: ModalityMode;
}

// ─────────────────────────────────────────────────────────
// Pattern banks (organized by axis they signal)
// ─────────────────────────────────────────────────────────

// Original v0.29.0 intent patterns. Drive .intent + .suggestedDetail.
const TEMPORAL_PATTERNS = [
  /\bwhen\b/i,
  /\blast\s+(met|meeting|call|conversation|chat|talked|spoke|seen|heard|time)\b/i,
  /\brecent(ly)?\b/i,
  /\bhistory\b/i,
  /\btimeline\b/i,
  /\bmeeting\s+notes?\b/i,
  /\bwhat('s| is| was)\s+new\b/i,
  /\blatest\b/i,
  /\bupdate(s)?\s+(on|from|about)\b/i,
  /\bhow\s+long\s+(ago|since)\b/i,
  /\b\d{4}[-/]\d{2}\b/i,
  /\blast\s+(week|month|quarter|year)\b/i,
];

const EVENT_PATTERNS = [
  /\bannounce[ds]?(ment)?\b/i,
  /\blaunch(ed|es|ing)?\b/i,
  /\braised?\s+\$?\d/i,
  /\bfund(ing|raise)\b/i,
  /\bIPO\b/i,
  /\bacquisition\b/i,
  /\bmerge[drs]?\b/i,
  /\bnews\b/i,
  /\bhappened?\b/i,
];

const ENTITY_PATTERNS = [
  /\bwho\s+is\b/i,
  /\bwhat\s+(is|does|are)\b/i,
  /\btell\s+me\s+about\b/i,
  /\bdescribe\b/i,
  /\bsummar(y|ize)\b/i,
  /\boverview\b/i,
  /\bbackground\b/i,
  /\bprofile\b/i,
  /\bwhat\s+do\s+(you|we)\s+know\b/i,
];

const FULL_CONTEXT_PATTERNS = [
  /\beverything\b/i,
  /\ball\s+(about|info|information|details)\b/i,
  /\bfull\s+(history|context|picture|story|details)\b/i,
  /\bcomprehensive\b/i,
  /\bdeep\s+dive\b/i,
  /\bgive\s+me\s+everything\b/i,
];

// v0.29.1 — recency-axis patterns
//
// Canonical patterns: queries asking for the authoritative / definitional
// answer. These signal recency='off' even when other axes match — UNLESS
// an explicit temporal bound is present (per D6 narrow exception).
const CANONICAL_PATTERNS = [
  /\bwho\s+is\b/i,
  /\bwhat\s+(is|are|does|means?)\b/i,
  /\bdefin(e|ition|ing)\b/i,
  /\bexplain\s+(what|how|why)\b/i,
  /\b(history|origin|background)\s+of\b/i,
  /\bconcept\s+of\b/i,
  /\boverview\s+of\b/i,
  /\btell\s+me\s+about\b/i,
  /\bcompiled\s+truth\b/i,
  /::|->|\.\w+\(/,
  /\b(function|class|method|module)\s+\w+/i,
  /\b(graph|traversal|backlinks?|inbound|outbound)\b/i,
];

// Aggressive recency: "today", "right now", "this morning", "just now".
const STRONG_RECENCY_PATTERNS = [
  /\btoday\b/i,
  /\bright\s+now\b/i,
  /\bthis\s+morning\b/i,
  /\bjust\s+now\b/i,
];

// Moderate recency: "what's going on", "latest", "recent", "this week",
// meeting prep, conversation recall, status updates.
const RECENCY_ON_PATTERNS = [
  /\bwhat'?s\s+(going\s+on|happening|new|latest|up)\b/i,
  /\b(latest|recent(ly)?|currently)\b/i,
  /\b(this|last|past)\s+(week|month|few\s+days|couple\s+days)\b/i,
  /\bmeeting\s+(prep|with|for|notes?|brief)\b/i,
  /\bbefore\s+(my|the|our)\s+(meeting|call|sync|chat)\b/i,
  /\bprep(are)?\s+(for|me)\b/i,
  /\bcatch(es|ing)?\b[\s\w]{0,15}\bup\b/i,  // "catch up", "catch me up", "catching X up"
  /\bremind\s+me\s+(what|about|of)\b/i,
  /\b(update|status|progress)\s+(on|with|from)\b/i,
];

// Per D6: explicit temporal bounds override canonical-wins. "Who is X today"
// → recency='on' (temporal bound wins). "Who is X" alone → recency='off'.
const EXPLICIT_TEMPORAL_BOUND_PATTERNS = [
  /\btoday\b/i,
  /\bright\s+now\b/i,
  /\bthis\s+morning\b/i,
  /\bthis\s+week\b/i,
  /\bsince\s+(launch|last|the|\d)/i,
  /\blast\s+\d+\s+(day|days|week|weeks|month|months)\b/i,
];

// v0.29.1 — salience-axis patterns
//
// Salience suggests "what matters in this brain right now" — when the user
// is asking about people/companies/deals in the current context, they
// usually want the emotionally-weighted + take-rich pages to surface.
// Salience patterns are a subset of recency-on patterns (meeting prep,
// catch-up, update language) plus people-centric phrasings.
const SALIENCE_ON_PATTERNS = [
  /\bwhat'?s\s+(going\s+on|happening|been\s+going|been\s+up)\b/i,
  /\bcatch(es|ing)?\b[\s\w]{0,15}\bup\b/i,
  /\bremind\s+me\s+(what|about|of)\b/i,
  /\bprep(are)?\s+(for|me)\b/i,
  /\bbefore\s+(my|the|our)\s+(meeting|call|sync|chat)\b/i,
  /\bmeeting\s+(prep|with|for|brief)\b/i,
  /\b(update|status|progress)\s+(on|with|from)\b/i,
  /\bwhat\s+matters\b/i,
  /\bwhat'?s\s+important\b/i,
];

// v0.36 cross-modal wave — modality-axis patterns (D6).
//
// CROSS_MODAL_PATTERNS fires the 'image' modality when the query explicitly
// names visual artifacts ("show me photos", "find images of", "screenshot of",
// "what does X look like", "diagram of"). Module-scope const so regexes
// compile once at module load (D15).
//
// Conservative on purpose — false positives cost "one cheaper image search
// where text might have worked." False negatives cost nothing (the legacy
// text path still runs). The LLM-intent escalation in Commit 4 catches
// genuinely ambiguous phrasings.
const CROSS_MODAL_PATTERNS: RegExp[] = [
  /\b(show|find|get|pull)\s+(me\s+)?(the\s+)?(photos?|images?|pictures?|pics?|screenshots?)\b/i,
  /\b(photos?|images?|pictures?|pics?|screenshots?)\s+(of|from|at|with|showing|featuring)\b/i,
  /\bwhat\s+does\s+[\w\s']{1,40}?\s+look\s+like\b/i,
  /\b(whiteboard|diagram|slide|screenshot|infographic|chart)s?\s+(of|from|about|showing)\b/i,
  /\bdiagram\s+(of|for|showing)\b/i,
  /\bvisual(s|ly)?\s+(of|from|about|showing|representation)\b/i,
];

// v0.36 cross-modal wave (Commit 4 prep): visual nouns that combined with
// ambiguous-pronoun phrasings ("any pics from last week's offsite?") trigger
// the optional LLM intent escalation. Subset of cross-modal patterns plus
// looser noun-form matches.
const AMBIGUOUS_MODALITY_NOUNS: RegExp[] = [
  /\b(photo|image|picture|pic|screenshot|diagram|whiteboard|slide|chart)s?\b/i,
  /\blook(s|ed)?\s+like\b/i,
  /\bvisual(s|ly)?\b/i,
];

// Pronoun + filler markers that signal "the user is referencing something
// they can't quite name" — combined with AMBIGUOUS_MODALITY_NOUNS, triggers
// the LLM tie-break in Commit 4.
const AMBIGUOUS_REFERENCE_MARKERS: RegExp[] = [
  // Match all the visual nouns (pic/pics, picture/pictures, photo/photos, image/images,
  // screenshot/screenshots, diagram/diagrams, whiteboard/whiteboards, slide/slides, chart/charts).
  /\b(any|some|that|those|these|the)\s+(pic|pics|picture|pictures|photo|photos|image|images|screenshot|screenshots|diagram|diagrams|whiteboard|whiteboards|slide|slides|chart|charts)\b/i,
  /\bfrom\s+(last|this|the)\s+(week|month|year|offsite|meeting|hackathon|deck)\b/i,
];

// ─────────────────────────────────────────────────────────
// Classifier
// ─────────────────────────────────────────────────────────

function matches(patterns: RegExp[], q: string): boolean {
  for (const re of patterns) if (re.test(q)) return true;
  return false;
}

/**
 * Classify a query and return all three axis suggestions.
 *
 * Resolution rules:
 *   - intent:            original v0.29.0 priority (full-context > temporal > event > entity > general)
 *   - suggestedDetail:   intent → detail mapping (entity=low, temporal/event=high)
 *   - suggestedRecency:  STRONG_RECENCY > RECENCY_ON; CANONICAL wins UNLESS
 *                        EXPLICIT_TEMPORAL_BOUND also matches; default 'off'
 *   - suggestedSalience: SALIENCE_ON; CANONICAL wins UNLESS
 *                        EXPLICIT_TEMPORAL_BOUND; default 'off'
 *
 * Note: salience and recency are independent. A "what's going on with X"
 * query gets BOTH on; "who is X" gets BOTH off; "today's news" gets
 * recency='strong' but salience='off' (the user wants newest, not
 * emotionally-weighted).
 */
export function classifyQuery(query: string): QuerySuggestions {
  const intent = classifyQueryIntent(query);
  const suggestedDetail = intentToDetail(intent);

  const hasCanonical = matches(CANONICAL_PATTERNS, query);
  const hasTemporalBound = matches(EXPLICIT_TEMPORAL_BOUND_PATTERNS, query);
  const hasStrongRecency = matches(STRONG_RECENCY_PATTERNS, query);
  const hasRecencyOn = matches(RECENCY_ON_PATTERNS, query);
  const hasSalienceOn = matches(SALIENCE_ON_PATTERNS, query);

  // Recency axis
  let suggestedRecency: RecencyMode;
  if (hasCanonical && !hasTemporalBound) {
    suggestedRecency = 'off';
  } else if (hasStrongRecency) {
    suggestedRecency = 'strong';
  } else if (hasRecencyOn) {
    suggestedRecency = 'on';
  } else {
    suggestedRecency = 'off';
  }

  // Salience axis (orthogonal)
  let suggestedSalience: SalienceMode;
  if (hasCanonical && !hasTemporalBound) {
    suggestedSalience = 'off';
  } else if (hasSalienceOn) {
    suggestedSalience = 'on';
  } else {
    suggestedSalience = 'off';
  }

  // v0.36 cross-modal — modality axis. Independent of intent/detail/salience/recency.
  // Conservative default 'text'; only flips to 'image' on explicit cross-modal regex match.
  // 'both' is reserved for explicit per-call opts (LLM-intent escalation in Commit 4
  // can also produce 'both' via tie-break).
  const suggestedModality: ModalityMode = matches(CROSS_MODAL_PATTERNS, query) ? 'image' : 'text';

  return { intent, suggestedDetail, suggestedSalience, suggestedRecency, suggestedModality };
}

/**
 * v0.36 — heuristic gate for the optional LLM intent escalation (Commit 4).
 *
 * Fires when the query contains a visual noun ("any pics", "the diagram",
 * "what does it look like") combined with an ambiguous reference marker
 * ("from last week's offsite"). These are the phrasings the conservative
 * regex misses but a Haiku tie-break catches.
 *
 * Returns false for unambiguous text queries (no LLM call burned). Returns
 * false for queries the regex ALREADY caught (no need to tie-break a
 * confident classification). Returns true only for the narrow band where
 * the LLM call earns its $0.0001 cost.
 *
 * Pure function. No LLM call. No DB access. Used by hybridSearch's
 * escalation branch only when `search.cross_modal.llm_intent: true`.
 */
export function isAmbiguousModalityQuery(query: string): boolean {
  // Already-confident classification → no LLM needed.
  if (matches(CROSS_MODAL_PATTERNS, query)) return false;

  const hasVisualNoun = matches(AMBIGUOUS_MODALITY_NOUNS, query);
  if (!hasVisualNoun) return false;

  const hasReferenceMarker = matches(AMBIGUOUS_REFERENCE_MARKERS, query);
  return hasReferenceMarker;
}

// ─────────────────────────────────────────────────────────
// v0.29.0 compatibility shims
// ─────────────────────────────────────────────────────────

/** v0.29.0 intent type. Preserved verbatim for back-compat. */
export function classifyQueryIntent(query: string): QueryIntent {
  if (matches(FULL_CONTEXT_PATTERNS, query)) return 'temporal';
  if (matches(TEMPORAL_PATTERNS, query)) return 'temporal';
  if (matches(EVENT_PATTERNS, query)) return 'event';
  if (matches(ENTITY_PATTERNS, query)) return 'entity';
  return 'general';
}

/** v0.29.0 mapping. */
export function intentToDetail(intent: QueryIntent): 'low' | 'medium' | 'high' | undefined {
  switch (intent) {
    case 'entity': return 'low';
    case 'temporal': return 'high';
    case 'event': return 'high';
    case 'general': return undefined;
  }
}

/** v0.29.0 helper. Routes through classifyQuery internally. */
export function autoDetectDetail(query: string): 'low' | 'medium' | 'high' | undefined {
  return classifyQuery(query).suggestedDetail;
}
