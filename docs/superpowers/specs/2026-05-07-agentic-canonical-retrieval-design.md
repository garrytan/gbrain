# Agentic Canonical Retrieval for MBrain

## Purpose

This design makes MBrain retrieval safer and more useful for Codex, Claude
Code, and other agent clients. The user-facing problem is simple: `search` and
`query` return chunk snippets, and chunks often cut through meaning. The system
must show enough surrounding information for agents to understand the result,
without spending tokens as if every hit should become a full-page read.

The right fix is a retrieval contract that treats chunks as recall candidates,
then promotes selected candidates into bounded canonical evidence reads before
an agent answers.

## Problem

MBrain already stores canonical Markdown pages, section indexes, context maps,
scope gates, route planners, and retrieval traces. The failure is mostly in the
agent-facing retrieval surface.

Today an agent can do the following:

- run `search` or `query`
- see a short chunk excerpt
- infer meaning from that excerpt
- answer without reading the page, section, timeline entry, or source reference
  that actually gives the claim authority

Increasing chunk size would reduce some cut-off snippets, but it would also
spend more tokens on every result, including weak candidates. Hydrating the top
five results by default has the same problem: it improves context on average
while over-reading in common lookup cases. Graph-first retrieval is also wrong
as a default because graph edges and context maps are derived orientation, not
canonical truth.

The missing layer is progressive retrieval: discover cheaply, read canonically
only when needed, and make answerability explicit.

## Goals

1. Preserve token-efficient candidate discovery for `search` and `query`.
2. Prevent agents from treating chunks or graph edges as answer-grounding
   evidence.
3. Add an agent-facing retrieval facade that returns route, scope, candidates,
   required reads, warnings, and answerability state.
4. Add a bounded canonical reader that can read page, section, timeline, and
   source-reference selectors under a token budget.
5. Use context maps and backlinks to recommend reads and explain relationships,
   while requiring canonical follow-through before factual answers.
6. Support exact slug/path/section/source-ref lookup without fuzzy query hops.
7. Preserve existing scenario routing, scope gates, local/offline behavior, and
   canonical Markdown authority.
8. Measure success through actual agent tool-call transcripts, not only service
   unit tests.

## Non-Goals

- Do not replace Markdown pages as canonical memory.
- Do not make larger chunks the primary fix.
- Do not make top-five hydration automatic for every query.
- Do not make context maps, backlinks, embeddings, or retrieval traces
  authoritative truth sources.
- Do not make MBrain write the final natural-language answer. Agents still
  synthesize answers; MBrain supplies structured evidence and constraints.
- Do not bypass scope gates for personal or mixed-scope retrieval.
- Do not require managed Postgres-only behavior. SQLite and local/offline modes
  remain first-class.

## Core Design

Add two primary agent-facing operations:

1. `retrieve_context`
2. `read_context`

`retrieve_context` is the probe and planning operation. It classifies the
request, applies scope and route logic, discovers candidate pages or sections,
consults derived orientation when useful, and returns the next canonical reads.
It does not claim that the answer is ready except for narrow mention/existence
checks.

`read_context` is the bounded canonical evidence reader. It accepts selectors
from `retrieve_context`, explicit selectors from the caller, or `reads: "auto"`
for conservative automatic selection. It returns canonical text spans,
provenance, conflict and freshness warnings, continuation selectors, and an
`answer_ready` state.

The low-level `search` and `query` operations remain available, but their public
contract changes: they are candidate-discovery tools. Their chunks are pointers,
not answer evidence.

## Retrieval Flow

The normal agent loop becomes:

1. Exact selector check.
   - If the request includes a slug, file path, section id, source ref, task id,
     or profile/episode id, skip fuzzy discovery and go to the precise route.
2. Scope gate.
   - If personal or mixed-scope data could be disclosed, evaluate scope before
     returning candidates or snippets.
3. Scenario route.
   - Reuse `plan_scenario_memory_request`, `plan_retrieval_request`, and
     `select_retrieval_route` to decide whether this is task continuation,
     project Q&A, knowledge Q&A, broad synthesis, precision lookup, personal
     recall, or mixed.
4. Candidate discovery.
   - Use keyword search, hybrid search, manifests, sections, and context maps as
     appropriate for the route.
5. Candidate grouping.
   - Group chunks by canonical page and section. Return one candidate per
     meaningful canonical target, not one answer-shaped line per chunk.
6. Required reads.
   - Return selector-based read actions such as "read this section", "read this
     compiled-truth page", or "read timeline entries around this source ref".
7. Canonical read.
   - `read_context` loads only the selected canonical selectors under budget.
8. Agent answer.
   - The agent answers only when `read_context.answer_ready` is true or explains
     what remains unread or unsupported.

## Public Contract

### `retrieve_context`

Input fields:

