# MBrain Phase 3 Broad Synthesis Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only broad-synthesis routing step that packages persisted
context-map orientation into a compact, protocol-aligned route artifact.

**Architecture:** Reuse existing `map-report`, `map-query`, and `map-explain`
services rather than changing core search behavior. Add one route service that
selects a persisted map, builds a broad orientation report, narrows structural
matches, optionally explains the top match, and returns compact recommended
reads plus an explicit retrieval route.

**Tech Stack:** Bun, TypeScript, existing context-map services, package scripts,
local benchmark harness

---

## File Map

- Create: `src/core/services/broad-synthesis-route-service.ts`
- Create: `test/broad-synthesis-route-service.test.ts`
- Create: `test/broad-synthesis-route-operations.test.ts`
- Create: `test/phase3-broad-synthesis-route.test.ts`
- Create: `scripts/bench/phase3-broad-synthesis-route.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/operations.ts`
- Modify: `test/cli.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`

## Tasks

### Task 1: Lock the route contract with failing tests

- [ ] Add service tests for direct broad-synthesis routing, no-match
      disclosure, query-miss fallback, and stale-route disclosure
- [ ] Add operation registration and direct-read coverage for
      `broad-synthesis-route`
- [ ] Add one benchmark-shape test for `bench:phase3-broad-synthesis-route`
- [ ] Add one CLI help test for `broad-synthesis-route --help`
- [ ] Verify the new tests fail before implementation

### Task 2: Implement the minimal route service

- [ ] Add the new broad-synthesis route types to `src/core/types.ts`
- [ ] Compose persisted `map-report`, `map-query`, and optional `map-explain`
      into one route artifact
- [ ] Keep a non-null route when the map exists but the query yields no matched
      nodes
- [ ] Build one explicit ordered `retrieval_route`
- [ ] Keep stale maps routable while surfacing explicit stale warnings

### Task 3: Expose the operation and benchmark

- [ ] Add `get_broad_synthesis_route` to `src/core/operations.ts`
- [ ] Expose CLI hints as `broad-synthesis-route`
- [ ] Add `scripts/bench/phase3-broad-synthesis-route.ts`
- [ ] Add `bench:phase3-broad-synthesis-route` to `package.json`

### Task 4: Update verification docs

- [ ] Add one `broad-synthesis-route` verification section to
      `docs/MBRAIN_VERIFY.md`
- [ ] Document the slice test command and benchmark command

### Task 5: Run verification

- [ ] `bun test test/broad-synthesis-route-service.test.ts test/broad-synthesis-route-operations.test.ts test/phase3-broad-synthesis-route.test.ts`
- [ ] `bun test test/cli.test.ts -t "broad-synthesis-route --help"`
- [ ] `bun run bench:phase3-broad-synthesis-route --json`
- [ ] `bun run test:phase2`
- [ ] `bun run test:phase1`
