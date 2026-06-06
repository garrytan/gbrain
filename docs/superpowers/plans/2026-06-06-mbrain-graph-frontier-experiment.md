# MBrain Graph Frontier Retrieval Experiment Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. If the
> Superpowers skill is not available in the current runtime, use available
> subagents for sidecar review and keep this checklist updated.

**Goal:** Test whether bounded graph-assisted selector planning improves
canonical read selection without allowing graph edges, graph paths, or
graph-derived claims to become answer authority.

**Architecture:** Graph frontier retrieval is an experiment over existing
authority surfaces. It may expand or rank selectors that should be read through
`read_context`, but it must not create factual answer evidence, canonical page
writes, or new assertion authority. The graph layer is a guide to what to read,
not a judge of what is true.

**Tech Stack:** Bun, TypeScript, existing assertion retrieval store, existing
retrieval selector/read-context/retrieve-context services, existing
memory-why trace types, existing evaluation fixture patterns, Bun test runner,
`bun run typecheck`.

---

## Source Specs

- `docs/superpowers/specs/2026-06-06-mbrain-authority-first-memory-improvement-design.md`
- `docs/superpowers/plans/2026-06-06-mbrain-authority-first-full-spec-roadmap.md`
- `docs/superpowers/plans/2026-06-06-mbrain-authority-first-foundation.md`
- `docs/superpowers/plans/2026-06-06-mbrain-trust-contract-service.md`
- `docs/superpowers/plans/2026-06-06-mbrain-memory-why-proof-mode.md`
- `docs/architecture/redesign/05-workstream-context-map.md`
- `docs/MBRAIN_AGENT_RULES.md`
- `docs/MCP_INSTRUCTIONS.md`

## Scope Check

This phase implements only:

- a bounded graph frontier selector planner behind an explicit flag;
- a strict first-edge allowlist:
  - `supports`
  - `contradicts`
  - `supersedes`
  - `requires_reverification`
- edge direction and authority implications;
- scope and policy filtering before traversal;
- fanout and depth caps;
- graph path trace output for audit and memory-why;
- deterministic graph-off and graph-on evaluation fixtures;
- measured recall, precision, false bridge, latency, and token deltas.

Do not implement:

- graph-RAG answer generation;
- graph paths as citations or factual evidence;
- graph centrality, path length, or edge weight as an authority score;
- graph traversal that bypasses `scope_id`, policy labels, trust decisions, or
  `read_context`;
- automatic canonical writes or assertion promotion from frontier output;
- default-on graph expansion before evaluation passes;
- a new graph database or ontology migration;
- schema changes unless a failing test proves an existing index or label is
  missing.

## Design Principle

Graph frontier output is selector planning only.

The allowed data flow is:

1. canonical search, explicit selectors, or scoped assertions produce initial
   seed selectors;
2. graph frontier expands possible adjacent selectors within scope and budget;
3. the planner returns canonical `RetrievalSelector` entries plus a trace of
   paths considered, omitted, and rejected;
4. `read_context` remains the factual evidence boundary;
5. `memory-why` may explain graph paths considered, but answer authority must
   count only canonical reads.

`read_context` must not start its own graph traversal. If auto-read flows need
graph-on behavior, they should pass the same explicit graph-frontier flag into
the existing `retrieve_context` planning step and then read only the resulting
canonical selectors.

The forbidden data flow is:

1. graph path found;
2. graph relation treated as a factual claim;
3. answer uses that relation without a canonical read.

## Existing Surfaces To Reuse

- `src/core/assertions/assertion-retrieval-store.ts`
  - already enforces `scope_id` for frontier-style assertion retrieval.
- `src/core/assertions/assertion-types.ts`
  - assertion and link records are the likely source for graph edge metadata.
- `src/schema.sql`, `src/core/sqlite-engine.ts`, and `src/core/migrate.ts`
  - already carry assertion, assertion evidence, and assertion link scope and
    policy labels; do not change schema by default.
- `src/core/services/retrieval-selector-service.ts`
  - selector normalization and stable selector ids.
- `src/core/services/retrieve-context-service.ts`
  - required read planning and candidate search integration.
- `src/core/services/read-context-service.ts`
  - canonical evidence boundary.
- `src/core/types/memory-why.ts`
  - already has `graph_paths_considered`.
- `src/core/services/memory-why-service.ts`
  - should render graph paths as explanation, not authority.
- `src/core/evaluation/memory-eval-cases.ts`
  - fixture type patterns for deterministic evaluation.
