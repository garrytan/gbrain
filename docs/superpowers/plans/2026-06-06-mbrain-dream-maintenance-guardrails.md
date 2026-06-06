# MBrain Dream Maintenance Guardrails Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. If the
> Superpowers skill is not available in the current runtime, use available
> subagents for sidecar review and keep this checklist updated.

**Goal:** Expand Dream maintenance guardrails so mutating Dream runs renew their
cycle lock, abort before apply when the lock cannot be renewed, require a replay
canary before apply paths, and report safety states without silently expanding
Dream authority.

**Architecture:** Keep Dream as the operational loop over existing authority
surfaces. This phase adds guardrail metadata and gates around the existing
`runDreamCycle` and `runDreamCycleMaintenance` services. It must not introduce
new canonical write authority, new broad raw ingest, or a new truth store.

**Tech Stack:** Bun, TypeScript, existing `src/core/services`, existing
maintenance runtime lock APIs, Bun test runner, `bun run typecheck`.

---

## Source Specs

- `docs/superpowers/specs/2026-06-06-mbrain-authority-first-memory-improvement-design.md`
- `docs/superpowers/plans/2026-06-06-mbrain-authority-first-full-spec-roadmap.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-07-dream-cycle.md`
- `docs/superpowers/specs/2026-06-01-mbrain-auto-promotion-design.md`
- `docs/MBRAIN_AGENT_RULES.md`
- `docs/MCP_INSTRUCTIONS.md`

## Scope Check

This phase implements only:

- cycle lock renewal/heartbeat around mutating Dream phases;
- TTL-before-abort behavior before apply-capable phases;
- a deterministic replay canary gate for apply paths;
- policy-version and verdict-cache review metadata;
- self-consumption guard checks for dream-generated outputs;
- report-only safety states for trust, source, contradiction, negative-memory,
  freshness, runner, redaction, candidate debt, projection freshness, and replay
  canary outcomes;
- focused verification docs and scripts.

Do not add graph frontier retrieval, setup-agent trust UX, doctor explain UX,
new persisted Dream output tables, direct canonical page writes, or same-cycle
promotion of Dream-generated/inferred candidates.

## Implementation Split

Implement Phase 6 in two small slices:

1. **Runner-level apply guards first.**
   Add phase-boundary cycle-lock renewal and replay-canary gating in
   `dream-cycle-runner-service.ts`. This is the first PR-sized code slice
   because it protects existing apply-capable paths without adding new storage
   or report models.
2. **Report-only maintenance visibility second.**
   Add safety-state counts, candidate debt, and projection freshness reporting.
   This slice must reuse existing Memory Inbox, projection, and safety-scan data
   instead of creating a parallel Dream report store.

Avoid timers, background intervals, and new runtime APIs unless the existing
`acquireCycleLock` renewal semantics cannot satisfy a failing test. Do not use
`recordWorkerHeartbeat` as the cycle-lock heartbeat; it records worker liveness
but does not extend a Dream cycle lock.

## Progress Notes

- [x] Slice A runner-level apply guards:
  `dream-cycle-runner-service.ts` now exposes guardrail status, requires replay
  canary before apply-capable phase work, renews same-holder locks before
  candidate-writing maintenance phases, and aborts before guarded phase
  handlers on renewal failure.
- [ ] Slice B report-only maintenance visibility:
  safety-state counts, candidate debt, and projection freshness remain to be
  added without new storage or canonical-write authority.

## Existing Surfaces To Reuse

- `src/core/services/dream-cycle-runner-service.ts`
  - phase registry, cycle lock acquisition/release, auto-promote dry-run/apply
    routing, self-consumption marker.
- `src/core/services/maintenance-runtime-service.ts`
  - `acquireCycleLock` already refreshes same-holder locks and updates
    `heartbeat_at`; reuse this as the heartbeat primitive.
- `src/core/services/maintenance-runtime-db-adapter.ts`
  - SQL-backed cycle lock behavior mirrors the in-memory service.
- `src/core/services/dream-cycle-maintenance-service.ts`
  - bounded candidate suggestions, derived freshness report, apply control
    plane.
- `src/core/services/memory-review-report-service.ts`
  - daily memory report formatting and auto-promotion summary.
- `src/core/services/memory-why-service.ts`
  - negative-memory suppression and stale-check explanations can be reported
    as safety-state inputs later; do not duplicate that authority.

## File Structure

- Add: `src/core/types/dream-guardrails.ts`
  - Guardrail report types for lock renewal, replay canary, report-only safety
    states, candidate debt, and projection freshness.

