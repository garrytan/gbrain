# MBrain Phase 2 Workspace Corpus Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one read-only `workspace-corpus-card` artifact that compresses the
current workspace orientation bundle into a smaller corpus-oriented summary.

**Architecture:** Reuse the current workspace orientation bundle as the only
selector, then project a compact card with anchor slugs and bounded reads. Keep
the slice additive, deterministic, and read-only.

**Tech Stack:** Bun, TypeScript, shared operations, SQLite benchmark harness

---

## File Map

- Create: `src/core/services/workspace-corpus-card-service.ts`
- Create: `scripts/bench/phase2-workspace-corpus-card.ts`
- Create: `test/workspace-corpus-card-service.test.ts`
- Create: `test/workspace-corpus-card-operations.test.ts`
- Create: `test/phase2-workspace-corpus-card.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/operations.ts`
- Modify: `test/cli.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`

## Tasks

### Task 1: Lock the contract with failing tests

- [ ] Add service, operation, and benchmark tests for `workspace-corpus-card`
- [ ] Verify the new tests fail because the service, operation, and benchmark
      script do not exist yet

### Task 2: Implement the minimal read-only service

- [ ] Add corpus-card result types
- [ ] Implement `getWorkspaceCorpusCard()` over `workspace-orientation-bundle`
- [ ] Project anchor slugs from attached system/project cards

### Task 3: Expose the shared operation and CLI surface

- [ ] Add `get_workspace_corpus_card`
- [ ] Project it as `workspace-corpus-card`
- [ ] Add a help test for the CLI entry

### Task 4: Add benchmark and verification hooks

- [ ] Add `bench:phase2-workspace-corpus-card`
- [ ] Add benchmark fixture coverage for corpus-card correctness
- [ ] Update `docs/MBRAIN_VERIFY.md`

### Task 5: Run verification

- [ ] `bun test test/workspace-corpus-card-service.test.ts test/workspace-corpus-card-operations.test.ts test/phase2-workspace-corpus-card.test.ts`
- [ ] `bun test test/cli.test.ts -t "workspace-corpus-card --help"`
- [ ] `bun run bench:phase2-workspace-corpus-card --json`
- [ ] `bun run test:phase1`
