# MBrain Authority-First Full Spec Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the full authority-first memory improvement spec as a staged implementation program, so the existing foundation plan can ship first without losing the remaining spec.

**Architecture:** Treat the full spec as a sequence of independently testable implementation plans. Each phase must preserve the canonical evidence boundary: candidates, episodes, graph paths, projections, and Dream outputs may guide review or retrieval, but they cannot become answer authority unless the trust contract explicitly allows it.

**Tech Stack:** Bun, TypeScript, existing MBrain CLI/service patterns, Postgres/PGLite/SQLite schema paths, `docs/superpowers/plans`, `docs/superpowers/specs`, Bun test runner, `bun run typecheck`, `bun run build:schema`.

---

## Source Specs

- `docs/superpowers/specs/2026-06-06-mbrain-authority-first-memory-improvement-design.md`
- `docs/superpowers/plans/2026-06-06-mbrain-authority-first-foundation.md`
- `docs/designs/HYPER_COMPANY_BRAIN_LESSONS_FOR_MBRAIN.ko.md`
- `docs/MBRAIN_AGENT_RULES.md`
- `docs/MCP_INSTRUCTIONS.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-03-assertion-pipeline.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-04-governed-canonical-write.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-07-dream-cycle.md`
- `docs/superpowers/specs/2026-06-01-mbrain-auto-promotion-design.md`

## Roadmap Principle

The current foundation plan is correct as the first implementation slice, but it
is not the whole spec. Complete the full spec through this plan series:

1. Foundation and safety substrate.
2. Central trust contract service.
3. Decision packet and negative memory projections.
4. Memory-why and proof mode.
5. Allowlisted episode capture and Inbox lead refinement.
6. Expanded Dream maintenance guardrails.
7. Bounded graph frontier retrieval experiment.
8. Agent trust UX and final integrated acceptance gate.

Each phase produces working software and commits. Do not start a later phase
until the previous phase's acceptance gate passes.

## Full Spec Coverage Matrix

| Spec decision | Primary phase | Completion evidence |
|---|---:|---|
| D1 canonical evidence remains the answer boundary | 1, 2, 8 | retrieval tests prove candidates, graph paths, and Dream outputs cannot ground answers by default |
| D2 artifact activation labels | 1 | activation policy tests cover `answer_ground`, `hint_only`, `promote_first`, `audit_only`, `verify_first`, `suppress_if_valid` |
| D3 trust policy contract view | 2 | `TrustContractService` derives decisions from source, scope, assertion, freshness, sensitivity, and snapshot inputs |
| D4 decision packet projection | 3 | decision packets are read models over assertions, task decisions, traces, handoffs, and source refs |
| D5 conditional negative memory | 3 | suppression only applies when applicability anchors match and `reopen_if` is false |
| D6 graph as selector planner | 7 | graph-on evaluation improves canonical read selection without graph-as-answer evidence |
| D7 narrow episode capture | 5 | capture is allowlisted, redacted, scoped, and candidate-producing rather than canonical-writing |
| D8 memory-why trace | 4 | concise and verbose outputs explain selected reads, omitted leads, stale checks, and suppressions |
| D9 Dream as operational loop | 1, 6 | Dream permissions, budgets, replay canary, lock renewal, report-only states, and self-consumption guard pass tests |
| D10 proof mode before broad expansion | 4, 8 | `proof --agent` or equivalent repeatable CLI flow demonstrates user-visible value |

## Phase 1: Foundation And Safety Substrate

**Plan file:** `docs/superpowers/plans/2026-06-06-mbrain-authority-first-foundation.md`

**Purpose:** Build the minimum substrate that prevents unsafe expansion:
activation labels, scoped assertion retrieval, Dream permission split, and
auto-promote safety hardening.

**Status:** Plan exists and should be executed first.

**Acceptance gate:**

```bash
bun run test:authority-foundation
bun run typecheck
```

**Exit criteria:**

