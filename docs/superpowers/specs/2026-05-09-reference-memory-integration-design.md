# Reference-Informed Memory Integration for MBrain

## Purpose

This design folds useful patterns from two local reference systems into mbrain
without importing their product shape wholesale. The goal is to improve memory
quality, review safety, relationship discovery, and operator visibility while
preserving mbrain's existing contract:

- Markdown remains the canonical human-editable substrate.
- Derived maps, indexes, reports, and digests remain regenerable orientation.
- Uncertain or inferred updates flow through Memory Candidates and governed
  patch paths before touching canonical truth.
- Local/offline operation remains first-class.
- CLI and MCP continue to expose behavior through the shared operation registry.

This is an umbrella design. It defines the full target structure and a staged
rollout. Each phase should receive its own implementation plan before code is
changed.

## Naming Constraint

Generated code, commit messages, branch names, and pull request titles or
descriptions must not mention the reference project names. Public-facing feature
names should describe the mbrain capability directly, such as duplicate review,
brain health, related memory, activity digest, mutation planning, source
structure, or local schema instructions.

## Problem

mbrain already has the core memory architecture: canonical pages, task memory,
Source Records, Note Manifests, Context Maps, Context Atlas, Memory Inbox,
Retrieval Traces, scope gates, and a memory mutation control plane. The gap is
less about adding another store and more about making existing layers easier to
operate:

- duplicate or overlapping memory can still reach review too late
- structural health checks do not yet cover the full Markdown-to-DB-to-map chain
- relationship discovery is available through maps, but there is no lightweight
  "nearby memory" surface for everyday use
- recent memory activity is not summarized into a bounded operator digest
- candidate writes do not yet distinguish enough between full rewrite, append,
  link-only, and related-only changes
- long sources and media-like evidence need a more structured read model before
  they can be safely used by agents
- repo-local memory rules are not yet treated as a scoped, versioned input to
  read and write routing

## Goals

1. Add semantic duplicate review before canonical promotion or noisy candidate
   accumulation.
2. Add a deterministic brain health surface that checks canonical Markdown,
   database indexes, links, manifests, maps, and freshness together.
3. Add lightweight related-memory and activity-digest operations for daily use.
4. Add a mutation planning layer that separates rewrite, append, link-only, and
   related-only changes before any canonical write.
5. Extend source ingestion design toward structured long-source reads without
   making heavy document processing a default dependency.
6. Add a safe local schema-instruction mechanism that agents can read without
   letting local instructions bypass mbrain's global governance rules.
7. Preserve backend parity, local/offline behavior, and existing operation
   registry patterns.

## Non-Goals

- Do not replace compiled truth plus timeline pages.
- Do not make derived maps or digests canonical truth.
- Do not allow automatic full-page rewrites without patch review and target
  snapshot checks.
- Do not add a new graph database.
- Do not add a browser UI in this program.
- Do not add a required cloud document-processing dependency.
- Do not change the MCP instruction strategy into broad automatic writeback.

## Design Principles

1. **Govern before writing.** Similarity, summaries, map edges, and source
   structure can propose changes, but Memory Candidates and patch preconditions
   decide whether anything becomes durable truth.
2. **Use deterministic checks first.** Health checks, link extraction, manifest
   freshness, and target hashes should be code-first. LLM review can be layered
   later as a candidate source.
3. **Prefer narrow operations.** A link-only update should not invoke a full
   page rewrite. A digest should point to canonical records rather than copying
   their content.
4. **Keep derived surfaces disposable.** Related views, digests, reports, and
   source trees can be rebuilt from canonical inputs.
5. **Expose enough structure for agents.** Operations should return target
   selectors, source refs, status, and next actions rather than prose-only
   output.
6. **Stage heavy capabilities.** Long-source and media handling should begin
   with local structure contracts before adding optional backends.

## Target Architecture

The program adds six capability bands on top of the current architecture.

| Capability Band | Layer | Responsibility |
|---|---|---|
| Duplicate Review | Governance / Retrieval | Find semantically or structurally similar pages and candidates before promotion or candidate creation multiplies noise. |
| Brain Health | Derived / Audit | Check Markdown, DB state, links, manifests, maps, and freshness from one deterministic operator surface. |
| Related Memory | Retrieval / Derived | Return lightweight related pages, candidates, tasks, and source records using existing embeddings, tags, links, and maps. |
| Activity Digest | Audit / Interface | Summarize recent pages, task events, candidates, contradictions, promotions, and health warnings. |
| Mutation Planning | Governance | Convert proposed changes into rewrite, append, link-only, related-only, or no-op plans with target snapshots. |
| Structured Sources | Source Inputs / Retrieval | Represent long sources as section/page ranges and optional media handles so agents can read focused evidence. |
| Local Schema Instructions | Interfaces / Governance | Let a brain repo expose scoped local conventions without overriding global safety, scope, and provenance rules. |

The bands share existing primitives where possible:

- Pages and tags remain canonical page storage.
- Memory Candidates hold uncertain durable updates.
- Memory mutation events record privileged write outcomes.
- Note Manifests and Context Maps provide structural orientation.
- Retrieval Traces explain reads and writeback decisions.
- Source Records become the eventual home for structured long-source metadata.

