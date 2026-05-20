# Testing

Test layout, harnesses, fixtures, and the categories that make up gbrain's regression net. Read before adding a new test or running CI locally.


### Test command tiers (v0.26.4 — parallel fast loop)

Five tiers of test commands, each with a clear scope:

| Command | What it runs | Wallclock | When to use |
|---|---|---|---|
| `bun run test` | Parallel unit-test fast loop. 8-shard fan-out via `scripts/run-unit-parallel.sh`, then a serial pass over `*.serial.test.ts`. Excludes `*.slow.test.ts` and `test/e2e/*`. No pre-checks, no typecheck. | ~85s on a Mac dev box (3650+ tests) | Inner edit loop. Default. |
| `bun run verify` | CI's authoritative pre-test gate set: `check:privacy && check:jsonb && check:progress && check:wasm && bun run typecheck`. The 4 checks `.github/workflows/test.yml` runs on shard 1 + typecheck. Single source of truth — CI literally calls `bun run verify`. | ~12s (wasm-compile dominates) | Before pushing; before `/ship`. |
| `bun run test:full` | `verify && bun run test && bun run test:slow && [smart e2e]`. The local equivalent of "everything CI runs." Smart e2e: runs e2e only when `DATABASE_URL` is set; else loud skip notice to stderr. | ~3-5min depending on slow + e2e | Pre-merge sanity, before opening a PR. |
| `bun run test:slow` | Just the `*.slow.test.ts` set (intentional cold-path correctness checks). | seconds-to-minutes | When touching slow-path code. |
| `bun run test:serial` | Just the `*.serial.test.ts` set (cross-file-contention quarantine; runs at `--max-concurrency=1`). | ~1s per quarantined file | Debugging a specific quarantined file. |
| `bun run test:e2e` | Real Postgres E2E. Requires Docker + `DATABASE_URL`. Sequential (template-DB parallelization is a v0.27+ TODO). | ~5-10min | Pre-ship; nightly. |
| `bun run check:all` | All 7 historical pre-checks (privacy + jsonb + progress + no-legacy-getconnection + trailing-newline + wasm + exports-count). Superset of `verify`. | ~10s | Local-only sweep. The 4 not in `verify` are nice-to-haves. |

### CI vs local: intentionally divergent file sets

- **CI matrix** (`.github/workflows/test.yml`) runs `scripts/test-shard.sh` 4-way, which uses FNV-1a hash bucketing and INCLUDES `*.slow.test.ts`. As of v0.31.4.1, CI EXCLUDES `*.serial.test.ts` from the hash buckets and runs them on shard 1 via `bun run test:serial` at `--max-concurrency=1`. Before that, serial files were hashed in alongside parallel files, which broke the `mock.module` quarantine (top-level mocks in serial files leaked into the parallel files they shared a shard process with — most visibly, `eval-takes-quality-runner.serial.test.ts` stubbed `gateway.ts` and broke every `gateway.embedMultimodal` test in `voyage-multimodal.test.ts` on shard 2). CI is the ground truth for "did everything pass."
- **Local fast loop** (`scripts/run-unit-shard.sh` via the parallel wrapper) uses round-robin-by-index sharding and EXCLUDES `*.slow.test.ts` AND `*.serial.test.ts`. Local trades coverage for inner-loop speed; CI catches what local skips.

This divergence is intentional. Don't try to make them equal — the two scripts deliberately solve different problems. The regression test at `test/scripts/run-unit-shard.test.ts` pins what the local fast loop should and shouldn't include.

### Failure-first logging

When `bun run test` finds any failure, the wrapper:

1. Writes failure blocks (each prefixed with `--- shard N: <test name> ---`) to `.context/test-failures.log` (workspace-local, gitignored). On systems without a writable `.context/`, falls back to `/tmp/gbrain-test-failures.log`.
2. Prints a loud stderr banner with the absolute log path, plus the last 30 lines of the failure log inlined. Banner survives `| head` / `| tail` / agent-side log truncation.
3. Writes a one-line-per-shard summary to `.context/test-summary.txt` (`shard N/M: pass=X fail=Y skip=Z rc=W`).
4. Exits non-zero. Empty failure log + non-zero exit = infrastructure problem (wedged shard, killed child); the banner says so.

If a shard wedges (per-shard `GBRAIN_TEST_SHARD_TIMEOUT` cap, default 600s), the wrapper writes `--- shard N: WEDGED after ${SHARD_TIMEOUT}s ---` to the failure log, includes the last 50 lines of the shard log, and proceeds with other shards' results.

### File taxonomy