- activation labels exist without changing legacy activation decisions,
- assertion retrieval can require `scope_id` before frontier use,
- `dream --apply` does not imply auto-promote apply,
- canonical page writes require explicit permission,
- B-lite auto-promote lanes keep canonical writes strict while preserving
  handoff-only learning signals,
- inferred, ambiguous, dream-generated, and non-fact candidates can reach
  review or handoff paths but cannot write canonical pages,
- verdict cache compatibility remains covered without requiring a policy-aware
  cache key schema.

## Phase 2: Trust Contract Service

**Next plan file:** `docs/superpowers/plans/2026-06-06-mbrain-trust-contract-service.md`

**Purpose:** Centralize authority decisions so retrieval, Inbox leads, graph
planning, Dream, and proof mode use the same policy contract.

**Required implementation plan scope:**

- Create `src/core/services/trust-contract-service.ts`.
- Create `src/core/types/trust-contract.ts`.
- Update `src/core/services/memory-activation-policy-service.ts` to delegate
  candidate, episode, graph, assertion, and source/timeline artifact decisions
  to the trust contract where possible.
- Add freshness labels and revalidation instructions.
- Add policy version hash fields to trust decisions.
- Keep `read_context` as the evidence boundary.

**Required tests:**

```bash
bun test test/trust-contract-service.test.ts test/memory-activation-policy-service.test.ts
bun run typecheck
```

**Exit criteria:**

- stale code claims become `verify_first`,
- scope-denied artifacts become `ignore` or audit-only outputs,
- unreviewed candidates remain `candidate_only`,
- personal episodes ground answers only under explicit or obvious personal scope,
- source/timeline evidence can be `citation_only` without compiled-truth authority,
- every decision includes reason codes and a policy version hash.

## Phase 3: Decision Packet And Negative Memory Projections

**Next plan file:** `docs/superpowers/plans/2026-06-06-mbrain-decision-negative-projections.md`

**Purpose:** Preserve decisions, rationales, rejected alternatives, and failed
approaches as projections over existing records rather than as a new truth
store.

**Required implementation plan scope:**

- Create decision packet projection types and service.
- Create negative memory projection types and service.
- Source decision packets from assertions, assertion evidence, task decisions,
  canonical handoffs, retrieval traces, and source refs.
- Source negative memory from failed task attempts, rejected candidates, stale
  procedures, and explicit failed-approach records.
- Add applicability anchors: repo, branch, file, command, version, error class,
  target snapshot hash, `valid_until`, `reopen_if`, and source refs.
- Add retrieval activation: decision packets may become `answer_ground` only
  through canonical evidence; negative memory defaults to `suppress_if_valid`
  or `verify_first`.

**Required tests:**

```bash
bun test test/decision-packet-projection-service.test.ts test/negative-memory-projection-service.test.ts
bun run typecheck
```

**Exit criteria:**

- decision packet output includes `decision`, `rationale`,
  `rejected_alternatives`, `source_refs`, `canonical_target`,
  `target_snapshot_hash`, `valid_until`, `revalidation_path`, and
  `affected_selectors`,
- negative memory suppresses only when applicability anchors match,
- negative memory reopens when `reopen_if` conditions match,
- projections do not mutate canonical pages directly.

## Phase 4: Memory-Why And Proof Mode

**Next plan file:** `docs/superpowers/plans/2026-06-06-mbrain-memory-why-proof-mode.md`

**Purpose:** Make memory behavior explainable and demonstrate practical
Codex/Claude value before broad capture or graph expansion.

**Required implementation plan scope:**

- Extend retrieval traces with `considered_selectors`, `selected_selectors`,
  `omitted_candidate_refs`, `suppression_reason_codes`,
  `activation_decisions`, `freshness_snapshot`, `graph_paths_considered`, and
  `scope_policy_snapshot`.