- Add: `src/core/services/dream-guardrail-service.ts`
  - Pure helpers for replay canary evaluation, self-consumption checks, and
    safety-state summaries. Keep lock renewal in the runner unless a shared
    helper is truly needed.

- Modify: `src/core/services/dream-cycle-runner-service.ts`
  - Add lock heartbeat/renewal before mutating phases and before
    auto-promote apply.
  - Add replay canary gate before apply-capable phases.
  - Include guardrail report in `DreamCycleRunResult`.

- Modify: `src/core/services/dream-cycle-maintenance-service.ts`
  - Include candidate debt and projection freshness in report-only output.
  - Surface redaction/runner/freshness/report-only states without applying.

- Modify: `src/core/types.ts`
  - Export Dream guardrail types if needed by tests or operations.

- Add: `test/dream-maintenance-guardrails.test.ts`
  - Locks the new guardrail service and runner behavior.

- Add or modify: `test/dream-report-service.test.ts`
  - Locks report-only safety sections and candidate/projection counts.

- Modify: `test/dream-cycle-runner-service.test.ts`
  - Keeps existing runner behavior while adding TTL-before-abort and replay
    canary tests.

- Modify: `docs/MBRAIN_VERIFY.md`
  - Adds the Phase 6 verification command.

- Modify: `package.json`
  - Adds `test:dream-guardrails`.

## Guardrail Contract

Dream must expose a run-level `guardrails` report with:

- `lock_renewal`
  - status: `not_required`, `renewed`, `aborted`, or `missing_runtime`
  - renewal count
  - last renewal timestamp
  - reason codes
- `replay_canary`
  - status: `not_required`, `passed`, `failed`, or `not_configured`
  - required before apply-capable phases
  - failed or missing canary aborts apply-capable phases
- `self_consumption`
  - anti-loop marker present
  - dream-generated candidates cannot be promoted in the same cycle
- `report_only_states`
  - trust policy changes
  - new source class approval
  - unresolved contradictions
  - negative memory blocks
  - freshness violations
  - runner failures
  - redaction failures
- `maintenance_health`
  - candidate debt counts
  - projection freshness counts
  - stale/expired lifecycle transition counts
  - runner budget usage

The guardrail report is evidence for review and audit. It is not answer
authority and does not authorize canonical writes.

## Task 1: Guardrail Types And Pure Service

**Files:**

- Add: `src/core/types/dream-guardrails.ts`
- Add: `src/core/services/dream-guardrail-service.ts`
- Add: `test/dream-maintenance-guardrails.test.ts`
- Modify: `src/core/types.ts`

- [ ] **Step 1: Write failing service tests**

Create tests covering:

- replay canary is `not_required` for dry-run/report-only runs;
- replay canary is required before apply-capable phases;
- missing or failed canary produces an abort decision;
- dream-generated candidates are blocked from same-cycle promotion;
- safety states are report-only by default and include reason codes;
- candidate debt and projection freshness summaries are deterministic.

- [ ] **Step 2: Implement guardrail types**

Keep types structural and narrow. Prefer string literal unions and plain
objects; avoid a class hierarchy.

- [ ] **Step 3: Implement pure guardrail service**

Implement helpers such as:

```ts
export function evaluateDreamReplayCanary(input: DreamReplayCanaryInput): DreamReplayCanaryResult
export function evaluateDreamApplyGuardrails(input: DreamApplyGuardrailInput): DreamApplyGuardrailDecision
export function buildDreamReportOnlyStates(input: DreamReportOnlyStateInput): DreamReportOnlyStateResult
```

Do not call the database from this service.

- [ ] **Step 4: Run focused tests**

Run:

```bash
bun test test/dream-maintenance-guardrails.test.ts
bun run typecheck
```

Expected: PASS.

## Task 2: Lock Heartbeat And TTL-Before-Abort

**Files:**

- Modify: `src/core/services/dream-cycle-runner-service.ts`
- Modify: `test/dream-cycle-runner-service.test.ts`

- [ ] **Step 1: Write failing runner tests**

Create tests covering:

- mutating Dream renews the same-holder cycle lock before each mutating or
  apply-capable phase;
- if renewal returns `busy`, Dream aborts before the phase and records a failed
  guardrail result;
- if runtime is missing, mutating Dream still fails closed before reads;
- dry-run does not require lock renewal;
- release still runs only for an acquired same-holder lock.

- [ ] **Step 2: Implement renewal wrapper**

