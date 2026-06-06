# MBrain Memory-Why And Proof Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make authority-first memory behavior inspectable through a concise
`memory-why` explanation and a repeatable proof-mode surface that demonstrates
agent value without allowing candidates, graph paths, or raw projections to
become answer authority.

**Architecture:** Start with a pure explanation service over existing retrieval
results, canonical reads, activation decisions, decision packets, negative
memory projections, candidate signals, and retrieval traces. Proof mode should
compose existing services and fixtures; it must not mutate canonical pages,
Memory Inbox candidates, assertions, handoffs, or persisted projection rows.

**Tech Stack:** Bun, TypeScript, existing `src/core/services` and
`src/core/operations.ts` patterns, Bun test runner, `bun run typecheck`.

---

## Source Specs

- `docs/superpowers/specs/2026-06-06-mbrain-authority-first-memory-improvement-design.md`
- `docs/superpowers/plans/2026-06-06-mbrain-authority-first-full-spec-roadmap.md`
- `docs/superpowers/plans/2026-06-06-mbrain-trust-contract-service.md`
- `docs/superpowers/plans/2026-06-06-mbrain-decision-negative-projections.md`
- `docs/MBRAIN_AGENT_RULES.md`
- `docs/MCP_INSTRUCTIONS.md`

## Scope Check

This phase implements explanation and proof surfaces only. Do not add broad
episode capture, candidate content reads, graph frontier retrieval, expanded
Dream guardrails, setup-agent UX, doctor explain UX, or integrated acceptance
in this branch.

The first implementation must be read-only and schema-free. It may explain
existing artifacts and explicit fixture inputs, but it must not create a new
truth store or change retrieval ranking.

## File Structure

- `src/core/types/memory-why.ts`
  - Defines memory-why input, concise and verbose explanation output, proof
    scenario output, and stable reason-code types.

- `src/core/services/memory-why-service.ts`
  - Builds concise and verbose memory explanations from existing result shapes.

- `src/core/services/proof-agent-service.ts`
  - Runs deterministic proof scenarios with fixture inputs and verifies that
    only canonical reads or trusted scoped artifacts can ground answers.

- `src/core/operations.ts`
  - Registers `proof_agent_memory` as a read-only operation with a CLI hint.

- `test/memory-why-service.test.ts`
  - Locks concise and verbose memory-why output.

- `test/proof-agent-command.test.ts`
  - Locks operation registration, output formatting, and proof-mode authority
    guardrails.

- `docs/MBRAIN_VERIFY.md`
  - Adds the focused Phase 4 verification command.

- `package.json`
  - Adds `test:memory-why`.

## Memory-Why Contract

The concise output should fit in three to five lines and include:

- canonical reads used,
- candidate or Inbox leads ignored,
- stale or code-sensitive items that require revalidation,
- suppressions from valid negative memory, and
- whether a trace was persisted or only explained from in-memory inputs.

The verbose output may include:

- `considered_selectors`,
- `selected_selectors`,
- `omitted_candidate_refs`,
- `suppression_reason_codes`,
- `activation_decisions`,
- `freshness_snapshot`,
- `graph_paths_considered`,
- `scope_policy_snapshot`,
- `trace_refs`,
- latency or token-cost placeholders only when supplied by the caller.

Verbose graph fields are trace fields only in this phase. They must default to
empty arrays and must not trigger graph retrieval.

## Proof Mode Contract

`proof_agent_memory` should return a deterministic report with scenarios for:

- decision reuse from a canonical decision packet,
- failed-attempt avoidance through conditional negative memory,
- stale code claim `verify_first`,
- candidate exclusion from answer grounding,
- concise memory-why explanation.

Proof mode passes only when:

- every grounded answer has canonical or trust-contract-approved authority,
- candidates and graph-like orientation artifacts are excluded from answer
  grounding,
- negative memory suppresses only when anchors match,
- stale code-like claims require verification,
- no scenario reports a mutation.

## Task 1: Memory-Why Types And Service

**Files:**

- Add: `src/core/types/memory-why.ts`
- Add: `src/core/services/memory-why-service.ts`
- Add: `test/memory-why-service.test.ts`

- [x] **Step 1: Write failing service tests**

Create tests covering:

- concise output counts canonical reads, ignored candidate signals, stale
  revalidations, and suppressions in three to five summary lines;
