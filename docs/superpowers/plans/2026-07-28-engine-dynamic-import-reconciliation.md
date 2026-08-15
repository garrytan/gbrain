# Engine Dynamic-Import Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruct the missing engine-path static-import hardening, preserve the four load-bearing lazy gateway fallbacks, and prevent unreviewed dynamic imports from returning.

**Architecture:** Make the 13 safe engine/migration import statements static and leave only four line-marked `ai/gateway.ts` imports inside their existing soft-failure `try/catch` boundaries. Enforce that current state with a repository-anchored Bash wrapper delegating to a fail-closed TypeScript AST scanner, a hermetic Bun regression test, package/verify wiring, and current-state architecture documentation.

**Tech Stack:** TypeScript compiler API, Bun test runner, Bash, Git, generated llms documentation bundles.

## Global Constraints

- Reconstruct directly on branch `claude/kind-meitner-330c90`, based on investigated `origin/master` commit `6136e139972a5449630b4f47f5ed7b4cbe5b811b` plus design commit `d7f52d8c`.
- Do not merge or cherry-pick `48ada48f`, `248bfe55`, `ef4cf7a8`, or either historical branch wholesale.
- Do not modify `VERSION`, `CHANGELOG.md`, `TODOS.md`, or release metadata; this is a no-version-bump reconciliation.
- Keep all four `await import('./ai/gateway.ts')` calls lazy: PGLite and Postgres `initSchema`, plus both `_upsertChunksOnce` methods.
- Every allowed lazy gateway line must carry `engine-dynamic-import-ok`; there is no file-level exemption.
- Preserve the stronger gateway rationale: the static closure is large, and eager module evaluation would occur outside the local `try/catch`, potentially converting a recoverable configuration/import failure into a module-load-time hard failure.
- Describe the hoists as engine-path hardening. Do not claim every dynamic import deterministically causes a Windows crash; system-wide commit exhaustion confounded prior measurements.
- Keep shared PGLite/Postgres behavior in parity.
- Invoke repository shell scripts through `bash` in `package.json`.
- Capture complete test/check output to workspace-local `.context/*.txt` files before inspecting it; never pipe a test command directly through `head` or `tail`.
- Use `git log -G`, not `git log -S`, for any additional dynamic-to-static import history work.
- Keep every implementation and verification commit local. Do not push, create a PR, comment upstream, or otherwise publish without explicit user approval after local completion.
- Before editing any affected function, run GBrain `code_blast` and `code_callers` for that symbol and inspect any disambiguation candidates.

---

## File Map

- Create `scripts/check-engine-dynamic-import.sh` — repository-anchored Bash wrapper for default and explicit input routing.
- Create `scripts/check-engine-dynamic-import.ts` — TypeScript AST policy scanner for runtime `import()` expressions, parse/read failures, and exact-line comment-trivia opt-outs.
- Create `test/scripts/check-engine-dynamic-import.test.ts` — 22 hermetic adversarial, CRLF, fail-closed, real-tree, and wiring tests.
- Modify `src/core/pglite-engine.ts` — hoist three safe import statements and mark two deliberate gateway imports.
- Modify `src/core/postgres-engine.ts` — hoist eight safe import statements and mark two deliberate gateway imports.
- Modify `src/core/migrate.ts` — hoist two safe migration helper import statements.
- Modify `package.json` — expose `check:engine-dynamic-import` and append it to `check:all` through `bash`.
- Modify `scripts/run-verify-parallel.sh` — add the package check to the authoritative verify dispatcher.
- Modify `CLAUDE.md` — add the cross-cutting current-state invariant.
- Modify `docs/architecture/KEY_FILES.md` — update current-state entries for the three engine-path files.
- Regenerate `llms.txt` and `llms-full.txt` — required derived bundles after CLAUDE/reference documentation changes.

---

### Task 1: Establish and enforce the source invariant