- `query`: natural-language request.
- `task_id`: optional active task id.
- `repo_path`: optional active repository path.
- `requested_scope`: optional `work | personal | mixed`.
- `known_subjects`: optional detected slugs, paths, people, systems, or
  concepts.
- `selectors`: optional exact selectors.
- `limit`: candidate limit, default `5`.
- `token_budget`: planning output budget, default small.
- `include_orientation`: default `true`.
- `persist_trace`: default `false`.

Output fields:

- `request_id`
- `scenario`
- `scope_gate`
- `route`
- `answerability`
- `candidates`
- `required_reads`
- `orientation`
- `warnings`
- `trace`

`answerability` includes:

- `answerable_from_probe`: normally `false`
- `allowed_probe_answer_kind`: `mention_existence | slug_disambiguation | none`
- `must_read_context`: boolean
- `reason_codes`

Each candidate includes:

- `candidate_id`
- `canonical_target`
- `matched_chunks` metadata only: slug, page id, chunk source, score, and
  freshness. It must not expose snippet text as answer evidence.
- `why_matched`
- `activation`: `candidate_only | orientation_only | verify_first`
- `read_priority`
- `read_selector`

### `read_context`

Input fields:

- `query`: optional natural-language request for `reads: "auto"`.
- `selectors`: explicit selectors from `retrieve_context`.
- `reads`: optional `auto | explicit`; default `explicit`.
- `token_budget`: default moderate.
- `max_selectors`: default `3`.
- `include_timeline`: `auto | include | exclude`.
- `include_source_refs`: default `true`.
- `persist_trace`: default `false`.

Output fields:

- `answer_ready`
- `canonical_reads`
- `evidence_claims`
- `conflicts`
- `warnings`
- `unread_required`
- `continuations`
- `trace`

`answer_ready` includes:

- `ready`: boolean
- `answer_ground`: list of selectors that may support factual answer claims
- `unsupported_reasons`
- `citation_policy`

## Selector Model

Selectors are stable handles for bounded canonical reads. They are deliberately
more precise than a page slug and more authoritative than a search chunk.

Selector kinds:

- `page`
- `compiled_truth`
- `section`
- `line_span`
- `timeline_entry`
- `timeline_range`
- `source_ref`
- `task_working_set`
- `task_attempt`
- `task_decision`
- `profile_memory`
- `personal_episode`

Every selector includes:

- `selector_id`
- `kind`
- `scope_id`
- `slug` or domain object id
- `path` when known
- `section_id` when known
- `line_start` and `line_end` when known
- `source_refs`
- `content_hash`
- `freshness`

The section selector should use the existing note-section index:
`section_id`, `heading_path`, `line_start`, `line_end`, `section_text`,
`source_refs`, and `content_hash`. This lets MBrain read a meaningful semantic
span without loading the whole page.

## Authority And Answerability

The authority order remains:

1. User direct statement in the current interaction.
2. Exact current artifact verified in the workspace or source system.
3. Canonical compiled truth.
4. Timeline or source-record evidence.
5. Operational memory with valid applicability anchors.
6. Derived orientation artifact.
7. Unreviewed candidate.

`retrieve_context` results cannot be `answer_ground` except for explicit
mention/existence checks where the user only asks whether something appears in
memory. Even then, the output must label the answer as a search/probe result.

`read_context` is the only new retrieval operation that can return
`answer_ready.ready = true`. It may still return `false` when:

- required selectors were not read
- scope was denied or deferred
- the canonical page is stale-sensitive and needs live verification
- conflicting canonical evidence exists
- only derived orientation was available
- embeddings were unavailable and keyword fallback found weak candidates

## Token Budget Strategy

The design uses budget where it changes correctness:

- `retrieve_context` returns compact grouped candidates, not full text.
- Only top candidates get recommended canonical selectors.
- `read_context` reads at most `max_selectors` by default.
- Section reads are preferred over full-page reads when the question is narrow.
- Page compiled-truth reads are preferred when the question asks "what do we
  know about X?"
- Timeline reads are included only when the question is historical, asks "what
  happened", needs evidence, or compiled truth cites conflicting facts.
- Long reads return continuation selectors instead of overflowing the budget.

Default budgets should be conservative:

- exact lookup: one selector, small section or compiled-truth read
- narrow Q&A: one to three section selectors
- "tell me about X": compiled truth plus a small evidence sample
- broad synthesis: up to three canonical targets plus derived orientation
- task continuation: task state first, then working-set selectors

## Graph And Context Map Use

The knowledge graph is valuable, but not as a truth source. Use it for:

- discovering related pages when a query is broad
- explaining why two concepts are connected
- finding paths between entities
- ranking or grouping candidate pages
- recommending follow-up canonical reads
- detecting stale or missing links that should become maintenance candidates

Do not use it for:

- factual answer claims without canonical read-through
- hidden reranking that cannot be explained
- personal/work scope bridging before a scope-gate decision
- promotion of inferred facts directly into canonical pages

