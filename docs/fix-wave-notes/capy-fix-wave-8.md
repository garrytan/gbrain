# Fix wave 8 notes (`capy/fix-wave-8`, v0.60.36.0)

One integrated PR. Eight lanes (A-G, with D split into D1 and D2) were built in
parallel on master v0.60.31.0, merged here, then merged with master v0.60.32.0
(fix wave 7, #5908) before the items that touch fix wave 7's files were built.
Lane H (explicit-cap `no_pricing` guidance and `foresights pricing`) was built on
v0.60.32.0 and merged last. The branch also folds in community PR #5587 and
GBRA-35's `capy/gbra35-defaults-on` (see [its notes](capy-gbra35-defaults-on.md)).

## Headline

MCP-path `search` p50 at 10k brain pages, as shipped (PGLite, no manual
ANALYZE, `bun run test:scale -- --pages 10000 --seed 1`, five runs after a
warmup, same machine and fixture for both arms):

| Build | MCP search p50 | get_health p50 | Import rate ratio (last/first 10%) |
|---|---|---|---|
| v0.60.31.0 (wave 8 base) | 145.5 ms | 1,390 ms | 8.2 |
| v0.60.32.0 (master the wave merged), five runs | 110.5 / 105.3 / 115.6 / 129.8 / 106.0 ms | 1,263-1,279 ms | 7.4-9.7 |
| This branch before the alias-read fix, three runs | 134.9 / 126.3 / 147.8 ms | 1,269-1,439 ms | 7.0-9.7 |
| This branch after the alias-read fix | 104.9 ms | 1,290 ms | 8.1 |
| This branch as shipped (also with the adjacency-read fix), paired with v0.60.32.0 at 106.0 ms | 105.3 ms | 1,275 ms | 6.9 |
| v0.60.35.0 (master after #5932, which adds saved-fact and declared-name work to each MCP search) | 138.3 ms | 1,286 ms | 8.8 |
| This branch merged with v0.60.35.0, as shipped | 141.2 ms | 1,253 ms | 8.3 |

Each row is a separate run of the full harness on the same 4-core machine
(seed 1, five timed runs after a warmup). Runs of the same build vary by up to
25 ms, so "as shipped" means no regression, not a speed-up. The jump from about 106 ms to about 140 ms between v0.60.32.0
and v0.60.35.0 comes from #5932, and wave 8 adds no measurable time on top of it. The three
mid-wave runs showed a real 20-30 ms regression: the #5094 foreign key from
`page_aliases` to `sources` flipped PGLite's statistics-free plan for the alias
read, so every MCP search walked all readable pages (10 ms at 3k pages, 24 ms
at 10k). The alias read now looks the matching aliases up first and reaches
each page by its unique key (`test/search/alias-read-plan.test.ts`).

This wave does not target search latency, and the number confirms it did not
regress it. The scale harness also shows what F4 has to fix: the per-page import
cost of the last 10% of a 10k import is about 8x the first 10% (gate 1.5), and no
hot table has planner statistics after import.

S1 regressions that now pass (each fails on master v0.60.31.0):

| Issue | What used to happen | Regression test |
|---|---|---|
| #5730 | One aborted statement left a pooled Postgres connection inside a transaction, so every later query failed with 25P02 until restart | `test/e2e/postgres-poisoned-connection.test.ts` (direct and PgBouncer) |
| #5842 | `apply-migrations --export-db-only` refused on its own orchestration lease | `test/e2e/export-db-only-own-lease-postgres.test.ts` |
| #5595 (item 1) | The managed write queue wedged on Windows (fsync of a read-only handle, EPERM) | `test/persistence-windows-flush-5595.test.ts` |
| #5475 (parts 2-3) | Every skill-bundle publication, including init's packaged pack, failed on Windows | `test/bundle-files-windows-5475.test.ts`, `test/init-packaged-skills-native.test.ts` |
| #5255 | A managed cycle with `pull: true` failed sync, so remote-tracking sources silently stopped ingesting | `test/managed-cycle-pull-upstream.test.ts`, `test/managed-phase-matrix.test.ts` |
| #5088 | `migrate embeddings` rebuilt the HNSW index before the bulk re-embed (index-first 67.9 s vs load-then-build 16 s on a 4k-vector PGLite probe) | `test/migrate-embeddings-ann-deferred-5088.serial.test.ts`, `test/e2e/migrate-embeddings-ann-build-5088-postgres.test.ts` |
| #5216, #4738 | Migration 150 rewrote the whole `pages` table and a torn TOAST row blocked the upgrade | `test/page-revision-backfill-5216.test.ts`, `test/e2e/page-revision-rollout-5216-postgres.test.ts` |

## Overlap with fix wave 7 (O-CEO-1)

Computed at integration from `git diff --name-only master...origin/capy/fix-wave-7`
and `...origin/capy/fw7-community`: 70 files shared with wave 8, 41 of them
non-generated: `.github/workflows/test.yml`, `docs/guides/repair.md`,
`docs/guides/write-refusals.md`, `package.json`, `plugin/README.md`,
`scripts/e2e-test-map.ts`, `skills/skills.lock.json`, `src/cli.ts`,
`src/commands/{autopilot-fanout,bootstrap,config,hook,serve-http-mcp,sync,upgrade}.ts`,
`src/commands/sync/run.ts`, `src/commands/doctor/{bootstrap-checks,checks/extraction-sync,checks/graph-health,checks/search-eval}.ts`,
`src/core/{cycle,cycle/synthesize,doctor-categories,engine,import-file,pglite-engine,postgres-engine}.ts`,
`src/core/ops/{contract,pages}.ts`,
`src/core/persistence/{activation,coordinator,page-prepare,prepared-maintenance,service,source-lifecycle,sync-prepare}.ts`,
`src/core/repair/{core,registry}.ts`, and three tests
(`fix-wave-5-integration`, `managed-maintenance`, `repair-explicit-only`).

After the master merge, the conflicted files were `config.ts` (lane E's
`persistence.write_wait_ms` re-applied onto wave 7's file-plane refactor),
`activation.ts`, the repair registry and its tests (wave 7's `captured-facts` and
`loop-facts` beside lane G's `orphan-children`), the e2e map, the size ratchets
and four key-files docs. The focused run afterwards covered 244 files (every lane
regression test, every test wave 7 changed, the conflicted tests; 24 of them E2E
on Postgres): all green except `hook-command.serial`, which fails only in the
Capy sandbox.

## Per-issue record

Status values: fixed, hardening, data requested, deferred (TODO), dropped (fixed
in fix wave 7), skipped (owner named), closed as already fixed.

| Issue | Lane | Fix commit | Regression test | Status |
|---|---|---|---|---|
| #5730 | A | da9fafb2e, 993cfbf2f | `test/e2e/postgres-poisoned-connection.test.ts`, `test/e2e/token-usage-skip-locked.test.ts`, `test/backfill-base.test.ts` | fixed |
| #5842 | A | 593816220, eb4dc7744 | `test/e2e/export-db-only-own-lease-postgres.test.ts` | fixed |
| #5233 | A | eb809b0f2 | `test/e2e/persistence-idle-pool.test.ts`, `test/persistence-consumer-log.test.ts` | fixed |
| #5801 | A | 184646b8d, 3cb95172c | `test/e2e/postgres-checkout-observer.test.ts`, `test/persistence-consumer-log.test.ts` | hardening (instrumentation) + data requested |
| #4732 | A | a926bcce0 | `test/get-health-embedding-column.test.ts`, `test/e2e/get-health-embedding-column-postgres.test.ts` | hardening (diagnostic) + data requested |
| #5205 | A | 023c8bb9b, fde6e11d4 | `test/pool-diagnostics-fix-commands.test.ts`, `test/serve-stdio-lifecycle.test.ts` | fixed (guidance) |
| #4817 | A | dae21ecd4 | `test/serve-http-mcp-dispatch-context.serial.test.ts` | hardening + data requested |
| #5255 | B | fc9a100df, 21137ae09 | `test/managed-cycle-pull-upstream.test.ts`, `test/managed-phase-matrix.test.ts` | fixed |
| #5176 | B | fc9a100df | `test/managed-cycle-pull-upstream.test.ts` | fixed (short half); coordinated ff-only refresh moved to Foundations 1 (F0) |
| #5566 | B | c34dcff55 | `test/managed-sync-chunker-version.test.ts` | fixed |
| #5206 | B | fda586152 | `test/activation-missing-source-path.test.ts` | fixed |
| #5362 | B + integrator | 17e0b6f2d, afe0cc596 | `test/facts-absorb-write-refusal.test.ts`, `test/facts-absorb-log.test.ts` | fixed (codes, no retry, bound-root precheck before inference) |
| #5219 | B | 83a05825e | `test/source-retire-missing-checkout.test.ts` | fixed |
| #5279 | integrator (AFTER-FW7) | 09b401aa2 | `test/filesystem-guard-names-root-5279.test.ts` | fixed (residual: guard detail names root, source, evidence) |
| #5341 | B | (fix wave 7) | | dropped (fixed in fix wave 7) |
| #5186, #5799, #5606, #5808 | B | | | skipped (fw7 community PRs #5371, #5796); #5808 doctor check is a TODO |
| #5595 | C | 5c40fd812, e5e290005, 0480ab3bc; integrator 07e03dc23 | `test/persistence-windows-flush-5595.test.ts`, `test/fs-durable.test.ts`, `test/scripts/durable-flush-guard.test.ts`, `test/binary-self-update-durable-download.test.ts` | fixed (self-upgrade download migrated after fix wave 7; guard allowlist now empty) |
| #5475 | C | 5c40fd812, e9119c2d3 | `test/bundle-files-windows-5475.test.ts`, `test/init-packaged-skills-native.test.ts` | fixed |
| (no issue) `auth local-writer register --dry-run` | C | 14336e756 | `test/auth-local-writer-dry-run.test.ts` | fixed |
| #5886 | D1 | 15d499bc7 | `test/takes-supersede-pointer.test.ts` | fixed; repair of older chains is a TODO |
| #5885, #5188 | D1 | f7cb66c98 | `test/takes-vector-lifecycle-5885.serial.test.ts`, `test/takes-engine.test.ts`, `test/embedding-recovery.serial.test.ts` | fixed |
| #5527 | D1 | 05a7f504d | `test/embed-null-signature-warning-5527.serial.test.ts` | fixed |
| #5822 | D1 | accf339a3 | `test/content-sanity-gbrain-fences-5822.test.ts` | fixed |
| #5884 | D1 | b2e9751d2 | `test/managed-maintenance.test.ts` | fixed |
| #5094 | D1 | 58c3051b7, 48b1722c5 | `test/alias-source-cascade-5094.test.ts` | fixed (migration v191) |
| #5883 | D1 | ff99ffa1a | `test/engine-sql-timeline-tiebreak.test.ts` | fixed |
| #5158 | D1 | ae3fa2d37 | `test/import-frontmatter-key-order-5158.test.ts` | fixed |
| #5876 | D1 | e8e4f7a90 | `test/auto-chronicle-no-effect-5876.test.ts` | fixed (honest half); restoring the trigger moved to Foundations 1 (TODO) |
| #5831 | integrator (AFTER-FW7) | 8a03e4be8, ef6b28574 | `test/facts-eligibility.test.ts`, `test/facts-recall-audit-rows.test.ts`, `test/doctor-atom-facts-5831.test.ts` | fixed |
| #5879 | D2 | 8905ca86b | `test/doctor-schema-pack-checks.test.ts`, `test/schema-pack-type-conformance.test.ts` | fixed |
| #5881 | D2 | aa0d7fa7b | `test/gbrain-owned-page-types.test.ts` | fixed |
| #5626 | D2 | ab40b5e3d | `test/lint-page-type-vocabulary.test.ts` | fixed |
| #5880 | D2 | 094d3e680 | `test/put-page-type-warning.test.ts` | fixed (warn); managed retype is a TODO |
| #5828 | D2 | d35a2169a | `test/brain-score-timeline-grading.test.ts` | fixed |
| #5432 | D2 | 8905ca86b, 4df9e0269 | `test/doctor-not-verified-5432.test.ts` | fixed; quote-presence check is a TODO |
| #5012 | D2 + integrator | db832b5c3, b52fbd939 | `test/sync-connector-partial-exit.test.ts`, `test/github-source-materialize.test.ts`, `test/google-oauth-doctor.test.ts` | fixed (connector partials exit 1 with the real reason; doctor no longer calls an unprobed refresh token healthy). The `apply-migrations` exit and `jobs smoke` parts of the issue were not in this wave's triage |
| #4419 | D2 | 8aa8ba751 | `test/dream-conversation-pages.test.ts` | fixed (on by default with a corpus dir) |
| #5882 | integrator (AFTER-FW7) | ab5ed1672, 7b6e87bd8 | `test/link-inference-pack.test.ts` | fixed |
| #5232 | E + integrator | d8e39fb75, cbcfab691, c27421c31; 3b2320e1f | `test/pending-write-exit.serial.test.ts`, `test/pending-write-exit-owner.serial.test.ts`, `test/thin-client-write-errors.serial.test.ts`, `test/persistence-connector-recovery.test.ts` | fixed (connector recovery honors the configured wait) |
| #5249 | E | d5ed54007 | `test/accepted-pending-status.test.ts` | fixed |
| #5616 | E + integrator | b25ed496b, c3b1b2c99, f39b1a9ce; 1feb4038a | `test/edit-page.test.ts`, `test/persistence-consumer-scheduling.test.ts`, `test/ingestion/put-page-write-through.test.ts` | fixed (feature) |
| #5037 | E + integrator | 954d6684a; 4d53c7cf5 | `test/mcp-tool-defs.test.ts` | fixed |
| #5891 | integrator (AFTER-FW7) | 37bb8d79e | `test/orphans-paging-5891.test.ts`, `test/write-contract-conformance.test.ts`, `test/e2e/write-contract-conformance.test.ts` | fixed |
| O-CEO-13 conformance gate | E + integrator | c4f3127a1 | `test/write-contract-conformance.test.ts`, `test/e2e/write-contract-conformance.test.ts` | both lane-F and #5891 cases enabled |
| #5231 (CLI half), #5893 | F + integrator | 32621e183, 90d618cc8, 50984ea99; 07b1ba9aa | `test/auth-rescope-token.serial.test.ts`, `test/e2e/auth-rescope-token.test.ts`, `test/harness-rotation-grants.serial.test.ts`, `test/recall-federated-search-scope.test.ts` | fixed (recall facts arms use the federated scope) |
| #5878 | F | baf4abe31 | `test/harness-skills-epoch.test.ts` | fixed |
| #5042 | F | 52ac5e8bb | `test/resolve-ipc-source-keyed.test.ts` | fixed |
| #4768 | F | 9d64aa078 | `test/serve-stdio-read-only.test.ts` | fixed (stdio half); issue retitled |
| #5181 | G | 9cb30a2d9 | `test/e2e/reindex-auto-workers-5181.test.ts` | fixed |
| #5297 | G | 9c4b8846e | `test/root-registry-idle-chmod-5297.test.ts` | fixed (chmod leftover); closed as already fixed for the main bug |
| #5154 | G | 0a37ed8eb | `test/list-pages-columns-5154.test.ts` | hardening + data requested |
| #5821 | G | e9e70b840 | `test/doctor-timeline-history-cursor-5821.test.ts` | fixed |
| #4578 | G | 5e7cff18d, 11f147c12, 3f68931e2 | `test/autopilot-global-maintenance-resume-4578.test.ts` | fixed |
| #5088 | G | a66fbdbcf, cc9a872d0 | `test/migrate-embeddings-ann-deferred-5088.serial.test.ts`, `test/e2e/migrate-embeddings-ann-build-5088-postgres.test.ts` | fixed (takes join the deferred worklist at integration) |
| #5216, #4738 | G + integrator | 61ae59fe5, 70afd929a, 592c48f1a, ca6a21f95; cc7c9956a | `test/page-revision-backfill-5216.test.ts`, `test/e2e/page-revision-rollout-5216-postgres.test.ts`, `test/pg-access-storage-corrupt-5216.test.ts`, `test/revision-backfill-pending-request-error.test.ts` | fixed |
| `no_pricing` under an explicit cap; `foresights pricing set/list/unset` | H | 181ac34fa, fec4875a8, 4e126ce5e, b078f584d, 81631b879 | `test/budget/no-pricing-registration.test.ts`, `test/extract-atoms-explicit-cap-no-pricing.test.ts`, `test/extract-atoms-embed-cost-gate.test.ts` | fixed (product change approved) |
| (no issue) PGLite generic-plan stall: the sixth and later searches in a process took ~7 s at 2k pages | integrator | 9aa88eb31 | `test/search/adjacency-generic-plan.test.ts` | fixed (found while measuring the headline metric) |
| #5587 (community PR) | integrator | 658d6109e | skill tests, `scripts/check-plugin-tree.sh` | absorbed; close as superseded |
| #5856 follow-up (GBRA-35) | GBRA-35 | 7530e1d4a | `test/connector-atom-pages.test.ts`, `test/autopilot-auto-drain-dispatch.test.ts`, `test/managed-connector-job-contract.test.ts` | fixed (connector atoms on by default) |
| #5349 (X11) | | | | skipped (GBRA-35) |
| #5203 residual `jobs requeue-facts` (X12) | | | | skipped (GBRA-35) |
| #5203, #5217, #5204, #5127, #5006, #5414, #5250, #5218, #5420 | | see below | | closed as already fixed |
| #3783, #5848, #4951, #5547 | | | | data requested |
| #5406 | | | | reporter asked to confirm on v0.60.31.0+ |
| #4612 | | | | deferred (TODO) |

## Already fixed on master (close-out evidence)

| Issue | Fixing change | Evidence |
|---|---|---|
| #5203 | 6040075c6 (#5381, v0.54.1.0), f8d1e3936 (#5747, v0.60.11.0) | `extract_facts` is a coordinated writer (`src/core/cycle/phase-table.ts`); `test/managed-facts-backstop.test.ts`, `test/managed-facts-writers.test.ts`. Residual `jobs requeue-facts` is GBRA-35's |
| #5217 | 6040075c6 (#5381, v0.54.1.0), f8d1e3936 (#5747) | consolidate runs the managed maintenance preflight; `test/managed-maintenance.test.ts` |
| #5204 | f8d1e3936 (#5747, v0.60.11.0) | bootstrap verify purges probes through the coordinator; `test/bootstrap-verify.serial.test.ts` |
| #5127 | 7ef5165b4 (#5194, v0.60.15.0) | People 400 on an expired sync token maps to `GoogleCursorExpiredError`; `test/google-clients.test.ts` |
| #5006 | 1fc8b6c2d (#5026, v0.49.0.0) | an `agent` grant with no bindings is refused (`delegated_tools_missing`); `test/client-grants.test.ts` |
| #5414 | db56c778e (#5412, v0.56.2.0) | restore flushes through a writable handle; `test/backup-portability-native.serial.test.ts` |
| #5250 | 5fffbe5b9 (#5658, v0.59.10.0) | stdio startup warns for `GBRAIN_SOURCE=__all__`; `test/mcp-stdio-source-preflight.test.ts` |
| #5218 | 5fffbe5b9 (#5658), f8d1e3936 (#5747), 3e60b2439 (#5792, v0.60.20.0) | restamp-only chunks are counted and processed apart from embed work; `test/embed-stale-dry-run-restamp-5289.serial.test.ts` (same root cause as #5289/#5226) |
| #5297 | 6e1e82628 (#5689, v0.60.5.0), 608a174dc (#5684, v0.60.10.0); chmod leftover 9c4b8846e (this wave) | idle refresh bounded; `test/root-registry-idle-chmod-5297.test.ts` |
| #5420 | f8d1e3936 (#5747, v0.60.11.0) | no managed bulk writer is refused any more; `test/managed-unsupported-preflight.serial.test.ts`. Residual tracked in #5867 |

## Gate

Final `bun run ci:ubicloud` on the release tree (run 2026-10-03T04-47-35-733Z,
four standard-16 VMs, 7 m 34 s): gitleaks 1/1, verify 1/1, unit 2,336/2,336,
serial 401/401, slow 26/26, E2E 388/388 (every E2E file on Postgres, the backend
matrix also through transaction-mode PgBouncer). Lane A's Postgres E2E ran in
full, including `postgres-poisoned-connection` (6/6 direct and 6/6 through
PgBouncer). The Windows regressions run in the `windows-latest` unit step of
`.github/workflows/test.yml` on the PR.

Earlier full runs on this branch found and fixed: takes joining the deferred ANN
worklist (lanes D1 x G), a conformance test racing the consumer's worktree lock,
a source-read ratchet, the alias-read plan regression above, an over-broad first
fix for the adjacency stall (it slowed the 10k-page delete benchmark), and two
order dependencies in fix wave 7's tests (`minions-authority-parity` leaving a
job behind; `managed-connector-job-contract` `cycle_extract` racing its own
queued `loops_extract`). Known flake seen once: `secret-scan-credential-shapes`
CRLF (passed on every later run).

Wave security scan (`bun run wave-security-scan origin/master..HEAD`, 136
commits): gitleaks 0 findings with the test/skills allowlist stripped, no
`admin/dist` change, no new outbound hosts. The four obfuscation alarms are
benign: the generated flag registry's `'eval'` command key and the vendored
Postgres driver's `String.fromCharCode(c.status)` that names the ReadyForQuery
status byte for the #5730 poisoned-connection callback. New spawns: `git` via
`execFileSync` in `src/core/sync-upstream.ts` (upstream observation, #5255).
Dependency change: `package.json` version and two scripts only.

## Measured cold-home time to first readback (O-DX-11)

Not measured in this wave; the keyless quickstart work is a Foundations 1 item.