**Files:**
- Create: `scripts/check-engine-dynamic-import.sh`
- Create: `scripts/check-engine-dynamic-import.ts`
- Create: `test/scripts/check-engine-dynamic-import.test.ts`
- Modify: `src/core/pglite-engine.ts`
- Modify: `src/core/postgres-engine.ts`
- Modify: `src/core/migrate.ts`

**Interfaces:**
- Consumes: shell positional arguments `FILE...`; without arguments, the guard scans the three repository files.
- Produces: `scripts/check-engine-dynamic-import.sh [FILE...]`, exit `0` when every runtime dynamic import is allowed and exit `1` after reporting every `file:line:text` violation plus every read/parse error on stderr.
- Produces: one line-level opt-out token, `engine-dynamic-import-ok`, accepted only in real comment trivia on the same physical line as the deliberately lazy import.
- Fails closed on missing/unreadable inputs, TypeScript parse diagnostics, and scanner/process failures; comments, strings, templates, regex literals, and type-position `import(...)` syntax are not runtime imports.

- [ ] **Step 1: Record call-graph blast radius before touching functions**

First call `sources_list` and select the source whose registered path is this gbrain checkout. Then run `code_blast` and `code_callers` for these qualified symbols with that exact `source_id`, following `did_you_mean`/`candidates` when a method name is ambiguous:

```text
src/core/pglite-engine.ts::PGLiteEngine.initSchema
src/core/pglite-engine.ts::PGLiteEngine.batchRetry
src/core/pglite-engine.ts::PGLiteEngine._upsertChunksOnce
src/core/pglite-engine.ts::PGLiteEngine.mergeOntologyFact
src/core/pglite-engine.ts::PGLiteEngine.getRecentSalience
src/core/postgres-engine.ts::PostgresEngine.disconnect
src/core/postgres-engine.ts::PostgresEngine.initSchema
src/core/postgres-engine.ts::PostgresEngine.batchRetry
src/core/postgres-engine.ts::PostgresEngine._upsertChunksOnce
src/core/postgres-engine.ts::PostgresEngine.mergeOntologyFact
src/core/postgres-engine.ts::PostgresEngine.reconnect
src/core/postgres-engine.ts::PostgresEngine.getRecentSalience
src/core/migrate.ts::runMigrationSQLWithRetry
src/core/migrate.ts::runMigrations
```

Use `depth: 5`, `max_nodes: 200`, and `limit: 100`. Expected: no caller requires a signature or behavior change; the patch only changes module binding time and retains all local fallback/error handling.

- [ ] **Step 2: Write the failing guard regression test**

Create `test/scripts/check-engine-dynamic-import.test.ts` as a hermetic subprocess suite. The completed 22-test surface covers:

- unmarked runtime `import()` rejection, including bare and trivia-separated forms;
- same-line markers in real line or multiline block-comment trivia;
- rejection of markers on prior lines or inside strings, templates, and module paths;
- comments and comment-like delimiters inside strings, templates, and regex literals;
- live code after same-line or multiline block comments close;
- CRLF input and complete multi-file violation aggregation;
- missing/readable mixed inputs and TypeScript parse diagnostics;
- default repository anchoring when invoked from a foreign Git repository;
- the reconciled three-file source scan plus package/parallel-verifier wiring.

Use the TypeScript parser rather than a partial lexical reimplementation. On Windows, set the test default to 30 seconds because each case launches Git Bash and Bun, whose startup can exceed Bun's 5-second per-test default.

- [ ] **Step 3: Run the test to prove the pre-implementation red state**

```bash
bun test test/scripts/check-engine-dynamic-import.test.ts > .context/engine-dynamic-import-red.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc"; exit 0
```

Expected: non-zero Bun result captured inside the log. At minimum, the `exists` assertion fails because `scripts/check-engine-dynamic-import.sh` does not exist. Read `.context/engine-dynamic-import-red.txt`; do not infer the result from a truncated pipeline.

