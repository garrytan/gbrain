/**
 * v0.29 — Tool descriptions, extracted to a constants module so that:
 *   1. The exact LLM-facing strings are pinnable in tests
 *      (`test/operations-descriptions.test.ts`).
 *   2. Routing changes ship as data, not buried-in-handler edits.
 *   3. The `salience-llm-routing.test.ts` Tier-2 eval has a stable surface
 *      to load tool definitions from.
 *
 * Description style:
 *   - Lead with what the tool does in one short sentence.
 *   - Include explicit triggers ("Use this when the user asks ...") that
 *     the LLM tool-selection prompt can match.
 *   - For redirect hints (query/search → salience), be blunt:
 *     "Do NOT run a semantic search for these."
 */

// ──────────────────────────────────────────────────────────────────────────────
// New v0.29 ops
// ──────────────────────────────────────────────────────────────────────────────

export const GET_RECENT_SALIENCE_DESCRIPTION =
  "Returns pages recently touched and ranked by emotional + activity salience " +
  "(deterministic 0..1 emotional_weight + take density + recency decay). " +
  "Use this when the user asks what's been going on, what's notable, what's hot, " +
  "anything crazy happening, or for any open-ended 'current state' question " +
  "about themselves or their work. Do NOT run a semantic search for these — " +
  "salience surfaces what's unusual without needing a search term.";

export const FIND_ANOMALIES_DESCRIPTION =
  "Returns statistical anomalies in recent page activity, grouped by cohort " +
  "(tag or type). Use this for questions about what stood out, what's unusual, " +
  "or what changed recently. Returns explanatory cohorts (e.g. '15 pages tagged " +
  "wedding touched on 2026-04-28, baseline 0.3/day') so you can speak about " +
  "patterns the user wouldn't have searched for. Cohort kinds: tag, type. " +
  "Year cohort is deferred to a later release.";

export const FIND_EXPERTS_DESCRIPTION =
  "Answers 'who in my brain knows about <topic>'. Returns ranked person/company " +
  "pages by expertise depth (sub-linear match score), relationship recency " +
  "(exp decay with 6-month half-life), and salience. Use this for questions " +
  "like 'who should I talk to about X', 'who knows about Y', 'find me someone " +
  "who's worked on Z', or any expertise-routing intent. Filters at SQL to " +
  "person + company pages — does NOT return notes or articles. Pair with " +
  "--explain (CLI) to surface the per-result factor breakdown.";

export const GET_RECENT_TRANSCRIPTS_DESCRIPTION =
  "Returns one-line summaries of recent raw conversation transcripts (NOT polished " +
  "reflections). Use this FIRST for questions about 'what's going on with me', " +
  "'what have I been thinking about', or anything personal/emotional. Raw " +
  "transcripts are the canonical source for the user's own state — polished pages " +
  "summarize and flatten. Local-only: rejects remote (MCP/HTTP) callers with a " +
  "clear permission_denied; call via the gbrain CLI.";

// ──────────────────────────────────────────────────────────────────────────────
// Redirect hints appended to existing op descriptions
// ──────────────────────────────────────────────────────────────────────────────

export const LIST_PAGES_DESCRIPTION =
  "List pages with optional filters. " +
  "For 'what's recent / what did I touch this week' questions, use list_pages " +
  "with sort=updated_desc instead of semantic search.";

export const QUERY_DESCRIPTION =
  "Hybrid search with vector + keyword + multi-query expansion. " +
  "For personal/emotional questions ('what's going on with me', 'anything notable', " +
  "'how am I feeling'), prefer get_recent_salience, find_anomalies, or " +
  "get_recent_transcripts. Semantic search returns polished pages and misses " +
  "recent activity bursts. Do NOT assume words like 'crazy', 'notable', or 'big' " +
  "mean impressive — they often mean difficult or emotionally charged.";

export const SEARCH_DESCRIPTION =
  "Keyword search using full-text search. For personal/emotional questions, " +
  "prefer get_recent_salience or find_anomalies — they surface activity bursts " +
  "without needing a search term.";

// ──────────────────────────────────────────────────────────────────────────────
// v0.32.6 — contradiction probe MCP surface (M3)
// ──────────────────────────────────────────────────────────────────────────────

export const FIND_CONTRADICTIONS_DESCRIPTION =
  "v0.32.6 — return suspected-contradiction findings from the most recent " +
  "`gbrain eval suspected-contradictions` probe run, optionally filtered by slug " +
  "and/or severity. Use this when the user asks 'what's inconsistent in my " +
  "brain', 'show me contradictions about Acme', 'high-severity issues only', or " +
  "wants to act on the probe's findings without re-running it. Returns " +
  "{contradictions: [{a, b, severity, axis, confidence, resolution_command}]}. " +
  "Reads the cached run row — does NOT trigger a new probe; users run " +
  "`gbrain eval suspected-contradictions` for that.";