- `src/core/evaluation/memory-replay.ts`
  - metric style and fail-closed replay checks.

## File Structure

- Add: `src/core/types/graph-frontier.ts`
  - planner inputs, edge allowlist, path trace, selector output, and evaluation
    report types.
- Add: `src/core/services/assertion-frontier-retrieval-service.ts`
  - pure bounded traversal over scoped assertion nodes and edges.
- Add: `src/core/evaluation/graph-frontier-evaluation.ts`
  - graph-off/graph-on fixture runner and aggregate metrics.
- Add: `test/assertion-frontier-retrieval-service.test.ts`
  - planner authority, scope, edge allowlist, fanout/depth, and trace tests.
- Add: `test/graph-frontier-evaluation.test.ts`
  - graph-off/on ablation tests and metric gates.
- Add: `test/fixtures/authority-first/phase7-graph-frontier-eval.fixture.json`
  - deterministic evaluation fixture.
- Modify: `src/core/services/retrieve-context-service.ts`
  - explicit input flag plus optional test dependency for graph frontier
    augmentation.
- Modify: `src/core/types/retrieval-routing.ts`
  - add production-visible explicit graph frontier flag on
    `RetrieveContextInput`; graph frontier must not be enabled by test-only
    dependency injection.
- Modify: `src/core/types.ts`
  - export graph frontier types if needed by operations or tests.
- Modify: `src/core/types/memory-why.ts`
  - only if path trace structure needs more detail than string ids.
- Modify: `src/core/services/memory-why-service.ts`
  - ensure graph paths are explanation-only and never counted as canonical
    reads.
- Modify: `docs/MBRAIN_VERIFY.md`
  - add Phase 7 verification command after behavior is implemented.
- Modify: `package.json`
  - add `test:graph-frontier` after focused tests exist.

## Graph Frontier Contract

The planner input must include:

- `scope_id`
- `policy_version`
- seed assertion ids or seed selectors
- max depth
- fanout cap
- allowed edge types
- `enabled: true`

The planner output must include:

- `selected_selectors`: canonical read selectors only
- `paths_considered`: graph paths for explanation/audit only
- `omitted_paths`: paths rejected by scope, policy, stale graph, fanout cap,
  depth cap, unsupported edge type, or missing canonical selector
- `authority_violations`: must be empty for valid output
- `warnings`: stale graph or revalidation messages

Allowed edge implications:

- `supports`
  - May add adjacent canonical selectors for reading.
  - Must not imply transitive factual truth.
- `contradicts`
  - May add both sides as review/read candidates.
  - Must not choose one side as true.
- `supersedes`
  - May prefer current selector and record historical selector as explanation.
  - Historical selector is allowed only when query mode asks for historical
    context.
- `requires_reverification`
  - May add a selector with `verify_first` orientation.
  - Must not become `answer_ground` without fresh canonical evidence.

## Metrics Contract

`GraphFrontierEvaluationReport` must include:

```ts
type GraphFrontierEvaluationReport = {
  fixture_version: string;
  graph_config: {
    enabled: boolean;
    scope_id: string;
    policy_version: string;
    max_depth: number;
    fanout_cap: number;
    allowed_edge_types: string[];
  };
  cases: Array<{
    id: string;
    query: string;
    gold_selectors: string[];
    forbidden_selectors: string[];
    graph_off: GraphFrontierRunMetrics;
    graph_on: GraphFrontierRunMetrics;
    deltas: {
      recall_delta: number;
      precision_delta: number;
      latency_ms_delta: number;
      estimated_token_delta: number;
      time_to_first_gold_delta: number;
    };
  }>;
  aggregate: {
    recall_off: number;
    recall_on: number;
    precision_off: number;
    precision_on: number;
    false_bridge_rate: number;
    p95_latency_delta_ms: number;
    p95_token_delta: number;
    graph_as_answer_evidence_count: number;
    scope_leak_count: number;
    stale_graph_leakage_count: number;
    unsupported_edge_traversal_count: number;
    edge_type_contribution: Record<string, {
      added_gold: number;
      false_bridges: number;
    }>;
  };
};
```

`false_bridge_rate` is:

```text
graph_added = graph_on.required_reads - graph_off.required_reads
false_bridge = graph_added entries that are forbidden or neither gold nor allowed
false_bridge_rate = false_bridge_count / max(graph_added_count, 1)
```

Latency and token metrics should be deterministic instrumentation in tests, not
wall-clock thresholds.

## Evaluation Fixture Families

The phase fixture must include:

- `recall_bridge`
  - graph-on finds a gold canonical selector that graph-off misses.
