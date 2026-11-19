# Foundations 1 notes (`capy/foundations-1`, v0.60.37.0)

One integrated PR. Ten lanes (F0, F1a, F1b, F1c, F2, F3, F4a, F4b, F4c, F4d)
were built in parallel on the fix wave 8 collector (`capy/fix-wave-8`), merged
here in the order F1c (with F1a), F1b, F0, F3, F4a, F2, F4d, F4c, F4b, then
merged with master. Migrations were renumbered once at integration: v193
`f1_write_attribution`, v194 `f0_worktree_refreshes`, v195
`f3_access_token_grants`, v196 `f4_planner_stats` (PGLite only). Generated
files (schema blobs, migration registry, CLI flag registry, goldens, llms) were
regenerated, never hand-merged.

## Headline

10,000-page PGLite brain, as shipped with no manual ANALYZE
(`bun run test:scale -- --pages 10000 --seed 1`). Each cell is the median of
per-run p50s (five timed runs after a warmup in each harness run). All runs
were on one Ubicloud standard-8 VM, with the same fixture for every build:
five interleaved runs each for the last two columns and two runs for the
first.

| Metric | Fix wave 8 without #5932 | Fix wave 8 + #5932's ANALYZE fix (ad7252a) | Foundations 1 |
| --- | --- | --- | --- |
| `get_health` (memo off) | 12,073 ms | 208 ms | 158 ms |
| `find_orphans` | 14,989 ms | 43.5 ms | 34.3 ms |
| Keyword search scoped to one source | 38,645 ms | 18.2 ms | 22.1 ms |
| MCP search (headline) | 118 ms | 41.4 ms | 42.5 ms |
| `query` with injected vector (hybrid) | 306 ms | 375 ms | 26.3 ms |
| Import of 10,000 files | 119 s | 99 s | 62 s |
| Import rate ratio (last/first 10%) | 1.74 | 0.85 | 0.84 |
| Enforced gates | n/a (report-only build) | `planner_stats` fails | all pass |

