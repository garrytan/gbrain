# Lane-move pilot evidence (slice: 20 PGLite-only test/e2e files)

Base: collector branch `test-reduction-wave` at faf4e0f. BEFORE run `2026-09-29T05-13-41-018Z-faf4e0fa`, AFTER run `2026-09-29T05-26-52-078Z-faf4e0fa` (same config: 10 x standard-16, 8 slots, all lanes).

## Selection (move criterion)

Ranked by `scripts/e2e-weights.json` over `docs/test-audit/2026-09-29/lane-e2e/pglite-files.txt`. Skipped: `sync-delegation-under-serve.serial` and `dream-synthesize-pglite` (named e2e.yml tier1 steps, E2E_EXCLUSIONS); `v030_1-integration-pglite` and `v0_30_3-fix-wave` were already deleted by earlier slices. Every file: constructs PGLite or spawns a PGLite CLI directly, no `test/e2e/helpers` import, no DATABASE_URL/hasDatabase skip gate (they only scrub the URL for children), header read.

## Per-file table

| Former path | New path | Lane | GitHub e2e weight (s) | ubicloud BEFORE e2e (s) | ubicloud AFTER new lane (s) | local new lane (s) | executed pass/skip (e2e = new) |
|---|---|---|---:|---:|---:|---:|---|
| `test/e2e/claw-test.test.ts` | `test/claw-test.slow.test.ts` | slow | 185.9 | 67.8 | 67.7 | 78.4 | 12/0 |
| `test/e2e/init-fresh-pglite.test.ts` | `test/init-fresh-pglite.slow.test.ts` | slow | 44.5 | 39.0 | 35.6 | 36.4 | 17/0 |
| `test/e2e/mounts-routing-pglite.test.ts` | `test/mounts-routing-pglite.slow.test.ts` | slow | 31.0 | 28.6 | 27.6 | 29.1 | 8/0 |
| `test/e2e/qm-provisioning.test.ts` | `test/qm-provisioning.test.ts` | unit | 28.3 | 26.9 | 25.1 | 27.3 | 11/0 |
| `test/e2e/minions-field-report-repro.test.ts` | `test/minions-field-report-repro.test.ts` | unit | 26.5 | 7.6 | 7.3 | 9.5 | 1/0 |
| `test/e2e/fresh-install-pglite.test.ts` | `test/fresh-install-pglite.serial.test.ts` | serial | 23.4 | 18.5 | 20.6 | 21.7 | 6/0 |
| `test/e2e/remote-privacy-journeys.test.ts` | `test/remote-privacy-journeys.serial.test.ts` | serial | 19.9 | 17.4 | 22.7 | 17.0 (separate run) | 6/0 |
| `test/e2e/serve-stdio-roundtrip.test.ts` | `test/serve-stdio-roundtrip.test.ts` | unit | 19.8 | 17.3 | 22.4 | 17.8 | 9/0 |
| `test/e2e/serve-http-surface-ceiling.test.ts` | `test/serve-http-surface-ceiling.test.ts` | unit | 16.8 | 13.6 | 17.5 | 16.1 | 6/0 |
| `test/e2e/skillpack-flow.test.ts` | `test/skillpack-flow.test.ts` | unit | 13.7 | 10.6 | 10.1 | 11.1 | 17/0 |
| `test/e2e/v0_28_5-fix-wave.test.ts` | `test/v0_28_5-fix-wave.serial.test.ts` | serial | 12.9 | 10.4 | 10.3 | 11.9 | 6/0 |
| `test/e2e/backfill-perf-pglite.test.ts` | `test/backfill-perf-pglite.test.ts` | unit | 10.8 | 9.0 | 9.7 | 10.6 | 1/0 |
| `test/e2e/connect-bearer.test.ts` | `test/connect-bearer.test.ts` | unit | 10.7 | 9.2 | 9.6 | 10.3 | 6/2 |
| `test/e2e/bootstrap-hook-under-serve.serial.test.ts` | `test/bootstrap-hook-under-serve.serial.test.ts` | serial | 9.8 | 10.0 | 8.8 | 10.5 | 6/0 |
| `test/e2e/upgrade-bun-link-arc.serial.test.ts` | `test/upgrade-bun-link-arc.serial.test.ts` | serial | 9.2 | 7.6 | 8.2 | 9.5 | 5/0 |
| `test/e2e/dream-synthesize-chunking.test.ts` | `test/dream-synthesize-chunking.serial.test.ts` | serial | 9.1 | 8.8 | 8.9 | 8.9 | 10/0 |
| `test/e2e/search-readiness-http.test.ts` | `test/search-readiness-http.test.ts` | unit | 8.7 | 6.9 | 7.4 | 8.1 | 2/0 |
| `test/e2e/transcripts-ingest-pglite.test.ts` | `test/transcripts-ingest-pglite.test.ts` | unit | 8.6 | 6.6 | 6.5 | 8.9 | 27/0 |
| `test/e2e/bootstrap-harness-lifecycle.serial.test.ts` | `test/bootstrap-harness-lifecycle.serial.test.ts` | serial | 8.3 | 6.9 | 7.1 | 8.1 | 5/0 |
| `test/e2e/fact-backfill-resident.test.ts` | `test/fact-backfill-resident.test.ts` | unit | 7.8 | 7.4 | 6.6 | 7.0 | 7/0 |
| **total** | | | 505.5 | 329.7 | 340.1 | | |