- `false_bridge_distractor`
  - graph-on does not add an unrelated selector through a tempting bridge.
- `scope_boundary`
  - workspace traversal cannot reach personal selectors.
- `contradiction`
  - `contradicts` creates review/read planning only, not a truth decision.
- `supersession`
  - current canonical selector is preferred; historical selector requires
    historical mode.
- `requires_reverification`
  - stale or verify-first paths cannot ground answers.
- `stale_graph`
  - stale graph version is excluded or warning-only.
- `graph_only_no_canonical`
  - graph path without a canonical selector leaves the answer not ready.

## Implementation Split

Implement Phase 7 in three PR-sized slices:

1. **Planner and authority boundary.**
   Add graph frontier types and a pure planner service. It should accept
   in-memory nodes/edges in tests and enforce scope, policy, edge allowlist,
   fanout, depth, and authority violations. No retrieval integration yet.
2. **Retrieve-context wiring behind an explicit flag.**
   Add an optional dependency/input flag so `retrieveContext` can merge
   graph-planned canonical selectors into `required_reads`. Graph paths go only
   to orientation/trace/memory-why surfaces.
3. **Evaluation fixture and gate.**
   Add graph-off/on evaluation fixtures, metrics, `test:graph-frontier`, and
   `docs/MBRAIN_VERIFY.md` coverage. Do not make graph frontier default-on even
   when the fixture passes.

## Task 1: Planner Types And Pure Frontier Service

**Files:**

- Add: `src/core/types/graph-frontier.ts`
- Add: `src/core/services/assertion-frontier-retrieval-service.ts`
- Add: `test/assertion-frontier-retrieval-service.test.ts`
- Modify: `src/core/types.ts`

- [ ] **Step 1: Write failing planner tests**

Create tests covering:

- graph frontier is inert when `enabled` is false;
- `scope_id` is required for enabled frontier planning;
- nodes or edges from a different scope are rejected before traversal;
- policy-version mismatches are omitted with trace reason codes;
- only `supports`, `contradicts`, `supersedes`, and
  `requires_reverification` are traversed;
- depth and fanout caps are enforced and reported;
- `requires_reverification` creates `verify_first` orientation only;
- `contradicts` never chooses one side as fact;
- graph paths never appear in answer evidence fields.

- [ ] **Step 2: Implement narrow types**

Use string literal unions and plain objects. Avoid classes. The type surface
should make authority explicit:

```ts
export type GraphFrontierEdgeType =
  | 'supports'
  | 'contradicts'
  | 'supersedes'
  | 'requires_reverification';

export type GraphFrontierSelectorActivation =
  | 'canonical_read'
  | 'verify_first'
  | 'review_only';
```

- [ ] **Step 3: Implement pure planner**

Implement a deterministic BFS-style planner over supplied nodes and edges.
Keep this service database-free. It should return selected canonical selectors
and explanation-only path traces.

- [ ] **Step 4: Run focused planner gate**

Run:

```bash
bun test test/assertion-frontier-retrieval-service.test.ts
bun run typecheck
```

Expected: PASS.

## Task 2: Retrieve Context Integration Behind Explicit Flag

**Files:**

- Modify: `src/core/services/retrieve-context-service.ts`
- Modify: `src/core/types/retrieval-routing.ts`
- Modify: `src/core/services/memory-why-service.ts`
- Modify: `src/core/types/memory-why.ts` only if structured path traces are
  needed
- Modify: `test/retrieve-context-service.test.ts`
- Modify: `test/memory-why-service.test.ts`

- [ ] **Step 1: Write failing integration tests**

Create or extend tests covering:

- default retrieval does not call graph frontier;
- explicit graph-frontier input/dependency can add canonical selectors to
  `required_reads`;
- graph-added reads are deduped with search and orientation reads;
- graph paths are exposed only in orientation/trace/memory-why explanation;
- `read_context` remains required before factual answers;
- graph path ids, edge ids, and graph-derived claims never appear as
  `source_refs` for answer grounding.

- [ ] **Step 2: Add explicit graph frontier input flag and dependency**

Extend `RetrieveContextInput` in `src/core/types/retrieval-routing.ts` with a
production-visible explicit flag, for example `graph_frontier?: { enabled:
boolean; max_depth?: number; fanout_cap?: number }`. Extend
`RetrieveContextDependencies` with an optional planner for testability, but do
not let dependency injection become the only way to turn the feature on.
Default behavior must be graph-off.

- [ ] **Step 3: Merge planner selectors safely**