- [ ] **Step 4: Add the CRLF-safe, fail-closed guard**

Create `scripts/check-engine-dynamic-import.sh` as a thin LF-terminated wrapper. Resolve its own directory first; when no explicit files are passed, anchor the repository with `git -C "$SCRIPT_DIR/.."` and scan the two engines plus `migrate.ts`. Delegate with `exec bun "$SCRIPT_DIR/check-engine-dynamic-import.ts" "${FILES[@]}"` so scanner failures propagate.

Create `scripts/check-engine-dynamic-import.ts` using the TypeScript compiler API:

- read every requested file and aggregate read failures;
- parse as TypeScript and aggregate parse diagnostics;
- walk the AST for `CallExpression`s whose expression is `ImportKeyword`;
- locate all marker occurrences in the full source and use `ts.getTokenAtPosition` to admit only occurrences outside AST tokens (real comment trivia), recording their physical source lines;
- require each runtime import's line to have an admitted marker or report its original `file:line:text`;
- print every read/parse error and every violation before exiting nonzero.

This preserves CRLF line accounting, ignores comment/literal/type-only false positives, catches every legal runtime `import()` shape the TypeScript parser recognizes, rejects marker spoofing, and fails closed.

- [ ] **Step 5: Run the guard test to prove the source-tree midpoint is still red**

```bash
bun test test/scripts/check-engine-dynamic-import.test.ts > .context/engine-dynamic-import-midpoint.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc"; exit 0
```

Expected: the synthetic violation, marker, comments, and CRLF cases pass. The default repository scan fails and reports all 17 current imports: 13 unmarked safe candidates plus the four not-yet-marked gateway calls.

- [ ] **Step 6: Hoist the three safe PGLite import statements**

Replace the existing `retry.ts` import and add the ontology/recency imports near the top of `src/core/pglite-engine.ts`:

```ts
// Engine-path imports stay static unless a call site carries an explicit
// engine-dynamic-import-ok justification. The gateway is the only current
// exception because its local try/catch preserves a soft fallback.
import {
  withRetry,
  BULK_RETRY_OPTS,
  resolveBulkRetryOpts,
  computeNextDelay,
  isRetryableConnError,
  type BatchAuditSite,
} from './retry.ts';
import {
  valueHash,
  normalizeDimension,
  isNovelDimension,
} from './chronicle/ontology.ts';
import {
  resolveRecencyDecayMap,
  DEFAULT_FALLBACK,
} from './search/recency-decay.ts';
```

Delete only these three in-method destructuring imports, leaving their uses unchanged:

```ts
const { isRetryableConnError } = await import('./retry.ts');
const { valueHash, normalizeDimension, isNovelDimension } = await import('./chronicle/ontology.ts');
const { resolveRecencyDecayMap, DEFAULT_FALLBACK } = await import('./search/recency-decay.ts');
```

- [ ] **Step 7: Mark both PGLite gateway soft-failure boundaries**

In `PGLiteEngine.initSchema`, preserve the `try/catch` and accessors, changing only the rationale and import line:

```ts
try {
  // Keep the gateway lazy: its static closure is large, and evaluation inside
  // this try/catch preserves the unconfigured-gateway default fallback.
  const gw = await import('./ai/gateway.ts'); // engine-dynamic-import-ok
  // Both accessors THROW when the gateway is unconfigured (they never
  // return falsy), so the catch below is the only fallback path (#3461).
  dims = gw.getEmbeddingDimensions();
  model = gw.getEmbeddingModel();
} catch { /* gateway not configured — use defaults */ }
```

In `PGLiteEngine._upsertChunksOnce`, preserve the config-row and compile-time fallback chain:

```ts
try {
  // Keep the gateway lazy so module-load failure remains inside this soft
  // fallback boundary; eager evaluation would bypass the config-row fallback.
  const gw = await import('./ai/gateway.ts'); // engine-dynamic-import-ok
  resolvedModel = gw.getEmbeddingModel();
} catch {
```

