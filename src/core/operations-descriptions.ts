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
  "without needing a search term. " +
  "For code-symbol questions (callers, callees, definitions, blast radius), use " +
  "code_callers / code_callees / code_def / code_refs instead — those return " +
  "structural graph data, not text chunks.";

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

export const FIND_TRAJECTORY_DESCRIPTION =
  "v0.35.4 — return the chronological claim trajectory for an entity (typed " +
  "metric values over time, plus auto-detected regressions and narrative drift). " +
  "Use this when the user asks 'how has Acme's MRR trended', 'show me what " +
  "alice-example said about runway over time', 'is this founder consistent', " +
  "'find regressions for fund-a's portfolio', or wants a time-series view of an " +
  "entity's structured claims. Returns " +
  "`{points: [{fact_id, valid_from, metric, value, unit, period, text, source_session, source_markdown_slug}], " +
  "regressions: [{metric, from_value, from_date, to_value, to_date, delta_pct}], " +
  "drift_score: number|null, schema_version: 1}`. Drift score 0 = stable narrative, " +
  "1 = every consecutive claim is unrelated; null when fewer than 3 typed points " +
  "exist. Visibility-filtered for remote callers (world-only); source-scoped by " +
  "the caller's OAuth source binding. Pair with `gbrain founder scorecard <slug>` " +
  "for an aggregated rollup of the same data.";

// ──────────────────────────────────────────────────────────────────────────────
// v0.33.3 Cathedral III foundation — code-intelligence ops (MCP-exposed).
// Pre-v0.33.3 the callers/callees/def/refs commands were CLI-only — agents
// reached for grep because the MCP surface didn't expose them. These
// descriptions are resolver-grade so the LLM tool-selection prompt routes
// plan-mode questions straight to the right op.
//
// Style notes per the v0.34 eng review D10 finding: every description carries
// an inline example response so agents don't burn first-call context discovering
// shape. Pin via test/operations-descriptions.test.ts.
// ──────────────────────────────────────────────────────────────────────────────

export const CODE_CALLERS_DESCRIPTION =
  "BEFORE editing any function, run code_callers with the symbol name to find " +
  "every caller (the people who'd be affected by your change). Returns direct " +
  "callers from the v0.20+ tree-sitter call graph. Use during plan-mode to size " +
  "the change. Defaults to source-scoped; for multi-source brains pass source_id " +
  "or all_sources=true. " +
  "Returns: `{symbol, count, callers: [{from_symbol_qualified, to_symbol_qualified, edge_type, resolved}]}`. " +
  "Example: `{symbol:'parseMarkdown', count:4, callers:[{from_symbol_qualified:'callerInA', " +
  "to_symbol_qualified:'parseMarkdown', edge_type:'calls', resolved:true}]}`.";

export const CODE_CALLEES_DESCRIPTION =
  "When tracing how a function flows to its dependencies (DB calls, HTTP calls, " +
  "file I/O), run code_callees from the entry point. Forward view of the call " +
  "graph: what does this symbol call? Use this when debugging unexpected behavior " +
  "or when planning to extract / inline a function. Same shape as code_callers " +
  "but the field is `callees` and the edge direction is reversed.";

export const CODE_DEF_DESCRIPTION =
  "Where is this symbol defined? Returns one row per definition site (function, " +
  "class, type, interface, enum, struct, trait, module, contract). Use this BEFORE " +
  "reaching for grep when you want to read a definition. Single-result is the common " +
  "case; multiple results indicate same-name symbols across files (which is information " +
  "in itself). " +
  "Returns: `{symbol, count, defs: [{slug, file, language, symbol_type, start_line, end_line, snippet}]}`. " +
  "Filter by --lang to scope a polyglot brain (e.g., lang='typescript').";

export const CODE_REFS_DESCRIPTION =
  "Find every reference to a symbol across the codebase (every file, every line). " +
  "Differs from code_callers in two ways: (1) catches references in comments, " +
  "strings, imports, type annotations — not just call sites; (2) returns line " +
  "numbers, not symbol-qualified edges. Use this when planning a rename or " +
  "deprecation where you need to touch every literal mention. " +
  "Returns: `{symbol, count, refs: [{slug, file, language, line, context}]}`.";
