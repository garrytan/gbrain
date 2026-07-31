# Scalar-source Backlink Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make backlink validation compare exact `(source_id, slug)` endpoint identities while preserving existing scalar, unscoped, and federated link-read semantics.

**Architecture:** Enrich every engine link-read row with the source identity of its joined from, to, and visible origin pages. Pass the validated page's scalar or federated scope into validator context; the backlink validator scopes its initial read consistently, groups targets by exact identity, and accepts only an exact reverse endpoint pair. SQL predicates remain unchanged, so trusted scalar cross-source visibility and federated all-endpoint containment remain intact.

**Tech Stack:** TypeScript, Bun test, PGLite, PostgreSQL/postgres.js.

## Global Constraints

- Use strict red-before-green TDD with duplicate slugs across sources.
- Preserve unscoped historical reads, scalar near-endpoint scoping, scalar explicit cross-source visibility, federated all-endpoint containment, and `sourceIds` precedence.
- Keep PostgreSQL and PGLite projections in parity.
- Do not change schema or conditional-write conflict semantics.
- Keep deployment, restart, migration, and push actions outside the implementation tasks; a separately authorized release workflow may perform them after verification.
- Capture full test output to files before inspecting it.

---

### Task 1: Pin the backlink false-negative in PGLite

**Files:**
- Modify: `test/writer.test.ts`

**Interfaces:**
- Consumes: `backLinkValidator.validate(PageValidationContext)` and source-qualified `putPage`/`addLink`.
- Produces: regressions for wrong-source reverse rejection, exact reverse acceptance, cross-source pair acceptance, and exact target deduplication.

- [ ] **Step 1: Add the minimal failing duplicate-slug regression**

