# Phase 4 Mixed-Scope Episode Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `mixed_scope_bridge` so the personal side can use either an exact profile-memory route or an exact personal-episode route, while preserving the current explicit mixed-scope boundary.

**Architecture:** Keep `intent: mixed_scope_bridge` and add a required `personal_route_kind` discriminator. The work side stays fixed to `broad_synthesis`; the personal side dispatches to either `personal_profile_lookup` or `personal_episode_lookup`. Retrieval traces and benchmark coverage must disclose which personal route kind was used.

**Tech Stack:** TypeScript, Bun, shared operations contract, existing mixed-scope bridge service, personal lookup services, retrieval selector, SQLite/PGLite/Postgres through current engine abstractions.

---

## File Map

- Modify: `src/core/types.ts`
- Modify: `src/core/services/mixed-scope-bridge-service.ts`
- Modify: `src/core/services/retrieval-route-selector-service.ts`
- Modify: `src/core/operations.ts`
- Modify: `scripts/bench/phase4-mixed-scope-bridge.ts`
- Modify: `docs/MBRAIN_VERIFY.md`
- Modify: `test/mixed-scope-bridge-service.test.ts`
- Modify: `test/mixed-scope-bridge-operations.test.ts`
- Modify: `test/retrieval-route-selector-service.test.ts`
- Modify: `test/retrieval-route-selector-operations.test.ts`
- Modify: `test/phase4-mixed-scope-bridge.test.ts`

## Task 1: Contract Extension

**Files:**
- Modify: `src/core/types.ts`
- Modify: `test/mixed-scope-bridge-service.test.ts`

- [ ] **Step 1: Write failing tests for the new discriminator**

Add coverage that requires:
- existing profile path to pass only when `personal_route_kind: "profile"` is present
- new episode path to require `personal_route_kind: "episode"` and `episode_title`

- [ ] **Step 2: Run the service test to verify RED**

Run: `bun test test/mixed-scope-bridge-service.test.ts`

Expected: fail because the current bridge input and route payload do not support episode variants.

- [ ] **Step 3: Extend the bridge types**

Update:
- `MixedScopeBridgeInput`
- `MixedScopeBridgeRoute`
- any helper unions needed for `personal_route`

- [ ] **Step 4: Run the service test to verify GREEN for the type-level changes**

Run: `bun test test/mixed-scope-bridge-service.test.ts`

Expected: still failing only on missing implementation behavior.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts test/mixed-scope-bridge-service.test.ts
git commit -m "refactor: extend mixed bridge contract for episode routes"
```

## Task 2: Mixed Bridge Service Behavior

**Files:**
- Modify: `src/core/services/mixed-scope-bridge-service.ts`
- Modify: `test/mixed-scope-bridge-service.test.ts`

- [ ] **Step 1: Add failing service coverage for episode routing**

Cover:
- explicit mixed scope + valid work query + exact episode title returns a combined bridge route
- missing episode title degrades explicitly
- ambiguous episode title degrades explicitly

- [ ] **Step 2: Run the service test to verify RED**

Run: `bun test test/mixed-scope-bridge-service.test.ts`

Expected: fail because the service only supports personal profile routes today.

- [ ] **Step 3: Implement the minimal service extension**

Branch only on `personal_route_kind`:
- `profile` -> current profile route behavior
- `episode` -> exact personal episode route behavior

- [ ] **Step 4: Run the service test to verify GREEN**

Run: `bun test test/mixed-scope-bridge-service.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/mixed-scope-bridge-service.ts test/mixed-scope-bridge-service.test.ts
git commit -m "feat: add episode support to mixed bridge service"
```

## Task 3: Shared Surfaces And Trace Wiring

**Files:**
- Modify: `src/core/services/retrieval-route-selector-service.ts`
- Modify: `src/core/operations.ts`
- Modify: `test/mixed-scope-bridge-operations.test.ts`
- Modify: `test/retrieval-route-selector-service.test.ts`
- Modify: `test/retrieval-route-selector-operations.test.ts`

- [ ] **Step 1: Write failing operation and selector tests**

Cover:
- dedicated `mixed-scope-bridge` operation accepts `personal_route_kind: episode`
- `retrieval-route` accepts the same episode-side inputs
- persisted Retrieval Trace includes `personal-episode:<id>` source refs for episode bridges

- [ ] **Step 2: Run the tests to verify RED**

Run:

```bash
bun test test/mixed-scope-bridge-operations.test.ts
bun test test/retrieval-route-selector-service.test.ts
bun test test/retrieval-route-selector-operations.test.ts
```

Expected: fail because the shared surfaces only know the profile variant.

- [ ] **Step 3: Implement the minimal wiring**

Update:
- operation params and validation
- selector dispatch inputs
- mixed bridge trace source-ref collection for both personal route kinds

- [ ] **Step 4: Run the tests to verify GREEN**

Run:

```bash
bun test test/mixed-scope-bridge-operations.test.ts
bun test test/retrieval-route-selector-service.test.ts
bun test test/retrieval-route-selector-operations.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/retrieval-route-selector-service.ts src/core/operations.ts test/mixed-scope-bridge-operations.test.ts test/retrieval-route-selector-service.test.ts test/retrieval-route-selector-operations.test.ts
git commit -m "feat: wire episode variant through mixed bridge surfaces"
```

## Task 4: Benchmark And Verification Update

**Files:**
- Modify: `scripts/bench/phase4-mixed-scope-bridge.ts`
- Modify: `docs/MBRAIN_VERIFY.md`
- Modify: `test/phase4-mixed-scope-bridge.test.ts`

- [ ] **Step 1: Write failing benchmark expectations**

Require the benchmark correctness workload to cover both:
- profile-side mixed bridge success
- episode-side mixed bridge success

- [ ] **Step 2: Run the benchmark test to verify RED**

Run: `bun test test/phase4-mixed-scope-bridge.test.ts`

Expected: fail because the benchmark currently exercises only the profile variant.

- [ ] **Step 3: Extend the benchmark and docs**

Update:
- correctness workload to include the episode path
- `MBRAIN_VERIFY.md` wording so mixed bridge explicitly covers both personal-side kinds

- [ ] **Step 4: Run the benchmark test to verify GREEN**

Run:

```bash
bun test test/phase4-mixed-scope-bridge.test.ts
bun run bench:phase4-mixed-scope-bridge --json
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/bench/phase4-mixed-scope-bridge.ts docs/MBRAIN_VERIFY.md test/phase4-mixed-scope-bridge.test.ts
git commit -m "test: cover episode variant in mixed bridge benchmark"
```

## Task 5: Final Verification

**Files:**
- No new files expected

- [ ] **Step 1: Run the focused suite**

Run:

```bash
bun test test/mixed-scope-bridge-service.test.ts test/mixed-scope-bridge-operations.test.ts test/retrieval-route-selector-service.test.ts test/retrieval-route-selector-operations.test.ts test/phase4-mixed-scope-bridge.test.ts
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