Graph-derived results must appear under `orientation`, `derived_consulted`, or
`recommended_reads`, never under `answer_ground` unless canonical evidence is
also read.

## Scenario-Specific Behavior

### Task Continuation

Task continuation reads TaskThread, WorkingSet, Attempts, and Decisions before
raw source files or graph orientation. If code claims are stale-sensitive,
`read_context` returns `verify_first`.

### Project And System Q&A

Project Q&A prefers exact project/system pages, codemap-backed concept pages,
and current workspace verification for branch-sensitive claims. Search chunks
can identify candidate pages, but the answer must come from canonical pages or
verified files.

### Knowledge Q&A

Knowledge Q&A reads compiled truth first, then timeline/source evidence when the
question asks for history, provenance, or conflict resolution.

### Personal Recall

Personal recall always runs scope gate before disclosure. In mixed requests,
work-visible candidate summaries and personal canonical reads remain separated
until policy allows bridging.

### Broad Synthesis

Broad synthesis may consult context maps and backlinks for orientation, but it
must return canonical reads as required follow-through. If no canonical read is
available, it returns a warning and `answer_ready=false` after `read_context`.

## Operation Relationship

Existing operations remain useful:

- `search`: fast keyword candidate discovery.
- `query`: hybrid candidate discovery.
- `get_page`: explicit full canonical page read.
- `get_note_section_entry`: exact section inspection.
- `query_context_map` and `find_context_map_path`: graph orientation.
- `plan_scenario_memory_request`: scenario classification and route hints.
- `select_retrieval_route`: explicit route execution.

New operations become the preferred agent surface:

- `retrieve_context`: "what should I read, and what am I allowed to infer?"
- `read_context`: "give me bounded canonical evidence for these selectors."

MCP tool descriptions and skills should instruct agents to prefer the new
facade for normal Q&A. Low-level tools remain available for debugging,
inspection, and explicit manual workflows.

## Tracing

Retrieval traces should distinguish:

- canonical reads
- derived consultations
- candidate-only snippets
- verification requirements
- scope-gate outcomes
- unanswered or unsupported claims

The trace must make it clear whether an agent answered from canonical evidence
or stopped after candidate discovery.

## Evaluation

Unit tests are necessary but insufficient. Acceptance requires transcript-level
agent replay where a simulated agent has access to the same MCP tool
descriptions a real Codex or Claude Code session would see.

Golden scenarios:

- exact slug lookup skips fuzzy search and reads canonical content
- chunk hit points to a section, then section evidence is read
- broad synthesis uses graph orientation but does not answer from graph alone
- missing embeddings fall back to keyword with explicit degradation warning
- task continuation reads task state before raw files
- personal scope denial returns no personal snippets
- stale code claim returns `verify_first`
- no-match query says what was tried and does not invent an answer

Primary metrics:

- grounded answer rate
- chunk-hallucination rate
- canonical-read follow-through rate
- over-read rate
- scope leak count
- explicit degradation rate
- trace completeness

Acceptance thresholds:

- zero scope leaks in the scenario suite
- zero graph-only factual answers
- lower chunk-hallucination rate than current baseline
- no meaningful increase in over-read rate on exact and narrow lookup tasks
- trace completeness at or above the existing scenario contract

## Rollout

Phase 1: Contracts and selector normalization.

- Add retrieval selector, candidate, answerability, read result, and trace types.
- Add selector formatting and parsing helpers.
- Keep existing operations behavior unchanged.

Phase 2: `read_context`.

- Implement bounded canonical reads for pages, compiled truth, sections,
  timeline/source refs, task memory, profile memory, and personal episodes.
- Add continuation selectors and answer-ready policy.

Phase 3: `retrieve_context`.

- Compose scenario planner, scope gate, precision lookup, search/query,
  broad-synthesis route, and graph orientation into one agent-facing probe.
- Return grouped candidates and required reads instead of larger snippets.

Phase 4: MCP/CLI/skill contract update.

- Change descriptions so agents know `search/query` are candidate tools.
- Document the `retrieve_context -> read_context -> answer` loop.
- Keep `get_page` as explicit full-page escape hatch.

Phase 5: Evaluation and hardening.

- Add transcript-level scenario replay.
- Add regression scenarios for graph-only answers, over-reading, missing
  embeddings, scope-gate denial, and continuation selectors.

## Resolved Decisions

- The optimal default is not larger chunks. It is progressive canonical
  retrieval.
- The optimal default is not top-five hydration. It is required-read planning
  plus bounded canonical reads.
- The graph is useful for orientation and recommendations, not authority.
- The primary consumer is an agent, so the API should return structured route
  and answerability fields, not just prettier human snippets.
- `read_context` is the new evidence boundary. `retrieve_context` discovers and
  plans; `read_context` grounds answers.
