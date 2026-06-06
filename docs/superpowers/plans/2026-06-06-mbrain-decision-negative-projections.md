# MBrain Decision Packet And Negative Memory Projection Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class decision packet and negative memory projections that
help agents reuse prior decisions and avoid repeated failed work without
creating a new truth store or bypassing canonical evidence boundaries.

**Architecture:** Both outputs are deterministic read models over existing
records: assertions, assertion evidence, task decisions, task attempts,
retrieval traces, Memory Inbox candidates, canonical handoffs, and source refs.
The services must not mutate canonical pages, create assertions, write Memory
Inbox candidates, or persist projection rows in this phase.

**Tech Stack:** Bun, TypeScript, existing `src/core/services` patterns,
`src/core/types`, Bun test runner, `bun run typecheck`.

---

## Source Specs

- `docs/superpowers/specs/2026-06-06-mbrain-authority-first-memory-improvement-design.md`
- `docs/superpowers/plans/2026-06-06-mbrain-authority-first-full-spec-roadmap.md`
- `docs/superpowers/plans/2026-06-06-mbrain-trust-contract-service.md`
- `docs/MBRAIN_AGENT_RULES.md`
- `docs/MCP_INSTRUCTIONS.md`

## Scope Check

This phase implements projection services and focused tests only. Do not add a
database schema, CLI command, MCP operation, retrieval-route integration,
Memory-why output, proof mode, graph frontier retrieval, episode capture, or
Dream maintenance behavior here.

The projection output may be consumed by later retrieval or proof flows, but in
this phase it is an explicit service result. It is not answer authority by
itself.

## File Structure

- `src/core/types/decision-projections.ts`
  - Defines decision packet, negative memory, applicability anchor,
    revalidation, activation, and source-record projection types.

- `src/core/services/decision-packet-projection-service.ts`
  - Builds decision packet projections from explicit input records.

- `src/core/services/negative-memory-projection-service.ts`
  - Builds conditional negative memory projections from failed attempts,
    rejected/superseded candidates, stale procedures, and applicability anchors.

- `test/decision-packet-projection-service.test.ts`
  - Locks decision packet projection behavior and no-new-truth-store invariants.

- `test/negative-memory-projection-service.test.ts`
  - Locks conditional suppression, `reopen_if`, and anchor matching behavior.

- `docs/MBRAIN_VERIFY.md`
  - Adds the focused projection verification command.

- `package.json`
  - Adds `test:decision-projections`.

---

## Projection Contract

Decision packets return:

- `id`
- `decision`
- `claim`
- `rationale`
- `rejected_alternatives`
- `owner_or_source`
- `source_refs`
- `canonical_target`
- `target_snapshot_hash`
- `valid_until`
- `revalidation_path`
- `reversibility`
- `affected_selectors`
- `activation`
- `authority`
- `source_records`

Negative memory records return:

- `id`
- `failed_under`
- `why_failed`
- `do_not_repeat_if`
- `reopen_if`
- `valid_until`
- `source_refs`
- `owner_or_task`
- `activation`
- `suppression_applies`
- `reason_codes`

The first implementation should use explicit input arrays instead of engine
lookups. Later phases can add engine-backed loaders and retrieval integration.

## Task 1: Decision Projection Types And Service

**Files:**

- Add: `src/core/types/decision-projections.ts`
- Add: `src/core/services/decision-packet-projection-service.ts`
- Add: `test/decision-packet-projection-service.test.ts`

- [x] **Step 1: Write failing decision packet tests**

Create tests covering:

- task decisions become decision packets with rationale, consequences, source
  refs, canonical target, and affected selectors;
- canonical handoffs attach canonical target and source refs but do not create
  answer authority by themselves;
- assertion records can contribute canonical claims only when supplied as
  canonical and active source records;
- rejected alternatives are extracted from rejected/superseded candidates and
  failed attempts when they share applicability anchors;
- decision packets include `valid_until`, `target_snapshot_hash`, and
  `revalidation_path`;
- output includes source provenance and does not request or perform writes.

