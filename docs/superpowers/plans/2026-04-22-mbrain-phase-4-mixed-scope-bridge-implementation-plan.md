# Phase 4 Mixed-Scope Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the first explicit mixed-scope retrieval bridge for `mbrain` without weakening the current work-personal isolation defaults.

**Architecture:** Extend the retrieval contract with one new intent, `mixed_scope_bridge`, that composes exactly two existing read-only routes: work-side `broad_synthesis` and personal-side `personal_profile_lookup`. Keep the bridge deterministic, traceable, and explicit by requiring `requested_scope: mixed`, denying writes, and returning no combined route when either delegated side fails.

**Tech Stack:** TypeScript, Bun, shared operations contract, existing scope-gate/retrieval-selector services, SQLite/PGLite/Postgres through the current engine abstractions.

---

## File Map

- Create: `src/core/services/mixed-scope-bridge-service.ts`
- Create: `test/mixed-scope-bridge-service.test.ts`
- Create: `test/mixed-scope-bridge-operations.test.ts`
- Create: `test/phase4-mixed-scope-bridge.test.ts`
- Create: `scripts/bench/phase4-mixed-scope-bridge.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/services/scope-gate-service.ts`
- Modify: `src/core/services/retrieval-route-selector-service.ts`
- Modify: `src/core/operations.ts`
- Modify: `test/scope-gate-service.test.ts`
- Modify: `test/retrieval-route-selector-service.test.ts`
- Modify: `scripts/bench/phase4-acceptance-pack.ts`
- Modify: `test/phase4-acceptance-pack.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`