- [ ] **Step 8: Hoist the eight safe Postgres import statements**

Replace the existing `retry.ts` import and add these imports near the top of `src/core/postgres-engine.ts`:

```ts
// Engine-path imports stay static unless a call site carries an explicit
// engine-dynamic-import-ok justification. The gateway is the only current
// exception because its local try/catch preserves a soft fallback.
import {
  withRetry,
  BULK_RETRY_OPTS,
  resolveBulkRetryOpts,
  computeNextDelay,
  isRetryableConnError,
  type BatchAuditSite,
} from './retry.ts';
import { isConnectionEndedError } from './retry-matcher.ts';
import {
  valueHash,
  normalizeDimension,
  isNovelDimension,
} from './chronicle/ontology.ts';
import {
  resolveRecencyDecayMap,
  DEFAULT_FALLBACK,
} from './search/recency-decay.ts';
import { logDbDisconnect } from './audit/db-disconnect-audit.ts';
import { logPoolRecovery } from './audit/pool-recovery-audit.ts';
```

Delete the eight safe dynamic-import statements while keeping their surrounding `try/catch` blocks and calls unchanged:

```ts
const { logDbDisconnect } = await import('./audit/db-disconnect-audit.ts');
const { isRetryableConnError } = await import('./retry.ts');
const { valueHash, normalizeDimension, isNovelDimension } = await import('./chronicle/ontology.ts');
const { isConnectionEndedError } = await import('./retry-matcher.ts');
const { logPoolRecovery } = await import('./audit/pool-recovery-audit.ts');
const { logPoolRecovery } = await import('./audit/pool-recovery-audit.ts');
const { logPoolRecovery } = await import('./audit/pool-recovery-audit.ts');
const { resolveRecencyDecayMap, DEFAULT_FALLBACK } = await import('./search/recency-decay.ts');
```

Update the stale `batchRetry` comment from “Lazy-import to avoid a circular dep concern” to current truth:

```ts
// retry.ts is already in this module's static graph through withRetry, so
// classifying the exhausted error does not need a second runtime import.
```

- [ ] **Step 9: Mark both Postgres gateway soft-failure boundaries**

In `PostgresEngine.initSchema`, mirror the PGLite rationale and preserve behavior:

```ts
try {
  // Keep the gateway lazy: its static closure is large, and evaluation inside
  // this try/catch preserves the unconfigured-gateway default fallback.
  const gw = await import('./ai/gateway.ts'); // engine-dynamic-import-ok
  // Both accessors THROW when the gateway is unconfigured (they never
  // return falsy), so the catch below is the only fallback path (#3461).
  dims = gw.getEmbeddingDimensions();
  model = gw.getEmbeddingModel();
} catch { /* gateway not yet configured — use defaults */ }
```

In `PostgresEngine._upsertChunksOnce`, preserve the DB-config fallback:

```ts
try {
  // Keep the gateway lazy so module-load failure remains inside this soft
  // fallback boundary; eager evaluation would bypass the config-row fallback.
  const gw = await import('./ai/gateway.ts'); // engine-dynamic-import-ok
  resolvedModel = gw.getEmbeddingModel();
} catch {
```

- [ ] **Step 10: Hoist the two migration helper import statements**

Add these static imports at the top of `src/core/migrate.ts`:

```ts
// runMigrations executes while an initialized engine is live. Keep its helper
// modules in the static graph rather than importing them from async handlers.
import {
  isStatementTimeoutError,
  isRetryableConnError,
} from './retry-matcher.ts';
import { repairTimelineDedupIndex } from './timeline-dedup-repair.ts';
```

Delete only these two local destructuring imports:

```ts
const { isStatementTimeoutError, isRetryableConnError } = await import('./retry-matcher.ts');
const { repairTimelineDedupIndex } = await import('./timeline-dedup-repair.ts');
```

- [ ] **Step 11: Run the complete guard test and direct guard**