## Lane deltas (ci:ubicloud summary.json)

| Lane | BEFORE files | BEFORE compute (s) | AFTER files | AFTER compute (s) | Delta compute (s) | BEFORE lane finished (s after start) | AFTER lane finished |
|---|---:|---:|---:|---:|---:|---:|---:|
| unit | 1970 | 3347 | 1980 | 3559 | +212 | 217 | 201 |
| serial | 330 | 1873 | 337 | 1976 | +103 | 294 | 227 |
| slow | 21 | 1012 | 24 | 1169 | +157 | 315 | 335 |
| e2e | 304 | 2756 | 284 | 2456 | -300 | 226 | 234 |
| verify | 1 | 43 | 1 | 43 | +0 | 125 | 124 |
| gitleaks | 1 | 5 | 1 | 5 | -0 | 81 | 81 |
| **run** | | 9036 | | 9208 | +172 | wall 317 | wall 337 |

Reading: ci:ubicloud runs ALL E2E in parallel slots, so its wall time is bounded by the slow-lane long poles (export-scale, reconcile-crash, reindex-markdown-persistence) and moved compute does not change wall; +20 s wall is run-to-run noise (export-scale alone went 222 -> 256 s). The E2E lane lost 300 s of compute (-10.9%, 20 files); the moved files cost 330 s in E2E and 340 s in unit/serial/slow, so compute moved rather than shrank. On GitHub, selected-E2E runs sequentially on 4 weighted workers, so removing ~506 s of weighted E2E work is ~126 s per worker on an all-E2E selection; the files now run on every PR instead of only when selected. BEFORE had 1 failure (`test/test-reads-source-smell.test.ts`, stale `distribution-import-boundary` entry left by slice 19, fixed in this slice); AFTER was all green. No moved file failed or flaked in either ci:ubicloud run, the local per-lane runs, or the co-located single-process run below, so none moved back.

## New test (authoring gate)

| Test | Mutation | Result on mutation | Result on real code |
|---|---|---|---|
| `test/scripts/classify-tests.test.ts` > "a dynamic import of src/ beside a non-repo read is behavioral" | `scripts/classify-tests.ts` `isRepoAnchored`: `const code = win;` (drop the `import(...)` specifier strip) | fails (1 of 9) | passes (9 of 9) |

