# MBrain Phase 3 Context Map Explain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `map-explain` behavior that explains one persisted
context-map node with bounded neighbors and canonical follow-through reads.

**Architecture:** Reuse the persisted `context_map_entries.graph_json` as the
source of node and edge structure. Add one focused explain service that selects
an existing map, resolves one node, derives bounded neighbor edges plus
recommended reads, and exposes that contract through one operation and one
benchmark.

**Tech Stack:** Bun, TypeScript, existing context-map services, package scripts,
local benchmark harness

---

## File Map

- Create: `src/core/services/context-map-explain-service.ts`
- Create: `test/context-map-explain-service.test.ts`
- Create: `test/context-map-explain-operations.test.ts`
- Create: `test/phase3-context-map-explain.test.ts`
- Create: `scripts/bench/phase3-context-map-explain.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/operations.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`

## Tasks

### Task 1: Lock the explain contract with failing tests

- [ ] Add service tests for direct-map explain, no-match disclosure, and stale
      disclosure
- [ ] Add operation registration and direct-read coverage for `map-explain`
- [ ] Add one benchmark-shape test for `bench:phase3-context-map-explain`
- [ ] Verify the new tests fail before implementation

### Task 2: Implement the minimal explain service

- [ ] Add the new explain result types to `src/core/types.ts`
- [ ] Implement persisted-map selection plus exact `node_id` lookup
- [ ] Derive bounded neighbor edges from stored `graph_json`
- [ ] Resolve recommended canonical reads from the explained node and its
      neighborhood
- [ ] Keep stale maps readable while surfacing explicit stale warnings

### Task 3: Expose the operation and benchmark

- [ ] Add `get_context_map_explanation` to `src/core/operations.ts`
- [ ] Expose CLI hints as `map-explain`
- [ ] Add `scripts/bench/phase3-context-map-explain.ts`
- [ ] Add `bench:phase3-context-map-explain` to `package.json`

### Task 4: Update verification docs

- [ ] Add one `map-explain` verification section to `docs/MBRAIN_VERIFY.md`
- [ ] Document the slice test command and benchmark command

### Task 5: Run verification

- [ ] `bun test test/context-map-explain-service.test.ts test/context-map-explain-operations.test.ts test/phase3-context-map-explain.test.ts`
- [ ] `bun run bench:phase3-context-map-explain --json`
- [ ] `bun run test:phase2`
- [ ] `bun run test:phase1`
