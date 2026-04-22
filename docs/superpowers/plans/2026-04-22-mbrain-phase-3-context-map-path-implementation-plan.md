# MBrain Phase 3 Context Map Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `map-path` behavior that explains a bounded path
between two nodes inside one persisted context map and points back to canonical
reads.

**Architecture:** Reuse the persisted `context_map_entries.graph_json` as the
path surface. Add one focused path service that selects an existing map, runs a
deterministic breadth-first search over stored nodes and edges, resolves compact
recommended reads from the path nodes, and exposes that contract through one
operation and one benchmark.

**Tech Stack:** Bun, TypeScript, existing context-map services, package scripts,
local benchmark harness

---

## File Map

- Create: `src/core/services/context-map-path-service.ts`
- Create: `test/context-map-path-service.test.ts`
- Create: `test/context-map-path-operations.test.ts`
- Create: `test/phase3-context-map-path.test.ts`
- Create: `scripts/bench/phase3-context-map-path.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/operations.ts`
- Modify: `test/cli.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`

## Tasks

### Task 1: Lock the path contract with failing tests

- [ ] Add service tests for direct-map path, no-match disclosure, no-path
      disclosure, and stale path disclosure
- [ ] Add operation registration and direct-read coverage for `map-path`
- [ ] Add one benchmark-shape test for `bench:phase3-context-map-path`
- [ ] Add one CLI help test for `map-path --help`
- [ ] Verify the new tests fail before implementation

### Task 2: Implement the minimal path service

- [ ] Add the new path result types to `src/core/types.ts`
- [ ] Implement persisted-map selection plus deterministic breadth-first path
      search over stored nodes and edges
- [ ] Return `no_path` as a bounded disclosure instead of throwing
- [ ] Resolve recommended canonical reads from path nodes only
- [ ] Keep stale maps path-readable while surfacing explicit stale warnings

### Task 3: Expose the operation and benchmark

- [ ] Add `find_context_map_path` to `src/core/operations.ts`
- [ ] Expose CLI hints as `map-path`
- [ ] Add `scripts/bench/phase3-context-map-path.ts`
- [ ] Add `bench:phase3-context-map-path` to `package.json`

### Task 4: Update verification docs

- [ ] Add one `map-path` verification section to `docs/MBRAIN_VERIFY.md`
- [ ] Document the slice test command and benchmark command

### Task 5: Run verification

- [ ] `bun test test/context-map-path-service.test.ts test/context-map-path-operations.test.ts test/phase3-context-map-path.test.ts`
- [ ] `bun test test/cli.test.ts -t "map-path --help"`
- [ ] `bun run bench:phase3-context-map-path --json`
- [ ] `bun run test:phase2`
- [ ] `bun run test:phase1`