- `*.test.ts` → fast loop (parallel 8-shard fan-out).
- `*.slow.test.ts` → run via `bun run test:slow` only (intentional cold-path tests; would dominate the fast loop's wallclock).
- `*.serial.test.ts` → run via `bun run test:serial` after the parallel pass completes; uses `--max-concurrency=1`. Quarantine for tests that share file-wide state and race when run alongside other files in the same `bun test` process. Currently: `test/brain-registry.serial.test.ts`, `test/reconcile-links.serial.test.ts`, `test/core/cycle.serial.test.ts`, `test/embed.serial.test.ts` (the latter two added in v0.26.7 — they use `mock.module(...)` which leaks across files in the shard process). **Do not put the parallelism back on a serial file unless you've fixed the contention root cause** (it just re-introduces the flake).
- `test/e2e/*.test.ts` → real-Postgres E2E. Skipped when `DATABASE_URL` is unset.

The intra-file parallelism project (turn `bun test` into `bun test --concurrent` after sweeping shared-state contention sites) is sliced across v0.26.7 (foundation), v0.26.8 (env-mutation sweep), and v0.26.9 (PGLite sweep + codemod + measurement). v0.26.4 ships file-level parallelism only.

### Test-isolation lint and helpers (v0.26.7)

The cross-file flake class is enforced statically by `scripts/check-test-isolation.sh`, wired into `bun run verify` and `bun run check:all`. Rules (non-serial unit files only; `*.serial.test.ts` and `test/e2e/*` are skipped):

| Rule | What it bans | Fix |
|---|---|---|
| **R1** | `process.env.X = ...`, bracket assignment, `delete process.env.X`, `Object.assign(process.env, ...)`, `Reflect.set(process.env, ...)` | Use `withEnv()` from `test/helpers/with-env.ts`, OR rename file to `*.serial.test.ts` |
| **R2** | `mock.module(...)` anywhere in the file | Rename file to `*.serial.test.ts` (no DI on production code for testability) |
| **R3** | `new PGLiteEngine(` outside ~50 lines after a `beforeAll(` line | Use the canonical block (below) inside `beforeAll(` |
| **R4** | Files creating `new PGLiteEngine(` without `engine.disconnect(` inside an `afterAll(` block | Add `afterAll(() => engine.disconnect())` |

Files that violated these rules at the v0.26.7 baseline are listed in `scripts/check-test-isolation.allowlist`. **The allow-list MUST shrink over time** — never add new entries. v0.26.8 (env sweep) and v0.26.9 (PGLite sweep) remove entries as files get fixed.

#### Canonical PGLite block (R3 + R4 compliant)

Every test file that needs a PGLite engine should use this exact pattern:

```ts
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});
```

Why this exact shape: `beforeAll` creates a single engine per file (PGLite WASM cold-start + initSchema is ~20s); `beforeEach` truncates user data via `resetPgliteState` ("two orders of magnitude faster" than fresh-engine-per-test); `afterAll` disconnects so the engine doesn't leak across file boundaries within a shard process.

#### `withEnv` pattern (R1 fix)

```ts
import { withEnv } from './helpers/with-env.ts';

test('reads OPENAI_API_KEY', async () => {
  await withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
    expect(loadConfig().openai_key).toBe('sk-test');
  });
});

// Delete a var (override is undefined):
await withEnv({ GBRAIN_HOME: undefined }, fn);

// Multiple keys:
await withEnv({ A: '1', B: '2', C: undefined }, fn);
```

`withEnv` saves the prior value of every key it touches and restores via try/finally — including when the callback throws. **It is cross-test safe but NOT intra-file concurrent-safe.** `process.env` is process-global; two `test.concurrent()` calls in the same file both touching the same key will race. Files using `withEnv` stay outside the future `test.concurrent()` codemod's eligibility filter.

#### When to quarantine instead of fix

Rename to `*.serial.test.ts` when:
- The file uses `mock.module(...)` (R2 — there's no clean fix without changing production code).
- The file is genuinely env-coupled (e.g. `gbrain-home-isolation.test.ts`, `claw-test-cli.test.ts`) — module-load env readers + ESM caching defeat dynamic-import-after-env tricks.
- The file's tests intentionally share state across `it()` boundaries.

Quarantine count cap: 10 (informational). Beyond that, push back on the design.

### Inventory (legacy)

`bun test` runs all tests. After the v0.12.1 release: ~75 unit test files + 8 E2E test files (1412 unit pass, 119 E2E when `DATABASE_URL` is set — skip gracefully otherwise). Unit tests run
without a database. E2E tests skip gracefully when `DATABASE_URL` is not set.

Unit tests: `test/markdown.test.ts` (frontmatter parsing), `test/chunkers/recursive.test.ts`
(chunking), `test/parity.test.ts` (operations contract
parity), `test/cli.test.ts` (CLI structure), `test/config.test.ts` (config redaction),
`test/files.test.ts` (MIME/hash), `test/import-file.test.ts` (import pipeline),
`test/upgrade.test.ts` (schema migrations),
`test/file-migration.test.ts` (file migration), `test/file-resolver.test.ts` (file resolution),
`test/import-resume.test.ts` (import checkpoints), `test/migrate.test.ts` (migration; v8/v9 helper-btree-index SQL structural assertions + 1000-row wall-clock fixtures that guard the O(n²)→O(n log n) fix + v0.13.1 assertions on v12/v13 SQL shape, `sqlFor` + `transaction:false` runner semantics, the `max_stalled DEFAULT 1` regression guard, and v0.22.6.1 v24 `sqlFor.pglite: ''` no-op assertion),
`test/bootstrap.test.ts` (v0.22.6.1 — bootstrap contract: no-op on fresh install, idempotent across two `initSchema()` calls, no-op on modern brain that already has every probed column, full bootstrap path on simulated pre-v0.18 brain, fresh-install regression guard, pre-v0.13 `links` shape coverage),
`test/schema-bootstrap-coverage.test.ts` (v0.22.6.1 CI guard — `REQUIRED_BOOTSTRAP_COVERAGE` lists every forward reference in PGLITE_SCHEMA_SQL; the test fails loudly if `applyForwardReferenceBootstrap` skips one. When you add a column-with-index to the embedded schema blob, you extend both arrays or this guard fails. The pattern that broke gbrain ten times in two years is now structurally prevented. **v0.35.5.0:** test now also parses `src/core/migrate.ts` source text for every `ALTER TABLE ... ADD COLUMN` (top-level `sql:`, `sqlFor.{postgres,pglite}` overrides, AND handler-body `engine.runMigration(N, \`ALTER TABLE ...\`)`), and asserts each (table, column) pair is covered by the bootstrap OR by the schema blob's CREATE TABLE bodies. Catches the column-only forward-reference class (e.g. `sources.archived` shape from v0.26.5, `oauth_clients.source_id` from v0.34.1) that the pre-existing CREATE INDEX parser couldn't see. Pre-existing parser bug fixed in same wave: `parseBaseTableColumns` now strips SQL line + block comments before identifying column names so commented-out lines no longer hide adjacent columns from coverage.),
`test/helpers/schema-diff.ts` + `test/helpers/schema-diff.test.ts` + `test/e2e/schema-drift.test.ts` (v0.26.6 #588 — cross-engine schema parity gate. Helper exports pure `snapshotSchema(query)` / `diffSnapshots(pg, pglite, opts)` / `formatDiffForFailure(diff)` / `isCleanDiff(diff)` over a four-tuple per column (`data_type`, `udt_name`, `is_nullable`, `column_default`). E2E test spins up fresh PGLite + Postgres, runs `engine.initSchema()` on each (bootstrap + schema replay + migrations), snapshots `information_schema.columns`, then diffs. 2-table allowlist (`files`, `file_migration_ledger`) — every other Postgres table must reach PGLite via PGLITE_SCHEMA_SQL or a migration's `sqlFor.pglite` branch. Sentinels for `oauth_clients`, `mcp_request_log`, `access_tokens`, `eval_candidates` give tighter blame messages. Skip-gracefully without `DATABASE_URL`. Wired into `scripts/e2e-test-map.ts` so changes to `src/schema.sql`, `src/core/pglite-schema.ts`, or `src/core/migrate.ts` trigger it. The failure message names every drift with a paste-ready hint pointing at `src/core/pglite-schema.ts`.),
`test/setup-branching.test.ts` (setup flow), `test/slug-validation.test.ts` (slug validation),
`test/storage.test.ts` (storage backends), `test/supabase-admin.test.ts` (Supabase admin),
`test/yaml-lite.test.ts` (YAML parsing), `test/check-update.test.ts` (version check + update CLI),
`test/pglite-engine.test.ts` (PGLite engine, all 40 BrainEngine methods including 11 cases for `addLinksBatch` / `addTimelineEntriesBatch`: empty batch, missing optionals, within-batch dedup via ON CONFLICT, missing-slug rows dropped by JOIN, half-existing batch, batch of 100 + v0.13.1 `connect()` error-wrap assertion (original error nested, #223 link in message, lock released)),
`test/engine-factory.test.ts` (engine factory + dynamic imports),
`test/integrations.test.ts` (recipe parsing, CLI routing, recipe validation),
`test/publish.test.ts` (content stripping, encryption, password generation, HTML output),
`test/backlinks.test.ts` (entity extraction, back-link detection, timeline entry generation),
`test/lint.test.ts` (LLM artifact detection, code fence stripping, frontmatter validation),
`test/report.test.ts` (report format, directory structure),
`test/skills-conformance.test.ts` (skill frontmatter + required sections validation),
`test/resolver.test.ts` (RESOLVER.md coverage, routing validation + v0.20.4 round-trip: every quoted RESOLVER.md trigger must match a frontmatter `triggers:` entry in the target skill, and every `name="<word>"` reference in any SKILL.md must resolve to a declared op in `src/core/operations.ts` or a Minions handler in `PROTECTED_JOB_NAMES`),
`test/search.test.ts` (RRF normalization, compiled truth boost, cosine similarity, dedup key),
`test/sql-ranking.test.ts` (v0.22.0 source-boost helpers: 39 cases covering longest-prefix-match in SQL CASE, detail=high temporal-bypass, three-meta-char LIKE escape (%, _, \\), single-quote SQL-literal doubling, env override parsing for GBRAIN_SOURCE_BOOST + GBRAIN_SEARCH_EXCLUDE, resolveBoostMap / resolveHardExcludes merge semantics),
`test/dedup.test.ts` (source-aware dedup, compiled truth guarantee, layer interactions),
`test/intent.test.ts` (query intent classification: entity/temporal/event/general),
`test/eval.test.ts` (retrieval metrics: precisionAtK, recallAtK, mrr, ndcgAtK, parseQrels),
`test/check-resolvable.test.ts` (resolver reachability, MECE overlap, gap detection, DRY checks + v0.14.1 proximity-based DRY detection + `extractDelegationTargets` coverage — 13 DRY cases),
`test/dry-fix.test.ts` (v0.14.1 auto-fix: three shape-aware expander pure-function tests, five guards — working-tree-dirty, no-git-backup, inside-code-fence, already-delegated within 40 lines, ambiguous-multi-match, block-is-callout — 28 cases),
`test/doctor-fix.test.ts` (v0.14.1 `gbrain doctor --fix` CLI integration: dry-run preview, apply path, JSON output shape — 3 cases),
`test/backoff.test.ts` (load-aware throttling, concurrency limits, active hours),
`test/fail-improve.test.ts` (deterministic/LLM cascade, JSONL logging, test generation, rotation),
`test/transcription.test.ts` (provider detection, format validation, API key errors),
`test/enrichment-service.test.ts` (entity slugification, extraction, tier escalation),
`test/data-research.test.ts` (recipe validation, MRR/ARR extraction, dedup, tracker parsing, HTML stripping),
`test/minions.test.ts` (Minions job queue v7: CRUD, state machine, backoff, stall detection, dependencies, worker lifecycle, lock management, claim mechanics, depth/child-cap, timeouts, cascade kill, idempotency, child_done inbox, attachments, removeOnComplete/Fail + v0.13.1 `max_stalled` clamp/default/plumbing coverage),
`test/extract.test.ts` (link extraction, timeline extraction, frontmatter parsing, directory type inference),
`test/extract-db.test.ts` (gbrain extract --source db: typed link inference, idempotency, --type filter, --dry-run JSON output),
`test/extract-fs.test.ts` (gbrain extract --source fs: first-run inserts + second-run reports zero, dry-run dedups candidates across files, second-run perf regression guard — the v0.12.1 N+1 dedup bug),
`test/link-extraction.test.ts` (canonical extractEntityRefs both formats, extractPageLinks dedup, inferLinkType heuristics, parseTimelineEntries date variants, isAutoLinkEnabled config),
`test/graph-query.test.ts` (direction in/out/both, type filter, indented tree output),
`test/features.test.ts` (feature scanning, brain_score calculation, CLI routing, persistence),
`test/file-upload-security.test.ts` (symlink traversal, cwd confinement, slug + filename allowlists, remote vs local trust),
`test/query-sanitization.test.ts` (prompt-injection stripping, output sanitization, structural boundary),
`test/search-limit.test.ts` (clampSearchLimit default/cap behavior across list_pages and get_ingest_log),
`test/repair-jsonb.test.ts` (v0.12.2 JSONB repair: TARGETS list, idempotency, engine-awareness),
`test/migrations-v0_12_2.test.ts` (v0.12.2 orchestrator phases: schema → repair → verify → record),
`test/markdown.test.ts` (splitBody sentinel precedence, horizontal-rule preservation, inferType wiki subtypes),
`test/orphans.test.ts` (v0.12.3 orphans command: detection, pseudo filtering, text/json/count outputs, MCP op),
`test/postgres-engine.test.ts` (v0.12.3 statement_timeout scoping: `sql.begin` + `SET LOCAL` shape, source-level grep guardrail against reintroduced bare `SET statement_timeout`),
`test/sync.test.ts` (sync logic + v0.12.3 regression guard asserting top-level `engine.transaction` is not called),
`test/sync-concurrency.test.ts` (v0.22.13 PR #490: 17 cases covering `autoConcurrency()` thresholds + PGLite-forces-serial + explicit-override clamping, `shouldRunParallel()` Q1 explicit-bypasses-floor contract, and `parseWorkers()` validation that rejects `'0'`/`'-3'`/`'foo'`/`'1.5'`/trailing chars),
`test/sync-parallel.test.ts` (v0.22.13 PR #490: PGLite-routed coverage of the bookmark gate under concurrency request, head-drift gate, vanished-file failure capture, PGLite-stays-serial, and the `gbrain-sync` writer-lock contract — 7 cases),
`test/sync-failures.test.ts` (v0.22.12: 28 cases pinning `classifyErrorCode` regex coverage for all 12 codes against literal production message strings from `markdown.ts:159-244` and `import-file.ts:199, 347, 352, 401`; `summarizeFailuresByCode` sort + pre-classified-honor; `recordSyncFailures` code-field persistence; `acknowledgeSyncFailures` AcknowledgeResult shape + backfill on pre-v0.22.12 entries),
`test/doctor.test.ts` (doctor command + v0.12.3 assertions that `jsonb_integrity` scans the four v0.12.0 write sites and `markdown_body_completeness` is present),
`test/utils.test.ts` (shared SQL utilities + `tryParseEmbedding` null-return and single-warn semantics),
`test/build-llms.test.ts` (llms.txt/llms-full.txt generator: path resolution, idempotence, spec shape, regen-drift guard, content contract, AGENTS.md install-path mirror, size-budget enforcement — 7 cases),
`test/oauth.test.ts` (v0.26.0 OAuth 2.1 provider — 27 cases: register, getClient, `client_credentials` grant exchange, `authorization_code` flow with PKCE challenge / verifier, refresh token rotation, `verifyAccessToken` with both OAuth + legacy `access_tokens` fallback, `revokeToken`, `sweepExpiredTokens`, and a contract test asserting `scope` + `localOnly` annotations are set correctly on all 30 operations; **v0.26.2** adds 5 `coerceTimestamp` unit cases (null/undefined/string/number/throw-on-NaN), NULL-`expires_at`-as-expired contract tests for both refresh + access token paths, and a cascade-delete contract test asserting `revoke-client` purges `oauth_tokens` + `oauth_codes` rows via FK CASCADE; **v0.26.9** adds 14 cases pinning the F1/F2/F3/F4/F5/F6/F7c/F12 invariants, including the F1/F4 cross-client isolation pattern (wrong-client attempt MUST reject AND rightful owner MUST still succeed atomically afterward) and the empty-string `redirect_uri` bypass guard surfaced during adversarial review),
`test/mcp-dispatch-summarize.test.ts` (v0.26.9 — 7 cases pinning F8 `summarizeMcpParams` invariants: declared-keys allow-list intersection, attacker-key-name leak guard (unknown keys counted not named), 1KB byte bucketing for size-probe defense, missing op falls through to fully-redacted shape, declared-keys sorted for deterministic output),
`test/trust-boundary-contract.test.ts` (v0.26.9 — 4 cases pinning F7b fail-closed semantics under cast bypass: `ctx.remote === undefined` treated as remote/untrusted at every flipped call site, `as any` and `Partial<>` spreads can't downgrade trust by accident),
`test/check-resolvable-cli.test.ts` (v0.19 CLI wrapper: exit codes, JSON envelope shape, AGENTS.md fallback chain),
`test/regression-v0_16_4.test.ts` (findRepoRoot regression guard — hermetic startDir parameterization),
`test/repo-root.test.ts` (v0.16.4 / v0.19 / v0.31.7 — 20 cases: `findRepoRoot` walk semantics + default-arg parity, the 4-tier `autoDetectSkillsDir` fallback chain (`$OPENCLAW_WORKSPACE` → `~/.openclaw/workspace` → repo-root → `./skills`), W1 RESOLVER.md/AGENTS.md filename precedence, D-CX-4 explicit-env-wins-over-repo-root, and 8 new v0.31.7 D3+D5 cases pinning tier-0 `$GBRAIN_SKILLS_DIR` valid/invalid/precedence-over-OPENCLAW_WORKSPACE, the install-path walk in `autoDetectSkillsDirReadOnly`, no-drift on primary success, `AUTO_DETECT_HINT` + `AUTO_DETECT_HINT_READ_ONLY` content, and the D5 regression guard asserting the shared `autoDetectSkillsDir` MUST NEVER return `'install_path'` source — that's how the read-path/write-path split stays safe),
`test/resolver-merge.test.ts` (v0.31.7 — 8 cases pinning the multi-file resolver merge: `findAllResolverFiles` empty / RESOLVER.md-only / AGENTS.md-only / both-present (RESOLVER.md first), and `checkResolvable` merge semantics across `skills/RESOLVER.md` + `../AGENTS.md` for the OpenClaw layout where the skillpack ships a thin RESOLVER.md and the real dispatcher lives at the workspace root — dedup by `skillPath` (first occurrence wins), AGENTS.md-at-workspace-root works alone, and the previously-unreachable 187/224 OpenClaw skills become reachable),
`test/filing-audit.test.ts` (v0.19 Check 6: `writes_pages` / `writes_to` frontmatter, filing-rules JSON validation),
`test/skill-brain-first.test.ts` (v0.37.1.0 — 56 cases: shared frontmatter parser, `analyzeSkillBrainFirst` compliance ladder across 9 fixtures under `test/fixtures/brain-first-skills/` (compliant-callout, compliant-phase, compliant-position, exempt-frontmatter, missing-brain-first, multi-pattern, negation-prose, no-external, typo-frontmatter), offset helpers, external-lookup regex shape, audit snapshot+diff transition logic, PR #1206 `FORMERLY_HARDCODED_EXEMPT` regression absorption),
`test/e2e/skill-brain-first.test.ts` (v0.37.1.0 — 12 E2E cases: doctor reports `skill_brain_first` check with structured issues; `--fix --dry-run` previews insertion without writing; `--fix` applies the canonical Convention callout idempotently; `brain_first: exempt` frontmatter resolves the warn; `brain_first_typo` surfaces paste-ready hint; audit JSONL records `detected` / `resolved` / `fixed` transitions; stable brain emits 0 audit lines/run),
`test/routing-eval.test.ts` (v0.19 Check 5: fixture parsing, structural routing, ambiguous_with, Haiku tie-break layer),
`test/skill-manifest.test.ts` (v0.19 skill manifest parser: drift detection, managed-block markers),
`test/skillify-scaffold.test.ts` (v0.19 `gbrain skillify scaffold` stubs: SKILL.md, script, tests, routing-eval fixtures),
`test/skillpack-install.test.ts` (v0.19 `gbrain skillpack install` managed-block install / update / no-clobber semantics),
`test/skillpack-sync-guard.test.ts` (v0.19 sync-guard: bundled skills stay byte-identical to `skills/` source),
`test/http-transport.test.ts` (v0.22.7 HTTP transport: 23 unit cases covering bearer auth + missing/no-Bearer/unknown/revoked + `/health` bypass, F1+F2 round-trip via dispatch.ts, F3 invalid_params, application/json response shape (not SSE), CORS default-deny + allowlist, body cap on Content-Length AND chunked, two-bucket rate limit (refill, exhaust+Retry-After, LRU eviction, TTL prune, pre-auth IP fires before DB), and `mcp_request_log` audit on success + auth_failed),
`test/restart-sweep.test.ts` (v0.28.3 — 27 bun:test cases for the `recipes/restart-sweep.md` inlined script: sentinel-anchored fenced-block extraction with salted tmp filenames to bypass ESM cache; constructor-time env reads (proves no module-load snapshot); idempotency layer load/save/atomic-tmp-rename/corrupt-JSON-recovery/30-day-prune; `(sessionKey, lastAlertedAt)` cooldown gate with 6h threshold (the C1 fix that survives synthesized restartTime); AGGRESSIVE-gate two-state tests; execFile argv shape proving shell metachars in `OPENCLAW_TELEGRAM_GROUP` cannot reach `/bin/sh`; real-`\n`-not-literal alert formatting; `GBRAIN_HOME` state path override),
`test/eval-longmemeval.test.ts` (v0.28.8 LongMemEval harness — 12 hermetic cases with no `DATABASE_URL` and no API keys: PGLite create + reset over runtime-enumerated `pg_tables`, infrastructure-table preservation across resets, JSONL question parsing, retrieval-only and answer-gen modes via stubbed `ThinkLLMClient`, `--limit` cutoff, `--keyword-only` vs hybrid, default `--expansion=off` behavior, perf gate (p50 < 30ms / p99 < 50ms warm reset+import+search on Apple Silicon), `--help` works without a configured brain, fixture round-trip via `test/fixtures/longmemeval-mini.jsonl`),
`test/longmemeval-sanitize.test.ts` (v0.28.8 sanitization parity: 12 cases pinning that `INJECTION_PATTERNS` from `src/core/think/sanitize.ts` is the single source of truth — adding a pattern there must cover both `<take>` framing and `<chat_session>` framing, no per-surface regex drift).

E2E tests (`test/e2e/`): Run against real Postgres+pgvector. Require `DATABASE_URL`.
- `bun run test:e2e` runs Tier 1 (mechanical, all operations, no API keys). Includes 9 dedicated cases for the postgres-engine `addLinksBatch` / `addTimelineEntriesBatch` bind path — postgres-js's `unnest()` binding is structurally different from PGLite's and gets its own coverage.
- `test/e2e/search-quality.test.ts` runs search quality E2E against PGLite (no API keys, in-memory)
- `test/e2e/graph-quality.test.ts` runs the v0.10.3 knowledge graph pipeline (auto-link via put_page, reconciliation, traversePaths) against PGLite in-memory
- `test/e2e/postgres-jsonb.test.ts` — v0.12.2 regression test. Round-trips all 5 JSONB write sites (pages.frontmatter, raw_data.data, ingest_log.pages_updated, files.metadata, page_versions.frontmatter) against real Postgres and asserts `jsonb_typeof='object'` plus `->>'key'` returns the expected scalar. The test that should have caught the original double-encode bug.
- `test/e2e/integrity-batch.test.ts` (v0.22.8) — parity tests for `scanIntegrity`'s batch-load fast path vs sequential. Four cases (dedup, hits, validate, topPages) seed a fixture and assert both paths return identical results. Dedup case uses raw SQL via `getConn().unsafe()` to seed a `(test-source-2, people/alice)` row alongside the default-source row, since `engine.putPage` doesn't take a `source_id`. Pins the codex-caught multi-source overcounting regression.
- `test/e2e/jsonb-roundtrip.test.ts` — v0.12.3 companion regression against the 4 doctor-scanned JSONB sites. Assertion-level overlap with `postgres-jsonb.test.ts` is intentional defense-in-depth: if doctor's scan surface ever drifts from the actual write surface, one of these tests catches it.
- `test/e2e/sync.test.ts` (v0.22.12 — `--skip-failed` failure-loop test, alongside the existing 13 happy-path tests): exercises the full chain — broken file → `performSync` returns `blocked_by_failures` with grouped breakdown → `performSync({skipFailed: true})` advances bookmark and returns `AcknowledgeResult` with code summary → second broken file → second cycle. Saves and restores the user's real `~/.gbrain/sync-failures.jsonl` so the test is hermetic on a developer machine. Asserts bookmark gating, JSONL state, dedup across paths, summary aggregation, and the literal doctor-rendering string format. This is the integration test that proves the v0.22.12 chain holds together — unit tests cover the pure functions in isolation, this covers the integration.
- `test/e2e/upgrade.test.ts` runs check-update E2E against real GitHub API (network required)
- `test/e2e/minions-shell-pglite.test.ts` (v0.20.4) exercises the PGLite `--follow` inline shell-job path (in-memory, no `DATABASE_URL` required) — the path the consolidated minion-orchestrator skill documents for dev use
- `test/e2e/openclaw-reference-compat.test.ts` (v0.19) — exercises `check-resolvable` + `skillpack install` against a minimal AGENTS.md workspace fixture (`test/fixtures/openclaw-reference-minimal/`), regression guard for the 107-skill OpenClaw deployment shape
- `test/e2e/search-swamp.test.ts` (v0.22.0) — reproduces the headline source-swamp case. Seeds a curated `originals/talks/article-outline-fat-code` page against two `wintermute/chat/` pages stuffed with the same multi-word phrase. Asserts the article wins keyword AND vector ranking, that `detail=high` lets the chat swamp re-surface (temporal-query workflow preserved), and that `source_id` passes through the two-stage CTE intact. PGLite in-memory.
- `test/e2e/search-exclude.test.ts` (v0.22.0) — verifies `test/` + `archive/` pages are hidden by default, that `include_slug_prefixes` opts back in, and that caller-supplied `exclude_slug_prefixes` adds to defaults. Both keyword and vector search paths covered.
- `test/e2e/engine-parity.test.ts` (v0.22.0) — Postgres ↔ PGLite top-result and result-set parity for `searchKeyword` + `searchVector`. Codex flagged that Postgres ranks pages then picks best chunk while PGLite returns chunks directly — without parity coverage the source-boost fix could pass on PGLite and fail on Postgres. Skips gracefully when `DATABASE_URL` is unset.
- `test/e2e/postgres-bootstrap.test.ts` (v0.22.6.1) — exercises `PostgresEngine.initSchema()` directly against a fresh real Postgres database. Asserts the bootstrap path is no-op on fresh installs and that SCHEMA_SQL replays cleanly through the engine path (not via the standalone `db.initSchema` from `src/core/db.ts`, which would have produced false-positive coverage). Codex caught the E2E-shape gap during plan review.
- `test/e2e/http-transport.test.ts` (v0.22.7) — 8 cases against real Postgres covering `gbrain serve --http` end-to-end: bearer auth round-trip, `last_used_at` SQL-level debounce semantics, `mcp_request_log` row insertion on success and auth_failed paths, `/health` DB-down → 503 (DB-probing health check), and the F1+F2+F3 dispatch round-trip with a real operation. Skips gracefully when `DATABASE_URL` is unset.
- `test/e2e/serve-http-oauth.test.ts` (v0.26.0, expanded v0.26.2, expanded v0.26.9) — real-Postgres E2E against `gbrain serve --http` with full OAuth 2.1. Spawns a subprocess server, registers a client via the CLI, mints `client_credentials` tokens, exercises the `/mcp` JSON-RPC pipeline. **v0.26.2 adds:** real DCR `/register` HTTP-level response-shape test (asserts `typeof body.client_id_issued_at === 'number'` over the wire — RFC 7591 §3.2.1 spec compliance, not just internal-store shape); real CLI subprocess test for `revoke-client` (registers → mints token → revokes via `execSync` → asserts token rejected at `/mcp` → asserts re-run exits 1); server fixture flips on `--enable-dcr` so `/register` is reachable. **bun execSync env-inheritance fix:** bun's `execSync` does NOT inherit env mutations done via `process.env.X = ...`, only OS-level env from before bun started. helpers.ts loads `.env.testing` and sets `DATABASE_URL` via `process.env` mutation, which is invisible to subprocesses unless `env: { ...process.env }` is passed explicitly — every subprocess call in this file passes `env: { ...process.env }` for that reason. Reference fix for the next maintainer hitting the same failure mode in sibling sync/cycle/dream/claw-test E2Es. `afterAll` cleanup is guarded on `clientId` (won't throw if `beforeAll` failed before registration); cleanup errors surface to stderr without throwing so real test failures aren't masked. Tracks DCR-registered clients alongside the manual one. **v0.26.9** adds 2 regressions for the F7 trust-boundary fix: an HTTP MCP `submit_job` for `name: "shell"` MUST reject with a permission error (proving the request handler now sets `remote: true` and `submit_job`'s protected-name guard fires), and the same guard rejects subagent submission. Closes the OAuth-token-to-RCE escalation path. Skips gracefully when `DATABASE_URL` is unset.
- `test/e2e/sync-parallel.test.ts` (v0.22.13 PR #490) — DATABASE_URL-gated. T2: 60-file Postgres sync at concurrency=4 imports all + no connection leak (probes `pg_stat_activity` before/after to confirm worker engines disconnected). P4: 120-file serial-vs-parallel benchmark prints `SYNC_PARALLEL_BENCH N files | serial=Xms | parallel(4)=Yms | speedup=Zx` for CHANGELOG quoting. Asserts parallel ≤ serial × 1.5 (CI-noise tolerant; not a strict speedup gate).
- `test/e2e/multi-source-bug-class.test.ts` (v0.32.8, PR #860) — 7-case PGLite in-memory regression suite pinning every bug site fixed in this PR: `listAllPageRefs` ordering by `(source_id, slug)` (F11), `getPage` with sourceId picks the right `(source, slug)` row (F2), `extract-takes` processes both overlapping `people/alice` rows independently, `listPages` filters correctly with `PageFilters.sourceId`, `addLinksBatch` with `from/to_source_id` targets the right rows (F4), `validateSourceId` rejects path traversal (F6), reverse-write disk layout uses `brainDir/.sources/<id>/<slug>.md` for non-default sources (F6). No DATABASE_URL needed. Wired into `scripts/e2e-test-map.ts` so changes to extract-takes / patterns / synthesize / embed / extract / migrate-engine auto-trigger this test. Companion: `test/e2e/integrity-batch.test.ts`'s "multi-source duplicate slugs scan once" case was pinning the pre-fix bug — assertion flipped in v0.32.8 to expect both batch + sequential paths report 2.
- `test/e2e/source-isolation-pglite.test.ts` (v0.34.1.0, #861) — 14-case PGLite in-memory regression suite pinning the source-isolation P0 seal at two layers. Engine layer: `searchKeyword` / `searchVector` / `searchKeywordChunks` / `listPages` / `getPage` / `traverseGraph` / `traversePaths` apply `sourceId` (scalar fast path) and `sourceIds` (array path) correctly across both engines. Op-handler layer: routes through `sourceScopeOpts(ctx)` so a `read+write`-scoped OAuth client bound to `--source dept-x` cannot see rows from neighboring sources via `search`, `query`, `list_pages`, `get_page`, or `find_experts`. Covers both `ctx.sourceId` (single-source clients) and `ctx.auth.allowedSources` (federated_read clients) precedence; federated array wins over scalar wins over nothing. No DATABASE_URL needed.
- `test/openai-compat-multimodal.test.ts` (v0.34.1.0, #875) — 11-case unit suite for the gateway's openai-compatible multimodal path: happy-path single + multi-input embedding, unauthenticated proxy mode, dimension-mismatch guard (D12; throws `AIConfigError` with model id + observed + expected pre-storage), default-dim fallback when recipe declares `default_dims`, HTTP 401 / 400 / malformed-JSON / non-array error paths, plus a regression test that the existing Voyage `/multimodalembeddings` recipe still routes through its dedicated path (not the openai-compatible one). Hermetic via the `__setEmbedTransportForTests` seam.
- `test/serve-stdio-lifecycle.test.ts` (extended v0.34.1.0, #870) — adds 3 new cases for the `MCP_STDIO=1` env guard: stdin EOF does NOT trigger shutdown when the env is set, SIGTERM still does (guard scope is correct), unset env preserves the pre-v0.34 CLI lifecycle. Exercises the `ServeOptions.mcpStdio?: boolean` test seam directly so tests don't mutate `process.env`.
- `test/oauth.test.ts` (extended v0.34.1.0, #909) — 5 new cases for the PKCE DCR public-client gate: `registerClient` with `token_endpoint_auth_method: "none"` returns no `client_secret` field on the public client, default `client_secret_post` clients still get the one-time-reveal secret, `getClient` NULL→undefined normalization so the SDK's clientAuth path accepts public clients, full PKCE `/authorize` → `/token` round-trip against a public client (no client_secret presented), and a regression test that the public-vs-confidential branch doesn't break confidential client `client_secret_post` exchange.
- Tier 2 (`skills.test.ts`) requires OpenClaw + API keys, runs nightly in CI
- If `.env.testing` doesn't exist in this directory, check sibling worktrees for one:
  `find ../  -maxdepth 2 -name .env.testing -print -quit` and copy it here if found.
- **Run E2E tests without asking permission.** When you want to verify behavior,
  there's a relevant E2E test, or you're shipping touching anything covered by an
  E2E suite — just spin up the test DB, run the tests, and tear down. Don't ask,
  don't propose it, don't defer. The lifecycle is short (~2-30s startup, sub-minute
  tests, instant teardown) and the gate value is high. Skipping with "DATABASE_URL
  unset" is silent regression, not caution.

### API keys and running ALL tests

ALWAYS source the user's shell profile before running tests:

```bash
source ~/.zshrc 2>/dev/null || true
```

This loads `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Without these, Tier 2 tests
skip silently. Do NOT skip Tier 2 tests just because they require API keys — load
the keys and run them.

When asked to "run all E2E tests" or "run tests", that means ALL tiers:
- Tier 1: `bun run test:e2e` (mechanical, sync, upgrade — no API keys needed)
- Tier 2: `test/e2e/skills.test.ts` (requires OpenAI + Anthropic + openclaw CLI)
- Always spin up the test DB, source zshrc, run everything, tear down.

### E2E test DB lifecycle (ALWAYS follow this)

You are responsible for spinning up and tearing down the test Postgres container.
Do not leave containers running after tests. Do not skip E2E tests, do not ask
permission to run them — see the "run without asking" rule above.

1. **Check for `.env.testing`** — if missing, copy from sibling worktree.
   Read it to get the DATABASE_URL (it has the port number).
2. **Check if the port is free:**
   `docker ps --filter "publish=PORT"` — if another container is on that port,
   pick a different port (try 5435, 5436, 5437) and start on that one instead.
3. **Start the test DB:**
   ```bash
   docker run -d --name gbrain-test-pg \
     -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
     -e POSTGRES_DB=gbrain_test \
     -p PORT:5432 pgvector/pgvector:pg16
   ```
   Wait for ready: `docker exec gbrain-test-pg pg_isready -U postgres`
4. **Bootstrap the schema** (required — fresh containers have no `oauth_clients`,
   `mcp_request_log`, `pages` etc.; tests like `serve-http-oauth.test.ts` will fail
   with `relation "oauth_clients" does not exist` if you skip this):
   ```bash
   DATABASE_URL=postgresql://postgres:postgres@localhost:PORT/gbrain_test \
     bun run src/cli.ts doctor --json > /dev/null 2>&1
   ```
   `gbrain doctor` triggers `initSchema()` on first connect, which is the canonical
   way to bring a fresh DB to head. `apply-migrations --yes` alone does NOT seed
   the base schema — it runs ALTER-style migrations on top of `initSchema`. Tests
   that bypass the engine (raw `execSync`-spawned `auth register-client`) hit the
   schema directly and need this step to have run first.
5. **Run E2E tests:**
   `DATABASE_URL=postgresql://postgres:postgres@localhost:PORT/gbrain_test bun run test:e2e`
6. **Tear down immediately after tests finish (pass or fail):**
   `docker stop gbrain-test-pg && docker rm gbrain-test-pg`

Never leave `gbrain-test-pg` running. If you find a stale one from a previous run,
stop and remove it before starting a new one.