## Phase 1: Semantic Duplicate Review

### Capability

Before creating or promoting durable memory, mbrain should detect likely
duplicates and return merge/update candidates. This applies to:

- page writes
- memory candidate creation
- candidate promotion
- patch candidate application
- optional operator scans over existing pages and candidates

### Data Flow

1. Normalize the proposed content into a comparison payload.
2. Search exact slug/title/tag/link overlap.
3. Search semantic similarity using available local embeddings or backend vector
   search.
4. Rank matches by semantic score, title/slug overlap, shared tags, shared
   source refs, target object, and recency.
5. Return a duplicate review result:
   - `no_match`
   - `possible_duplicate`
   - `likely_duplicate`
   - `same_target_update`
6. If the operation is a governed write, attach duplicate evidence to the
   candidate or preflight result.

### Boundaries

Duplicate review must not silently merge pages. It can:

- block promotion when a likely duplicate is unresolved
- suggest a target object for update
- increase recurrence score for existing candidates
- create a link-only or append-only mutation plan

### Acceptance

- Similar canonical pages are surfaced before a new duplicate page is promoted.
- Similar Memory Candidates are grouped instead of multiplying review rows.
- Local/offline mode works with keyword and text-similarity fallback when vector
  embeddings are unavailable.

## Phase 2: Brain Health

### Capability

Add a deterministic operator surface that reports structural and derived-state
health across the brain.

Checks should include:

- missing or malformed frontmatter
- compiled truth / timeline separator problems
- broken explicit links
- missing reciprocal backlinks where the local schema requires them
- duplicate-looking slugs or titles
- pages missing DB import state
- DB pages whose markdown source no longer exists
- stale Note Manifest entries
- stale Note Section entries
- stale Context Map or Atlas entries
- source refs that no longer resolve
- candidate targets that no longer exist
- retrieval traces pointing at removed artifacts

### Data Flow

1. Collect Markdown files from the configured repo path.
2. Collect DB page/index state from the active engine.
3. Compare file hashes, page hashes, manifest hashes, and map source-set hashes.
4. Emit a structured health report with severity, affected target, evidence, and
   suggested next action.
5. Optionally write the report as a derived artifact or return JSON for CLI/MCP.

### Severity

- `error`: canonical or governed state is inconsistent enough to block trust.
- `warning`: retrieval quality or review quality may degrade.
- `info`: useful maintenance hint.

### Boundaries

Health checks are read-only by default. Any fix mode must use existing patch or
write precondition paths and should be planned separately.

### Acceptance

- One command can explain whether Markdown, DB, manifests, and maps agree.
- Stale derived artifacts are reported without implying canonical corruption.
- Reports are stable enough for tests to assert issue counts and issue kinds.

## Phase 3: Related Memory And Activity Digest

### Related Memory

Add a lightweight operation that answers "what is near this memory object?"
without requiring a full map query.

Inputs:

- page slug, candidate id, task id, source ref, or free-text query
- optional scope
- optional relation kinds
- limit

Signals:

- vector similarity
- keyword overlap
- shared tags
- explicit links/backlinks
- shared source refs
- shared task or candidate target
- Context Map neighborhood, when fresh and available

Output:

- ranked related objects
- relationship reasons
- source selectors to open next
- freshness warnings

### Activity Digest

Add a bounded digest operation for recent memory activity.

Inputs:

- time window
- scope
- optional focus kind: pages, tasks, candidates, governance, health, all

Output groups:

- updated canonical pages
- new or changed task records
- new candidates and review backlog changes
- promotions, rejections, supersessions, contradictions
- health warnings
- recommended next review actions

### Boundaries

Related memory and digests are derived views. They should point to canonical
selectors and governance records, not duplicate large content.

### Acceptance

- Related results explain why each object was selected.
- Digest output is small enough for MCP clients to use directly.
- The operation works in local/offline mode without network calls.

## Phase 4: Mutation Planning

### Capability

Add a planning layer between "new information arrived" and "write a page".
The planner classifies the safest mutation shape.

Mutation plan kinds:

- `no_op`: existing canonical memory already covers the signal.
- `link_only`: add or repair a relationship without rewriting body text.
- `append_timeline`: add evidence without changing compiled truth.
- `compiled_truth_patch`: propose a small reviewed change to compiled truth.
- `full_rewrite_candidate`: high-risk rewrite requiring explicit review.
- `new_page_candidate`: proposed new canonical page.
- `candidate_update`: update or supersede an existing Memory Candidate.

### Data Flow

1. Read target candidates from duplicate review and retrieval.
2. Compare the incoming signal against existing compiled truth, timeline,
   links, tags, and source refs.
3. Produce one or more mutation plans with target snapshots.
4. Route uncertain plans into Memory Candidates.
5. Route direct, low-risk plans through existing preconditioned writes.
6. Record ledger events for mutating paths.

### Boundaries

The planner does not apply high-risk changes. It only returns an auditable plan
that a write operation or reviewer can apply later.

### Acceptance

