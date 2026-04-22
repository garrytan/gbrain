# MBrain Phase 2 Workspace System Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one compact workspace system card over the existing context-map report and canonical system-page frontmatter.

**Architecture:** Keep card generation read-only and derived. Reuse context-map report as the source of truth for scope and freshness, then resolve the first recommended `system` page through canonical page data and surface build/test commands plus key entry points. No schema changes and no persisted cards.

**Tech Stack:** Bun, TypeScript, shared operation framework, sqlite/pglite/postgres engine layer for existing page/map reads

---

## Task 1: Add workspace system-card service behavior

**Files:**
- Create: `src/core/services/workspace-system-card-service.ts`
- Modify: `src/core/types.ts`
- Test: `test/workspace-system-card-service.test.ts`

- [ ] Add failing service tests for system-card output and no-system fallback.
- [ ] Add minimal card result types and implement deterministic card rendering over context-map-report plus canonical page frontmatter.
- [ ] Re-run the targeted service test until it passes.

## Task 2: Expose workspace-system-card through shared operations

**Files:**
- Modify: `src/core/operations.ts`
- Modify: `test/cli.test.ts`
- Test: `test/workspace-system-card-operations.test.ts`

- [ ] Add failing operation tests for `workspace-system-card`.
- [ ] Implement the shared operation and CLI help surface.
- [ ] Re-run the targeted operation and CLI tests until they pass.

## Task 3: Add the Phase 2 workspace-system-card benchmark

**Files:**
- Create: `scripts/bench/phase2-workspace-system-card.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`
- Test: `test/phase2-workspace-system-card.test.ts`

- [ ] Add a failing benchmark-shape test for the new script.
- [ ] Implement the sqlite benchmark for card latency and correctness.
- [ ] Re-run the benchmark test until it passes.

## Verification

Run:

```bash
bun test test/workspace-system-card-service.test.ts test/workspace-system-card-operations.test.ts test/phase2-workspace-system-card.test.ts
bun test test/cli.test.ts -t "workspace-system-card --help"
bun run bench:phase2-workspace-system-card --json
```

Expected:

- card tests pass
- `workspace-system-card --help` works without a DB connection
- benchmark reports `readiness_status: "pass"` and `phase2_status: "pass"`