- [x] **Step 2: Implement types**

Keep types narrow and projection-oriented. Use strings for source refs and
canonical target ids rather than importing storage-specific record shapes into
callers.

- [x] **Step 3: Implement pure projection service**

Implement:

```ts
export function buildDecisionPacketProjections(
  input: DecisionPacketProjectionInput,
): DecisionPacketProjection[]
```

The service must be deterministic, side-effect free, and independent of the
database.

- [x] **Step 4: Run focused decision tests**

Run:

```bash
bun test test/decision-packet-projection-service.test.ts
bun run typecheck
```

Expected: PASS.

## Task 2: Negative Memory Projection Service

**Files:**

- Add: `src/core/services/negative-memory-projection-service.ts`
- Add: `test/negative-memory-projection-service.test.ts`

- [x] **Step 1: Write failing negative memory tests**

Create tests covering:

- failed task attempts produce `suppress_if_valid` records only when current
  applicability anchors match;
- failed attempts without enough current anchors produce `verify_first`;
- rejected and superseded candidates become `audit_only` or `verify_first`,
  not global suppression;
- `reopen_if` disables suppression when changed conditions match;
- `valid_until` disables suppression after expiry;
- suppression decisions include visible reason codes and source refs.

- [x] **Step 2: Implement service**

Implement:

```ts
export function buildNegativeMemoryProjections(
  input: NegativeMemoryProjectionInput,
): NegativeMemoryProjection[]
```

Keep anchor matching exact and conservative: a missing current anchor cannot
prove suppression safety.

- [x] **Step 3: Run focused negative memory tests**

Run:

```bash
bun test test/negative-memory-projection-service.test.ts
bun run typecheck
```

Expected: PASS.

## Task 3: Verification Docs

**Files:**

- Modify: `docs/MBRAIN_VERIFY.md`
- Modify: `package.json`

- [x] **Step 1: Add script**

Add:

```json
"test:decision-projections": "bun test test/decision-packet-projection-service.test.ts test/negative-memory-projection-service.test.ts"
```

- [x] **Step 2: Add docs section**

Add a short `Decision and negative memory projections` section to
`docs/MBRAIN_VERIFY.md`:

```bash
bun run test:decision-projections
bun run typecheck
```

Acceptance:

- decision packets are projections over existing records,
- negative memory suppresses only when anchors match,
- `reopen_if` and `valid_until` can reopen or expire suppression,
- neither projection service mutates canonical pages or candidates.

- [x] **Step 3: Run docs gate**

Run:

```bash
bun run test:decision-projections
bun run typecheck
git diff --check
```

Expected: PASS.

## Task 4: Commit And Phase Gate

Run:

```bash
bun run test:decision-projections
bun run test:trust-contract
bun run test:authority-foundation
bun run typecheck
git status --short --branch
```

Expected:

- projection tests pass,
- trust contract and authority foundation gates remain green,
- before staging, changed files match the commit recipe plus the pre-existing
  untracked `reference/` directory.
- after commit, only the pre-existing untracked `reference/` directory remains
  untracked.

Commit:

```bash
git add \
  src/core/types/decision-projections.ts \
  src/core/types.ts \
  src/core/services/decision-packet-projection-service.ts \
  src/core/services/negative-memory-projection-service.ts \
  test/decision-packet-projection-service.test.ts \
  test/negative-memory-projection-service.test.ts \
  docs/MBRAIN_VERIFY.md \
  docs/superpowers/plans/2026-06-06-mbrain-decision-negative-projections.md \
  package.json
git commit -m "feat: add decision memory projections"
```

---

## Final Verification

After all tasks are complete, run:

```bash
bun run test:decision-projections
bun run test:trust-contract
bun run test:authority-foundation
bun run typecheck
git log --oneline -5
git status --short --branch
```

## Out Of Scope

- Database schema or persisted projection tables.
- CLI or MCP operations.
- Retrieval integration.
- Memory-why or proof command output.
- Episode capture changes.
- Graph frontier retrieval.
- Dream maintenance changes.