```bash
bun test test/scripts/check-engine-dynamic-import.test.ts > .context/engine-dynamic-import-green.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc"; exit "$rc"
```

Expected: exit `0`; the full guard regression suite passes.

```bash
bash scripts/check-engine-dynamic-import.sh > .context/engine-dynamic-import-guard.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc"; exit "$rc"
```

Expected: exit `0`; output contains `check-engine-dynamic-import: ok (3 file(s) scanned)`.

- [ ] **Step 12: Prove the guard leaves exactly four marked dynamic imports**

```bash
git grep -n -F "import('./ai/gateway.ts'); // engine-dynamic-import-ok" -- src/core/pglite-engine.ts src/core/postgres-engine.ts src/core/migrate.ts > .context/engine-dynamic-import-sites.txt; rc=$?; printf 'EXIT=%s\n' "$rc"; exit "$rc"
```

Expected: exactly four lines, all importing `./ai/gateway.ts` and all carrying `engine-dynamic-import-ok`; no match in `src/core/migrate.ts`.

- [ ] **Step 13: Run focused behavior tests**

```bash
bun test test/chronicle-ontology.test.ts test/chronicle-ontology-ops.test.ts test/recency-decay.test.ts test/core/retry.test.ts test/retry-matcher.test.ts test/audit/pool-recovery-audit.test.ts test/migrate-retry.test.ts test/timeline-dedup-repair.test.ts > .context/engine-dynamic-import-focused.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc"; exit "$rc"
```

Expected: exit `0`. If Windows resource pressure aborts the process, record the exact exit code and rerun the failing file alone; do not relabel an infrastructure abort as a source pass.

- [ ] **Step 14: Commit the source invariant locally**

```bash
git add scripts/check-engine-dynamic-import.sh scripts/check-engine-dynamic-import.ts test/scripts/check-engine-dynamic-import.test.ts src/core/pglite-engine.ts src/core/postgres-engine.ts src/core/migrate.ts
```

```bash
git commit -m "fix(engine): reconcile dynamic import hardening"
```

Expected: one local commit; no version or release files staged.

---

### Task 2: Wire the guard into repository checks

**Files:**
- Modify: `test/scripts/check-engine-dynamic-import.test.ts`
- Modify: `package.json`
- Modify: `scripts/run-verify-parallel.sh`

**Interfaces:**
- Consumes: `scripts/check-engine-dynamic-import.sh` from Task 1.
- Produces: package script `check:engine-dynamic-import` and verify dry-list entry of the same name.

- [ ] **Step 1: Add failing wiring assertions**

Add these imports/constants to `test/scripts/check-engine-dynamic-import.test.ts`:

```ts
const PACKAGE_JSON = resolve(REPO_ROOT, 'package.json');
```

Append this test block:

```ts
describe('engine dynamic-import guard wiring', () => {
  it('is invoked through bash by check:all', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['check:engine-dynamic-import']).toBe(
      'bash scripts/check-engine-dynamic-import.sh',
    );
    expect(pkg.scripts['check:all']).toContain(
      'bash scripts/check-engine-dynamic-import.sh',
    );
  });

  it('is listed by the authoritative verify dispatcher', () => {
    const result = spawnSync(BASH, [VERIFY_DISPATCHER, '--dry-list'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(new Set((result.stdout ?? '').trim().split('\n'))).toContain(
      'check:engine-dynamic-import',
    );
  });
});
```

- [ ] **Step 2: Run the test and verify both wiring assertions fail**

```bash
bun test test/scripts/check-engine-dynamic-import.test.ts > .context/engine-dynamic-import-wiring-red.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc"; exit 0
```

Expected: non-zero Bun result. The source guard tests remain green; package-script and verify-list assertions fail because the wiring is absent.

- [ ] **Step 3: Add the package scripts**

In `package.json`, add this script alongside the other `check:*` entries:

```json
"check:engine-dynamic-import": "bash scripts/check-engine-dynamic-import.sh"
```

Append the guard to the existing `check:all` chain, preserving every existing check:

```text
&& bash scripts/check-engine-dynamic-import.sh
```

Do not rewrite any existing shell entry without its `bash` prefix.

- [ ] **Step 4: Add the authoritative verify entry**

In `scripts/run-verify-parallel.sh`, add this stable `CHECKS` entry near the other source-shape guards:

```bash
  "check:engine-dynamic-import"
```

- [ ] **Step 5: Run the regression test and package check**

```bash
bun test test/scripts/check-engine-dynamic-import.test.ts > .context/engine-dynamic-import-wiring-green.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc"; exit "$rc"
```

Expected: exit `0`; the full guard regression suite passes.

```bash
bun run check:engine-dynamic-import > .context/engine-dynamic-import-package-check.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc"; exit "$rc"
```

Expected: exit `0` and three files scanned.

- [ ] **Step 6: Commit the wiring locally**

```bash
git add package.json scripts/run-verify-parallel.sh test/scripts/check-engine-dynamic-import.test.ts
```

```bash
git commit -m "test(engine): guard dynamic import policy"
```

Expected: one local commit with the guard wiring and its regression assertions.

---

### Task 3: Document the current-state invariant

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/architecture/KEY_FILES.md`
- Regenerate: `llms.txt`
- Regenerate: `llms-full.txt`

**Interfaces:**
- Consumes: the four-marked-import source state and the `check:engine-dynamic-import` package surface.
- Produces: current-state contributor guidance and fresh generated documentation bundles.

- [ ] **Step 1: Add the cross-cutting invariant to `CLAUDE.md`**

Add this bullet under “Cross-cutting invariants” near the other language/filesystem guards:

```md
- **Engine-live paths use static imports by default.** In
  `src/core/pglite-engine.ts`, `src/core/postgres-engine.ts`, and
  `src/core/migrate.ts`, helper modules are top-level imports. The only current
  exceptions are the four `ai/gateway.ts` lookups in both engines'
  `initSchema()` and `_upsertChunksOnce()` methods; each remains lazy inside a
  local `try/catch` because the gateway has a large provider/config closure and,
  more importantly, eager evaluation would occur before the catch and could
  turn a recoverable default/config-row fallback into a module-load failure.
  Every exception carries `engine-dynamic-import-ok` on the import line.
  `scripts/check-engine-dynamic-import.sh` enforces the rule. For history, use
  `git log -G'await[[:space:]]+import\\('`, not `git log -S`: a dynamic-to-static
  rewrite can preserve the searched token while changing its context.
