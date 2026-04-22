# MBrain Phase 2 Atlas Orientation Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one read-only `atlas-orientation-card` artifact that applies atlas
selection and projects the chosen map into the existing workspace corpus-card
layer.

**Architecture:** Reuse structural atlas selection or direct atlas id lookup as
the only router, then render a compact orientation card over the selected map's
workspace corpus-card output. Keep the slice additive, deterministic, and
read-only.

**Tech Stack:** Bun, TypeScript, shared operations, SQLite benchmark harness

---

## File Map

- Create: `src/core/services/atlas-orientation-card-service.ts`
- Create: `scripts/bench/phase2-atlas-orientation-card.ts`
- Create: `test/atlas-orientation-card-service.test.ts`
- Create: `test/atlas-orientation-card-operations.test.ts`
- Create: `test/phase2-atlas-orientation-card.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/operations.ts`
- Modify: `test/cli.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`

## Tasks

### Task 1: Lock the contract with failing tests

- [ ] Add service, operation, and benchmark tests for `atlas-orientation-card`
- [ ] Verify the new tests fail because the service, operation, and benchmark
      script do not exist yet

### Task 2: Implement the minimal read-only service

- [ ] Add atlas-orientation-card result types
- [ ] Implement `getAtlasOrientationCard()` over atlas selection plus
      workspace-corpus-card
- [ ] Carry atlas freshness and budget metadata into the final card

### Task 3: Expose the shared operation and CLI surface

- [ ] Add `get_atlas_orientation_card`
- [ ] Project it as `atlas-orientation-card`
- [ ] Add a help test for the CLI entry

### Task 4: Add benchmark and verification hooks

- [ ] Add `bench:phase2-atlas-orientation-card`
- [ ] Add benchmark fixture coverage for atlas-orientation-card correctness
- [ ] Update `docs/MBRAIN_VERIFY.md`

### Task 5: Run verification

- [ ] `bun test test/atlas-orientation-card-service.test.ts test/atlas-orientation-card-operations.test.ts test/phase2-atlas-orientation-card.test.ts`
- [ ] `bun test test/cli.test.ts -t "atlas-orientation-card --help"`
- [ ] `bun run bench:phase2-atlas-orientation-card --json`
- [ ] `bun run test:phase1`
