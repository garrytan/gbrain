# RFC: MCP Server Instructions + Tool Descriptions — Brain-First Lookup Enforcement

**Status:** Proposed (revised after critical review)
**Date:** 2026-04-16
**Decision type:** Architecture + agent behavior
**Revision:** v2 — incorporates critical review feedback (path resolution, instructions scope, tool descriptions)

---

## 1. Summary

GBrain's MCP server should provide an `instructions` string in its `InitializeResult` **and** improve its core tool descriptions so that AI agents — main or sub-agent — know **when** and **why** to use GBrain tools without relying on CLAUDE.md injection alone.

Today, brain-first lookup is enforced only through markdown rules injected into agent config files (`~/.claude/CLAUDE.md`). This is fragile: sub-agents spawned mid-conversation don't follow these rules reliably, and the instructions compete with dozens of other rules for attention.

This RFC proposes three coordinated changes:

1. **MCP server instructions** — a concise trigger telling agents when to use GBrain
2. **Improved tool descriptions** — actionable, context-rich descriptions for the core search/query/get tools
3. **CLAUDE.md deduplication** — remove "when to use" triggers from agent rules (now covered by instructions), keeping only "how to use" protocol

---

## 2. Motivation

### 2.1 The Problem: Agents Ignore Brain-First Lookup

An experiment on 2026-04-16 demonstrated the failure:

| Agent type | Question | GBrain calls | Behavior |
|---|---|---|---|
| Main agent (explicit gbrain request) | "TLB 동작을 설명 + gbrain에서 탐색하세요" | 3 (search, get x2) | Brain-first, rich context |
| Sub-agent (pure question) | "TLB 동작을 간단히 설명해주세요" | **0** | Grep/Read codebase directly |

The sub-agent had access to all GBrain MCP tools (listed in deferred tools) but chose not to use them.

**Experiment limitations (acknowledged):** This is N=1. The two conditions differ in three ways: (a) explicit gbrain instruction in the prompt, (b) different question text, (c) main vs sub-agent context. The experiment does not isolate which variable caused the failure. The fix addresses (b) and (c) but a controlled multi-trial validation is required before declaring success (see Section 7.2).

### 2.2 Root Cause Analysis

Three contributing factors, each requiring a different fix:

| Factor | Layer | Fix |
|---|---|---|
| **No protocol-level trigger** — MCP server never tells agents when to use its tools | MCP instructions | Add `instructions` field |
| **Generic tool descriptions** — `search` described as "Keyword search using full-text search" gives no reason to prefer it over Grep | Tool descriptions | Rewrite core tool descriptions with trigger context |
| **Signal dilution** — GBrain rules buried in long CLAUDE.md among dozens of other rules | CLAUDE.md | Remove "when" triggers (now redundant with instructions) |

Instructions alone are **necessary but not sufficient**. The highest-ROI change is improving tool descriptions, because descriptions are shown at the decision point — when the agent chooses which tool to call. Instructions are shown once at session start.

### 2.3 The Working Model: Context7

Context7 succeeds because of two factors working together:
1. **MCP instructions** — "Use this server to fetch current documentation whenever the user asks about a library..."
2. **Small tool surface** — only 2 tools (resolve-library-id, query-docs), making the decision trivial

GBrain has 31 tools. Adding instructions without improving discoverability risks the same failure. This RFC addresses both.

### 2.4 Why This Matters

Without these changes, GBrain is a passive tool catalog. The agent can use it but doesn't know it should. With instructions + better descriptions, GBrain becomes discoverable: agents check the brain before searching, the brain compounds knowledge, and future lookups get richer.

---

## 3. Problem Statement

GBrain's MCP server has two discoverability gaps:

1. **No server instructions** — agents don't know when to prefer GBrain tools
2. **Generic tool descriptions** — core tools (`search`, `query`, `get_page`) describe mechanics ("keyword search") instead of purpose ("look up people, concepts, systems")

Additionally:

3. **CLAUDE.md redundancy** — when MCP instructions provide trigger conditions, the "when to use" content in CLAUDE.md becomes redundant noise
4. **31-tool choice paralysis** — agents face a large tool surface; better descriptions help them select the right 3-4 core tools

---

## 4. Goals

### 4.1 Primary goals

- Add `instructions` to the GBrain MCP server `InitializeResult`
- Rewrite descriptions for core tools (`search`, `query`, `get_page`, `put_page`) to include trigger context and domain specificity
- Remove "when to use" triggers from `GBRAIN_AGENT_RULES.md` (covered by instructions)
- Include a negative list in instructions (what NOT to use GBrain for)

### 4.2 Quality goals

- **Minimal change footprint** — `server.ts` (instructions constant + tool descriptions in operations.ts)
- **Backward compatible** — older MCP clients that don't read `instructions` are unaffected
- **Measurable** — verifiable via controlled sub-agent experiment
- **No competing "use me first"** — domain-specific triggers that don't conflict with Context7 or other servers

### 4.3 Success criteria

| Metric | Before | Target |
|---|---|---|
| Sub-agent GBrain calls for entity/concept question (Korean) | 0 | ≥1 (search or query) |
| Sub-agent GBrain calls for entity/concept question (English) | 0 | ≥1 (search or query) |
| Main agent GBrain calls without explicit prompt | Inconsistent | Consistent |
| Instructions visible in system prompt | No | Yes (under MCP Server Instructions) |
| MCP instructions visible in sub-agent context | Unknown | Verified (Phase 0 gate) |

---

## 5. Non-Goals

- **Replacing CLAUDE.md rules entirely** — instructions say *when*, rules say *how*. Both are needed, but with clear separation.
- **Forcing GBrain usage for all queries** — only entity/concept/system questions should trigger brain-first lookup.
- **Reducing tool count** — 31 tools serve different use cases. Better descriptions address the discoverability problem without removing functionality. A composite `lookup` tool is a potential future optimization.
- **Modifying setup-agent injection** — the CLAUDE.md rules content changes, but the injection mechanism remains as-is.

### On Programmatic Hooks

Programmatic enforcement (e.g., PreToolUse hook that intercepts Grep calls) was considered and explicitly deferred. Rationale:

- **Pros:** Stronger enforcement; fires at the exact decision point
- **Cons:** Invasive (modifies user's global settings), noisy (fires on every Grep even for legitimate code searches), fragile (breaks when hook config changes)
- **Decision:** MCP instructions + better tool descriptions first. If sub-agent compliance remains below 50% after 2 weeks of measurement, revisit hooks as a supplementary measure.

---

## 6. Design

### 6.1 MCP SDK API

The `@modelcontextprotocol/sdk` Server constructor accepts `instructions` in `ServerOptions`:

```typescript
// node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts
export type ServerOptions = ProtocolOptions & {
  capabilities?: ServerCapabilities;
  instructions?: string;  // ← this field
};
```

When a client sends `initialize`, the server includes `instructions` in the response. The client renders this in the system prompt under "MCP Server Instructions".

**Note:** The SDK marks `Server` as deprecated in favor of `McpServer`. Migration to `McpServer` is out of scope for this RFC but should be tracked as separate technical debt.

### 6.2 Instructions Text

Design principles:
- **Read-trigger only** — no write-back directives (that belongs in CLAUDE.md protocol)
- **Domain-specific** — list exactly what GBrain covers, not a blanket "use me first"
- **Negative list** — explicitly say what GBrain is NOT for (avoids conflict with Context7 etc.)
- **Under 400 characters** — shorter than Context7's (~350), forcing focus

Proposed text:

```
Use this server to look up knowledge about people, companies, technical concepts, internal systems, and organizational context. Prefer this over web search or codebase grep when the question involves a named entity, domain concept, or cross-system architecture. The brain contains compiled truth, relationship history, and technical maps that external search cannot provide.

Do not use for: code editing, git operations, file management, library documentation, or general programming.
```

(~430 characters)

**Changes from v1:**
- Removed "BEFORE searching the web or codebase" (absolutist claim that conflicts with other servers)
- Removed "Also write back new information" (write-back is a complex protocol, not a trigger)
- Added negative list (prevents false triggers, avoids competition with Context7)
- Changed "always call search or query first" to "Prefer this over" (softer, more accurate)

### 6.3 Tool Description Improvements

This is the highest-ROI change. Current vs proposed descriptions for core tools:

**`search` (keyword search)**
- Current: `"Keyword search using full-text search"`
- Proposed: `"Search the knowledge graph for people, companies, concepts, systems, and organizational context by keyword. Use this BEFORE Grep or WebSearch when the question involves a named entity or domain-specific topic. Returns matching pages with relevance scores."`

**`query` (hybrid search)**
- Current: `"Hybrid search with vector + keyword + multi-query expansion"`
- Proposed: `"Semantic search across the knowledge graph. Use when the question is conceptual, cross-cutting, or when keyword search returned no results. Combines vector similarity with keyword matching for best recall."`

**`get_page` (read page)**
- Current: `"Read a page by slug (supports optional fuzzy matching)"`
- Proposed: `"Read a specific knowledge page by slug. Use after search or query returns a relevant slug. Pages contain compiled truth (current understanding) and timeline (evidence history)."`

**`put_page` (write page)**
- Current: `"Write/update a page (markdown with frontmatter). Chunks, embeds, and reconciles tags."`
- Proposed: `"Create or update a knowledge page. Use to record new information about people, companies, concepts, or systems discovered during the conversation. Content should follow the compiled truth + timeline pattern."`

### 6.4 Compiled-In Instructions (No File Loading)

**Revised decision:** Use a compiled-in string constant instead of file loading.

Rationale (from critical review):
- The instructions text is ~430 characters — not a configuration file that evolves independently
- `import.meta.url` path resolution breaks in Bun compiled binaries (`bin/gbrain`), causing silent fallback to hardcoded default in production
- Silent fallback means you never notice when the file is missing — a debugging trap
- When instructions change, you want to rebuild and verify anyway
- "Non-technical contributors" is speculative for a personal knowledge system

```typescript
// server.ts — compiled-in constant
const INSTRUCTIONS = [
  'Use this server to look up knowledge about people, companies, technical concepts,',
  'internal systems, and organizational context. Prefer this over web search or codebase',
  'grep when the question involves a named entity, domain concept, or cross-system',
  'architecture. The brain contains compiled truth, relationship history, and technical',
  'maps that external search cannot provide.',
  '',
  'Do not use for: code editing, git operations, file management, library documentation,',
  'or general programming.',
].join(' ').replace(/  +/g, ' ').trim();

export async function startMcpServer(engine: BrainEngine) {
  const server = new Server(
    { name: 'gbrain', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
    },
  );
  // ... rest unchanged
}
```

A copy of the instructions text will also be placed in `docs/MCP_INSTRUCTIONS.md` as **documentation** (not loaded at runtime), so the text is reviewable alongside other agent docs.

### 6.5 CLAUDE.md Agent Rules Deduplication

With MCP instructions covering "when to use GBrain", trim `GBRAIN_AGENT_RULES.md` Section 2 to remove trigger framing ("Before calling ANY external API...") and keep only the step-by-step protocol:

**Before (Section 2):**
```markdown
## 2. Brain-First Lookup (before every entity or technical question)

Before calling ANY external API or broad code search to research a person,
company, concept, system, or topic:

1. gbrain search "name"
2. gbrain query "what do we know about name"
3. gbrain get <slug>
4. External APIs as FALLBACK only
```

**After:**
```markdown
## 2. Brain-First Lookup Protocol

When using GBrain for lookup (triggered by MCP server instructions):

1. gbrain search "name"          -- keyword match, fast, always works
2. gbrain query "what do we know about name"  -- hybrid search (needs embeddings)
3. gbrain get <slug>             -- direct page read when you know the slug

Stop at the first step that gives you what you need.
```

The trigger condition ("before every entity or technical question") moves to MCP instructions. The protocol steps remain in CLAUDE.md.

### 6.6 Layered Enforcement Model (revised)

```
┌─────────────────────────────────────────────────┐
│ Layer 1: MCP Instructions                       │
│ → "WHEN to use GBrain" (trigger conditions)     │
│ → Concise, shown in system prompt               │
│ → Verified for: main agent, sub-agent (Phase 0) │
├─────────────────────────────────────────────────┤
│ Layer 1b: Tool Descriptions                     │
│ → "WHY to prefer this tool" (at decision point) │
│ → Shown when agent selects tools                │
├─────────────────────────────────────────────────┤
│ Layer 2: CLAUDE.md Agent Rules                  │
│ → "HOW to use GBrain" (step-by-step protocol)   │
│ → Brain-Agent Loop, entity detection,           │
│   source attribution, back-linking, sync        │
├─────────────────────────────────────────────────┤
│ Layer 3: Skillpack                              │
│ → "REFERENCE" for advanced patterns             │
│ → Enrichment, meeting ingestion, cron           │
└─────────────────────────────────────────────────┘
```

**Layer 1b is new.** Tool descriptions operate at the decision point (when the agent chooses which tool to call), making them potentially more effective than session-level instructions.

---

## 7. Testing Strategy

### 7.0 Phase 0 Gate: Sub-Agent MCP Instruction Delivery

**This must be verified BEFORE implementation begins.**

Spawn a sub-agent and ask it: "List the MCP server instructions you can see in your system prompt. Report the exact text for each server."

If gbrain's MCP instructions do NOT appear in the sub-agent's context, the entire instructions approach fails for sub-agents and we need an alternative strategy (e.g., improved tool descriptions alone, or hooks).

### 7.1 Unit Test: Instructions and Descriptions

```typescript
test('MCP server includes instructions in initialize response', async () => {
  const { server } = await createTestServer();
  const result = await server.handleInitialize({ ... });
  expect(result.instructions).toBeDefined();
  expect(result.instructions).toContain('people, companies, technical concepts');
  expect(result.instructions).toContain('Do not use for');
});

test('core tool descriptions include trigger context', async () => {
  const tools = await server.listTools();
  const search = tools.find(t => t.name === 'search');
  expect(search.description).toContain('BEFORE Grep or WebSearch');
});
```

### 7.2 Controlled Sub-Agent Experiment

Multi-trial test with variable isolation:

| Trial | Question | Language | Expected trigger |
|---|---|---|---|
| 1 | "What do we know about TLB in our systems?" | English | search/query |
| 2 | "TLB 동작을 간단히 설명해주세요" | Korean | search/query |
| 3 | "Fix the off-by-one error in krt_copy" | English | No gbrain (code task) |
| 4 | "Who is Chan Heo?" | English | search (person) |

Each trial spawns a fresh sub-agent. Success = gbrain called for trials 1/2/4, NOT called for trial 3.

### 7.3 Build Verification

```bash
bun build --compile --outfile bin/gbrain src/cli.ts
# Verify no build errors
```

---

## 8. Migration & Rollout

### Phase 0: Verify Sub-Agent Delivery (pre-implementation gate)

1. Spawn a sub-agent
2. Ask it to report MCP server instructions in its context
3. If gbrain instructions are NOT visible → stop, investigate alternative approach
4. If visible → proceed to Phase 1

### Phase 1: Implementation

1. Add `INSTRUCTIONS` constant to `server.ts`
2. Pass `instructions` in Server constructor options
3. Update tool descriptions in `operations.ts` for search, query, get_page, put_page
4. Trim GBRAIN_AGENT_RULES.md Section 2 (remove trigger framing, keep protocol)
5. Place instructions copy in `docs/MCP_INSTRUCTIONS.md` (documentation only)
6. Add unit tests
7. Verify build

### Phase 2: Validation

1. Restart GBrain MCP server
2. Verify instructions appear in system prompt
3. Run controlled sub-agent experiment (Section 7.2)
4. Measure: ≥3/4 trials match expected behavior

### Phase 3: Iteration (ongoing)

1. Monitor agent behavior for 2 weeks
2. Tune instructions text and tool descriptions based on observed trigger accuracy
3. If sub-agent compliance < 50% after 2 weeks, escalate to hooks (see Section 5)

---

## 9. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Instructions insufficient alone | High | Medium | Tool descriptions are the primary fix; instructions are supplementary |
| Sub-agent doesn't receive MCP instructions | Medium | High | Phase 0 gate — verify before implementing |
| Agent ignores instructions (too long) | Medium | Medium | Keep under 400 chars; include negative list to reduce noise |
| Tool descriptions too long → agent truncates | Low | Medium | Keep each description under 250 chars |
| Competing "use me first" with other servers | Low | Low | Domain-specific triggers + negative list avoids overlap |
| CLAUDE.md deduplication introduces gap | Low | Medium | Verify CLAUDE.md + instructions together cover full protocol |

---

## 10. Open Questions

1. **Should instructions be tested in both Korean and English?** The triggering failure was a Korean-language question. English instructions may not fire reliably for Korean triggers. **Resolved:** Yes — Korean test case included in Section 7.2 (trial 2).

2. **Should CLAUDE.md Section 2 be trimmed in the same PR?** Critical review says yes — shipping known redundancy invites "clean up later, never do." **Resolved:** Yes — CLAUDE.md deduplication is Phase 1, not a follow-up.

3. **Should a composite `lookup` tool be added?** A single tool that combines search → query → get_page would reduce agent decision surface from 31 tools to 1 for the common case. **Deferred:** Out of scope for this RFC. Track as a potential v2 optimization if sub-agent compliance remains below target.

4. **Should the `Server` class be migrated to `McpServer`?** The SDK marks `Server` as deprecated. **Deferred:** Separate technical debt item. This RFC's changes work with either class.

---

## 11. Appendix

### A. Context7 Instructions (reference)

```
Use this server to fetch current documentation whenever the user asks about a
library, framework, SDK, API, CLI tool, or cloud service -- even well-known ones
like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This
includes API syntax, configuration, version migration, library-specific
debugging, setup instructions, and CLI tool usage. Use even when you think you
know the answer -- your training data may not reflect recent changes. Prefer
this over web search for library docs.

Do not use for: refactoring, writing scripts from scratch, debugging business
logic, code review, or general programming concepts.
```

### B. Experiment Log

**Date:** 2026-04-16
**Environment:** Claude Code (Opus 4.6, 1M context), rbln-kernel-poc repo
**Branch:** dev (commit 5e4b463)

| Test | Agent type | GBrain tools available | GBrain calls | Tool call sequence |
|---|---|---|---|---|
| 1 | Main (explicit request) | Yes | 3 | search → get_page x2 |
| 2 | Sub-agent (pure question) | Yes (deferred) | **0** | Grep x4 → Read x9 |

**Limitations:** N=1, variables not isolated (prompt content, agent type, and question text all differ). Results are indicative, not conclusive.

**Conclusion:** MCP tool availability alone is insufficient. Agents need protocol-level instructions AND actionable tool descriptions to trigger brain-first lookup.

### C. Critical Review Summary (2026-04-16)

Two independent reviews were conducted:

**Code reviewer findings:**
- CRITICAL: Path resolution breaks in compiled binary (fix: compiled-in constant)
- HIGH: Write-back directive misplaced in instructions (fix: removed)
- HIGH: Experiment is N=1 (fix: acknowledged, multi-trial validation added)
- MEDIUM: Sub-agent MCP instruction delivery unverified (fix: Phase 0 gate added)

**Architect findings:**
- Instructions are necessary but not sufficient (fix: tool descriptions added as primary intervention)
- File-based loading over-engineered (fix: compiled-in constant)
- 31 tools cause choice paralysis (fix: improved core tool descriptions)
- Competing "use me first" risk (fix: negative list added, absolutist phrasing removed)
- CLAUDE.md redundancy should be addressed in same PR (fix: Section 6.5 added)
