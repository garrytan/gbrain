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
  "Recently touched pages ranked by salience. Use this when the user asks what's been going on, what's notable, anything crazy happening. Do NOT run a semantic search for these.";

export const FIND_ANOMALIES_DESCRIPTION =
  "Anomalies in recent page activity, grouped by cohort (tag or type) against a baseline. Use for what stood out, what's unusual or changed. Cohort kinds: tag, type.";

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
  "List pages with filters. For 'what's recent / what did I touch this week' use sort=updated_desc. Default 50 rows (remote max 100); a full page may be truncated: continue with updated_after + updated_after_slug from the last row.";

export const QUERY_DESCRIPTION =
  "Hybrid search plus multi-query expansion for concept or landscape questions (expansion recovers synonym-phrased matches). Still top-K; return_unit returns whole sections or conversations. Lists: list_pages. Exact tokens: `search` is cheaper (no expansion LLM call). Personal: get_recent_salience, find_anomalies; transcripts: `gbrain transcripts recent` on the host. Do NOT assume 'crazy' means impressive (often difficult or emotionally charged). Needs an embedding key (else keyword-only); expansion needs a chat key. fields: \"full\" adds diagnostics.";

export const SEARCH_DESCRIPTION =
  "Cheap hybrid search, no LLM expansion, top 20: exact tokens, names, field values. NOT proof of coverage; match: \"keyword\" pages every keyword match. Concepts or landscape: `query`; lists: list_pages; personal: get_recent_salience. return_unit: sections or conversations. fields: \"full\" adds diagnostics.";

/** `search`'s `match` param (Cat 40 Hard F2). */
export const SEARCH_MATCH_DESCRIPTION = 'keyword: every keyword match, paged.';

// ──────────────────────────────────────────────────────────────────────────────
// v0.32.6 — contradiction probe MCP surface (M3)
// ──────────────────────────────────────────────────────────────────────────────

export const FIND_CONTRADICTIONS_DESCRIPTION =
  "Stored contradiction reports are temporarily available only to trusted local callers without a source filter. " +
  "Remote or source-scoped callers receive {contradictions: [], note} with an availability note. " +
  "For eligible local callers, return suspected-contradiction findings from the most recent " +
  "`gbrain eval suspected-contradictions` probe run, optionally filtered by slug " +
  "and/or severity. Use this when the user asks 'what's inconsistent in my " +
  "brain', 'show me contradictions about Acme', 'high-severity issues only', or " +
  "wants to act on the probe's findings without re-running it. Returns " +
  "{contradictions: [{a, b, severity, axis, confidence, resolution_command}]}. " +
  "An eligible read loads the stored run without triggering a new probe; users run " +
  "`gbrain eval suspected-contradictions` for that.";

export const FIND_TRAJECTORY_DESCRIPTION =
  "Return the chronological claim trajectory for an entity (typed " +
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
  "callers from the tree-sitter call graph. Use during plan-mode to size " +
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

// ──────────────────────────────────────────────────────────────────────────────
// PR1 — skill catalog over MCP (list_skills / get_skill). The agent repo's
// fat-markdown skills, published so a thin MCP client (Codex desktop, Claude
// Code, Perplexity) can discover and FOLLOW them. Skills are prose instruction
// sets, not executable code — "using" one = fetching its prose and then calling
// the gbrain MCP tools the same server already exposes. The instructional
// envelope below is the load-bearing UX: it tells the pulling agent what these
// are and the use protocol. Pinned by test/operations-descriptions.test.ts.
// ──────────────────────────────────────────────────────────────────────────────

export const LIST_SKILLS_DESCRIPTION =
  "Skills: prose instruction sets (NOT executable code) for tasks with this server's tools, with triggers, usable_tools and unavailable_tools. Use one via get_skill.";

export const GET_SKILL_DESCRIPTION =
  "Fetch a skill's prose and follow it: when it says search or store, call the same-named MCP tool here. There is nothing to execute. unavailable_tools won't work for you.";

/**
 * The load-bearing `instructions` envelope for list_skills. Pinned so the
 * agent-facing protocol can't silently drift. `how_to_use` is the ordered
 * protocol a thin client follows.
 */
export const SKILL_CATALOG_INSTRUCTIONS = {
  summary:
    "These are 'skills': named prose instruction sets, not executable tools. " +
    "There is no skill to 'run' — a skill tells YOU how to accomplish a task " +
    "using the MCP tools this same server already exposes.",
  how_to_use: [
    "Pick a skill from this list whose triggers match the user's intent.",
    "Call get_skill with its name to fetch the full prose (the `body`).",
    "Follow that prose as your plan for the task.",
    "When the prose says to search, store, link, or look something up, call the " +
      "correspondingly-named MCP tool on THIS server (e.g. search, query, put_page).",
    "Only call tools in this skill's `usable_tools`; tools in `unavailable_tools` " +
      "are not callable by you on this server.",
    "For host-repository skills, declared `tools` narrow the usable tools. Valid " +
      "frontmatter without `tools` inherits your available brain tools; `tools: []` permits none. " +
      "Canonical shared skills follow the same rule; their other requirements gate `usable`.",
  ],
} as const;

/**
 * Per-skill `client_guidance` for get_skill. Same protocol, scoped to one skill.
 */
export const SKILL_CLIENT_GUIDANCE = {
  nature:
    "This is a fat-markdown instruction set, not code to execute. The `body` is " +
    "your operating procedure; carry it out using this server's MCP tools.",
  protocol: [
    "Read `body` as your operating instructions for this task.",
    "When the prose names a brain operation (search, store, link, look up), call " +
      "the MCP tool of that name on THIS server.",
    "Do not invent tools — only the tools in `usable_tools` are callable by you.",
    "For host-repository skills, declared `tools` narrow this list. Valid frontmatter " +
      "without `tools` inherits your available brain tools; `tools: []` permits none. " +
      "Canonical shared skills follow the same rule; their other requirements gate `usable`.",
    "If `mutating` is true, this skill writes to the brain; confirm before doing so " +
      "if the user hasn't clearly asked for a write.",
  ],
} as const;

/**
 * CLI→MCP gap-closure wave — the capture op (D2A). Pinned here because it
 * rewrites the routing guidance three docs used to carry as the
 * "unknown tool: capture → use put_page" FAQ: agents must learn the split
 * (capture = quick notes with auto-slug + dedupe; put_page = full control)
 * from this description alone. Phrase-pinned by
 * test/operations-descriptions.test.ts.
 */
export const CAPTURE_DESCRIPTION =
  "Quick note (\"just remember this\"): auto-slugged under inbox/ by date + content hash, so recapturing is idempotent. Use put_page to control slug or type; remember for facts about entities.";