Reuse `acquireCycleLock` with the same holder as the renewal primitive. Keep
the default TTL small and explicit in code, but do not add new runtime APIs
unless tests prove `acquireCycleLock` cannot express the behavior. If renewal
returns `busy`, throws, or cannot prove same-holder ownership, fail closed before
invoking the next phase.

- [ ] **Step 3: Run runner tests**

Run:

```bash
bun test test/dream-cycle-runner-service.test.ts test/dream-maintenance-guardrails.test.ts
bun run typecheck
```

Expected: PASS.

## Task 3: Replay Canary Gate

**Files:**

- Modify: `src/core/services/dream-cycle-runner-service.ts`
- Modify: `test/dream-cycle-runner-service.test.ts`
- Modify: `test/dream-maintenance-guardrails.test.ts`

- [ ] **Step 1: Write failing canary tests**

Create tests covering:

- apply mode with `write_candidates` requires a replay canary result before
  apply-capable phases run;
- failed canary skips/aborts apply-capable phases and records a report-only
  safety state;
- successful canary lets candidate-writing phases continue;
- auto-promote apply does not run without successful canary;
- dry-run and report-only modes mark canary `not_required`.

- [ ] **Step 2: Implement injectable canary dependency**

Add a small optional dependency to `DreamCycleRunDeps`, for example:

```ts
replayCanary?: {
  run(input: { scope_id: string; now: string; trigger: string }): Promise<DreamReplayCanaryResult>
}
```

Default behavior should be fail-closed for apply-capable runs and
`not_required` for dry-run/report-only runs. Canary failure is a failed apply
guard, not a warning; do not call `autoPromote.run` for an apply request after a
failed or missing canary.

- [ ] **Step 3: Run canary gate tests**

Run:

```bash
bun test test/dream-cycle-runner-service.test.ts test/dream-maintenance-guardrails.test.ts
bun run typecheck
```

Expected: PASS.

## Task 4: Dream Report Safety States

**Files:**

- Modify: `src/core/services/dream-cycle-maintenance-service.ts`
- Add or modify: `test/dream-report-service.test.ts`
- Modify: `docs/MBRAIN_VERIFY.md`

- [ ] **Step 1: Write failing report tests**

Create tests covering:

- unresolved contradictions appear as report-only safety states;
- redaction and runner failures appear as report-only safety states;
- candidate debt is summarized without exposing candidate content;
- projection freshness is summarized from existing derived freshness data;
- replay canary failure appears in summary lines and does not imply mutation.

- [ ] **Step 2: Implement report-only summaries**

Prefer deriving counts from existing phase counts and maintenance reports. Do
not create new tables. Keep `proposed_content` and raw source text out of
report summaries. Reuse `computeCandidateDebtMetrics` for candidate debt rather
than inventing a second debt model, and derive projection freshness from
existing projection target status/freshness fields.

- [ ] **Step 3: Run report tests**

Run:

```bash
bun test test/dream-maintenance-guardrails.test.ts test/dream-report-service.test.ts
bun run typecheck
```

Expected: PASS.

## Task 5: Verification Docs

**Files:**

- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`

- [ ] **Step 1: Add script**

Add:

```json
"test:dream-guardrails": "bun test test/dream-cycle-runner-service.test.ts test/dream-maintenance-guardrails.test.ts test/dream-report-service.test.ts"
```

- [ ] **Step 2: Add docs section**

Add a short `Dream maintenance guardrails` section to `docs/MBRAIN_VERIFY.md`:

```bash
bun run test:dream-guardrails
bun run typecheck
```

Acceptance:

- mutating Dream renews/holds a cycle lock before apply work;
- Dream aborts before apply when lock renewal fails;
- replay canary is required before apply-capable phases;
- Dream-generated outputs cannot be promoted in the same cycle;
- safety states are report-only unless explicit gates authorize action.

- [ ] **Step 3: Run phase gate**

Run:

```bash
bun run test:dream-guardrails
bun run test:episode-capture
bun run typecheck
git diff --check
```

Expected: PASS.

## Phase Acceptance

- [ ] Mutating Dream renews the cycle lock before apply-capable work.
- [ ] Dream aborts before applying when lock renewal fails or runtime is
  missing.
- [ ] Replay canary gates candidate-writing and auto-promote apply paths.
- [ ] Dream-generated candidates cannot be promoted in the same cycle.
- [ ] Trust/source/contradiction/negative-memory/freshness/runner/redaction
  safety states are report-only by default.
- [ ] Candidate debt and projection freshness appear as bounded, content-light
  report signals.
- [ ] Focused tests, episode-capture regression, typecheck, and diff check pass.