Create `default` and `team-x` copies of the origin and target, add `(team-x, origin) -> (team-x, target)` plus the wrong reverse `(team-x, target) -> (default, origin)`, validate with `sourceId: 'team-x'`, and require one warning.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
bun test test/writer.test.ts -t "wrong-source reverse" > "$TEMP/backlink-red.txt" 2>&1
```

Expected: assertion failure because current slug-only validation returns zero findings.

- [ ] **Step 3: Add the remaining behavioral regressions after the first red is recorded**

Add tests proving that the exact reverse clears the warning, a legitimate cross-source forward/reverse pair passes, and two destinations sharing one slug but differing by source are validated independently.

### Task 2: Expose exact endpoint identity from both engines

**Files:**
- Modify: `src/core/types.ts:1204-1229`
- Modify: `src/core/postgres-engine.ts:3021-3124`
- Modify: `src/core/pglite-engine.ts:2941-3037`
- Modify: `test/get-page-federated-scope.test.ts:187-246,289-306`
- Modify: `test/e2e/multi-source-bug-class.test.ts:184-205`
- Modify: `test/e2e/engine-parity.test.ts:813-875`

**Interfaces:**
- Produces: `Link.from_source_id: string`, `Link.to_source_id: string`, and `Link.origin_source_id?: string | null`.
- Preserves: `getLinks(slug, { sourceId?, sourceIds? })` and `getBacklinks(...)` filtering semantics.

- [ ] **Step 1: Add engine-contract assertions before implementation**

Assert scalar cross-source rows expose `beta -> default`, federated rows expose only in-grant endpoint IDs, `sourceIds` still beats scalar `sourceId`, and an out-of-grant origin has both `origin_slug` and `origin_source_id` null.

- [ ] **Step 2: Run the focused contract tests and verify RED**

```bash
bun test test/get-page-federated-scope.test.ts test/e2e/multi-source-bug-class.test.ts > "$TEMP/link-identity-red.txt" 2>&1
```

Expected: source-ID assertions fail because fields are absent.

- [ ] **Step 3: Extend `Link` and project IDs without changing predicates**

Use this additive contract:

```ts
export interface Link {
  from_slug: string;
  from_source_id: string;
  to_slug: string;
  to_source_id: string;
  link_type: string;
  context: string;
  link_source?: string | null;
  origin_slug?: string | null;
  origin_source_id?: string | null;
  origin_field?: string | null;
}
```

In all six branches per engine, project:

```sql
f.source_id AS from_source_id,
t.source_id AS to_source_id,
o.source_id AS origin_source_id
```

Keep every `WHERE` and grant-aware origin `LEFT JOIN` unchanged.

- [ ] **Step 4: Re-run contract tests and verify GREEN**

Use the same command and require all focused tests to pass.

### Task 3: Validate exact reverse identities and propagate scope

**Files:**
- Modify: `src/core/output/writer.ts:89-96,240-318`
- Modify: `src/core/output/post-write.ts:36-41,73-118`
- Modify: `src/core/output/validators/back-link.ts:24-47`
- Modify: `src/core/operations.ts:1227-1246`
- Modify: `test/post-write-lint.test.ts:67-130`

**Interfaces:**
- Produces: optional `PageValidationContext.sourceId` and `sourceIds`, with `sourceIds` taking precedence.
- `runPostWriteLint(..., opts)` accepts the same optional scope and loads the validated page through it.

- [ ] **Step 1: Add a post-write nested-read regression and verify RED**

Validate a non-default page with a wrong-source reverse via `runPostWriteLint(..., { force: true, noLog: true, sourceId: 'team-x' })`; require a backlink warning.

- [ ] **Step 2: Implement minimal scope propagation**

Add `sourceId?`/`sourceIds?` to validation context and lint options. Load pages using `sourceIds` when non-empty, otherwise scalar `sourceId`. Pass the same scope into nested validators. In the put-page success hook, call lint with the already-resolved write source ID.

- [ ] **Step 3: Implement exact backlink matching**

Initial outbound reads use the validation scope. Deduplicate rows by all four endpoint identity fields so every distinct expected origin remains represented even when targets share a source-qualified identity. Read each target using the federated grant when present, otherwise the target's exact scalar source. Accept only a row matching all four endpoint fields of the expected reverse.

- [ ] **Step 4: Run writer and post-write tests and verify GREEN**

```bash
bun test test/writer.test.ts test/post-write-lint.test.ts > "$TEMP/backlink-green.txt" 2>&1
```

Expected: all tests pass, including the recorded false-negative.

### Task 4: Verify PostgreSQL/PGLite parity and final scope

**Files:**
- Modify: `test/e2e/engine-parity.test.ts:813-875`
- Verify: all files above

**Interfaces:**
- Consumes: exact endpoint fields and unchanged filtering semantics.
- Produces: parity evidence for scalar cross-source and federated reads.

- [ ] **Step 1: Compare complete endpoint tuples across engines**

Compare sorted tuples containing `from_source_id`, `from_slug`, `to_source_id`, `to_slug`, `origin_source_id`, and `origin_slug` for scalar and federated fixtures.

- [ ] **Step 2: Run focused PGLite/source-isolation tests**

```bash
bun test test/writer.test.ts test/post-write-lint.test.ts test/get-page-federated-scope.test.ts test/e2e/multi-source-bug-class.test.ts > "$TEMP/backlink-focused.txt" 2>&1
```

Expected: exit 0.

- [ ] **Step 3: Run PostgreSQL parity when the test database is available**

```bash
bun test test/e2e/engine-parity.test.ts -t "federated sourceIds" --timeout=300000 > "$TEMP/backlink-parity.txt" 2>&1
```

Expected: exit 0; if the configured test database is unavailable, report the exact environmental blocker rather than claiming parity execution.

- [ ] **Step 4: Typecheck and inspect the final diff**

```bash
bun run typecheck > "$TEMP/backlink-typecheck.txt" 2>&1
```

Expected: exit 0. Then run `git diff --check` and confirm no version, schema, migration, deployment, or conditional-write files changed.