- verbose output lists selected selectors, omitted candidate refs, activation
  decisions, freshness snapshot, scope policy snapshot, and empty graph paths;
- candidate signals and graph-like artifacts are never reported as
  `answer_ground`;
- negative memory `suppress_if_valid` appears as suppression only when the
  projection says `suppression_applies`;
- missing optional inputs produce stable zero-count output.

- [x] **Step 2: Implement types**

Define narrow projection types rather than importing the full retrieval service
internals into every caller. Prefer structural fields like `selector_id`,
`candidate_id`, `activation`, `reason_codes`, and `source_ref`.

- [x] **Step 3: Implement pure service**

Implement:

```ts
export function buildMemoryWhy(input: MemoryWhyInput): MemoryWhyReport
```

The service must be deterministic, side-effect free, and independent of the
database.

- [x] **Step 4: Run focused tests**

Run:

```bash
bun test test/memory-why-service.test.ts
bun run typecheck
```

Expected: PASS.

## Task 2: Proof Agent Service

**Files:**

- Add: `src/core/services/proof-agent-service.ts`
- Add: `test/proof-agent-command.test.ts`

- [x] **Step 1: Write failing proof tests**

Create tests covering:

- proof report contains all five required scenarios;
- canonical decision reuse passes through `answer_ground`;
- failed-attempt avoidance passes through conditional negative memory;
- stale code claim is `verify_first`;
- candidate-only or orientation-only artifacts fail if marked as grounding;
- every proof scenario reports `mutations: []`.

- [x] **Step 2: Implement deterministic proof service**

Implement:

```ts
export function runProofAgentMemory(input?: ProofAgentInput): ProofAgentReport
```

Use in-memory fixtures and existing pure services:

- `evaluateTrustContract`
- `buildDecisionPacketProjections`
- `buildNegativeMemoryProjections`
- `buildMemoryWhy`

Keep this service read-only and schema-free.

- [x] **Step 3: Run focused proof tests**

Run:

```bash
bun test test/proof-agent-command.test.ts
bun run typecheck
```

Expected: PASS.

## Task 3: Operation And CLI Surface

**Files:**

- Modify: `src/core/operations.ts`
- Modify: `test/proof-agent-command.test.ts`

- [x] **Step 1: Register read-only operation**

Add:

- `proof_agent_memory`
  - CLI hint: `proof-agent`
  - accepts `verbose?: boolean`.

The operation must have `mutating: false`. Keep `memory-why` as the pure service
used by proof mode rather than exposing a second JSON-heavy CLI command in this
phase.

- [x] **Step 2: Add formatters**

Add a `formatResult` branch so `proof-agent` prints pass/fail status, scenario
statuses, and the concise
  memory-why lines.

- [x] **Step 3: Run operation tests**

Run:

```bash
bun test test/proof-agent-command.test.ts
bun run typecheck
```

Expected: PASS.

## Task 4: Verification Docs

**Files:**

- Modify: `docs/MBRAIN_VERIFY.md`
- Modify: `package.json`

- [x] **Step 1: Add script**

Add:

```json
"test:memory-why": "bun test test/memory-why-service.test.ts test/proof-agent-command.test.ts"
```

- [x] **Step 2: Add docs section**

Add a short `Memory-why and proof mode` section to `docs/MBRAIN_VERIFY.md`:

```bash
bun run test:memory-why
bun run typecheck
```

Acceptance:

- concise memory-why output stays short,
- verbose output lists selected and omitted evidence paths,
- proof mode demonstrates useful agent outcomes without canonical pollution,
- proof mode fails if candidate or orientation artifacts are used as answer
  authority.

- [x] **Step 3: Run docs gate**

Run:

```bash
bun run test:memory-why
bun run test:decision-projections
bun run test:trust-contract
bun run typecheck
git diff --check
```

Expected: PASS.

## Phase Acceptance

- [x] `memory-why` explains selected canonical reads, omitted leads,
  revalidations, and suppressions.
- [x] Proof mode demonstrates decision reuse, failed-attempt avoidance, stale
  code verify-first, candidate exclusion, and memory-why explanation.
- [x] No Phase 4 service mutates canonical pages, candidates, assertions,
  handoffs, traces, or projection rows.
- [x] Candidate, graph-like, and raw projection artifacts cannot ground proof
  answers.
- [x] Focused tests, trust-contract regression, decision-projection regression,
  typecheck, and diff check pass.