```

Do not add release tags, Windows-crash certainty, or historical branch names.

- [ ] **Step 2: Update the PGLite current-state entry in `KEY_FILES.md`**

Append this current-state sentence to the existing `src/core/pglite-engine.ts` entry, preserving the entry as one bullet:

```md
Engine-path helper dependencies (`retry`, ontology, recency decay) bind statically; the only lazy imports are `ai/gateway.ts` in `initSchema` and `_upsertChunksOnce`, line-marked because their local catches preserve compiled-default and stored-config fallbacks that eager module evaluation would bypass.
```

- [ ] **Step 3: Update the Postgres current-state entry in `KEY_FILES.md`**

Append this sentence to the existing `src/core/postgres-engine.ts` entry:

```md
Retry classifiers, ontology/recency helpers, and disconnect/pool-recovery audit writers bind statically; only the two `ai/gateway.ts` fallback lookups stay lazy and line-marked, in parity with PGLite.
```

- [ ] **Step 4: Update the migration current-state entry in `KEY_FILES.md`**

Append this sentence to the canonical `src/core/migrate.ts` entry (the broad runner entry, not the older v95-specific index note):

```md
`retry-matcher.ts` and `timeline-dedup-repair.ts` are static dependencies because `runMigrations()` executes from live engine initialization; the engine dynamic-import guard scans this file with both engine implementations.
```

Keep all three entries current-state only: no `v0.42.x`, branch, commit, “previously,” or “was/now” narration.

- [ ] **Step 5: Regenerate the llms bundles**

```bash
bun run build:llms > .context/engine-dynamic-import-build-llms.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc"; exit "$rc"
```

Expected: exit `0`; `llms.txt` and/or `llms-full.txt` update according to their configured linked/inlined status. Byte-identical output for a linked source is acceptable; the freshness test is authoritative.

- [ ] **Step 6: Run documentation freshness checks**

```bash
bun test test/build-llms.test.ts > .context/engine-dynamic-import-llms-test.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc"; exit "$rc"
```

Expected: exit `0`.

```bash
bun run check:doc-history > .context/engine-dynamic-import-doc-history.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc"; exit "$rc"
```

Expected: exit `0`; no release-history marker is introduced into current-state reference docs.

- [ ] **Step 7: Confirm prohibited release files remain untouched**

```bash
git diff --name-only d7f52d8c..HEAD -- VERSION CHANGELOG.md TODOS.md
```

Expected: no output.

- [ ] **Step 8: Commit documentation and generated bundles locally**

```bash
git add CLAUDE.md docs/architecture/KEY_FILES.md llms.txt llms-full.txt
```

```bash
git commit -m "docs(engine): record static import invariant"
```

Expected: one local documentation commit. If one generated bundle is byte-identical, Git simply omits it.

---

### Task 4: Verify and review the complete local reconciliation

**Files:**
- Verify all files changed since `d7f52d8c`.
- Do not create or modify release/publication metadata.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: full local verification evidence and an implementation diff ready for user review, not publication.

- [ ] **Step 1: Run the regression test and direct guard again**

```bash
bun test test/scripts/check-engine-dynamic-import.test.ts > .context/engine-dynamic-import-final-test.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc"; exit "$rc"
```

Expected: exit `0`; the full guard regression suite passes.

```bash
bash scripts/check-engine-dynamic-import.sh > .context/engine-dynamic-import-final-guard.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc"; exit "$rc"
```

Expected: exit `0`; three files scanned.

- [ ] **Step 2: Run TypeScript checking**

```bash
bun run typecheck > .context/engine-dynamic-import-typecheck.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc"; exit "$rc"
```

Expected: exit `0`. Report exact diagnostics if the branch or current Windows environment has a pre-existing failure.

- [ ] **Step 3: Run the authoritative verify dispatcher**

```bash
bun run verify > .context/engine-dynamic-import-verify.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc"; exit "$rc"
```

Expected: exit `0`, including `check:engine-dynamic-import`. On Windows, classify any per-check timeout from the complete log instead of treating the aggregate result as a source regression without evidence.

- [ ] **Step 4: Re-run focused tests as an ownership check**

```bash
bun test test/chronicle-ontology.test.ts test/chronicle-ontology-ops.test.ts test/recency-decay.test.ts test/core/retry.test.ts test/retry-matcher.test.ts test/audit/pool-recovery-audit.test.ts test/migrate-retry.test.ts test/timeline-dedup-repair.test.ts > .context/engine-dynamic-import-final-focused.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc"; exit "$rc"
```

Expected: exit `0`; record any infrastructure abort separately and rerun only the named file before classifying it.

- [ ] **Step 5: Run the llms freshness test after all documentation settles**

```bash
bun test test/build-llms.test.ts > .context/engine-dynamic-import-final-llms.txt 2>&1; rc=$?; printf 'EXIT=%s\n' "$rc"; exit "$rc"
```

Expected: exit `0`.

- [ ] **Step 6: Run whitespace and scope checks**

```bash
git diff --check d7f52d8c..HEAD
```

Expected: exit `0`, no output.

```bash
git diff --name-only d7f52d8c..HEAD
```

Expected files only:

```text
CLAUDE.md
docs/architecture/KEY_FILES.md
docs/superpowers/plans/2026-07-28-engine-dynamic-import-reconciliation.md
llms-full.txt
llms.txt
package.json
scripts/check-engine-dynamic-import.sh
scripts/check-engine-dynamic-import.ts
scripts/run-verify-parallel.sh
src/core/migrate.ts
src/core/pglite-engine.ts
src/core/postgres-engine.ts
test/scripts/check-engine-dynamic-import.test.ts
```

Either generated llms file may be absent if regeneration proves it byte-identical. `VERSION`, `CHANGELOG.md`, and `TODOS.md` must be absent.

- [ ] **Step 7: Review the exact implementation diff**

```bash
git diff --stat d7f52d8c..HEAD && git diff d7f52d8c..HEAD -- src/core/pglite-engine.ts src/core/postgres-engine.ts src/core/migrate.ts scripts/check-engine-dynamic-import.sh test/scripts/check-engine-dynamic-import.test.ts package.json scripts/run-verify-parallel.sh CLAUDE.md docs/architecture/KEY_FILES.md
```

Expected review findings:

- Exactly 13 safe `await import(...)` statements are removed.
- Exactly four `ai/gateway.ts` imports remain, all marked on the same line.
- All four gateway imports remain inside their original local `try/catch` fallback boundaries.
- No accessor logic, fallback ordering, SQL, public signature, or engine parity behavior changes.
- The parser-backed guard reports all violations plus read/parse failures, preserves CRLF line accounting, ignores comments/literals/type-only syntax, detects every runtime `import()` call expression, and accepts opt-outs only from real comment trivia on the same physical line.
- The package script invokes the shell guard through Bash; `check:all` invokes that shell guard directly, and the parallel verify dispatcher invokes the package check.
- Documentation is current-state and makes no deterministic Windows-crash claim.

**Observed Windows verification classification:** The authoritative aggregate completed with 25 of 33 checks passing. Individual reruns showed `check:test-names` and `typecheck` green; privacy/isolation exceeded Windows timing budgets; WASM failed in unrelated temporary-symlink setup; eval-glossary was CRLF/LF drift; resolver/brain-first findings predated and did not intersect this branch. The focused aggregate produced 103 pass / 5 fail: three setup-hook timeouts reproduced at the untouched base, and the known `migrate-retry` polling failure reproduced there. Its additional race-status assertion did not reproduce at base, so it remains an unresolved timing-sensitive limitation in untouched code—not evidence of an in-scope defect and not claimed as conclusively pre-existing.

- [ ] **Step 8: Commit the approved plan document locally**

The plan is an approved, tracked execution artifact and must not be left as an uncommitted file after implementation:

```bash
git add docs/superpowers/plans/2026-07-28-engine-dynamic-import-reconciliation.md
```

```bash
git commit -m "docs: plan engine dynamic-import reconciliation"
```

Expected: one local plan commit; no release metadata staged.

- [ ] **Step 9: Inspect final status without publishing**

```bash
git status --short --branch
```

Expected: branch `claude/kind-meitner-330c90` with a clean working tree. No push, PR, upstream comment, or other external side effect.

- [ ] **Step 10: Capture the completed milestone to memory**

Before writing, search MemPalace wing `gbrain` for this exact reconciliation to avoid duplication. Add a verbatim drawer recording exact base/head commits, the 13 hoists, four gateway opt-outs and rationale, guard/test/docs files, every verification command with exit code, and any environment-owned failures. Add a GBrain project timeline entry only if there is an existing relevant gbrain project page; do not create duplicate release metadata.

- [ ] **Step 11: Report the local result and ask separately before publication**

Report:

- exact local commits;
- changed files;
- test/check exit codes;
- any blocked or pre-existing failures;
- confirmation that release files were untouched;
- confirmation that nothing was pushed or published.

Do not run any publication command. Wait for explicit user approval before any push, PR, or upstream interaction.