- Link-only changes avoid full page rewrites.
- Timeline append and compiled-truth patch are separate outcomes.
- Target snapshot mismatches become conflicts, not silent overwrites.

## Phase 5: Structured Source Reads

### Capability

Extend source handling so long documents and media-like evidence can be read in
focused ranges rather than copied wholesale into prompts.

Source structure should support:

- source id
- original file or URI reference
- conversion artifact path
- page, section, or segment list
- section titles and ranges
- image or table handles
- content hash and extractor version
- source quality metadata

### Data Flow

1. Import or register a source artifact.
2. Store raw provenance in the canonical source domain.
3. Build derived structure: sections, pages, ranges, image/table handles.
4. Let retrieval return source selectors.
5. Let read operations fetch only requested ranges.
6. Keep derived source structure refreshable from the canonical source record.

### Optional Backends

Heavy PDF, OCR, or media extraction should be optional. The baseline contract is
local structure plus focused reads for artifacts that already have readable text.

### Acceptance

- Agents can request a precise source range.
- Long-source reads stay bounded.
- Source structure never becomes compiled truth by itself.

## Phase 6: Local Schema Instructions

### Capability

Allow a brain repo to expose local organization rules that guide retrieval,
lint, candidate filing, and mutation planning.

### Model

Local schema instructions should be represented as a canonical or governed
configuration artifact with:

- schema version
- scope id
- rule source path
- allowed directories and page types
- required backlink rules
- filing conventions
- candidate routing hints
- conflict priority
- content hash

### Precedence

1. System and application safety rules.
2. mbrain global memory contract.
3. scope gate and memory realm policy.
4. local schema instructions.
5. individual operation parameters.

Local instructions can narrow behavior but cannot authorize unsafe writes,
cross-scope leakage, missing provenance, or direct promotion of inferred truth.

### Acceptance

- Retrieval and write planning can cite which local rule influenced a decision.
- Conflicting local rules are reported by brain health.
- Local schema changes mark dependent derived artifacts stale.

## Operation Surface

Exact names should be finalized during phase implementation plans, but the
operation family should stay close to existing mbrain patterns.

Candidate operations:

- `review_duplicate_memory`
- `scan_duplicate_memory`
- `get_brain_health`
- `list_brain_health_issues`
- `get_related_memory`
- `get_activity_digest`
- `plan_memory_mutation`
- `get_source_structure`
- `read_source_range`
- `get_local_schema_rules`

CLI aliases can be shorter, but MCP tools should remain explicit and
contract-first.

## Testing Strategy

Each phase needs focused tests plus one acceptance pack.

Test families:

- service unit tests for ranking, planning, and health issue generation
- operation tests for parameter validation and output contracts
- SQLite tests for local/offline behavior
- parity-sensitive tests where Postgres and PGLite share the same public
  contract
- scenario tests proving retrieval still opens canonical evidence before
  answering from derived surfaces
- regression tests that ensure derived outputs do not mutate canonical truth

Minimum verification commands should be declared in each implementation plan.
Typical commands:

- `bun test test/<phase-specific>.test.ts`
- `bun test test/e2e/local-sqlite-cli.test.ts`
- `bun run bench:<phase-acceptance-command>` when a phase has an existing bench
  pattern

## Rollout Plan

The phases should be implemented in order because each one reduces risk for the
next:

1. Duplicate review reduces memory pollution before more candidate sources are
   added.
2. Brain health gives operators a way to detect drift caused by later features.
3. Related memory and digest add read-only value on top of existing state.
4. Mutation planning makes write paths narrower and safer.
5. Structured source reads add richer evidence without widening prompt loads.
6. Local schema instructions refine behavior after the safety surfaces exist.

Each phase should leave the repository in a shippable state with tests and a
small public operation surface.

## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| Similarity review blocks legitimate new pages | Use `possible_duplicate` versus `likely_duplicate`, make blocking configurable only at governed promotion boundaries, and preserve manual override through review. |
| Health reports become noisy | Start with deterministic high-signal checks and stable severity. Add advisory checks only after issue counts are useful. |
| Related memory duplicates map behavior | Keep related memory lightweight and selector-oriented. Use maps only as one optional signal. |
| Digest becomes another source of truth | Include selectors and counts, not copied canonical bodies. Treat digest as derived. |
| Mutation planner overfits one write path | Keep plan kinds small and map them to existing Memory Candidate and ledger primitives. |
| Structured source reads add heavy dependencies | Make advanced extraction optional and keep the baseline local text/range contract. |
| Local schema instructions conflict with global rules | Enforce precedence and report conflicts in brain health. |

## Success Criteria

The umbrella program is successful when:

- duplicate canonical pages and duplicate candidates are easier to catch before
  promotion
- operators can inspect brain health across files, DB state, manifests, and maps
- agents can ask for related memory and receive explainable, bounded selectors
- recent memory activity can be reviewed without scanning raw tables or logs
- write planning reduces unnecessary full-page rewrites
- long-source evidence can be read in focused ranges
- local schema rules guide behavior without weakening provenance, scope, or
  governance boundaries

No phase is complete without concrete tests and local/offline verification.