Most of the drop from fix wave 8 comes from GBRA-39's full ANALYZE after bulk
writes (#5932, on master since v0.60.35.0; F4b carried it as the cherry-pick f1970519, which the master merge reconciles). Foundations adds what
keeps statistics fresh between syncs: import time falls from 99 s to 62 s, and
the hybrid query from 375 ms to 26 ms, because the vector arm uses its HNSW
index once statistics see the injected embeddings. Keyword search scoped to
one source moved from 18.2 to 22.1 ms; the run ranges overlap (17.4-19.4 vs
18.7-25.0 ms).

Two harness fixes came out of the enforced runs:

- With statistics, PGLite plans the vector arm on HNSW, and the fixture's
  two-hot vectors (almost every pair at the same distance) gave HNSW nothing
  to navigate. On one kept 10k brain the injected-vector probe found its page
  in 2 to 5 of 10 probes per index build, across 6 rebuilds, and one enforced
  run failed its hybrid known answer. Seeded dense vectors in 16 dimensions
  found 30 of 30 on each of 6 rebuilds (421836c2).
- `get_health` is timed with its memo off (fb7f3657); with the memo on, repeat
  calls return in about 0.3 ms and say nothing about the computation.

## Items

| Item | What shipped | Commits | Tests |
| --- | --- | --- | --- |
| F0 | `foresights sources refresh <id>`: drained worktree-wide ff-only refresh with a durable checkpoint, admission fence (`worktree_refreshing`), restart recovery, doctor `worktree_refresh_stuck` | 9aff60d3 d4d112f2 f1236021 e0e5da3e f6687f66 e79cb322 6350d022 33ab99d6 5456bf10 2e020343 a689d909 37d274af; integration 9a128ddd | `test/persistence-worktree-refresh.test.ts`, `test/persistence-worktree-refresh-restart.test.ts`, `test/e2e/worktree-refresh-postgres.test.ts` |
| F1a | Creation attribution columns and BEFORE ROW triggers on pages, page versions, facts, takes and timeline entries; `withCoordinatedWrite` requires an attribution | 9a1b55a1 5a10097c 3f906834 15b942f5 f0b4863d 716407a4 e31618ac 7b7199ee | `test/write-attribution.test.ts`, `test/e2e/write-attribution-postgres.test.ts` |
| F1b | `get_write_attribution` / `foresights attribution`, `get_versions` `written_by`/`archived_by` for trusted and admin callers, `foresights repair attribution-backfill` | d0bbecfc 3eb948d3 b05ec9ae 8f1bc288 311ccdcf 3e9b826b 4cb56ad2; integration 6cad517b (test-only column helper dropped) | `test/write-attribution-read.test.ts`, `test/e2e/write-attribution-read-parity.test.ts`, repair kind lists in `test/fix-wave-3-integration.test.ts`, `test/fix-wave-4-integration.test.ts`, `test/repair-command.test.ts` |
| F1c | Unmanaged legacy writers (direct imports, `extract_facts` reconcile, `extract-takes`, stale-atom retirement) carry the maintenance principal; pinned attributed and unattributed writer lists | 0d3efb10 23fdce0f | `test/write-attribution-legacy.test.ts` |
| F2 | Seat sidecar on session capture, stamped into dream-synthesized frontmatter; `bootstrap --seat/--no-seat`, `GBRAIN_SEAT=off` opt-out (#4618) | d9d97e8d e19c78d9 99b4e4f9 871cad5e 8daf0456 | `test/session-seat-capture.serial.test.ts`, `test/session-seat-synthesize.test.ts`, `test/transcript-discovery-seat.test.ts`, `test/bootstrap-seat.serial.test.ts`, `test/e2e/session-seat-synthesize.test.ts` |
| F3 | Unified grant columns for legacy tokens with lazy migration, one `foresights auth rescope` for tokens and clients, `--migrate-legacy`, doctor `legacy_token_grant_shape` and `legacy_token_grant_drift` | 05c507f8 fa2601d3 6540b458 02bdc04b c31ef930 ec681332 9bcebb49 32f8ec09 | `test/access-token-grants.test.ts`, `test/auth-rescope-unified.serial.test.ts`, `test/e2e/access-token-grants.test.ts` |
| F4a | `get_health` in three SQL statements for both engines, shared orphan exclusion SQL, scoped memo with `computed_at` | 5976a6f0 fe286548 1424edf5 c3dd9c69 3d30b4c5 7a0bfbe8; integration 5f606673 (config key) | `test/engine-sql-health-equality.test.ts`, `test/orphan-policy-sql-parity.test.ts`, `test/health-memo.test.ts`, `test/e2e/engine-sql-health-parity.test.ts`, `test/brain-score-timeline-grading.test.ts` (#5828 grading kept) |
| F4b | PGLite transactional planner-stats accounting, row-delta ANALYZE (import, sync, cycle, idle, first read), doctor `planner_stats_stale`, repair `planner-stats`; carries #5932's ad7252a | f1970519 (cherry-pick) fd23e871 db13caf7; integration 2b985cb8 902f462e | `test/planner-stats.test.ts`, `test/planner-stats-catalog.test.ts`, `test/planner-stats-restart.serial.test.ts`, `test/planner-stats-import.slow.test.ts`, `test/declared-lineage-visibility.test.ts`, `test/e2e/planner-stats-postgres.test.ts` |
| F4c | CI scale tier: harness, gates, trend, nightly workflow; planner health and budgets phase enforced, PGLite budgets calibrated | 05c39c21 24ecac22 934a65cd 3e161719 dcb72da0 8ec8d046 22241075 07fe8c41; integration a704696c 421836c2 fb7f3657 54b6a890 | `test/scripts/scale-gates.test.ts`, `test/scripts/scale-harness.slow.test.ts`, `test/scripts/scale-trend.test.ts`, `test/scripts/scale-fixture.test.ts` |
| F4d | Large-brain ceilings: progress-aware sync deadline, `sources add` on a 20k-file checkout, loud `embed --stale` budget stop (exit 11), doctor embeddings backlog, serve boot no-progress window | 120fcfe2 6e0c6169 f3e11973 80ca07a6 53314706 5c1057c0 9fc2e201 94226d1f 2c9241cf | `test/large-brain-ceilings.serial.test.ts`, `test/doctor-embedding-backlog.test.ts`, `test/sync-hard-deadline.test.ts`, `test/process-watchdog.serial.test.ts`, `test/serve-stdio-lifecycle.test.ts`, `test/embed.serial.test.ts` |

Integration-only fixes: the F0 refresh test passes an attribution to
`withCoordinatedWrite` (9a128ddd); `core-persistence.md` split under the 60 KB
key-files cap (49303357); the reindex perf fixture classifies a bare `ANALYZE`
as statistics (from #5932's 77dcf414, in 902f462e). The first GitHub scale-tier run crashed because its corpus lives under the repository's ignored `.context/`, which `foresights import` listed as empty; import now walks an explicitly named ignored directory, and the harness validates a reused corpus file by file and refuses an empty or partly listed one with a named fix.

## Gates

- `bun run typecheck`, `bun run verify` (67 checks).
- `bun run ci:ubicloud`: gitleaks, unit, slow, serial, E2E (Postgres and
  PgBouncer), verify; all green at every integration push.
- OpenClaw native context-engine startup test against pgvector pg16
  (`test/openclaw-context-engine-native.serial.test.ts`, openclaw 2026.9.4),
  run locally because the Ubicloud gate does not include it.
- Enforced scale tier at 10k PGLite pages: 5 of 5 runs pass every enforced gate.
- gstack credential pre-push guard on every push: no HIGH findings.

Wave security scan (`bun run wave-security-scan origin/capy/fix-wave-8..HEAD`,
before the master merge): gitleaks 0 findings with the test/skills allowlist
stripped, no `admin/dist` change, no dependency change. The one obfuscation
alarm is benign: `test/write-attribution-legacy.test.ts` decodes a base64 PNG
fixture. The one "new" outbound URL is an existing link
(oven-sh/bun#30305) on a rewritten key-files line. New spawns are the scale
harness's own `foresights import` and cold-query children and `gh` in
`scripts/scale/trend.ts`.