- Add a concise memory-why rendering path.
- Add a verbose memory-why rendering path for debugging.
- Add `proof --agent` or an equivalent proof command routed through existing CLI
  patterns.
- Include fixtures for decision reuse, failed-attempt avoidance, stale code
  verify-first, candidate exclusion, and memory-why explanation.

**Required tests:**

```bash
bun test test/memory-why-service.test.ts test/proof-agent-command.test.ts
bun run typecheck
```

**Exit criteria:**

- default memory-why output fits in three to five lines,
- verbose output lists selected and omitted evidence paths,
- proof mode demonstrates at least one useful agent outcome without canonical
  pollution,
- proof mode fails if a candidate or graph path is used as answer authority.

## Phase 5: Allowlisted Episode Capture And Inbox Lead Refinement

**Next plan file:** `docs/superpowers/plans/2026-06-06-mbrain-episode-capture-inbox-leads.md`

**Purpose:** Capture useful episodes narrowly while preventing privacy leaks,
candidate spam, and review debt growth.

**Required implementation plan scope:**

- Add allowlisted capture categories: decisions, failed attempts worth negative
  memory, task resume state, code claims needing revalidation, explicit user
  preferences, and source-backed project facts.
- Add preview output before capture apply.
- Add redaction and scope classification before storage.
- Keep raw episode content as provenance/input, not answer authority.
- Add a gated candidate-content read surface such as `read_candidate_context`.
- Refine Inbox lead output so `retrieve_context` remains content-light by
  default.
- Add candidate debt metrics and review latency reporting.

**Required tests:**

```bash
bun test test/episode-capture-service.test.ts test/inbox-lead-service.test.ts test/read-candidate-context.test.ts
bun run typecheck
```

**Exit criteria:**

- broad raw capture is disabled by default,
- capture preview shows what will be stored and why,
- sensitive or secret content is redacted or rejected before storage,
- episode artifacts activate as provenance, hint, or citation surfaces only,
- candidate content requires an explicit gated read.

## Phase 6: Expanded Dream Maintenance Guardrails

**Next plan file:** `docs/superpowers/plans/2026-06-06-mbrain-dream-maintenance-guardrails.md`

**Purpose:** Let Dream maintain memory quality without silently expanding its
authority or writing canonical pages outside explicit gates.

**Required implementation plan scope:**

- Add lock heartbeat and TTL-before-abort behavior.
- Add replay canary before apply paths.
- Add verdict cache compatibility checks from Phase 1 and trust contract policy
  hash review from Phase 2.
- Add self-consumption guard for dream-generated outputs.
- Add report-only states for trust policy changes, new source class approval,
  unresolved contradictions, negative memory blocks, freshness violations,
  runner failures, and redaction failures.
- Add Dream report sections for candidate debt, projection freshness,
  stale/expired lifecycle transitions, and replay canary results.

**Required tests:**

```bash
bun test test/dream-cycle-runner-service.test.ts test/dream-maintenance-guardrails.test.ts test/dream-report-service.test.ts
bun run typecheck
```

**Exit criteria:**

- Dream aborts before applying when lock TTL cannot be renewed,
- Dream apply paths require replay canary success,
- Dream-generated candidates cannot be promoted in the same cycle,
- all flagged safety states are report-only unless an explicit policy gate
  authorizes action.

## Phase 7: Bounded Graph Frontier Retrieval Experiment

**Next plan file:** `docs/superpowers/plans/2026-06-06-mbrain-graph-frontier-experiment.md`

**Purpose:** Test whether graph-assisted selector planning improves canonical
read selection without making graph edges factual answer evidence.

**Status:** Detailed plan exists and should execute after Phase 6 acceptance.

**Required implementation plan scope:**

- Add strict edge allowlist for `supports`, `contradicts`, `supersedes`, and
  `requires_reverification`.
- Add edge authority implications and direction rules.
- Add fanout and depth caps.
- Add graph path trace output.
- Add graph-off and graph-on evaluation fixtures.
- Keep graph output as selector planning and orientation only until evaluation
  passes.

