# MBrain Phase 2 Atlas Orientation Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one read-only `atlas-orientation-bundle` artifact that composes
the existing atlas report and atlas orientation card for one selected atlas
entry.

**Architecture:** Reuse atlas report as the selector, then fetch the nested
atlas orientation card through direct `atlas_id` so both layers stay aligned.
Keep the slice additive, deterministic, and read-only.

**Tech Stack:** Bun, TypeScript, shared operations, SQLite benchmark harness

---

## File Map

- Create: `src/core/services/atlas-orientation-bundle-service.ts`
- Create: `scripts/bench/phase2-atlas-orientation-bundle.ts`
- Create: `test/atlas-orientation-bundle-service.test.ts`
- Create: `test/atlas-orientation-bundle-operations.test.ts`
- Create: `test/phase2-atlas-orientation-bundle.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/operations.ts`
- Modify: `test/cli.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`

## Tasks

### Task 1: Lock the contract with failing tests

- [ ] Add service, operation, and benchmark tests for `atlas-orientation-bundle`
- [ ] Verify the new tests fail because the service, operation, and benchmark
      script do not exist yet

### Task 2: Implement the minimal read-only service

- [ ] Add atlas-orientation-bundle result types
- [ ] Implement `getAtlasOrientationBundle()` over atlas report plus direct
      atlas-orientation-card lookup
- [ ] Keep report and card aligned through one atlas entry id

### Task 3: Expose the shared operation and CLI surface

- [ ] Add `get_atlas_orientation_bundle`
- [ ] Project it as `atlas-orientation-bundle`
- [ ] Add a help test for the CLI entry

### Task 4: Add benchmark and verification hooks

- [ ] Add `bench:phase2-atlas-orientation-bundle`
- [ ] Add benchmark fixture coverage for atlas-orientation-bundle correctness
- [ ] Update `docs/MBRAIN_VERIFY.md`

### Task 5: Run verification

- [ ] `bun test test/atlas-orientation-bundle-service.test.ts test/atlas-orientation-bundle-operations.test.ts test/phase2-atlas-orientation-bundle.test.ts`
- [ ] `bun test test/cli.test.ts -t "atlas-orientation-bundle --help"`
- [ ] `bun run bench:phase2-atlas-orientation-bundle --json`
- [ ] `bun run test:phase1`
