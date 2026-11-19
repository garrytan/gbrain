# Foundations 2 notes (`capy/foundations-2`, v0.60.53.0)

One integrated PR. Five lanes were built in parallel from master at
`5bd9e8497` and merged here with merge commits in the order F (scale and
operations), A (crash robot), E (keys and grants), C (write attribution), D
(silent failures). Lane E's placeholder migrations became v202
`legacy_token_grant_conversion` and v203 `oauth_client_grant_axes`, the next
numbers after master's v201 (engine graduation). Generated files (migration registry, CLI flag
registry, schema blobs, llms bundles, goldens) were regenerated, never
hand-merged; the module-size ratchet rows that two lanes both grew were merged
to measured line counts, keeping every lane's rationale.

## Headline

| Outcome | Before | After | Measured on |
| --- | --- | --- | --- |
| Crash runs per full persistence gate run (600 s budget) | 0 | PGLite 75 (Bun 1.4.0) and 69 (Bun 1.4.2); Postgres through PgBouncer 18 per Bun version; 11 crash points; 0 violations | `persistence-validation.yml` run 37234740186 on this branch |
| Local robot long run | n/a | PGLite 300 s budget: 40 sequence x crash-point runs, 3 process faults, 0 violations; Postgres 600 s through PgBouncer: 12 runs, 4 process faults, 0 violations | integrated head `8bd4e81f9` |
| Past persistence fixes caught when reverted (12 that reverse-apply cleanly) | 0 | 1 on each engine (6fe43935e, hung git child) | Lane A branch, `would-have-caught.ts` |
| Facts from 10 meeting pages on a served PGLite brain, no command | 0 after 22 min, 10 jobs waiting | 49 facts from 10 pages at about 20 min ($0.084) | Lane D branch, real model |
| Dashboard-minted keys with full access | 20 of 20 | 0 of 20 | `serve --http` fixture, integrated head |
| Legacy tokens authorized from the JSON grant after boot | 50 of 50 | 0 of 50 (50 of 50 requests succeed) | same fixture |
| Unattributed writer references | 90 in 40 files | 7 in 3 files | `test/write-attribution-legacy.test.ts` inventory |
| Scale tier, 10,000 pages, enforced | n/a | PGLite 25 of 25 gates, Postgres 24 of 24 | `scale-tier.yml` run 37234737519 on this branch |
| Scale tier, 20,000 pages | nightly red (PGLite timed out at 50 min) | green on both engines, about 8 min per job | Lane F run 37220459411 |

Foreground MCP latency with and without the live facts drain (12 pages, real
model): `get_page` p95 3.2 to 3.3 ms, `list_pages` 9.1 to 8.8 ms, search 439
to 389 ms.

Scale tier at 10k on this branch: MCP search p50 37.3 ms (PGLite) and 78.6 ms
(Postgres); hybrid query 25 and 201 ms; `find_orphans` 41.4 and 31.9 ms;
import 57 s and 102 s. The Postgres `planner_stats` gate is report-only and
reports no `pg_stats` rows yet for three tables right after import (autovacuum owns statistics there).
Ceiling enforcement stays report-only.

## Items

| Lane | What shipped | Priority |
| --- | --- | --- |
| A | Crash robot over the real operations (generator, reference model, SIGKILL at every crash seam, process faults, replay and shrink); crash-robot CI job per engine with PgBouncer; restarted PGLite owner releases its dead predecessor's claims; `buildHistoryFixture`; lock-order trace; would-have-caught runner | P0 |
| C | Unmanaged writers through `maintenanceTransaction`, bounded per batch; attribution-backfill verified on a 10k managed history; `calibration undo-wave` on Postgres | P1 |
| D | Automatic facts drain on PGLite (serve, serve --http, `facts_drain` cycle phase) with job deferral; #5299 cycle fence; `repair take-supersession` (#5886); doctor `revision_backfill` and the backfill on managed brains (#5216); chronicle event identity and invite projection | P0 drain, P1 rest |
| E | Dashboard key mint fix (read+write default, revoke by id); v202 bulk legacy grant conversion and column reads on both HTTP transports; v203 client `--sources none` and `--takes-holders`; doctor `legacy_token_null_scope` | P0 mint fix, P2 rest |
| F | `find_orphans` known answer on Postgres; PGLite planner stats in the timeline walk; autocommit WAL checkpoint guard; migrate refusals with why and fix; `sources refresh` inside a resident PGLite owner; projection-readiness cache; F4d ceilings in the scale tier; seat heartbeat and pattern-page seat follow-ups | P0 scale fixes and refusal, P2 rest |

Every P0 item shipped. Nothing was cut.

## Integration fixes

- `8bd4e81f9`: Lane F's planner-stats refresh flushed the timeline batch
  before page N, so one 100-row maintenance transaction split in two and Lane
  C's `test/write-attribution-timeline-10k.slow.test.ts` saw 101 transactions
  for 10,000 rows. The refresh now runs after every N pages, where the batch
  is already flushed; Lane F's planner-stats test walks 301 pages so its check
  after page 300 still sees 600 rows.
