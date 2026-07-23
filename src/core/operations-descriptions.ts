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
  "List the skills this agent's brain publishes. A skill is a named prose " +
  "instruction set (NOT executable code) that teaches you how to do a task " +
  "using this server's other tools. Returns a flat catalog — each entry has a " +
  "name, one-line description, triggers (phrasings that should invoke it), and " +
  "`usable_tools` / `unavailable_tools` (which tools the skill calls that you " +
  "CAN vs CANNOT call given this server + your access). To actually use a skill, " +
  "call get_skill with its name, read the returned prose, and follow it — calling " +
  "the correspondingly-named tools on THIS server. The response also carries an " +
  "`instructions` envelope explaining this protocol. Reflects the serving repo's " +
  "skills even when the call targets a mounted brain. Read-scope; published only " +
  "when the brain owner enabled mcp.publish_skills.";

export const GET_SKILL_DESCRIPTION =
  "Fetch one skill's full instructions by name. Returns `{name, frontmatter " +
  "(sanitized), body, usable_tools, unavailable_tools, client_guidance}`. The " +
  "`body` is prose — read it as your operating instructions for this task, and " +
  "when it says to search / store / look something up, call the same-named MCP " +
  "tool on THIS server. There is nothing to 'execute' — the value is the " +
  "instructions plus your tool calls back to this server. Tools listed in " +
  "`unavailable_tools` won't work for you (not exposed here, or beyond your " +
  "access) — adapt accordingly. Size-capped; read-scope; requires the owner to " +
  "have enabled mcp.publish_skills.";

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
    "If `mutating` is true, this skill writes to the brain; confirm before doing so " +
      "if the user hasn't clearly asked for a write.",
  ],
} as const;