Merge only canonical `RetrievalSelector` outputs into `required_reads` after
scope gating and selector normalization. Keep graph path traces out of
canonical refs.

- [ ] **Step 4: Run integration gate**

Run:

```bash
bun test test/retrieve-context-service.test.ts test/memory-why-service.test.ts test/assertion-frontier-retrieval-service.test.ts
bun run typecheck
```

Expected: PASS.

## Task 3: Graph-Off/Graph-On Evaluation

**Files:**

- Add: `src/core/evaluation/graph-frontier-evaluation.ts`
- Add: `test/graph-frontier-evaluation.test.ts`
- Add: `test/fixtures/authority-first/phase7-graph-frontier-eval.fixture.json`

- [ ] **Step 1: Write failing evaluation tests**

Create tests covering:

- graph-off and graph-on run against the same deterministic fixture;
- graph-on improves recall or time-to-first-gold on `recall_bridge`;
- graph-on does not reduce precision on distractor cases;
- deterministic fixture false bridge rate is zero;
- graph-as-answer-evidence count is zero;
- scope leak, stale graph leakage, and unsupported edge traversal counts are
  zero;
- p95 latency and token deltas are computed from instrumentation, not wall
  time.

- [ ] **Step 2: Implement fixture runner**

The runner should compute:

- recall and precision for selected canonical selectors;
- false bridge rate;
- p95 latency delta;
- p95 estimated token delta;
- time-to-first-gold delta;
- edge-type contribution;
- authority boundary violation counts.

- [ ] **Step 3: Add deterministic fixture**

Include all fixture families listed above. Keep fixture text minimal and avoid
depending on a live database.

- [ ] **Step 4: Run evaluation gate**

Run:

```bash
bun test test/graph-frontier-evaluation.test.ts test/assertion-frontier-retrieval-service.test.ts
bun run typecheck
```

Expected: PASS.

## Task 4: Verification Docs And Script

**Files:**

- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`
- Modify: `docs/superpowers/plans/2026-06-06-mbrain-authority-first-full-spec-roadmap.md`

- [ ] **Step 1: Add script**

Add:

```json
"test:graph-frontier": "bun test test/assertion-frontier-retrieval-service.test.ts test/graph-frontier-evaluation.test.ts test/retrieve-context-service.test.ts test/memory-why-service.test.ts"
```

- [ ] **Step 2: Add docs section**

Add a short `Graph frontier retrieval experiment` section to
`docs/MBRAIN_VERIFY.md`:

```bash
bun run test:graph-frontier
bun run typecheck
```

Acceptance:

- graph frontier is default-off;
- graph frontier is scope-filtered, policy-filtered, depth-capped, and
  fanout-capped;
- graph-derived claims cannot become answer evidence;
- false bridge rate, p95 latency delta, and p95 token delta are measured;
- graph-on improves canonical read recall or time-to-evidence without reducing
  canonical read precision.

- [ ] **Step 3: Mark Phase 7 plan progress only after implementation**

Update the roadmap only for behavior actually implemented. Do not claim full
Phase 7 completion until Task 4 verification passes.

- [ ] **Step 4: Run phase gate**

Run:

```bash
bun run test:graph-frontier
bun run test:authority-foundation
bun run typecheck
git diff --check
```

Expected: PASS.

## Phase Acceptance

- [ ] Graph frontier remains default-off and explicit-flag only.
- [ ] Traversal requires `scope_id` and policy-compatible graph records.
- [ ] Edge traversal is limited to `supports`, `contradicts`, `supersedes`,
  and `requires_reverification`.
- [ ] Fanout and depth caps are enforced and traceable.
- [ ] Graph paths appear only as selector-planning explanation, not answer
  authority.
- [ ] `read_context` remains the factual evidence boundary.
- [ ] Graph-off/graph-on evaluation reports recall, precision, false bridge
  rate, p95 latency delta, and p95 token delta.
- [ ] Graph-on improves canonical read recall or time-to-evidence without
  reducing canonical read precision in deterministic fixtures.
- [ ] Focused graph frontier tests, authority-foundation regression,
  typecheck, and diff check pass.

## Final Verification

After all tasks are complete, run:

```bash
bun run test:graph-frontier
bun run test:authority-foundation
bun run typecheck
git status --short --branch
```

Expected:

- all listed tests pass;
- typecheck passes;
- status shows only unrelated pre-existing untracked files, such as
  `reference/`;
- graph frontier is still not default-on;
- candidate, graph, episode, and Dream outputs never bypass canonical evidence
  or governed writeback.
