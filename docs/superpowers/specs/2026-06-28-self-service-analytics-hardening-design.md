# MBrain Self-Service Analytics Hardening Design

Date: 2026-06-28
Status: Design spec (subagent-reviewed draft)
Author: scott.lee + agent

## Source Inspiration

This spec translates the useful parts of Anthropic's article
[How Anthropic enables self-service data analytics with Claude](https://claude.com/blog/how-anthropic-enables-self-service-data-analytics-with-claude)
into MBrain-specific improvements.

The article's central lesson is not "give agents more raw data." It is that
high-accuracy self-service agents need governed sources, procedural skills,
fresh reference docs, offline evals, online correction loops, and visible
provenance. MBrain already has a strong governed-memory substrate, so the right
move is to harden the existing evidence boundary rather than add a second truth
store.

## Goal

Make MBrain's agent-facing knowledge workflow more reliable by treating
agent rules, skillpack guides, retrieval evidence, evaluation results, and
trust metadata as one governed product surface.

The result should reduce silent wrong answers, stale skill behavior, and
ambiguous canonical-target selection while preserving the current safety model:
`retrieve_context` is a probe, `read_context` is the factual evidence boundary,
and durable writes route through `route_memory_writeback`.

## Problem

The current runtime has the right authority primitives:

- `retrieve_context` returns candidates, required reads, and read plans.
- `read_context` returns bounded canonical evidence.
- candidate signals and search/query chunks are not answer evidence.
- canonical writes require route-first governance.
- memory-report and doctor already expose operator health.

However, the surfaces around those primitives can drift:

- some older skillpack guides still teach `search/query/get` and direct
  `mbrain put` flows instead of `retrieve_context -> read_context` and routed
  writeback;
- MCP declares resource capability but returns an empty resource list, so
  packaged reference docs are not available as the same portable surface across
  clients;
- retrieval traces record operational route metadata, but not eval-run metadata
  such as fixture ID, skill version, model ID, git SHA, tokens, latency, or
  assertion-level pass/fail;
- context maps and source ranking already help orientation, but canonical
  pages lack explicit resolver metadata such as grain, exclusions, routing
  triggers, owner, and gotchas;
- users and operators do not get a standard trust footer that summarizes
  authority, freshness, source tier, excluded candidate-only signals, and next
  verification action.

## Non-Goals

- Do not build a generic analytics dashboard.
- Do not add arbitrary SQL generation or warehouse execution to MBrain.
- Do not treat raw source, prior query history, context maps, code-lane maps, or
  graph frontier as factual answer evidence.
- Do not let LLM-generated reference docs become canonical definitions without
  human/governed review.
- Do not stuff the full skillpack into MCP initialize instructions.
- Do not overload `retrieval_traces` with every eval field; keep traces
  operational and link eval records to them.

## Design Principles

1. **Preserve the evidence boundary.** All improvements must keep
   `read_context` as the canonical answer-grounding step.
2. **Use existing surfaces first.** Prefer docs contracts, MCP resources,
   memory-report, doctor, qrels gates, and retrieval traces before adding new
   product surfaces.
3. **Make drift visible.** Skillpack, guides, MCP docs resources, and installed
   prompt rules should be hashable and testable.
4. **Capture evals as telemetry.** Eval output should be durable, comparable,
   and linked to traces, model/runtime identity, and git state.
5. **Surface ambiguity, do not hide it.** If two canonical pages can answer a
   term with different grain or exclusions, `retrieve_context` should expose a
   disambiguation gap instead of relying on rank order alone.

## Design

### 1. Skill Surface Manifest And Drift Guard

Add a small manifest that describes the current agent reference surface:

- `docs/MBRAIN_AGENT_RULES.md`
- `docs/MBRAIN_SKILLPACK.md`
- selected skillpack guides:
  - `docs/guides/brain-agent-loop.md`
  - `docs/guides/brain-first-lookup.md`
  - `docs/guides/source-attribution.md`
  - `docs/guides/search-modes.md`
- `docs/MCP_INSTRUCTIONS.md`
- setup-agent injected prompt and hook fragments

The manifest should include stable IDs, version strings where present, relative
paths, SHA-256 content hashes, and whether each document is agent-loadable,
MCP-resource-loadable, or docs-only.

The first pass covers packaged docs and setup-agent fragments only. Packaged
runtime skills under `skills/**/SKILL.md` are scanned by the stale-flow contract
tests, but broad skill-resource exposure is explicitly out of scope for this
spec; a separate package-size and surface-safety review must choose any
additional skill resources.

Initial implementation shape:

- create `src/core/services/skill-surface-manifest-service.ts`;
- add a generated or deterministic manifest command under the existing CLI;
- add contract tests that fail when examples teach stale flows:
  - factual answers must mention `retrieve_context` and `read_context`;
  - direct `put_page` or `mbrain put` examples must be paired with
    `route_memory_writeback`, `write_session_id`, or
    `expected_content_hash`;
  - no guide may imply search/query chunks are factual evidence.

This directly addresses the Anthropic article's skill maintenance lesson:
procedural docs are accuracy-critical and must be maintained like code.

### 2. MCP Documentation Resources

Expose the same manifest-backed docs as MCP resources while keeping
`get_skillpack` as the compact tool path.

Initial resource URIs:

- `mbrain://docs/agent-rules`
- `mbrain://docs/skillpack`
- `mbrain://docs/guides/brain-agent-loop`
- `mbrain://docs/guides/brain-first-lookup`
- `mbrain://docs/guides/source-attribution`
- `mbrain://docs/guides/search-modes`
- `mbrain://docs/mcp-instructions`

Resource metadata should include:

- title,
- description,
- MIME type `text/markdown`,
- manifest hash,
- packaged rules or skillpack version when available.

The resource implementation must not expand MCP initialize instructions. The
instructions remain short; docs are loaded on demand through resources or
`get_skillpack`.

Implementation details:

- import and handle both `ListResourcesRequestSchema` and
  `ReadResourceRequestSchema` in `src/mcp/server.ts`;
- `resources/list` returns manifest-backed resources with `uri`, `name`,
  `description`, and `mimeType: 'text/markdown'`;
- `resources/read` returns `{ contents: [{ uri, mimeType: 'text/markdown', text }] }`;
- unknown resource URIs return a structured MCP error instead of falling back to
  filesystem paths;
- update HTTP and stdio/e2e tests that currently assert an empty resource list;
- update docs that currently describe MCP resources as intentionally empty.

### 3. Trust Footer Contract

Add a structured trust footer payload to answer-grounding results. The footer is
not meant to make answers correct by itself. It makes the current authority and
residual risk visible.

Proposed type:

```ts
type AnswerTrustFooter = {
  authority_class: 'canonical_read' | 'operational_memory' | 'candidate_only' | 'raw_audited_redacted' | 'not_answer_evidence';
  underlying_authorities: string[];
  evidence_selectors: string[];
  source_refs: string[];
  excluded_signals: Array<{
    kind: 'candidate_signal' | 'search_chunk' | 'graph_frontier' | 'context_map' | 'raw_source';
    reason: string;
  }>;
  freshness: {
    content_hashes: string[];
    derived_index_status: 'current' | 'stale' | 'unknown';
    generated_at: string;
  };
  write_status: 'no_write' | 'candidate_created' | 'write_session_open' | 'write_session_expired' | 'canonical_write_applied';
  next_verification_action: string | null;
  trace_ids: string[];
};
```

Add `answer_trust_footer?: AnswerTrustFooter` to `ReadContextResult` and, where
needed for probe-only output, to `RetrieveContextResult`.

Initial attachment points:

- `retrieve_context` result: may include a probe footer that says the result is
  not answer evidence and records excluded candidate/search/graph/context-map
  signals;
- `read_context` result: generated from `canonical_reads`,
  `evidence_metadata`, `warnings`, `unread_required`, and trace IDs;
- optional probe-to-read handoff: `read_context` accepts a bounded
  `probe_context` object containing candidate-signal IDs/counts, search chunk
  counts, graph/context-map orientation flags, and retrieve trace IDs from the
  immediately preceding `retrieve_context` call. This object contains no raw
  candidate text and exists only so the footer can report what was explicitly
  excluded from answer evidence;
- memory-report JSON/text: generated per exception section where evidence,
  owner action, and verification command can be summarized;
- doctor agent explain JSON: include whether the installed agent can produce or
  preserve this footer.

The footer should explicitly say when candidate signals were seen but excluded
from answer evidence. If no `probe_context` is supplied, `read_context` still
returns a footer, but `excluded_signals` is limited to what the read result can
observe directly and `trace_ids` is empty when `persist_trace` is false.

### 4. Context Eval Ledger

Add a first-class eval ledger linked to retrieval traces instead of adding all
eval data to `retrieval_traces`.

Proposed tables:

```sql
CREATE TABLE context_eval_runs (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL,
  fixture_id TEXT NOT NULL,
  git_sha TEXT NOT NULL,
  agent_rules_version TEXT,
  skillpack_version TEXT,
  model_id TEXT,
  provider TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE context_eval_assertions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES context_eval_runs(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  assertion_key TEXT NOT NULL,
  expected JSONB NOT NULL DEFAULT '{}',
  actual JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  reason_codes JSONB NOT NULL DEFAULT '[]',
  retrieval_trace_ids JSONB NOT NULL DEFAULT '[]',
  token_count INTEGER,
  wall_clock_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The SQL above is the logical model. Implementation must add matching schema and
engine work across supported backends:

- add `ContextEvalRun` and `ContextEvalAssertion` types;
- add create/list/get methods to `BrainEngine`;
- implement row mappers and storage methods in SQLite, PGLite, and Postgres
  engine paths;
- add SQL to `src/schema.sql`;
- add migrations in `src/core/migrate.ts`;
- regenerate embedded schemas with `bun run build:schema`;
- add schema and migration tests.

`retrieval_trace_ids` is a denormalized array of trace IDs for the first
version, not a foreign-keyed relationship. A join table is deliberately deferred
unless query patterns show the denormalized array is insufficient.

Initial CLI:

```bash
mbrain eval context --fixture test/fixtures/source-aware-retrieval-quality-qrels.json --json
mbrain eval context --compare base.json head.json --json
```

Add `src/commands/eval.ts`, wire the `eval` command family into `src/cli.ts`
command dispatch and help text, and include it in CLI contract tests.

Fixture modes:

- `mode: injected_candidates` reuses the existing qrels-style gate for stable
  selection-math tests;
- `mode: live_retrieve` imports or points at a configured test brain, runs
  `retrieve_context` with `persist_trace: true`, then runs `read_context` with
  `persist_trace: true` and the probe-to-read footer handoff.

The first implementation should support `injected_candidates` and one small
`live_retrieve` fixture. It should assert:

- top-1 canonical slug or selector,
- recall@10,
- `answer_ready.ready`,
- no candidate/search/graph-only evidence counted as factual answer evidence,
- optional token/latency budget.

Comparison mode should report deltas and fail only on configured regressions.
This makes PR-level ablation possible without requiring a new service or UI.

### 5. Resolver Metadata For Canonical Pages

Add optional resolver metadata to canonical page frontmatter and extract it into
note manifests.

Suggested fields:

```yaml
canonical_subject_key: mbrain/retrieval/evidence-boundary
definition_owner: mbrain
semantic_grain: repository-runtime-contract
applies_to:
  - retrieve_context
  - read_context
excludes:
  - raw_source_as_answer_evidence
routing_triggers:
  - evidence boundary
  - probe candidates are not evidence
gotchas:
  - search and query chunks are pointers, not answer evidence
```

Manifest extraction should persist these fields and include them in source-set
hashing so stale context maps can be detected when resolver metadata changes.

Persist them as a typed `resolver_metadata` object on note manifest entries
rather than requiring callers to parse raw frontmatter. Add the same object to
manifest JSON payloads used by context-map/source-set hashing.

`retrieve_context` should use the metadata as a resolver feature:

- exact `canonical_subject_key` or `routing_triggers` match boosts the canonical
  page over weaker raw lexical matches;
- `excludes` can demote a page or add a gap reason when the user's query is
  outside scope;
- `gotchas` can appear in `read_plan.next_actions`;
- shared aliases or subject keys with incompatible grain/exclusions should
  create an ambiguity gap, not a silent rank-order choice.

Add explicit read-plan gap reasons and optional details:

```ts
type ResolverGapReason =
  | 'resolver_metadata_ambiguity'
  | 'resolver_scope_excluded';

type ResolverGapDetail = {
  reason: ResolverGapReason;
  subject_key?: string;
  candidate_slugs: string[];
  grain_values?: string[];
  exclusions?: string[];
};
```

The public `read_plan.gap_reasons` should include the named reason, while a
structured `read_plan.resolver_gaps` array carries details for clients that can
render ambiguity or exclusion guidance.

This is MBrain's equivalent of a thin semantic layer. It enriches existing
compiled-truth pages rather than creating a separate definition store.

### 6. Memory Report And Doctor Summary

Extend existing operator surfaces instead of adding a dashboard.

Memory report should include:

- last context eval run per suite,
- failed eval assertions by reason code,
- correction-harvest backlog,
- stale skill surface or manifest hash drift,
- trust footer coverage gaps,
- top candidate-only signals seen but not promoted into canonical evidence.

Doctor agent explain should include:

- required tools: `retrieve_context`, `read_context`,
  `route_memory_writeback`, `get_skillpack`;
- docs resource availability and manifest hash;
- managed rules block hash and packaged rules version;
- whether the installed prompt/hook surface preserves the evidence boundary.

### 7. Correction Harvesting

Add a boring, governed path for online corrections:

- a correction is linked to a trace ID or answer footer when available;
- it becomes a proposed eval assertion or Memory Inbox candidate;
- it does not become canonical truth automatically;
- report surfaces show owner action and verification command.

The first version is manual and CLI/API-driven:

```bash
mbrain eval correction record --trace-id <id> --case-id <id> --reason "<summary>" --json
```

It stores correction metadata linked to trace/footer IDs, creates either a
candidate eval assertion or a Memory Inbox candidate through existing governed
routes, and exposes the backlog in memory-report. Automated channel scanning is
future work and should be gated by source permissions.

## Acceptance Criteria

### Skill Surface

- all manifest docs, plus scanned `skills/**/SKILL.md` files, pass the stale-flow
  contract check.
- `brain-agent-loop`, `brain-first-lookup`, `source-attribution`, and
  `search-modes` no longer teach stale direct answer/write flows.
- A docs contract test fails if a guide shows `mbrain put` or `put_page`
  without route-first governance context.
- A manifest test proves packaged agent rules, skillpack, and selected guides
  have stable IDs and hashes.

### MCP Resources

- `resources/list` returns non-empty documentation resources with stable
  `mbrain://docs/...` URIs.
- `resources/read` is implemented through `ReadResourceRequestSchema` and
  returns the same packaged content hash as the manifest.
- `get_skillpack` no-arg output still returns `MBRAIN_AGENT_RULES.md`.
- MCP initialize instructions remain compact.
- existing tests and docs that asserted empty MCP resources are updated to the
  new docs-resource contract.

### Trust Footer

- `read_context` returns a trust footer whenever it returns canonical reads.
- The footer includes selector IDs, source refs, content hashes, and any
  candidate-only exclusions supplied through the probe-to-read handoff.
- If `read_context` is not answer-ready, the footer's `authority_class` is not
  `canonical_read`.
- The footer preserves underlying read authorities instead of flattening
  `canonical_compiled_truth`, `source_or_timeline_evidence`, `profile_memory`,
  or `personal_episode` into one value.

### Eval Ledger

- `mbrain eval context --fixture ... --json` records one eval run and assertion
  rows linked to retrieval/read traces.
- live retrieval fixture rows have non-empty linked trace IDs because the CLI
  forces `persist_trace: true`.
- The JSON report includes suite ID, fixture ID, git SHA, skill/rules versions,
  model/provider when available, pass/fail counts, token counts, and wall-clock.
- Compare mode reports base/head deltas and fails on configured regression
  thresholds.
- schema, migration, SQLite, PGLite, and Postgres tests cover the eval ledger.

### Resolver Metadata

- note manifest tests prove resolver metadata is parsed, persisted, and included
  in source-set hashes.
- `retrieve_context` boosts exact routing-trigger/subject-key matches without
  allowing probe candidates to become answer evidence.
- shared subject keys with incompatible grain/exclusions surface an ambiguity
  gap.
- `resolver_metadata_ambiguity` and `resolver_scope_excluded` are public
  read-plan gap reasons with structured `resolver_gaps` details.
- context maps and graph frontier remain orientation only.

### Operator Surfaces

- memory-report JSON and text include eval and skill-surface drift summaries.
- doctor agent explain verifies `get_skillpack` and docs resources in addition
  to the current required tools.
- raw-source reporting remains count/status based and never prints raw body text
  as proof.

### Correction Intake

- `mbrain eval correction record ... --json` records a correction linked to a
  trace/footer when supplied.
- correction intake can create a proposed eval assertion or governed Memory
  Inbox candidate, but never writes canonical truth directly.
- memory-report includes correction backlog counts and owner actions.

## Rejected Ideas

- **Raw query/source retrieval as a source of truth.** It can help investigation
  but should not bypass canonical reads.
- **A second semantic store.** Resolver metadata belongs on existing canonical
  pages and manifests.
- **A new dashboard first.** CLI JSON, memory-report, and doctor are enough for
  the first version.
- **Always-on adversarial review.** It may improve accuracy for high-risk
  answers, but token and latency cost make it a tiered follow-up, not the
  default.
- **LLM-owned definitions.** LLMs can draft reference docs or eval candidates,
  but governed pages remain the authority.

## Rollout Order

1. Refresh stale skillpack guides and add docs contract tests.
2. Add skill surface manifest and MCP docs resources.
3. Add `read_context` trust footer.
4. Add context eval ledger and `mbrain eval context`.
5. Add resolver metadata extraction and ranking/gap behavior.
6. Extend memory-report and doctor summaries.
7. Add correction harvesting from explicit trace-linked corrections.

Each step is independently useful and testable. None requires weakening current
writeback or evidence governance.

## Verification Plan

Baseline before this spec:

- `bun install --frozen-lockfile`
- `bun run typecheck`

Implementation verification should include:

- `bun run typecheck`
- `bun run build:schema`
- `bun run build:edge`
- targeted unit tests for each service changed
- MCP server resource list/read tests
- installed MCP smoke with docs resource discovery
- docs contract tests for stale flow examples
- `bun run test:agent-trust`
- targeted memory-report and doctor tests
- schema, migration, SQLite, PGLite, and Postgres tests for eval ledger changes
- context eval CLI fixture run with JSON output

## Subagent Review Inputs

Four read-only subagents reviewed the repo from separate perspectives:

- skillpack and documentation drift;
- retrieval evaluation and telemetry;
- canonical resolver and semantic-layer analogue;
- operator UX and implementation risk.

Their shared conclusion was that MBrain already has the core governed-memory
substrate. The highest-fit improvements are drift guards, trust footer,
eval telemetry, resolver metadata, MCP documentation resources, and operator
reporting. They also converged on the same anti-requirements: do not add a
parallel truth store, do not promote raw retrieval to answer evidence, and do
not make hidden correctness look more certain than it is.
