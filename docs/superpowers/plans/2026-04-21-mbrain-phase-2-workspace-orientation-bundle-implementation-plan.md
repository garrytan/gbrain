# MBrain Phase 2 Workspace Orientation Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one read-only `workspace-orientation-bundle` artifact that composes the current workspace map report and the existing workspace system/project cards.

**Architecture:** Reuse the current map report as the top-level selector, then attach the existing workspace system and project cards without adding new persistence. Keep the slice additive, deterministic, and read-only.

**Tech Stack:** Bun, TypeScript, shared operations, SQLite benchmark harness

---

## File Map

- Create: `src/core/services/workspace-orientation-bundle-service.ts`
- Create: `scripts/bench/phase2-workspace-orientation-bundle.ts`
- Create: `test/workspace-orientation-bundle-service.test.ts`
- Create: `test/workspace-orientation-bundle-operations.test.ts`
- Create: `test/phase2-workspace-orientation-bundle.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/operations.ts`
- Modify: `test/cli.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`

## Tasks

### Task 1: Lock the contract with failing tests

- [ ] Add service, operation, and benchmark tests for `workspace-orientation-bundle`
- [ ] Verify the new tests fail because the service, operation, and benchmark script do not exist yet

### Task 2: Implement the minimal read-only service

- [ ] Add bundle result types
- [ ] Implement `getWorkspaceOrientationBundle()` over `context-map-report`
- [ ] Attach the existing workspace system/project cards when they are available

### Task 3: Expose the shared operation and CLI surface

- [ ] Add `get_workspace_orientation_bundle`
- [ ] Project it as `workspace-orientation`
- [ ] Add a help test for the CLI entry

### Task 4: Add benchmark and verification hooks

- [ ] Add `bench:phase2-workspace-orientation-bundle`
- [ ] Add benchmark fixture coverage for bundle correctness
- [ ] Update `docs/MBRAIN_VERIFY.md`

### Task 5: Run verification

- [ ] `bun test test/workspace-orientation-bundle-service.test.ts test/workspace-orientation-bundle-operations.test.ts test/phase2-workspace-orientation-bundle.test.ts`
- [ ] `bun test test/cli.test.ts -t "workspace-orientation --help"`
- [ ] `bun run bench:phase2-workspace-orientation-bundle --json`
- [ ] `bun run test:phase1`
