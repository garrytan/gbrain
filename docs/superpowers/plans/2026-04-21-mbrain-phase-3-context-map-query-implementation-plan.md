# MBrain Phase 3 Context Map Query Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `map-query` behavior that returns bounded structural
matches from one persisted context map and points back to canonical reads.

**Architecture:** Reuse the persisted `context_map_entries.graph_json` as the
query surface. Add one focused query service that selects an existing map,
ranks node matches by deterministic label/slug rules, resolves compact
recommended reads from the matched nodes, and exposes that contract through one
operation and one benchmark.

**Tech Stack:** Bun, TypeScript, existing context-map services, package scripts,
local benchmark harness

---

## File Map

- Create: `src/core/services/context-map-query-service.ts`
- Create: `test/context-map-query-service.test.ts`
- Create: `test/context-map-query-operations.test.ts`
- Create: `test/phase3-context-map-query.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/operations.ts`
- Modify: `test/cli.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`
- Create: `scripts/bench/phase3-context-map-query.ts`

## Tasks

### Task 1: Lock the query contract with failing tests

- [ ] Add service tests for direct-map query, no-match disclosure, and stale
      query disclosure
- [ ] Add operation registration and direct-read coverage for `map-query`
- [ ] Add one benchmark-shape test for `bench:phase3-context-map-query`
- [ ] Add one CLI help test for `map-query --help`
- [ ] Verify the new tests fail before implementation

### Task 2: Implement the minimal query service

- [ ] Add the new query result types to `src/core/types.ts`
- [ ] Implement persisted-map selection plus deterministic node ranking by
      label and slug
- [ ] Bound the result list with a small default limit
- [ ] Resolve recommended canonical reads from matched nodes only
- [ ] Keep stale maps queryable while surfacing explicit stale warnings

### Task 3: Expose the operation and benchmark

- [ ] Add `query_context_map` to `src/core/operations.ts`
- [ ] Expose CLI hints as `map-query`
- [ ] Add `scripts/bench/phase3-context-map-query.ts`
- [ ] Add `bench:phase3-context-map-query` to `package.json`

### Task 4: Update verification docs

- [ ] Add one `map-query` verification section to `docs/MBRAIN_VERIFY.md`
- [ ] Document the slice test command and benchmark command

### Task 5: Run verification

- [ ] `bun test test/context-map-query-service.test.ts test/context-map-query-operations.test.ts test/phase3-context-map-query.test.ts`
- [ ] `bun test test/cli.test.ts -t "map-query --help"`
- [ ] `bun run bench:phase3-context-map-query --json`
- [ ] `bun run test:phase2`
- [ ] `bun run test:phase1`
