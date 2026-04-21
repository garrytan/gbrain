/**
 * Query Intent Classifier
 *
 * Zero-latency heuristic classifier that detects query intent from text patterns.
 * Maps intent to the appropriate detail level for hybrid search.
 *
 * No LLM call, no API cost, no latency. Pattern matching on query text.
 */

export type QueryIntent = 'entity' | 'temporal' | 'event' | 'general';

// Temporal patterns: questions about when things happened, meeting history
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
  /\b\d{4}[-/]\d{2}\b/i, // date pattern like 2024-03
  /\blast\s+(week|month|quarter|year)\b/i,
];

// Event patterns: specific events, announcements, launches
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

// Entity patterns: identity questions, overviews
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

// Full-context patterns: requests for everything
const FULL_CONTEXT_PATTERNS = [
  /\beverything\b/i,
  /\ball\s+(about|info|information|details)\b/i,
  /\bfull\s+(history|context|picture|story|details)\b/i,
  /\bcomprehensive\b/i,
  /\bdeep\s+dive\b/i,
  /\bgive\s+me\s+everything\b/i,
];

/**
 * Classify query intent from text patterns.
 * Returns the detected intent type.
 */
export function classifyQueryIntent(query: string): QueryIntent {
  // Full context requests → treat as temporal (return everything)
  if (FULL_CONTEXT_PATTERNS.some(p => p.test(query))) return 'temporal';

  // Check temporal patterns first (highest priority for detail=high)
  if (TEMPORAL_PATTERNS.some(p => p.test(query))) return 'temporal';

  // Check event patterns
  if (EVENT_PATTERNS.some(p => p.test(query))) return 'event';

  // Check entity patterns
  if (ENTITY_PATTERNS.some(p => p.test(query))) return 'entity';

  // Default: general query
  return 'general';
}

/**
 * Map query intent to detail level.
 *
 * entity   → 'low'    (compiled truth only, user wants the assessment)
 * temporal → 'high'   (need timeline, user wants dates/events)
 * event    → 'high'   (need timeline, user wants specific events)
 * general  → undefined (use default medium, let the boost handle it)
 */
export function intentToDetail(intent: QueryIntent): 'low' | 'medium' | 'high' | undefined {
  switch (intent) {
    case 'entity': return 'low';
    case 'temporal': return 'high';
    case 'event': return 'high';
    case 'general': return undefined; // use default
  }
}

/**
 * Auto-detect detail level from query text.
 * Returns undefined if no strong signal detected (uses default).
 */
export function autoDetectDetail(query: string): 'low' | 'medium' | 'high' | undefined {
  return intentToDetail(classifyQueryIntent(query));
}
