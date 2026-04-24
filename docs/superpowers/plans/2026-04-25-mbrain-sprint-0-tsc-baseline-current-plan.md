# MBrain Sprint 0 TypeScript Baseline Current Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bunx tsc --noEmit --pretty false` green on latest `origin/master`, then enforce it in CI.

**Architecture:** This track is intentionally mechanical. It aligns implementation classes with the existing `BrainEngine` contract, narrows dynamic SQL and JSON boundary types, fixes domain boundary mismatches, and updates test fixtures without changing runtime behavior.

**Tech Stack:** Bun, TypeScript strict mode, SQLite (`bun:sqlite`), PGLite, Postgres, GitHub Actions.

---

## Baseline

Measured on 2026-04-25 against `origin/master` at merge commit `528b07d`:

```bash
bunx tsc --noEmit --pretty false 2>&1 | rg -c "error TS"
```

Expected current output before this plan starts:

```text
851
```

The biggest cascade is `SQLiteEngine` missing `runMigration`, which makes every test or service that treats `SQLiteEngine` as `BrainEngine` fail typechecking. Fix that first.

## PR 2a: Engine Contract Alignment

Branch: `sprint-0.1-tsc-engine-contract`

### Task 2a.1: Confirm the `runMigration` Cascade

**Files:**

- Read: `src/core/engine.ts`
- Read: `src/core/sqlite-engine.ts`
- Read: `src/core/engine-factory.ts`
- Read: `test/task-memory-engine.test.ts`

- [ ] **Step 1: Create a clean worktree**

```bash
git fetch origin
git worktree add -b sprint-0.1-tsc-engine-contract .worktrees/sprint-0.1-tsc-engine-contract origin/master
cd .worktrees/sprint-0.1-tsc-engine-contract
```

Expected: worktree starts at `528b07d` or a later `origin/master` commit if more PRs have landed.

- [ ] **Step 2: Count the current cascade**

```bash
bunx tsc --noEmit --pretty false 2>&1 | rg -c "runMigration|SQLiteEngine"
```

Expected: nonzero count.

### Task 2a.2: Narrow Shared SQL Migration Capability

**Files:**

- Modify: `src/core/engine.ts`
- Modify: `src/core/migrate.ts`
- Modify: `src/core/sqlite-engine.ts`
- Test: `test/task-memory-engine.test.ts`
- Test: `test/sqlite-engine.test.ts`
- Test: `test/scenarios/helpers.ts`

- [ ] **Step 1: Remove shared SQL migration from the base engine contract**

In `src/core/engine.ts`, remove `runMigration(version: number, sql: string): Promise<void>` from `BrainEngine`.

Reason: SQLite has its own migration ladder in `SQLiteEngine.initSchema() -> runSqliteMigrations()`. The shared migration SQL in `src/core/migrate.ts` is Postgres/PGLite-flavored and includes constructs such as `JSONB`, `SERIAL`, `DO $$`, and `ALTER ... DROP CONSTRAINT`, so advertising shared SQL migration capability on every `BrainEngine` is incorrect.

- [ ] **Step 2: Add a narrower SQL migration capability type**

In `src/core/migrate.ts`, add:

```ts
type SqlMigrationEngine = BrainEngine & {
  runMigration(version: number, sql: string): Promise<void>;
};
```

Then change:

```ts
export async function runMigrations(engine: BrainEngine): Promise<{ applied: number; current: number }> {
```

to:

```ts
export async function runMigrations(engine: SqlMigrationEngine): Promise<{ applied: number; current: number }> {
```

Inside the transaction callback, cast only the transactional engine passed to the callback:

```ts
await (tx as SqlMigrationEngine).runMigration(m.version, m.sql);
```

Do not add `runMigration` to `SQLiteEngine`. That would make SQLite appear compatible with the shared Postgres/PGLite migration SQL when it is not.

- [ ] **Step 3: Guard the SQLite-only migration ladder**

In `src/core/sqlite-engine.ts`, make SQLite migration 5 mirror the local parts of the embedding upgrade:

```ts
case 5:
  this.database.run(
    `INSERT INTO config (key, value) VALUES ('embedding_model', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [DEFAULT_EMBEDDING_MODEL],
  );
  this.database.run(
    `INSERT INTO config (key, value) VALUES ('embedding_dimensions', '768')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  this.database.run(
    `UPDATE content_chunks SET embedding = NULL, embedded_at = NULL, model = ?`,
    [DEFAULT_EMBEDDING_MODEL],
  );
  {
    const columns = this.database.query(`PRAGMA table_info(pages)`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'page_embedding')) {
      this.database.exec(`UPDATE pages SET page_embedding = NULL`);
    }
  }
  break;
```

Make intentional SQLite no-op migration 7 explicit:

```ts
case 7:
  // Page embedding column is ensured by initSchema() for SQLite.
  break;
```

At the end of the switch, add:

```ts
default:
  throw new Error(`SQLite migration ${version} is not implemented`);
```

This prevents future shared migrations from being silently marked applied on SQLite without a corresponding SQLite case.

- [ ] **Step 4: Run focused runtime tests**

```bash
bun test test/task-memory-engine.test.ts test/sqlite-engine.test.ts test/scenarios/s01-fresh-install.test.ts --timeout 60000
```

Expected: zero failures.

- [ ] **Step 5: Confirm the cascade is gone**

```bash
bunx tsc --noEmit --pretty false 2>&1 | rg "runMigration|SQLiteEngine"
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/core/engine.ts src/core/migrate.ts src/core/sqlite-engine.ts test/sqlite-engine.test.ts docs/superpowers/plans/2026-04-25-mbrain-sprint-0-tsc-baseline-current-plan.md
git commit -m "fix(tsc): narrow shared migration capability"
```

### Task 2a.3: Review and Merge Gate

- [ ] **Step 1: Request critical subagent review**

Ask the reviewer to check that shared SQL migrations are no longer part of the base `BrainEngine` contract, SQLite still uses only its own migration ladder, and no unrelated cleanup landed.

- [ ] **Step 2: Run PR gate**

```bash
bun test test/task-memory-engine.test.ts test/sqlite-engine.test.ts test/scenarios/s01-fresh-install.test.ts --timeout 60000
bun run build
git diff --check
```

Expected: all pass.

- [ ] **Step 3: Open PR**

```bash
git push -u origin sprint-0.1-tsc-engine-contract
gh pr create --base master --head sprint-0.1-tsc-engine-contract --title "Sprint 0.1: narrow shared migration capability" --body-file /tmp/mbrain-sprint-0.1-pr-body.md
```

## PR 2b: SQL, JSON, and Mapper Type Boundaries

Branch: `sprint-0.2-tsc-sql-json`

### Task 2b.1: Add SQLite Binding Narrowing

**Files:**

- Modify: `src/core/sqlite-engine.ts`
- Test: `test/sqlite-engine.test.ts`
- Test: `test/brain-loop-audit-engine.test.ts`
- Test: `test/context-map-engine.test.ts`

- [ ] **Step 1: Create branch from updated master**

```bash
git fetch origin
git worktree add -b sprint-0.2-tsc-sql-json .worktrees/sprint-0.2-tsc-sql-json origin/master
cd .worktrees/sprint-0.2-tsc-sql-json
```

Expected: branch includes PR 2a.

- [ ] **Step 2: Add helper types**

In `src/core/sqlite-engine.ts`, add these helpers near existing SQLite row-mapping helpers:

```ts
type SqliteBinding = string | number | bigint | boolean | null | Uint8Array;

function sqliteBindings(values: unknown[]): SqliteBinding[] {
  return values.map((value) => {
    if (
      typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'bigint'
      || typeof value === 'boolean'
      || value === null
      || value instanceof Uint8Array
    ) {
      return value;
    }
    throw new TypeError(`Unsupported SQLite binding: ${typeof value}`);
  });
}
```

- [ ] **Step 3: Use helper at dynamic `.all(...params)` and `.run(...params)` call sites**

For each TypeScript error containing `SQLQueryBindings`, change:

```ts
statement.all(...params)
statement.run(...params)
```

to:

```ts
statement.all(...sqliteBindings(params))
statement.run(...sqliteBindings(params))
```

Only apply this where `params` is a dynamic `unknown[]` or mixed value array already used as SQL bindings.

- [ ] **Step 4: Verify SQLite binding errors are gone**

```bash
bunx tsc --noEmit --pretty false 2>&1 | rg "SQLQueryBindings|sqlite-engine"
```

Expected: no SQLite binding errors. Other unrelated TypeScript errors may remain.

### Task 2b.2: Fix Row Mapper Callback Signatures

**Files:**

- Modify: `src/core/sqlite-engine.ts`
- Modify: `src/core/postgres-engine.ts`
- Modify: `src/core/pglite-engine.ts`

- [ ] **Step 1: Replace direct mapper references that accidentally receive an array index**

For mappers with a second optional boolean argument, change:

```ts
rows.map(mapChunkRow)
```

to:

```ts
rows.map((row) => mapChunkRow(row, includeEmbedding))
```

When embeddings are not being included, use:

```ts
rows.map((row) => mapChunkRow(row, false))
```

- [ ] **Step 2: Verify mapper errors are gone**

```bash
bunx tsc --noEmit --pretty false 2>&1 | rg "mapChunkRow|Types of parameters.*index|includeEmbedding"
```

Expected: no output.

### Task 2b.3: Fix Postgres JSON and Dynamic Parameter Types

**Files:**

- Modify: `src/core/postgres-engine.ts`
- Modify: `src/core/pglite-engine.ts`
- Modify: `src/core/db.ts`

- [ ] **Step 1: Add JSON helper**

In `src/core/postgres-engine.ts`, add:

```ts
function jsonParam(value: unknown): postgres.JSONValue {
  return value as postgres.JSONValue;
}
```

Use it at `this.sql.json(...)` call sites that currently pass `Record<string, unknown>`, arrays, or typed objects:

```ts
this.sql.json(jsonParam(value))
```

- [ ] **Step 2: Type dynamic Postgres parameter arrays**

Where TypeScript reports `ParameterOrJSON<never>[]`, narrow existing dynamic arrays to the local SQL helper's expected parameter type instead of passing `unknown[]`.

Use the smallest local type alias that matches the postgres client in that file:

```ts
type PostgresParam = string | number | boolean | null | Date | Uint8Array;
```

Then type arrays at construction:

```ts
const params: PostgresParam[] = [];
```

- [ ] **Step 3: Fix generic query return helper**

In `src/core/db.ts` and `src/core/postgres-engine.ts`, fix helpers that return `UnwrapPromiseArray<T>` where `T` is promised. The corrected shape must make the generic represent the resolved row array, not the promise wrapper.

Use this pattern:

```ts
async function rows<T>(query: Promise<T[]>): Promise<T[]> {
  return query;
}
```

Do not cast the entire helper output to `T` unless a local row mapper immediately narrows it.

- [ ] **Step 4: Verify SQL/JSON family is gone**

```bash
bunx tsc --noEmit --pretty false 2>&1 | rg "ParameterOrJSON|JSONValue|UnwrapPromiseArray|mapChunkRow|SQLQueryBindings"
```

Expected: no output.

### Task 2b.4: Runtime Verification and Commit

- [ ] **Step 1: Run focused tests**

```bash
bun test test/sqlite-engine.test.ts test/postgres-jsonb-engine.test.ts test/brain-loop-audit-engine.test.ts test/context-map-engine.test.ts --timeout 60000
```

Expected: zero failures. Postgres-specific tests may skip if `DATABASE_URL` is not set.

- [ ] **Step 2: Commit**

```bash
git add src/core/sqlite-engine.ts src/core/postgres-engine.ts src/core/pglite-engine.ts src/core/db.ts
git commit -m "fix(tsc): type SQL and JSON boundaries"
```

## PR 2c: Domain Boundary Type Errors

Branch: `sprint-0.3-tsc-domain-boundaries`

### Task 2c.1: Fix Config Construction

**Files:**

- Modify: `src/commands/migrate-engine.ts`

- [ ] **Step 1: Replace partial config construction**

Build a full `MBrainConfig` with all required fields:

```ts
const config: MBrainConfig = {
  engine,
  database_url,
  database_path,
  offline: false,
  embedding_provider: 'none',
  query_rewrite_provider: 'none',
};
```

Adjust exact field values to match existing config defaults in the repo. Do not cast a partial object to `MBrainConfig`.

- [ ] **Step 2: Verify config errors are gone**

```bash
bunx tsc --noEmit --pretty false 2>&1 | rg "migrate-engine|MBrainConfig"
```

Expected: no output.

### Task 2c.2: Fix Structural Node Boundary Inputs

**Files:**

- Modify: `src/core/operations.ts`

- [ ] **Step 1: Add a local branded conversion helper**

If no existing helper is available in `src/core/types.ts`, add this local helper in `src/core/operations.ts` near other parameter coercion helpers:

```ts
function structuralNodeId(value: string): StructuralNodeId {
  return value as StructuralNodeId;
}
```

- [ ] **Step 2: Use the helper only after string validation**

Change operation boundary calls from:

```ts
node_id: params.node_id,
```

to:

```ts
node_id: structuralNodeId(params.node_id),
```

Only do this for validated string params that represent a structural node id.

- [ ] **Step 3: Verify structural errors are gone**

```bash
bunx tsc --noEmit --pretty false 2>&1 | rg "StructuralNodeId|operations.ts"
```

Expected: no `StructuralNodeId` errors.

### Task 2c.3: Fix Lock, Service, and Storage Boundaries

**Files:**

- Modify: `src/core/pglite-lock.ts`
- Modify: `src/core/services/historical-validity-service.ts`
- Modify: `src/core/services/map-derived-candidate-service.ts`
- Modify: `src/core/storage/supabase.ts`
- Test: `test/historical-validity-service.test.ts`
- Test: `test/phase6-map-derived-candidates.test.ts`

- [ ] **Step 1: Guard nullable lock directory**

In `src/core/pglite-lock.ts`, change the `mkdirSync` call to:

```ts
if (!lockDir) {
  throw new Error('PGLite lock path could not be resolved');
}
mkdirSync(lockDir, { recursive: true });
```

- [ ] **Step 2: Compare dates to dates**

In `src/core/services/historical-validity-service.ts`, replace number-vs-Date comparisons with one of these two forms:

```ts
if (candidate.updated_at.getTime() > cutoff.getTime()) {
  ...
}
```

or:

```ts
if (candidate.updated_at > cutoff) {
  ...
}
```

Use the form that matches the surrounding code's existing values.

- [ ] **Step 3: Narrow map-derived status values**

In `src/core/services/map-derived-candidate-service.ts`, return only:

```ts
'ready'
'stale'
null
```

for fields typed as readiness/status values. Do not return arbitrary strings.

- [ ] **Step 4: Use fetch-compatible body**

In `src/core/storage/supabase.ts`, change Node `Buffer` request bodies to:

```ts
body: new Uint8Array(buffer)
```

- [ ] **Step 5: Verify domain boundary errors are gone**

```bash
bunx tsc --noEmit --pretty false 2>&1 | rg "pglite-lock|historical-validity|map-derived|supabase"
bun test test/historical-validity-service.test.ts test/phase6-map-derived-candidates.test.ts --timeout 60000
```

Expected: no matching TypeScript errors and zero test failures.

- [ ] **Step 6: Commit**

```bash
git add src/commands/migrate-engine.ts src/core/operations.ts src/core/pglite-lock.ts src/core/services/historical-validity-service.ts src/core/services/map-derived-candidate-service.ts src/core/storage/supabase.ts
git commit -m "fix(tsc): resolve domain boundary types"
```

## PR 2d: Test Fixture Type Errors

Branch: `sprint-0.4-tsc-test-fixtures`

### Task 2d.1: Fix Scenario Placeholder Signatures

**Files:**

- Modify: `test/scenarios/s05-mixed-intent-decomposition.test.ts`
- Modify: `test/scenarios/s09-curated-over-map.test.ts`
- Modify: `test/scenarios/s11-code-claim-verification.test.ts`

- [ ] **Step 1: Replace one-argument `test.todo` calls**

Use callback form so strict TypeScript accepts the signature while runtime behavior remains todo:

```ts
test.todo('S5 gap — general request-level intent classifier (resume + synthesis, etc.)', () => {});
```

Apply the same callback form to both S9 todos and both S11 todos.

- [ ] **Step 2: Verify placeholder type errors are gone**

```bash
bunx tsc --noEmit --pretty false 2>&1 | rg "s05-mixed|s09-curated|s11-code|Expected 2-3 arguments"
```

Expected: no output.

### Task 2d.2: Fix Scenario Fixture Types

**Files:**

- Modify: `test/scenarios/helpers.ts`
- Modify: `test/scenarios/s12-baseline-gated-acceptance.test.ts`
- Modify: `test/scenarios/s14-retrieval-trace-fidelity.test.ts`
- Modify: `test/scenarios/s19-interaction-id-supersession.test.ts`
- Modify: affected operation/service tests that pass SQLite harnesses to `BrainEngine` APIs.

- [ ] **Step 1: Replace invalid task status literals**

In scenario helpers, replace invalid `'in_progress'` literals with the actual active status used by `TaskStatus`, for example:

```ts
status: 'active',
```

- [ ] **Step 2: Cast intentionally partial fixture objects through `unknown`**

Where tests intentionally omit fields from large report fixtures, change:

```ts
const summary = {
  ...
} as Phase8LongitudinalPhaseSummary;
```

to:

```ts
const summary = {
  ...
} as unknown as Phase8LongitudinalPhaseSummary;
```

Use this only in test fixtures, not production code.

- [ ] **Step 3: Guard optional array values in assertions**

In `test/scenarios/s14-retrieval-trace-fidelity.test.ts`, replace assertions that pass `string | undefined` into `toEqual` with explicit checks:

```ts
expect(trace.source_refs[0]).toBeDefined();
expect(trace.source_refs).toContain(trace.source_refs[0] as string);
```

Prefer more specific expected values when available.

- [ ] **Step 4: Verify test fixture family is gone**

```bash
bunx tsc --noEmit --pretty false 2>&1 | rg "test/|scenarios|scope-gate|workspace-|Expected 2-3 arguments|TaskStatus"
```

Expected: no output.

- [ ] **Step 5: Runtime tests**

```bash
bun test test/scenarios/ test/scope-gate-service.test.ts test/workspace-system-card-service.test.ts --timeout 60000
```

Expected: zero failures. Scenario todos still exist until Track B replaces them.

- [ ] **Step 6: Commit**

```bash
git add test/scenarios/s05-mixed-intent-decomposition.test.ts test/scenarios/s09-curated-over-map.test.ts test/scenarios/s11-code-claim-verification.test.ts test/scenarios/s12-baseline-gated-acceptance.test.ts test/scenarios/s14-retrieval-trace-fidelity.test.ts test/scenarios/s19-interaction-id-supersession.test.ts test/scenarios/helpers.ts test/scope-gate-service.test.ts test/workspace-system-card-service.test.ts
git commit -m "fix(tsc): align test fixtures with strict types"
```

## PR 2e: Final Typecheck and CI Enforcement

Branch: `sprint-0.5-tsc-ci`

### Task 2e.1: Confirm Local Typecheck Is Clean

**Files:**

- Modify: `.github/workflows/test.yml`

- [ ] **Step 1: Start from updated master**

```bash
git fetch origin
git worktree add -b sprint-0.5-tsc-ci .worktrees/sprint-0.5-tsc-ci origin/master
cd .worktrees/sprint-0.5-tsc-ci
```

Expected: branch includes PRs 2a-2d.

- [ ] **Step 2: Run typecheck**

```bash
bunx tsc --noEmit --pretty false
```

Expected: command exits 0 with no output.

### Task 2e.2: Add CI Typecheck

- [ ] **Step 1: Add workflow step**

In `.github/workflows/test.yml`, add this before the main `bun test` step:

```yaml
- name: Typecheck
  run: bunx tsc --noEmit --pretty false
```

- [ ] **Step 2: Run local gates**

```bash
bunx tsc --noEmit --pretty false
bun test --timeout 60000
bun run build
git diff --check
```

Expected: all pass.

- [ ] **Step 3: Commit and open PR**

```bash
git add .github/workflows/test.yml
git commit -m "ci: enforce TypeScript typecheck"
git push -u origin sprint-0.5-tsc-ci
gh pr create --base master --head sprint-0.5-tsc-ci --title "Sprint 0.5: enforce TypeScript typecheck" --body-file /tmp/mbrain-sprint-0.5-pr-body.md
```

## Review Discipline

- Every PR must be reviewed by a critical subagent before merge.
- No `@ts-ignore` or `@ts-expect-error` may be introduced.
- No new production `any` may be introduced.
- If a TypeScript fix exposes a real runtime bug, split the bug fix into its own PR unless it is required to keep this track green.
- Every PR must finish with focused tests, `bun run build`, and `git diff --check`.
- Starting with PR 2e, every later PR must also pass `bunx tsc --noEmit --pretty false`.

## Self-Review

- Spec coverage: Covers `2026-04-24-mbrain-sprint-0-tsc-baseline-design.md` and updates it with the current `851`-error baseline after PR #42.
- Scope control: Mechanical type cleanup only; no L1/L2/L4 feature semantics.
- Ordering: Fixes the largest cascade (`SQLiteEngine` contract) before lower-level SQL/JSON and test fixture families.
- Verification: Each slice has a focused TypeScript query, focused runtime tests, and a merge gate.