**Required tests:**

```bash
bun test test/assertion-frontier-retrieval-service.test.ts test/graph-frontier-evaluation.test.ts
bun run typecheck
```

**Exit criteria:**

- graph-derived claims cannot become answer evidence,
- false bridge rate is measured,
- p95 latency and token deltas are measured,
- graph-on improves canonical read recall or time-to-evidence without reducing
  canonical read precision,
- graph frontier remains behind an explicit flag until evaluation passes.

## Phase 8: Agent Trust UX And Integrated Acceptance

**Next plan file:** `docs/superpowers/plans/2026-06-06-mbrain-agent-trust-integrated-acceptance.md`

**Purpose:** Make the completed authority-first memory system inspectable for
Codex, Claude, and the user.

**Required implementation plan scope:**

- Add or extend `setup-agent --preview`.
- Add or extend `setup-agent --diff`.
- Add or extend `setup-agent --apply`.
- Add or extend `setup-agent --uninstall`.
- Add `doctor --agent --explain`.
- Add integrated acceptance tests across retrieval, trust contract, candidates,
  decision packets, negative memory, episode capture, Dream, graph-off/on, and
  proof mode.
- Update `docs/MBRAIN_AGENT_RULES.md`, embedded rule version, README, and
  `docs/MBRAIN_VERIFY.md` after behavior is implemented.

**Required tests:**

```bash
bun test test/setup-agent-trust-ux.test.ts test/doctor-agent-explain.test.ts test/authority-first-integrated-acceptance.test.ts
bun run typecheck
```

**Exit criteria:**

- the user can preview, diff, apply, and uninstall agent trust surfaces,
- doctor can explain installed memory behavior and proof status,
- integrated tests prove no scope leaks, candidate pollution, graph-as-answer
  evidence, promotion bypass, prompt-injection auto-write, or secret
  canonicalization,
- documentation and embedded agent rules match the final implemented behavior.

## Execution Rules For The Series

- Execute Phase 1 first because it blocks unsafe expansion.
- Before each later phase, create the named detailed plan file using
  superpowers:writing-plans.
- Each phase must include failing tests before implementation.
- Each phase must commit after its focused verification gate passes.
- Each phase must update `docs/MBRAIN_VERIFY.md` only for behavior actually
  implemented in that phase.
- Do not move a planned feature into an earlier phase unless it is required for
  that phase's acceptance gate.
- Keep the pre-existing untracked `reference/` directory untouched.
- If a phase changes `src/schema.sql`, run `bun run build:schema` and mirror
  required schema changes in PGLite and SQLite paths.
- If a phase changes agent behavior, update agent rules and embedded rule
  version in the same phase.

## Final Full-Spec Acceptance Gate

After all phases are complete, run:

```bash
bun run test:authority-foundation
bun test \
  test/trust-contract-service.test.ts \
  test/decision-packet-projection-service.test.ts \
  test/negative-memory-projection-service.test.ts \
  test/memory-why-service.test.ts \
  test/proof-agent-command.test.ts \
  test/episode-capture-service.test.ts \
  test/inbox-lead-service.test.ts \
  test/read-candidate-context.test.ts \
  test/dream-maintenance-guardrails.test.ts \
  test/dream-report-service.test.ts \
  test/assertion-frontier-retrieval-service.test.ts \
  test/graph-frontier-evaluation.test.ts \
  test/setup-agent-trust-ux.test.ts \
  test/doctor-agent-explain.test.ts \
  test/authority-first-integrated-acceptance.test.ts
bun run typecheck
git status --short --branch
```

Expected:

- all authority-first focused tests pass,
- typecheck passes,
- status shows only unrelated pre-existing untracked files,
- memory behavior can be explained through proof mode and memory-why,
- candidate, graph, episode, and Dream outputs never bypass canonical evidence
  or governed writeback.
