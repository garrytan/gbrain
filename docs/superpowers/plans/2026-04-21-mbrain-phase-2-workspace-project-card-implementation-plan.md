# MBrain Phase 2 Workspace Project Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one read-only `workspace-project-card` artifact that renders the most relevant canonical project page from the current workspace map report.

**Architecture:** Reuse `getStructuralContextMapReport()` for selection, then read the chosen canonical project page plus manifest metadata to build a compact deterministic card. Keep the slice additive and read-only with no new persistence.

**Tech Stack:** Bun, TypeScript, shared operations, SQLite benchmark harness

---

## File Map

- Create: `src/core/services/workspace-project-card-service.ts`
- Create: `scripts/bench/phase2-workspace-project-card.ts`
- Create: `test/workspace-project-card-service.test.ts`
- Create: `test/workspace-project-card-operations.test.ts`
- Create: `test/phase2-workspace-project-card.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/operations.ts`
- Modify: `test/cli.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`

## Tasks

### Task 1: Lock the contract with failing tests

- [ ] Add service, operation, and benchmark tests for `workspace-project-card`
- [ ] Verify the new tests fail because the service, operation, and benchmark script do not exist yet

### Task 2: Implement the minimal read-only service

- [ ] Add `WorkspaceProjectCard` types
- [ ] Implement `getWorkspaceProjectCard()` over `context-map-report`
- [ ] Read only canonical project page frontmatter and manifest-derived wikilinks

### Task 3: Expose the shared operation and CLI surface

- [ ] Add `get_workspace_project_card`
- [ ] Project it as `workspace-project-card`
- [ ] Add a help test for the CLI entry

### Task 4: Add benchmark and verification hooks

- [ ] Add `bench:phase2-workspace-project-card`
- [ ] Add benchmark fixture coverage for success and correctness
- [ ] Update `docs/MBRAIN_VERIFY.md`

### Task 5: Run verification

- [ ] `bun test test/workspace-project-card-service.test.ts test/workspace-project-card-operations.test.ts test/phase2-workspace-project-card.test.ts`
- [ ] `bun test test/cli.test.ts -t "workspace-project-card --help"`
- [ ] `bun run bench:phase2-workspace-project-card --json`
- [ ] `bun run test:phase1`