## Task 1: Contract And Scope-Gate Admission

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/services/scope-gate-service.ts`
- Modify: `test/scope-gate-service.test.ts`

- [ ] **Step 1: Write failing scope-gate coverage for mixed bridge admission**

Add tests that require:
- `mixed_scope_bridge` allows explicit mixed scope
- `mixed_scope_bridge` denies explicit work scope
- `mixed_scope_bridge` defers when scope is unknown

- [ ] **Step 2: Run the scope-gate test to verify RED**

Run: `bun test test/scope-gate-service.test.ts`

Expected: fail because `mixed_scope_bridge` is not part of the current intent contract and mixed scope is still denied globally.

- [ ] **Step 3: Implement the minimal contract change**

Update:
- `RetrievalRouteIntent` to include `mixed_scope_bridge`
- `RetrievalRouteSelection.route_kind` compatibility
- `evaluateScopeGate()` policy logic so only `mixed_scope_bridge` may proceed under explicit mixed scope

- [ ] **Step 4: Run the scope-gate test to verify GREEN**

Run: `bun test test/scope-gate-service.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/services/scope-gate-service.ts test/scope-gate-service.test.ts
git commit -m "feat: admit mixed-scope bridge through scope gate"
```

## Task 2: Mixed-Scope Bridge Service

**Files:**
- Create: `src/core/services/mixed-scope-bridge-service.ts`
- Create: `test/mixed-scope-bridge-service.test.ts`

- [ ] **Step 1: Write failing service tests**

Cover:
- explicit mixed scope + exact profile subject + valid work query returns a combined bridge route
- missing personal profile subject returns a degraded no-route disclosure
- missing work route match returns a degraded no-route disclosure
- the combined route contains both delegated route payloads and a compact bridge reason

- [ ] **Step 2: Run the new service test to verify RED**

Run: `bun test test/mixed-scope-bridge-service.test.ts`

Expected: fail because the service does not exist yet.

- [ ] **Step 3: Implement the minimal bridge**

Compose:
- `evaluateScopeGate(... intent: "mixed_scope_bridge")`
- `getBroadSynthesisRoute(...)`
- `getPersonalProfileLookupRoute(...)`

Rules:
- require `requested_scope: "mixed"`
- return no combined route unless both delegated routes succeed
- never write durable records

- [ ] **Step 4: Run the service test to verify GREEN**

Run: `bun test test/mixed-scope-bridge-service.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/mixed-scope-bridge-service.ts test/mixed-scope-bridge-service.test.ts
git commit -m "feat: add mixed-scope bridge service"
```

## Task 3: Shared Operation And Retrieval Selector Integration

**Files:**
- Modify: `src/core/services/retrieval-route-selector-service.ts`
- Modify: `src/core/operations.ts`
- Create: `test/mixed-scope-bridge-operations.test.ts`
- Modify: `test/retrieval-route-selector-service.test.ts`

- [ ] **Step 1: Write failing operation and selector tests**

Cover:
- `mixed-scope-bridge` is registered with CLI hints
- `retrieval-route` accepts `intent: mixed_scope_bridge`
- selector can persist a Retrieval Trace for a successful mixed bridge
- degraded mixed bridge returns deterministic `selection_reason` and no combined route

- [ ] **Step 2: Run the new tests to verify RED**

Run:

```bash
bun test test/mixed-scope-bridge-operations.test.ts
bun test test/retrieval-route-selector-service.test.ts
```

Expected: fail because the operation and selector do not know this intent yet.

- [ ] **Step 3: Implement the minimal shared-surface wiring**

Update:
- `src/core/operations.ts` with one `mixed_scope_bridge` operation
- `selectRetrievalRoute()` dispatch and validation
- trace persistence to include the mixed bridge route stack

- [ ] **Step 4: Run the tests to verify GREEN**

Run:

```bash
bun test test/mixed-scope-bridge-operations.test.ts
bun test test/retrieval-route-selector-service.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/retrieval-route-selector-service.ts src/core/operations.ts test/mixed-scope-bridge-operations.test.ts test/retrieval-route-selector-service.test.ts
git commit -m "feat: expose mixed-scope bridge through retrieval surfaces"
```

## Task 4: Benchmark And Phase 4 Acceptance Wiring

**Files:**
- Create: `scripts/bench/phase4-mixed-scope-bridge.ts`
- Create: `test/phase4-mixed-scope-bridge.test.ts`
- Modify: `scripts/bench/phase4-acceptance-pack.ts`
- Modify: `test/phase4-acceptance-pack.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`

- [ ] **Step 1: Write failing benchmark tests**

Cover:
- benchmark JSON shape for `mixed_scope_bridge`
- acceptance-pack benchmark list now includes `mixed_scope_bridge`

- [ ] **Step 2: Run the benchmark tests to verify RED**

Run:

```bash
bun test test/phase4-mixed-scope-bridge.test.ts
bun test test/phase4-acceptance-pack.test.ts
```

Expected: fail because the benchmark script and acceptance-pack wiring do not exist yet.

- [ ] **Step 3: Implement the benchmark slice**

Add:
- correctness workload for success, degrade, and traceable selection
- latency workload for the mixed bridge read path
- `bench:phase4-mixed-scope-bridge`
- `test:phase4` updates
- `MBRAIN_VERIFY.md` verification section

- [ ] **Step 4: Run the benchmark tests to verify GREEN**

Run:

```bash
bun test test/phase4-mixed-scope-bridge.test.ts
bun test test/phase4-acceptance-pack.test.ts
bun run bench:phase4-mixed-scope-bridge --json
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/bench/phase4-mixed-scope-bridge.ts test/phase4-mixed-scope-bridge.test.ts scripts/bench/phase4-acceptance-pack.ts test/phase4-acceptance-pack.test.ts package.json docs/MBRAIN_VERIFY.md
git commit -m "test: add mixed-scope bridge phase4 acceptance coverage"
```

## Task 5: Final Verification

**Files:**
- No new files expected

- [ ] **Step 1: Run the focused mixed-scope suite**

Run:

```bash
bun test test/scope-gate-service.test.ts test/mixed-scope-bridge-service.test.ts test/mixed-scope-bridge-operations.test.ts test/retrieval-route-selector-service.test.ts test/phase4-mixed-scope-bridge.test.ts
```

Expected: pass.

- [ ] **Step 2: Run the broader Phase 4 regression**

Run:

```bash
bun run test:phase4
bun run bench:phase4-acceptance --json
```

Expected:
- `test:phase4` passes with the same Postgres skips when `DATABASE_URL` is unavailable
- `acceptance.phase4_status` stays `pass`

- [ ] **Step 3: Push**

```bash
git push origin phase2-note-manifest
```