Why: moving `fresh-install-pglite` from `test/e2e/` to `test/` shortened `'../../src/...'` to `'../src/...'`, which the classifier's `REPO_ANCHORS` matched inside a dynamic `import()` next to a tmp-config `readFileSync`, misclassifying a behavioral suite as structural. The fix strips `import('...')` specifiers from the detector window; regenerating `scripts/structural-suites.tsv` then changes only the moved skillpack-flow path and the classifier test's own case count.

## Deletions

None. One stale ratchet entry removed: `test/test-reads-source-smell.test.ts` GRANDFATHERED `'distribution-import-boundary.test.ts': 1` (the test file was deleted in slice 19 commit 0ad8e62; the ratchet's own stale-entry test failed on the BEFORE run).

## Lockstep updates

- `scripts/e2e-test-map.ts`: moved paths removed from every row; 7 source keys whose only E2E owner moved were deleted (claw-test.ts, claw-test/**, brain-resolver.ts, mounts.ts, connect.ts, connect-probe.ts, embed-facts-delegate.ts) and now fail closed to all E2E; `src/mcp/surface.ts` stays covered by `src/mcp/**`.
- `test/fixtures/e2e-unmapped-baseline.txt`: 11 rows removed (137 -> 126); `BASELINE_SEEDED_LENGTH` 143 -> 126 (it carried 6 rows of stale slack).
- `test/select-e2e.test.ts`: dropped the two moved files from the fixture list and the two expected-selection arrays (the map no longer emits them).
- Weights: e2e keys removed from `scripts/e2e-weights.json`; carried to `scripts/test-weights.json` (unit/slow, ms) and `scripts/serial-weights.json` (serial, s); `scripts/ubicloud/weights.json` re-keyed `e2e:` -> `unit:/serial:/slow:` with the AFTER-run measured ms. Metadata files untouched (they describe the mined run).
- `scripts/structural-suites.tsv` regenerated; `.gitleaks.toml`, `scripts/check-privacy.sh`, `scripts/check-test-real-names.sh` path allowlists, two src comments, key-files docs, TODOS.md, and test cross-references updated to the new paths.
- `docs/TESTING.md`: new "Lane-move pilot (2026-09)" table (file -> lane -> command -> reason), stale E2E-inventory mentions updated. Each moved file's header gains a Lane/Run paragraph; assertions unchanged (diff of moved files is only relative paths and comments).

## Commands

| Command | Result |
|---|---|
| per-file lane wrappers (`run-unit-shard.sh` / `run-serial-tests.sh` / `run-slow-tests.sh`) for all 20 files | 20/20 pass, executed counts identical to BEFORE e2e logs |
| `bun test --timeout=60000 --max-concurrency=4` all 13 unit+slow moved files + 4 neighbours in ONE process | 306 pass, 2 skip (connect-bearer's 2, same as e2e), 0 fail, 246 s |
| `bash scripts/check-test-isolation.sh` | OK (after remote-privacy-journeys -> serial for R3) |
| `bun test test/select-e2e.test.ts test/scripts/e2e-wiring.test.ts test/scripts/classify-tests.test.ts test/test-reads-source-smell.test.ts test/scripts/serial-files.test.ts` | 72 pass, 0 fail |
| `bun run check:test-placeholders` | OK (2626 files, 6 allowlisted) |
| `bun test test/test-reads-source-smell.test.ts` | 12 pass (was 11/1 before the stale-entry fix) |
| `bun scripts/classify-tests.ts` + `scripts/check-structural-manifest.sh` | fresh |
| `bun run check:orphan-modules` | OK (1444 modules, 4 allowlisted, 20 permitted test-only) |
| `bun run verify` | 56/56 green |
| `bun run ci:ubicloud` BEFORE (clean tree) | 2626/2627; 1 pre-existing failure (source-smell stale entry) |
| `bun run ci:ubicloud` AFTER | 2627/2627 green, wall 337 s |
