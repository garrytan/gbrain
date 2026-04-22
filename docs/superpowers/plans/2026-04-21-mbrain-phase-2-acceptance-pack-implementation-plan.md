# MBrain Phase 2 Acceptance Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a phase-level acceptance pack so Phase 2 can be verified and
summarized as one unit before merge or rollout.

**Architecture:** Keep all existing per-slice tests and benchmark runners
unchanged. Add one umbrella test script and one benchmark summary script that
executes the existing benchmark entrypoints and aggregates their acceptance
status.

**Tech Stack:** Bun, TypeScript, package scripts, local benchmark harness

---

## File Map

- Create: `scripts/bench/phase2-acceptance-pack.ts`
- Create: `test/phase2-acceptance-pack.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`

## Tasks

### Task 1: Lock the pack contract with a failing test

- [ ] Add a benchmark-shape test for `bench:phase2-acceptance`
- [ ] Verify it fails because the summary script does not exist yet

### Task 2: Implement the benchmark summary runner

- [ ] Execute the published Phase 2 benchmark scripts as child processes
- [ ] Parse each child JSON payload and extract phase-level readiness
- [ ] Fail the pack when any child benchmark fails or reports `fail`

### Task 3: Expose the umbrella scripts

- [ ] Add `bench:phase2-acceptance`
- [ ] Add `test:phase2`
- [ ] Keep the package scripts deterministic and explicit

### Task 4: Update verification docs

- [ ] Add one Phase 2 acceptance-pack section to `docs/MBRAIN_VERIFY.md`
- [ ] Document the new umbrella test command and acceptance summary runner

### Task 5: Run verification

- [ ] `bun test test/phase2-acceptance-pack.test.ts`
- [ ] `bun run bench:phase2-acceptance --json`
- [ ] `bun run test:phase2`
- [ ] `bun run test:phase1`
