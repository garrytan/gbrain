# Phase 4 Export and Visibility Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Phase 4 gap by making personal-memory export behavior explicit, testable, and safe by default.

**Architecture:** Keep the current canonical personal stores (`profile_memory_entries`, `personal_episode_entries`) unchanged. Add a small export-policy service plus thin operation and CLI surfaces so default exports continue to exclude personal memory, while explicit personal export only allows curated `exportable` profile-memory records and keeps personal episodes private unless a later slice explicitly broadens the policy.

**Tech Stack:** TypeScript, Bun, shared operations contract, CLI command layer, SQLite/PGLite/Postgres through existing engine methods.

---

## File Map

- Create: `src/core/services/personal-export-visibility-service.ts`
- Create: `test/personal-export-visibility-service.test.ts`
- Create: `test/personal-export-operations.test.ts`
- Create: `test/export-personal-visibility.test.ts`
- Create: `docs/superpowers/specs/2026-04-22-mbrain-phase-4-export-and-visibility-boundaries-design.md`
- Modify: `src/core/operations.ts`
- Modify: `src/commands/export.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`
- Modify: `docs/superpowers/specs/2026-04-22-mbrain-phase-4-safe-personal-writes-design.md` only if the policy wording needs to reference the new export boundary
- Modify: `docs/superpowers/specs/2026-04-22-mbrain-phase-4-personal-write-target-design.md` only if the new export policy changes a named boundary

## Task 1: Personal Export Policy Contract

**Files:**
- Create: `src/core/services/personal-export-visibility-service.ts`
- Test: `test/personal-export-visibility-service.test.ts`

- [ ] **Step 1: Write failing service tests for the policy boundary**

Cover these behaviors:
- default export preview returns only profile-memory records with `export_status === 'exportable'`
- `private_only` profile-memory records are excluded
- personal episodes are excluded from raw export by default
- work-scoped export requests are denied
- unknown-scope export requests defer instead of exporting

- [ ] **Step 2: Run the new service test to verify RED**

Run: `bun test test/personal-export-visibility-service.test.ts`

Expected: fail because `personal-export-visibility-service.ts` does not exist yet.

- [ ] **Step 3: Implement the minimal service**

Implement one focused service that:
- reuses the existing scope-gate logic instead of inventing a second policy engine
- returns deterministic `allow`, `deny`, and `defer` disclosure shapes
- lists exportable profile-memory entries from the engine
- keeps personal episodes excluded for this slice

- [ ] **Step 4: Run the service test to verify GREEN**

Run: `bun test test/personal-export-visibility-service.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/personal-export-visibility-service.ts test/personal-export-visibility-service.test.ts
git commit -m "feat: add personal export visibility service"
```

## Task 2: Shared Operation Surface For Explicit Personal Export

**Files:**
- Modify: `src/core/operations.ts`
- Test: `test/personal-export-operations.test.ts`

- [ ] **Step 1: Write failing operation tests**

Cover these behaviors:
- operation is registered with a CLI hint such as `personal-export-preview`
- explicit personal request returns exportable profile-memory entries only
- work-scoped request is denied
- unknown-signal request defers

- [ ] **Step 2: Run the operation test to verify RED**

Run: `bun test test/personal-export-operations.test.ts`

Expected: fail because the operation is not registered yet.

- [ ] **Step 3: Implement the shared operation**

Add one operation in `src/core/operations.ts` that:
- calls the export-policy service
- exposes only preview/list behavior for this slice
- does not write files
- returns deterministic disclosure payloads rather than silently flattening policy failures

- [ ] **Step 4: Run the operation test to verify GREEN**

Run: `bun test test/personal-export-operations.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/operations.ts test/personal-export-operations.test.ts
git commit -m "feat: add personal export preview operation"
```

## Task 3: CLI Export Boundary

**Files:**
- Modify: `src/commands/export.ts`
- Test: `test/export-personal-visibility.test.ts`

- [ ] **Step 1: Write failing CLI/export tests**

Cover these behaviors:
- default `export` command continues exporting pages only and does not pull profile memory or personal episodes into the output
- explicit personal export mode writes only `exportable` profile-memory records
- explicit personal export mode never writes raw personal-episode records in this slice

- [ ] **Step 2: Run the export test to verify RED**

Run: `bun test test/export-personal-visibility.test.ts`

Expected: fail because the CLI export boundary is not implemented yet.

- [ ] **Step 3: Implement the smallest CLI change**

Keep the current page export path stable, and add one explicit personal-export flag or submode that:
- calls the shared personal-export preview operation or service
- writes Markdown only for exportable profile-memory records
- refuses to export personal episodes for now

- [ ] **Step 4: Run the export test to verify GREEN**

Run: `bun test test/export-personal-visibility.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/export.ts test/export-personal-visibility.test.ts
git commit -m "feat: gate personal exports by visibility policy"
```

## Task 4: Phase 4 Verification And Docs

**Files:**
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`
- Create: `docs/superpowers/specs/2026-04-22-mbrain-phase-4-export-and-visibility-boundaries-design.md`

- [ ] **Step 1: Write the short design doc**

Record:
- export rules
- why profile-memory export is curated
- why personal episodes stay private in this slice
- how default export differs from explicit personal export

- [ ] **Step 2: Add verification wiring**

Update:
- `test:phase4` to include the new tests
- `docs/MBRAIN_VERIFY.md` with the exact commands and expected outcomes

- [ ] **Step 3: Run the focused verification**

Run:

```bash
bun test test/personal-export-visibility-service.test.ts test/personal-export-operations.test.ts test/export-personal-visibility.test.ts
```

Expected: pass.

- [ ] **Step 4: Run the broader regression**

Run:

```bash
bun run test:phase4
```

Expected: pass with the same Postgres skips if `DATABASE_URL` is still unavailable.

- [ ] **Step 5: Commit**

```bash
git add package.json docs/MBRAIN_VERIFY.md docs/superpowers/specs/2026-04-22-mbrain-phase-4-export-and-visibility-boundaries-design.md
git commit -m "docs: wire export visibility checks into phase4 verification"
```

## Task 5: Closure Check

**Files:**
- No new code files expected

- [ ] **Step 1: Re-read `07-workstream-profile-memory-and-scope.md` export rules**

Check that the implementation now covers:
- selected Markdown export for curated subsets
- default exclusion from work-visible export paths
- private-by-default treatment for personal episodes

- [ ] **Step 2: Re-run Phase 4 acceptance sanity checks**

Run:

```bash
bun run bench:phase4-personal-write-target --json
bun run bench:phase4-acceptance --json
```

Expected:
- both commands succeed
- `phase4_status` remains `pass`

- [ ] **Step 3: Push**

```bash
git push origin phase2-note-manifest
```

## After This Plan

This plan intentionally stops before:
- mixed-scope bridge behavior
- governance / inbox work
- MCP `put_page` / `sync_brain` transport repair

Those are separate follow-up plans because they touch different subsystems and acceptance criteria.