- Master merge (v0.60.52.0: engine graduation, auto_chronicle date quality,
  contributor fixes): runMigrateEngine runs graduation's Windows platform
  check before Lane F's source checks; the legacy copier's PGLite refusal,
  which now only fires with graduation turned off, asks the user to turn
  graduation back on and preview the read-only plan, or to stay on PGLite and
  share it with `foresights mcp expose`; chronicle publication applies the
  invite marking to the events the date screen keeps, so an ended invite is
  projected (no judge call) and still dated by its `end`; `auth rescope
  --client` takes `--operations all` and `--sources none` / `--takes-holders`
  together; `core-services-1.md` was split under the 60 KB cap.
- `test/e2e/graduation-clients.test.ts` failed on master once v0.60.52.0 was
  tagged (its "older releases" included the graduation release); #6031
  fixes it on master and this branch takes that version.
- `consumer.ts` composes Lane A's `consumer:prepared` seam and first-tick
  PGLite `releaseAbandonedClaims` with Lane F's refresh-fence predicate in the
  idle probe; released claims are still fenced when they are claimed again.

- `foresights sources add` on a 20,000-file checkout failed intermittently on
  4-vCPU runners (also on branches without this wave): the background `git gc`
  that the fixture's large commit starts pruned `.git/objects/<xx>` while the
  physical-root overlap scan walked the checkout, and the scan's `readdirSync`
  threw ENOENT. The scan now skips a subdirectory that vanished mid-walk
  (`test/persistence-physical-root.test.ts` races it against a churning
  directory). Reproduced 4 of 5 times on a standard-4 VM before the fix.
- `test/sweep.test.ts` counted 4 raw queries instead of 3 when an earlier file
  in the same process had registered a local CLI writer in the shared test
  home: snapshot brains share one `brain_id`, so the maintenance principal
  lookup found and verified that registration. The test now runs with its own
  `GBRAIN_HOME`.
- `test/decide/retrieval-think.serial.test.ts` (from #5797): the late-answer
  test now waits for both of its intent receipts before returning, so the
  late `fallback_regex` receipt no longer lands in the next test's count.
- PR-budget coverage cut: the 150 s pull-request robot run on Postgres skips
  the seams and the fault that can wait out a dead owner's 2-minute claim
  lease (`effect:*`, `consumer:prepared`, `publication:prepared`,
  `publication:before_publication`, `publication:after_publication`, and the
  pooler disconnect fault). Before the cut that run took 669 s locally (three
  publication seams at about 128 s each, the pooler disconnect at 125 s). The
  manifest lists the cut as `lease_bound_seams_skipped` and
  `lease_bound_faults_skipped`; 600 s runs on pushes, schedules and manual
  dispatch still crash every seam and run every fault.

## Gates

- `bun run verify` (69 checks) and `bun run typecheck`.
- `bun run ci:ubicloud` on `8bd4e81f9`: 3,345 items, 0 failed (gitleaks 1,
  unit 2,468, serial 433, slow 30, E2E 412 against Postgres and PgBouncer,
  verify 1), 8 min 27 s wall.
- Lane focused tests after the merge: the 65 unit, serial and slow files green locally; the 11 E2E files green in `ci:ubicloud`.
- `persistence-validation.yml` (manual run, every Bun version): all jobs green.
- OpenClaw native context-engine startup test against pgvector pg16 with
  openclaw 2026.9.4: 1 of 1 pass.
- `uvx semgrep scan --config p/default --config p/typescript --error --baseline-commit origin/master`: 0 findings on 177 changed files.
- `bun run wave-security-scan origin/master..HEAD`: no obfuscation or eval;
  `admin/dist` changed and rebuilds byte-identical from `admin/src`; one
  gitleaks hit, a function-body sha256 in the migrations golden, which
  `.gitleaks.toml` allowlists.
- `bun run check:agent-contract`: OK.
- gstack credential pre-push guard on every push: no HIGH findings (MEDIUM
  hits are minified constants in `admin/dist` and a version-shaped string).

## Deferred (TODOS)

P1: a held sync lock reaches agents as `internal_error` (skipped test; the
agent-output contract owns it); ENOSPC and lost-exit process faults; a seeded
mutation pass; source and writer-lifecycle ops in the robot. P2: a restarted
Postgres owner waits out its predecessor's claims; a CI check that every
mutating operation is registered with the robot; pre-activation claim lock
order; the three link-extraction writers' attribution; one write path for
unmanaged brains; the `permissions` mirror after 2026-11-04; Postgres MCP
search at 20k pages; chronicle occurrence status, keyless invite projection
and invite-aware cost accounting. P3: `forget` as backfill proof,
`register-client --takes-holders`, `embed --stale` budget overshoot,
`findOrphans` paging.
