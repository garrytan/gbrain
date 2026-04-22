# Phase 4 Mixed-Scope Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded mixed-scope disclosure artifact that projects successful `mixed_scope_bridge` results into visibility-safe output.

**Architecture:** Keep the existing bridge and selector contract stable. Add one read-only disclosure service and one shared operation that delegate to `getMixedScopeBridge(...)`, then redact or surface personal detail according to existing `export_status`, `sensitivity`, and personal-episode privacy rules.

**Tech Stack:** TypeScript, Bun, existing mixed-scope bridge service, shared operations contract, Phase 4 benchmark and acceptance wiring.

---

## File Map

- Create: `src/core/services/mixed-scope-disclosure-service.ts`
- Create: `test/mixed-scope-disclosure-service.test.ts`
- Create: `test/mixed-scope-disclosure-operations.test.ts`
- Create: `test/phase4-mixed-scope-disclosure.test.ts`
- Create: `scripts/bench/phase4-mixed-scope-disclosure.ts`
- Modify: `src/core/operations.ts`
- Modify: `src/core/types.ts`
- Modify: `scripts/bench/phase4-acceptance-pack.ts`
- Modify: `test/phase4-acceptance-pack.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`
- Create: `docs/superpowers/specs/2026-04-22-mbrain-phase-4-mixed-scope-disclosure-design.md`

## Task 1: Service Contract And Redaction Policy

**Files:**
- Create: `src/core/services/mixed-scope-disclosure-service.ts`
- Create: `test/mixed-scope-disclosure-service.test.ts`
- Modify: `src/core/types.ts`

- [ ] **Step 1: Write failing service tests**

Cover:
- exportable profile-memory disclosure surfaces exact content
- private-only profile-memory disclosure withholds content but keeps metadata
- personal-episode disclosure remains metadata-only
- degraded mixed bridge returns no disclosure payload

- [ ] **Step 2: Run the new service test to verify RED**

Run: `bun test test/mixed-scope-disclosure-service.test.ts`

Expected: fail because the service does not exist yet.

- [ ] **Step 3: Implement the minimal projection**

Add one service that:
- delegates to `getMixedScopeBridge(...)`
- returns no disclosure payload unless the bridge resolved
- maps the personal branch to one of a few deterministic disclosure states
- keeps work-side output limited to the current bridge summaries and reads

- [ ] **Step 4: Run the service test to verify GREEN**

Run: `bun test test/mixed-scope-disclosure-service.test.ts`

Expected: pass.

## Task 2: Shared Operation

**Files:**
- Modify: `src/core/operations.ts`
- Create: `test/mixed-scope-disclosure-operations.test.ts`

- [ ] **Step 1: Write failing operation coverage**

Cover:
- `mixed-scope-disclosure` is registered with CLI hints
- operation returns deterministic disclosure payloads for profile and episode branches
- degraded bridge returns no disclosure payload

- [ ] **Step 2: Run the operation test to verify RED**

Run: `bun test test/mixed-scope-disclosure-operations.test.ts`

Expected: fail because the operation does not exist yet.

- [ ] **Step 3: Implement the minimal shared surface**

Add one operation that accepts the same bridge-routing inputs plus
`personal_route_kind`, and delegates to the disclosure service.

- [ ] **Step 4: Run the operation test to verify GREEN**

Run: `bun test test/mixed-scope-disclosure-operations.test.ts`

Expected: pass.

## Task 3: Benchmark And Acceptance Wiring

**Files:**
- Create: `scripts/bench/phase4-mixed-scope-disclosure.ts`
- Create: `test/phase4-mixed-scope-disclosure.test.ts`
- Modify: `scripts/bench/phase4-acceptance-pack.ts`
- Modify: `test/phase4-acceptance-pack.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`

- [ ] **Step 1: Write failing benchmark coverage**

Cover:
- benchmark JSON shape for `mixed_scope_disclosure`
- acceptance-pack includes the new slice

- [ ] **Step 2: Run the benchmark tests to verify RED**

Run:

```bash
bun test test/phase4-mixed-scope-disclosure.test.ts
bun test test/phase4-acceptance-pack.test.ts
```

Expected: fail because the new benchmark script and acceptance wiring do not exist yet.

- [ ] **Step 3: Implement the benchmark slice**

Add:
- correctness checks for exportable profile, private profile, and episode metadata-only disclosure
- latency workload for the mixed disclosure read path
- `bench:phase4-mixed-scope-disclosure`
- `test:phase4` update
- verification doc update

- [ ] **Step 4: Run the benchmark tests to verify GREEN**

Run:

```bash
bun test test/phase4-mixed-scope-disclosure.test.ts
bun test test/phase4-acceptance-pack.test.ts
bun run bench:phase4-mixed-scope-disclosure --json
```

Expected: pass.
