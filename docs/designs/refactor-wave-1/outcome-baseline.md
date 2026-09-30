# Refactor Wave 1: outcome baseline (criterion e)

This records, before any Wave 1 code moves, how often fixes landed in the four areas the refactor targets and what caused them. Criterion (e) in `docs/designs/REFACTOR_WAVE_1.md` asks for this so the +3-month re-measure can tell whether the structural changes (engine SQL written once, one schema source, sync phases with explicit state, doctor check registry, serve-http route modules with a guard) reduced the bug classes they were aimed at, rather than just moving code.

- Baseline commit: master `f8d1e3936` (2026-09-29, v0.60.11.0).
- Window: `--since=2026-03-30 --until=2026-09-30`. The repository's first commit is dated 2026-04-05, so this window covers the entire history: 1,101 non-merge commits (4 merge commits are excluded by `--no-merges`). Six months and "all history" are the same thing here. A last-90-day slice (2026-07-01 to 2026-09-30, 772 commits) is also reported, because the +3-month re-measure covers a 3-month window.
- Unit of analysis: a commit. Almost every commit is a squash-merged PR whose subject is `vX.Y.Z.W fix...` / `feat...`; the PR number is the last `(#N)` in the subject. A handful of early or direct-pushed commits carry an issue number there instead.
- One commit can yield several classified items (fix waves touch many things). An item is one distinct defect fixed in the area; the `n` column counts several same-cause defects of one commit in a single row.

## How to reproduce

The candidate lists and denominators come from one read-only script. Run it from the repo root; it writes its `all-*.txt` / `cand-*.txt` lists to the current directory.

```bash
BASE=f8d1e3936
WIN="--since=2026-03-30 --until=2026-09-30"
ENGINE="src/core/postgres-engine.ts src/core/pglite-engine.ts src/core/postgres-engine/ src/core/pglite-engine/ src/schema.sql src/core/pglite-schema.ts"
SYNC="src/commands/sync.ts src/commands/sync/ src/core/sync.ts src/core/sync-*.ts"
DOCTOR="src/commands/doctor.ts src/commands/doctor/ src/core/doctor-categories.ts"
HTTP="src/commands/serve-http*.ts src/core/oauth-provider.ts src/mcp/http-transport.ts"
FIXRE='(^|[^[:alnum:]-])(fix|fixes|fixed|fixwave|hotfix|bug|bugs|revert|reland)([^[:alnum:]]|$)|fix-wave|fix wave'
MANUAL='^(013b348c2|6db4cea2e|9a4ae0962|b30f0aa7c|d33aee843|5c49225e4) '
for a in ENGINE SYNC DOCTOR HTTP; do
  eval p=\$$a
  git log $BASE --no-merges $WIN --format='%h %s' -- $p > all-$a.txt          # every commit touching the area
  { grep -iE "$FIXRE" all-$a.txt; grep -E "$MANUAL" all-$a.txt; } | awk '!s[$1]++' > cand-$a.txt
  echo "$a total=$(wc -l < all-$a.txt) candidates=$(wc -l < cand-$a.txt)"
done
# migrate.ts-only fix candidates: counted for ENGINE only when the cause is schema drift / bootstrap
git log $BASE --no-merges $WIN --format='%h %s' -- src/core/migrate.ts | grep -iE "$FIXRE" \
  | grep -v -F -f <(cut -d' ' -f1 cand-ENGINE.txt) > cand-MIGRATEONLY.txt
# Engine co-edit denominators
both()   { comm -12 <(git log $BASE --no-merges $WIN --format=%h -- $1 | sort) <(git log $BASE --no-merges $WIN --format=%h -- $2 | sort) | wc -l; }
either() { git log $BASE --no-merges $WIN --format=%h -- $1 $2 | sort -u | wc -l; }
both src/core/postgres-engine.ts src/core/pglite-engine.ts; either src/core/postgres-engine.ts src/core/pglite-engine.ts
both 'src/core/postgres-engine.ts src/core/postgres-engine/' 'src/core/pglite-engine.ts src/core/pglite-engine/'
either 'src/core/postgres-engine.ts src/core/postgres-engine/' 'src/core/pglite-engine.ts src/core/pglite-engine/'
both src/schema.sql src/core/pglite-schema.ts; either src/schema.sql src/core/pglite-schema.ts
```

Each candidate was then read by hand: the body (`git show -s --format=%B <h>`) and the diff restricted to the area's paths (`git show <h> -- $AREA`, plus `src/core/migrate.ts` for ENGINE). The classification is of what the area-level change fixed, not of the commit subject. Code comments added in the diff (this codebase annotates fixes with `#issue` comments) were the main evidence for large wave commits.

### Candidate selection rules

A candidate is a non-merge commit in the window that touches the area's paths and whose subject is a fix: `fix`/`fixes`/`hotfix`/`fix wave`/`fix-wave`, `bug`/`bugs`, `revert` or `reland` of a fix. Mixed subjects (`feat: ... + 12 bug fixes`, `feat(...) ... ranking fixes`) are included, and a commit whose area change turned out to be a feature is then classified `feature-not-fix`, not dropped.

Changes from the first-pass subject-regex lists:

- Added by hand, because the subject describes a bug without a fix keyword: `013b348c2` (sync deadlock "reliability wave"), `6db4cea2e` (doctor image_assets false warning), `9a4ae0962` (CHECK constraint rejected a valid value), `b30f0aa7c` (doctor `--json` leaked progress), `d33aee843` (since/until filtered on the wrong column), `5c49225e4` ("stop wedging the daily cron").
- Removed by the regex boundary change (`[^[:alnum:]-]` before `fix`): `772253ef4` and `ebfbd5e6f`, feature commits that matched only on `--fix` / `auto-fix`.
- The 9 fix commits that touched only `src/core/migrate.ts` among engine paths were read; none was a schema-copy or bootstrap drift fix, so none counts for ENGINE (listed as `excluded-migrate-only` in the appendix).

Result: ENGINE 147, SYNC 80, DOCTOR 113, HTTP 53 candidate commits (263 distinct, since wave commits hit several areas), plus the 9 migrate.ts-only commits.

## Area path sets

| Area | Paths |
|---|---|
| Engine parity/drift (ENGINE) | `src/core/postgres-engine.ts` `src/core/pglite-engine.ts` `src/core/postgres-engine/` `src/core/pglite-engine/` `src/schema.sql` `src/core/pglite-schema.ts`; `src/core/migrate.ts` only when the cause is schema-copy drift or bootstrap |
| Sync hangs/partials (SYNC) | `src/commands/sync.ts` `src/commands/sync/` (does not exist at baseline) `src/core/sync.ts` `src/core/sync-*.ts` |
| Doctor (DOCTOR) | `src/commands/doctor.ts` `src/commands/doctor/` `src/core/doctor-categories.ts` |
| serve-http auth (HTTP) | `src/commands/serve-http*.ts` `src/core/oauth-provider.ts` `src/mcp/http-transport.ts` |

## Cause taxonomy

The seed taxonomy from the plan is kept. Seven classes were added because the seed classes could not hold what the diffs showed; each is marked (added).

| Cause | Area | Definition | Refactor expected to reduce it? |
|---|---|---|---|
| `engine-divergence` | ENGINE | Behavior or SQL implemented or fixed in one engine but not the other: one engine had the bug and the other did not, or a change landed in one engine and the other was patched later. | Yes. Engine SQL written once in `engine-sql/`. |
| `schema-copy-drift` | ENGINE | `schema.sql`, `pglite-schema.ts` and migrations/fragments out of sync, or a forward-reference/bootstrap wedge (initSchema replays DDL that references columns a pending migration adds). | Yes. One schema source and one bootstrap. |
| `driver-encoding` | ENGINE, HTTP | Driver-level binding and encoding: JSONB double-encoding, bigint/Date/array/jsonb[] binds, microsecond loss, `prepare:false`/pooler behavior, bind-parameter limits, lone surrogates into jsonb. | Partly. The E5 binding-matrix contract test pins the executor, but driver quirks outside converted statements remain. |
| `engine-logic` (added) | ENGINE | A query or logic bug present in both engines and fixed in both in the same commit (missing `deleted_at IS NULL`, missing source scope, wrong ORDER BY), or a bug in a DDL definition shared by all schema copies. The duplication doubled the fix but did not cause the bug. | Cost yes, count no. The fix is written once instead of twice; the bug still happens. |
| `engine-runtime` (added) | ENGINE | Connection, pool, singleton, reconnect, disconnect/close, lock, PGLite startup/WAL/data-dir, timeout or teardown bugs. Not SQL text. | No. These stay engine-specific. |
| `sync-shared-state` | SYNC | A hang/stall/partial/checkpoint/cleanup bug rooted in shared mutable state or phase interleaving inside the main sync function (`performSyncInner`, or its predecessor body in `commands/sync.ts`). Needs evidence naming the state: a closure flag, the shared `pagesAffected` set, a checkpoint or bookmark written for work that failed, pin vs head. | Yes. Phases with explicit inputs and outputs. |
| `sync-other` | SYNC | Any other sync fix: path handling, slugging, git invocation, failure ledger, lock file, cost gate, status reporting, a helper module's own logic, CLI flags, a hang not caused by shared state. | No. |
| `doctor-check-logic` | DOCTOR | One check's own logic: false positive or negative, wrong severity or category, crash inside a check, wrong query, wrong or unsafe fix hint. | No. |
| `doctor-structure` | DOCTOR | A bug from `buildChecks` ordering, early stop or shared state; from the half-done peel into `doctor/checks/`; from the check registry (`doctor-categories.ts`) drifting from what `buildChecks` emits; or from the local `buildChecks` and remote `doctorReportRemote` twins disagreeing. | Yes. One registry that both surfaces read. |
| `doctor-new-check` (added) | DOCTOR | A fix commit added a new check (or a new arm of a check) to surface a defect that lives elsewhere. Not a doctor defect. | No (not a defect). Registry makes adding one cheaper. |
| `doctor-other` (added) | DOCTOR | Command-level doctor bugs that are not a single check: output and `--json` cleanliness, progress output, flags silently ignored, exit codes, remediation-plan rendering. | No. |
| `http-auth` | HTTP | AuthN/authZ, `requireAdmin`, scope enforcement, CORS, OAuth/DCR/PKCE, token/secret/session handling, consent, source grants, auth rate limiting. | Partly. Only the items rooted in per-route guard attachment or the duplicated auth path between `serve-http.ts` and `mcp/http-transport.ts` (marked below). |
| `http-other` | HTTP | Other serve-http bugs: health probe, server lifecycle/shutdown, SSE, webhook routing, request parsing, rate-limit config, admin SQL. | No. |
| `unrelated-touch` | any | The area change is incidental: signature ripple, call-site update for a fix elsewhere, comment, type-only change, code removal with a retired feature. | n/a |
| `feature-not-fix` (added) | any | The area change adds new behavior rather than fixing a defect, including a schema addition made in lockstep across the three schema copies for a fix that lives elsewhere. | n/a |
| `revert-pair` (added) | any | A revert commit, or an original fix that was later reverted and relanded. The cause is counted once, on the reland. | n/a |
| `excluded-migrate-only` (added) | migrate.ts | A migrate.ts-only fix whose cause is not schema drift or bootstrap. Not counted for ENGINE. | n/a |

Each appendix row carries a confidence: `high` when the diff or body names the defect directly, `medium` when the class is my reading of a wave commit whose area change is large or only partly explained. For ENGINE rows, `both_engines` says whether the fix edited both `postgres-engine*` and `pglite-engine*` paths (`n/a` for schema-only rows).
## Denominators

| Area | Commits touching the area (fix or not) | Fix-subject candidates | Candidates with at least one real defect fix in the area | Same three, last 90 days |
|---|---|---|---|---|
| ENGINE | 242 | 147 | 131 | 119 / 94 / 85 |
| SYNC | 119 | 80 | 72 | 61 / 50 / 43 |
| DOCTOR | 206 | 113 | 69 | 98 / 70 / 47 |
| HTTP | 77 | 53 | 44 | 50 / 36 / 29 |

"Real defect fix" excludes `unrelated-touch`, `feature-not-fix`, `revert-pair` and `doctor-new-check` rows.

Engine co-edit counts (non-merge commits in the window):

| Measure | Full window | Last 90 days |
|---|---|---|
| Edited both `postgres-engine.ts` and `pglite-engine.ts` | 165 of 220 that edited either (75.0%) | 82 of 112 (73.2%) |
| Edited both engines counting module dirs (`postgres-engine{.ts,/}` and `pglite-engine{.ts,/}`) | 167 of 221 (75.6%); 31 Postgres-only, 23 PGLite-only | 84 of 113 (74.3%); 10 Postgres-only, 19 PGLite-only |
| Edited both `src/schema.sql` and `src/core/pglite-schema.ts` | 63 of 84 that edited either (75.0%); 12 schema.sql-only, 9 pglite-schema-only | not computed |

These match the plan's Problem table (165 edited both engine files); the plan's 188/196 per-file counts were taken at `608a174`, and at `f8d1e3936` they are 189 (PGLite) and 196 (Postgres).

## Summary: items and distinct commits per area and cause

Items count distinct defects (sum of `n`); commits count distinct commits with at least one row of that cause. A commit can appear under several causes.

| Area | Cause | Items | Commits | Items, last 90 days | Commits, last 90 days | Refactor expected to reduce |
|---|---|---|---|---|---|---|
| ENGINE | `engine-divergence` | 10 | 9 | 6 | 6 | yes |
| ENGINE | `schema-copy-drift` | 15 | 14 | 9 | 8 | yes |
| ENGINE | `driver-encoding` | 13 | 13 | 7 | 7 | partly |
| ENGINE | `engine-logic` | 84 | 74 | 63 | 57 | fix cost only |
| ENGINE | `engine-runtime` | 39 | 37 | 21 | 19 | no |
| ENGINE | `feature-not-fix` | 7 | 7 | 2 | 2 | n/a |
| ENGINE | `unrelated-touch` | 4 | 4 | 2 | 2 | n/a |
| ENGINE | `revert-pair` | 6 | 6 | 6 | 6 | n/a |
| SYNC | `sync-shared-state` | 6 | 6 | 5 | 5 | yes |
| SYNC | `sync-other` | 78 | 67 | 44 | 39 | no |
| SYNC | `feature-not-fix` | 5 | 5 | 4 | 4 | n/a |
| SYNC | `unrelated-touch` | 1 | 1 | 1 | 1 | n/a |
| SYNC | `revert-pair` | 2 | 2 | 2 | 2 | n/a |
| DOCTOR | `doctor-structure` | 4 | 4 | 2 | 2 | yes |
| DOCTOR | `doctor-check-logic` | 71 | 59 | 47 | 42 | no |
| DOCTOR | `doctor-other` | 8 | 8 | 3 | 3 | no |
| DOCTOR | `doctor-new-check` | 47 | 43 | 23 | 20 | n/a (not a defect) |
| DOCTOR | `feature-not-fix` | 5 | 5 | 0 | 0 | n/a |
| DOCTOR | `unrelated-touch` | 4 | 4 | 3 | 3 | n/a |
| DOCTOR | `revert-pair` | 4 | 4 | 4 | 4 | n/a |
| HTTP | `http-auth` | 34 | 29 | 19 | 19 | partly |
| HTTP | `http-other` | 19 | 17 | 14 | 12 | no |
| HTTP | `driver-encoding` | 2 | 2 | 0 | 0 | partly |
| HTTP | `feature-not-fix` | 5 | 5 | 3 | 3 | n/a |
| HTTP | `unrelated-touch` | 2 | 2 | 2 | 2 | n/a |
| HTTP | `revert-pair` | 2 | 2 | 2 | 2 | n/a |
| migrate.ts only | `excluded-migrate-only` | 9 | 9 | - | - | n/a |

### Findings that shape the re-measure

- The two engine-drift causes the refactor removes outright are a minority of engine fixes: `engine-divergence` 10 items in 9 commits and `schema-copy-drift` 15 items in 14 commits, against 84 `engine-logic` items in 74 commits. But 68 of 74 `engine-logic` rows edited both engines with the same change, so most engine fixes are written twice today. That duplicated-fix cost is what criterion (a) removes; it will show up in the re-measure as fewer storage PRs editing both engine files, not as fewer `engine-logic` bugs.
- `schema-copy-drift` is mostly the forward-reference bootstrap class: 9 of the 14 commits are upgrade wedges where the schema blob referenced a column older brains lacked (`6966623e0`, `1d78013c0`, `ff53a4c9b`, `4446e9f9d`, `2fca12446`, `130d321d2`, `69aea15e8`, `d9909cddd`, `a6be012a3`). One is the two bootstrap paths diverging (`492b55282`), and four are the schema text copies disagreeing: a view missing from `pglite-schema.ts` (`83c4ca056`), default dimensions (`d0d0e2a64`), the FTS language template (`f7d4f1912`), and constraint allowlists that had drifted at two sites (`864dec4f1`).
- `engine-runtime` (39 items) is the second-largest engine class and is out of scope for Wave 1: PGLite close/WAL/lock/startup and Postgres pool/singleton/reconnect bugs.
- `sync-shared-state` is small: 6 items in 6 commits (`271a707b7`, `4e4677b1b`, `69e7e79a1`, `f70c3fe9d`, `43597b19e`, `b5fa3d044`), all around checkpointing or reusing phase state (`importErrored`, `markCompleted(to)`, `pagesAffected`, pin vs head). The other 78 sync items are path, slug, git, ledger and reporting bugs that decomposing `performSyncInner` does not touch. Sync hangs in this history came from other causes: a PGLite non-reentrant transaction (`013b348c2`), an unbounded drain (`bb2e88c42`), a full-tree cost estimate (`5c49225e4`), a symlink-following walker (`eec2d2bf7`).
- `doctor-structure` is also small (4 items: registry drift `d6fe48637`, local/remote twin drift `67e7e8a92`, `5a06af5a5`, `182900d07`). Twin drift is real but mostly got fixed inside check logic in both twins at once (for example `b2f5ab89d`), so it shows up under `doctor-check-logic` too. 47 doctor items are new checks added by fix waves, not doctor defects.
- HTTP: 34 `http-auth` items in 29 commits. The ones rooted in per-route guard attachment or the duplicated auth path between `serve-http.ts` and `mcp/http-transport.ts` are `c860a411f`, `864dec4f1`, `4b38724aa`, `1eb430a2d`, `a948dfd6e`, `055ac6c75`, `6af0c91e5`, `cb0293238`, `d43fb631b` (9 commits, my judgment, medium confidence as a group). The rest are OAuth/DCR semantics inside `oauth-provider.ts` that a route split does not change.
- Reverts: 6 revert commits in the window reverted fixes that were later relanded (originals `2941e1779`, `5aa4795c0`, `8fc93c8fa`, `11659743a`, `e36251c02`, `74358329e`); each fix is counted once, on its reland.

### Limitations

- Large fix-wave commits (for example `67e7e8a92`, `055ac6c75`, `492b55282`, `77bb9d8c2`) change hundreds of lines per area. For those, rows cover the defects the diff comments and body identify; the item counts are a lower bound, and the dominant class is marked `medium`.
- The window is the whole history, so early commits (v0.1 to v0.20) come from a much smaller codebase. The last-90-day columns are the better comparison for a 3-month re-measure.
- One reader classified everything. Borderline calls are marked `medium`; the most judgment-dependent boundary is `engine-logic` vs `engine-divergence` when both engines were edited but one engine's comment says "parity with" the other (classified `engine-divergence` only when the diff or a pre-fix check shows one engine already had the behavior, as for `d33aee843`).

## Re-measure at +3 months

Run on or after 2026-12-30, against master at that date, and compare with the last-90-day columns above (same window length).

1. Rerun the script with `BASE=<master at re-measure>`, `SINCE=2026-09-30`, `UNTIL=2026-12-31`, and add the new directories the refactor creates to the path sets: ENGINE gains `src/core/engine-sql/` and the schema-migrations directory; SYNC gains `src/commands/sync/`; DOCTOR gains `src/commands/doctor/checks/`; HTTP gains the new serve-http route modules. Keep the old paths too, since facades stay.
2. Classify the new candidates with the same taxonomy and rules, then report items and commits per cause, and items per 100 area commits (the raw counts depend on how busy the quarter was).
3. W7 additions:
   - Share of storage PRs editing both engine files. Baseline: 74.3% of commits touching either engine (with module dirs) in the last 90 days, 75.6% over the full window. After Wave 1 a storage PR should edit `engine-sql/` once; count "storage PR" as a commit touching either engine path or `src/core/engine-sql/`, and report the share that still edits both engine files.
   - Conflicts on target paths per merged PR. Git history cannot show conflicts after a squash, so this needs the GitHub API: for each PR merged in the window that touches the target paths (the four area path sets, `src/core/migrate.ts`, `src/cli.ts`, `src/commands/jobs.ts`, `src/core/search/hybrid.ts`, `src/commands/autopilot.ts`), count other PRs merged between its creation and its merge that touched the same file. No baseline was computed here; compute it for 2026-07-01 to 2026-09-30 with the same method at re-measure time so both numbers use one method.
   - Remaining baseline rows: row count of the engine-sql ratchet TSV and the W5 function-size baseline.
   - Median rebase-to-merge time: from the GitHub API, the time between a PR's last head update and its merge, for PRs touching target paths.

## Appendix: every classified item

Sorted by area, then newest commit first. `pr` is the last `(#N)` in the subject.

| hash | pr | date | area | cause | n | confidence | both engines | evidence |
|---|---|---|---|---|---|---|---|---|
| `f8d1e3936` | #5747 | 2026-09-29 | ENGINE | `engine-runtime` | 1 | medium | no | pglite-engine.ts buildWalRepairNotice (recovery guidance); schema.sql+pglite-schema.ts+migrate v177 'unbound_source' added in lockstep (feature side) |
| `6f3a2a564` | #5694 | 2026-09-29 | ENGINE | `engine-logic` | 1 | medium | yes | insertFacts supersession chains (A->B->C) and fence reconcile keyed by row number, identical edits in both engine facts.ts |
| `6e1e82628` | #5689 | 2026-09-29 | ENGINE | `engine-runtime` | 1 | high | no | new pglite-engine/checkpoint-guard.ts: PGLite nested inline checkpoint spun forever at 100% CPU (#5449/#5284) |
| `6e1e82628` | #5689 | 2026-09-29 | ENGINE | `engine-logic` | 1 | medium | yes | embedding-input provenance kept only with its vector (#5553), both engine files |
| `a6eca5ed2` | #5666 | 2026-09-28 | ENGINE | `engine-logic` | 1 | medium | yes | both engines: forgotten claim stays forgotten after entity rename (+6 each); schema additions in lockstep |
| `b80cad61e` | #5676 | 2026-09-28 | ENGINE | `engine-divergence` | 1 | high | no | pglite-engine/facts.ts findTrajectory: "Postgres parity: single-type filter and exact-slug excludes" were missing on PGLite |
| `b80cad61e` | #5676 | 2026-09-28 | ENGINE | `engine-logic` | 1 | high | yes | findTrajectory returned oldest `limit` points; now newest-first then chronological, both facts.ts |
| `2ede415d7` | #5668 | 2026-09-28 | ENGINE | `engine-logic` | 1 | high | yes | updateSlug: zero-row UPDATE indistinguishable from success; rename + slug alias commit together (#3056), both engines |
| `5fffbe5b9` | #5658 | 2026-09-28 | ENGINE | `engine-logic` | 1 | medium | yes | embedding generation predicate and p.deleted_at filter in stale-chunk paths, both engines (+forward-reference-bootstrap) |
| `6bb88d128` | #5602 | 2026-09-28 | ENGINE | `engine-runtime` | 1 | medium | no | postgres-engine/cancellation.ts: cancellation-capable vendored Postgres driver; import ripple across postgres-engine/* |
| `467ff6737` | #5411 | 2026-09-24 | ENGINE | `engine-runtime` | 1 | high | no | postgres-engine.ts: late CancelRequest could hit the successor statement; exclusive connection through cancellation settlement |
| `db56c778e` | #5412 | 2026-09-24 | ENGINE | `unrelated-touch` | 1 | medium | yes | removal of retired provider paths from both engines and pglite-schema.ts |
| `b272cf234` | #5361 | 2026-09-22 | ENGINE | `feature-not-fix` | 1 | medium | n/a | sources_incarnation_key index added to schema.sql + pglite-schema.ts + migrate in lockstep (fix lives in persistence reconcile) |
| `44f96edf7` | #5298 | 2026-09-22 | ENGINE | `engine-logic` | 2 | medium | yes | searchVector: nondeterministic ORDER BY score only, date bounds not inclusive-capable, visibility opts not threaded; both engines |
| `9b0a1b5ea` | #5295 | 2026-09-21 | ENGINE | `engine-runtime` | 1 | high | no | pglite-engine.ts in-memory startup retry replaced open databases |
| `668b9bac3` | #5130 | 2026-09-15 | ENGINE | `engine-logic` | 1 | medium | yes | raw_data reads joined pages without deleted_at filter (raw_data follows page soft-delete); both engine files edited |
| `7fb6617db` | #5122 | 2026-09-15 | ENGINE | `engine-logic` | 1 | medium | yes | stale-embedding invalidation used signature-only comparison; currentSpaceChunkPredicate(model,dims), both engines |
| `f1fbdfba1` | #5097 | 2026-09-15 | ENGINE | `engine-logic` | 3 | medium | yes | facts row_num offset past canonical MAX (#4558, "see the Postgres twin"), qualified code callee fallback (#4670), salience batch; both engines |
| `a6be012a3` | #5027 | 2026-09-10 | ENGINE | `schema-copy-drift` | 1 | high | n/a | forward-reference-bootstrap.ts + pglite bootstrap: v149 blob references minion_jobs fields partial upgrades lack ("Mirror the PGLite bootstrap") |
| `43597b19e` | #4954 | 2026-09-07 | ENGINE | `engine-logic` | 2 | medium | yes | listFactsSince microsecond cursor; provenance-page visibility gate before DISTINCT ON; both engines |
| `ede85e2e8` | #4941 | 2026-09-06 | ENGINE | `engine-logic` | 1 | medium | yes | read policies: authorize concrete rows via shared live predicate throughout both engines (-315/-342 lines each) |
| `e9a14c952` | - | 2026-09-01 | ENGINE | `engine-logic` | 1 | medium | yes | #4280 quarantined entity shells counted in link/timeline coverage denominators; both engines |
| `3f2f30048` | #4701 | 2026-08-29 | ENGINE | `engine-divergence` | 1 | high | no | pglite-engine.ts getStats: "#4592: optional source scope — parity with postgres-engine.getStats" missing on PGLite |
| `3f2f30048` | #4701 | 2026-08-29 | ENGINE | `feature-not-fix` | 1 | medium | yes | new softDeletePages batch primitive written twice ("Parity implementation with PostgresEngine.softDeletePages") |
| `d9909cddd` | #4699 | 2026-08-28 | ENGINE | `schema-copy-drift` | 1 | high | n/a | Postgres blob index on dream_verdicts.expires_at wedged pre-v143 upgrades; forward-reference bootstrap probe added (#4657) |
| `c860a411f` | #4654 | 2026-08-28 | ENGINE | `engine-logic` | 1 | medium | yes | event-page LEFT JOIN lacked caller scope so out-of-scope event fields leaked (#2200 origin-join), both engines |
| `3464179ce` | #4650 | 2026-08-27 | ENGINE | `engine-runtime` | 1 | high | no | pglite-engine.ts pre-close CHECKPOINT so abandoned close() loses no committed rows ("PGLite-only by design") |
| `3464179ce` | #4650 | 2026-08-27 | ENGINE | `engine-logic` | 1 | medium | yes | facts supersede/count paths edited in both engine facts.ts |
| `77bb9d8c2` | #4565 | 2026-08-26 | ENGINE | `engine-logic` | 1 | high | yes | getPage multi-source tiebreak anchored on hardcoded 'default'; now sourceIds[0], "applied identically ... lockstep" (#3931) |
| `77bb9d8c2` | #4565 | 2026-08-26 | ENGINE | `driver-encoding` | 1 | medium | yes | NUL/lone-surrogate cleanup had to feed both md5 embedded_text_hash bind and stored chunk_text; raw NUL aborted INSERT |
| `492b55282` | #4567 | 2026-08-24 | ENGINE | `schema-copy-drift` | 1 | high | n/a | forward-reference bootstrap moved to postgres-engine/forward-reference-bootstrap.ts (#4477) so db.initSchema() replay path runs the same probes |
| `492b55282` | #4567 | 2026-08-24 | ENGINE | `engine-logic` | 1 | medium | yes | link delete RETURNING count (#4527) and orphan 'islanded' default predicate (#4524), both engines |
| `67e7e8a92` | #4475 | 2026-08-21 | ENGINE | `engine-divergence` | 1 | high | no | CJK keyword fallback existed on PGLite only; "#3986: the Postgres engine carries the same fallback (shared SQL builder)" |
| `67e7e8a92` | #4475 | 2026-08-21 | ENGINE | `engine-runtime` | 1 | medium | no | new postgres-engine/init-schema-lock.ts advisory lock around initSchema |
| `67e7e8a92` | #4475 | 2026-08-21 | ENGINE | `engine-logic` | 2 | medium | yes | #4352 untrusted-caller private-page filter; #3957 RETURNING count on stamped rows; both engines |
| `69aea15e8` | #4390 | 2026-08-21 | ENGINE | `schema-copy-drift` | 1 | high | n/a | blob indexes referenced private-queue owner/lease columns; pre-upgrade minion_jobs wedged blob replay (v121 class); both bootstraps ALTER them in |
| `055ac6c75` | #4368 | 2026-08-21 | ENGINE | `engine-divergence` | 1 | medium | no | new pglite-engine/cjk-search.ts: PGLite CJK path lacked searchKeyword's AND->OR recall fallback |
| `055ac6c75` | #4368 | 2026-08-21 | ENGINE | `engine-logic` | 1 | medium | yes | purge preview and DELETE used different predicates/clocks; same WHERE now, both engines |
| `07f5d28dc` | #4311 | 2026-08-19 | ENGINE | `engine-logic` | 1 | high | yes | putPage blank-body overwrite on empty read-modify-write; data-loss guard in both ("mirrors postgres-engine.ts") |
| `1886e1970` | #4316 | 2026-08-19 | ENGINE | `engine-runtime` | 1 | high | no | pglite-engine.ts: 5s close() bound armed after close(); honest bound + opt-in out-of-band watchdog (#4284) |
| `09dbb57e1` | #4227 | 2026-08-17 | ENGINE | `engine-runtime` | 2 | high | no | pglite-engine.ts: PGlite.close() deadlocked with a statement in flight (#4143); runtime assets unresolved under bun-global hoisting (#4116) |
| `afe923693` | #4228 | 2026-08-17 | ENGINE | `engine-logic` | 1 | medium | yes | searchVector bounded innerLimit escalation "IDENTICAL logic" in both engines (vector pool underfill) |
| `864dec4f1` | #4226 | 2026-08-17 | ENGINE | `engine-logic` | 1 | high | yes | getHealth link coverage/orphans ignored endpoint liveness (#4153); both engines |
| `864dec4f1` | #4226 | 2026-08-17 | ENGINE | `schema-copy-drift` | 1 | medium | n/a | v131 stale constraint dropped in both engines' schema; ledger/transcript allowlists "had already drifted at two sites" |
| `5ef85ac9e` | #4219 | 2026-08-16 | ENGINE | `engine-logic` | 1 | high | yes | unscoped getPage LIMIT 1 without ORDER BY returned arbitrary source row; identical clause in both engines |
| `8bf23abf7` | #4170 | 2026-08-15 | ENGINE | `driver-encoding` | 1 | medium | yes | lease map must bind as a raw object for jsonb; renewLock AbortSignal threaded to executeRawDirect |
| `8bf23abf7` | #4170 | 2026-08-15 | ENGINE | `engine-logic` | 1 | medium | yes | graph traversal pick plan/heap-order dependent so "the two engines (or two runs) can disagree"; lexicographic tiebreak in lockstep |
| `a90547e6f` | #4151 | 2026-08-15 | ENGINE | `engine-runtime` | 1 | high | no | postgres-engine.ts pool starvation: hung health probe not cancelled, implicit connection lifetime, tx counter leak on synchronous begin() throw |
| `4deee227b` | #4131 | 2026-08-14 | ENGINE | `engine-runtime` | 1 | high | no | pglite-engine.ts: snapshot-loaded engines ran sessions in the build machine TimeZone; restored sessions pinned to runtime zone |
| `83a4a94c3` | #4127 | 2026-08-14 | ENGINE | `engine-runtime` | 1 | medium | no | pglite-engine.ts tryLoadSnapshot accepted snapshots baked with different vector dims (test snapshot default-on incident) |
| `2ae5d60b9` | #3569 | 2026-08-13 | ENGINE | `engine-runtime` | 1 | high | no | pglite-engine.ts scratch-store probe: Aborted() could not distinguish damaged store from broken WASM runtime (#2674) |
| `8a626999f` | #3993 | 2026-08-13 | ENGINE | `engine-logic` | 1 | high | yes | embed --stale missed chunkless pages with content; shared predicate implemented in both engines ("mirrors PostgresEngine") |
| `dc6e61b07` | #4010 | 2026-08-12 | ENGINE | `driver-encoding` | 1 | high | no | pglite-engine.ts addCodeEdges crossed PGLite signed-int16 bind ceiling and corrupted the session; batched |
| `f7d4f1912` | #3774 | 2026-08-12 | ENGINE | `schema-copy-drift` | 1 | high | n/a | getPGLiteSchema/getPostgresSchema templates ignored configured FTS language; initSchema replay reverted non-English brains |
| `130d321d2` | #3902 | 2026-08-09 | ENGINE | `schema-copy-drift` | 2 | high | yes | applyForwardReferenceBootstrap in both engines: timeline_entries.event_page_id (pre-v121 wedge) and minion_jobs v7 columns referenced by blob indexes |
| `f15480b9d` | #3901 | 2026-08-08 | ENGINE | `engine-runtime` | 1 | high | no | pglite-engine.ts in-place WAL auto-repair for macOS Aborted() startup crash; init-error classifier |
| `c5ac3efe9` | - | 2026-08-01 | ENGINE | `unrelated-touch` | 1 | high | no | comment-only note on PGLite tx-engine nesting |
| `273bd0e2b` | #3550 | 2026-08-01 | ENGINE | `engine-logic` | 1 | medium | yes | residual federated reads not source-scoped; both engines |
| `42f810c40` | #3613 | 2026-08-01 | ENGINE | `engine-logic` | 1 | high | yes | searchVector LIMIT above hnsw.ef_search default 40 was unreachable; SET LOCAL ef_search (PGLite needed a transaction) |
| `a82a83dbc` | #3634 | 2026-08-01 | ENGINE | `engine-logic` | 2 | medium | yes | stale-chunk count used embedded_at not embedding IS NULL so remediation never converged ("Parity with postgres-engine.ts: same predicate"); facts row_num collision |
| `23003a216` | #3659 | 2026-07-31 | ENGINE | `engine-logic` | 1 | medium | yes | remote fence writes lost; both engines |
| `dba0ae7b1` | #3667 | 2026-07-31 | ENGINE | `engine-logic` | 1 | high | yes | back-link validator compared bare slugs across sources; identical +24-12 in both |
| `945fed610` | #3596 | 2026-07-29 | ENGINE | `engine-runtime` | 1 | medium | yes | lazy import() in engine-live paths replaced with static imports + guard |
| `e72d93fdb` | #3479 | 2026-07-29 | ENGINE | `engine-logic` | 1 | high | yes | updateSlug returned void; zero-row UPDATE invisible (#3056); both engines |
| `a104f98dc` | #3474 | 2026-07-29 | ENGINE | `engine-logic` | 1 | high | yes | fence reconcile destroyed legacy forget records (#2646); "implemented identically in both engines" |
| `a8a3b6df9` | #3556 | 2026-07-28 | ENGINE | `engine-logic` | 1 | high | yes | getHealth counted soft-deleted pages (#1305); "identically in both engines" |
| `176836f84` | #3538 | 2026-07-28 | ENGINE | `engine-logic` | 1 | high | yes | _upsertChunksOnce provenance fallback stamped compile-time default model (#3461); "pglite mirrors it for parity" |
| `0bbaed2e4` | #3459 | 2026-07-27 | ENGINE | `engine-logic` | 1 | high | yes | #3391 stale-chunk predicates grandfathered NULL signatures during provider migration; both engines |
| `16782aee7` | #3420 | 2026-07-27 | ENGINE | `driver-encoding` | 1 | high | no | postgres-engine restoreSource bound a JSON string to bare $1::jsonb; postgres.js double-encoded it; "PGLite masks the bug" |
| `16782aee7` | #3420 | 2026-07-27 | ENGINE | `engine-divergence` | 1 | medium | no | pglite-engine updateSourceConfig lacked historical-shape normalization ("Parity with postgres-engine.updateSourceConfig") |
| `32d42454e` | #3373 | 2026-07-24 | ENGINE | `engine-logic` | 1 | medium | yes | page projection omitted effective_date/effective_date_source; one line in each engine |
| `d21f34e96` | #2873 | 2026-07-24 | ENGINE | `engine-logic` | 1 | medium | yes | search results did not project email citation metadata; both engines |
| `7bbd087cb` | #2779 | 2026-07-24 | ENGINE | `engine-logic` | 1 | high | yes | putPage upsert did not clear deleted_at on soft-deleted rows; one line each engine |
| `e1919fab9` | #3343 | 2026-07-23 | ENGINE | `engine-logic` | 1 | high | yes | content_chunks.model stamped compiled default not gateway model (#2846); reland of 5aa4795c0 |
| `418357332` | #2846 | 2026-07-23 | ENGINE | `revert-pair` | 1 | high | yes | Revert of 5aa4795c0; relanded as e1919fab9 |
| `5aa4795c0` | #2846 | 2026-07-23 | ENGINE | `revert-pair` | 1 | high | yes | original of reverted fix; counted on reland e1919fab9 |
| `97bdf6acc` | #3330 | 2026-07-23 | ENGINE | `engine-logic` | 1 | high | yes | graph health metrics ignored 'entity' page type (#2639); reland of 8fc93c8fa, lockstep both engines |
| `68e4cebd1` | #2639 | 2026-07-23 | ENGINE | `revert-pair` | 1 | high | yes | Revert of 8fc93c8fa; relanded as 97bdf6acc |
| `8fc93c8fa` | #2639 | 2026-07-23 | ENGINE | `revert-pair` | 1 | high | yes | original of reverted fix; counted on reland 97bdf6acc |
| `ca04874c8` | #3316 | 2026-07-23 | ENGINE | `engine-logic` | 1 | high | yes | enrich candidate query did not exclude dream_generated pages; reland of 2941e1779 ("parity with postgres-engine") |
| `439bbaac3` | #2407 | 2026-07-23 | ENGINE | `revert-pair` | 1 | high | yes | Revert of 2941e1779; relanded as ca04874c8 |
| `cd18081f4` | #3333 | 2026-07-23 | ENGINE | `engine-logic` | 1 | high | yes | searchTakes whole-string trigram similarity missed words in long claims; word_similarity in both |
| `ca4cf2a0c` | #3297 | 2026-07-23 | ENGINE | `engine-logic` | 1 | high | n/a | take_proposals unique index lacked md5(claim_text), collapsing multi-claim proposals; schema.sql + pglite-schema + migration |
| `080b64e05` | #3155 | 2026-07-23 | ENGINE | `engine-logic` | 1 | high | yes | getHealth orphan/timeline denominators used a different scope than orphans audit; both engines |
| `b5675437c` | #3143 | 2026-07-23 | ENGINE | `engine-logic` | 1 | high | yes | _upsertChunksOnce did not lowercase mixed-case slugs (#430); both engines |
| `d574e843a` | #2881 | 2026-07-23 | ENGINE | `engine-logic` | 1 | medium | yes | remote/federated callers not source-scoped in a read path; both engines ("mirrors the postgres engine") |
| `2941e1779` | #2407 | 2026-07-23 | ENGINE | `revert-pair` | 1 | high | yes | original of reverted fix (enrich dream-page exclusion); counted on reland ca04874c8 |
| `44cae6232` | #1649 | 2026-07-22 | ENGINE | `driver-encoding` | 1 | medium | no | pglite-engine putPage: PGLite returned zero rows from INSERT ... ON CONFLICT ... RETURNING; rowToPage(undefined) crashed sync |
| `0a757bf78` | #1508 | 2026-07-22 | ENGINE | `engine-logic` | 1 | high | yes | findByTitleFuzzy lacked sourceId + deleted_at filters; both engines |
| `e78ad9ff9` | #1202 | 2026-07-22 | ENGINE | `engine-logic` | 1 | high | yes | getRecentSalience ranked briefing pages in their own pulse; matching block in both engines |
| `64920f83c` | #1232 | 2026-07-21 | ENGINE | `engine-logic` | 1 | high | yes | upsertChunks ON CONFLICT nulled code-chunk metadata on pure re-embed (#769); both engines |
| `a93fcf504` | #2993 | 2026-07-21 | ENGINE | `engine-logic` | 1 | high | yes | chronicle last-seen included future events; bound to <= asof/today in both engines |
| `84fad4738` | #2988 | 2026-07-21 | ENGINE | `engine-logic` | 1 | high | yes | putPage INSERT defaulted chunker_version to 1 not MARKDOWN_CHUNKER_VERSION (#2807); both engines |
| `d698b4443` | #2977 | 2026-07-21 | ENGINE | `engine-logic` | 1 | high | n/a | pages.search_vector trigger included compiled_truth and overflowed tsvector on large pages; schema.sql + pglite-schema + migration |
| `9ed53e4e1` | #3020 | 2026-07-20 | ENGINE | `driver-encoding` | 1 | high | no | postgres-engine addCodeEdges: Bun SQL double-encoded jsonb[] binds; code_callers returned nothing on Postgres (#2968) |
| `184b6cb8a` | #2956 | 2026-07-20 | ENGINE | `engine-logic` | 1 | medium | yes | searchKeyword strict websearch AND zeroed recall; gated OR fallback + new searchTitles arm, both engines (mostly feature) |
| `bd2ba46a6` | #2934 | 2026-07-17 | ENGINE | `engine-runtime` | 1 | high | no | postgres-engine non-batch config accessors did not reconnect on a null instance pool (#1603) |
| `9eac87213` | #1906 | 2026-07-17 | ENGINE | `engine-runtime` | 1 | high | no | postgres-engine reconnect() disconnect-then-connect nulled _sql on a failed rebuild; build-then-swap (#1593) |
| `cfc120fcb` | #2235 | 2026-07-17 | ENGINE | `engine-logic` | 1 | high | yes | getStats type counts included soft-deleted pages; one line each engine |
| `26d2f8abf` | #2892 | 2026-07-16 | ENGINE | `engine-logic` | 1 | medium | yes | takes list/search/scorecard reads not source-scoped (#2200-class); both engines |
| `26d2f8abf` | #2892 | 2026-07-16 | ENGINE | `driver-encoding` | 1 | medium | yes | take hit rows had different runtime shapes (bigint) per engine; shared coercion helper "Engine parity with PostgresEngine" (#2450) |
| `216654584` | #2891 | 2026-07-16 | ENGINE | `engine-runtime` | 1 | high | no | pglite-engine init-failure banner blamed the macOS WASM bug on every platform (#2674) |
| `d33aee843` | #1706 | 2026-07-16 | ENGINE | `engine-divergence` | 1 | high | no | postgres-engine since/until filtered on updated_at while pglite-engine already used COALESCE(effective_date, ...) (verified at parent) |
| `010847c02` | #2739 | 2026-07-13 | ENGINE | `engine-logic` | 1 | medium | yes | think gather streams (takes keyword/vector, traversal) ignored caller source scope (#2200); both engines |
| `2fca12446` | #2735 | 2026-07-13 | ENGINE | `schema-copy-drift` | 1 | high | yes | pre-v121 schema replay wedged on timeline_entries.event_page_id forward reference; bootstrap probe in both engines |
| `058f448b9` | #2400 | 2026-07-06 | ENGINE | `engine-runtime` | 2 | high | no | pglite-engine stole a live data-dir lock (#2348) and corrupted-store errors lacked recovery classification |
| `dde1132a2` | #2399 | 2026-07-02 | ENGINE | `engine-logic` | 1 | medium | n/a | schema functions lacked SET search_path and BYPASSRLS detection missed superuser/inherited roles; schema.sql + pglite-schema + migration |
| `9bf96db80` | #2255 | 2026-06-17 | ENGINE | `engine-logic` | 2 | medium | n/a | page_generation_clock row-lock contention -> sequence (PGLite is_called gotcha); op_checkpoints.completed_keys scalar broke loader -> CHECK |
| `c023a6041` | #2239 | 2026-06-16 | ENGINE | `engine-logic` | 1 | high | yes | federated read scope missing on getTags/getLinks/getBacklinks/getTimeline (#2200); Postgres 8-branch tree vs PGLite dynamic WHERE |
| `4ee530f3c` | #2141 | 2026-06-12 | ENGINE | `engine-runtime` | 1 | high | no | pglite-engine: Emscripten runtime hijacked process.exitCode (99), clobbering error exits (#2084) |
| `7c27fa129` | #2128 | 2026-06-12 | ENGINE | `engine-divergence` | 1 | high | no | pglite-engine lacked reconnect() that PostgresEngine had; callers could not call engine.reconnect() uniformly (#2034 "engine-parity reconnect") |
| `7c27fa129` | #2128 | 2026-06-12 | ENGINE | `engine-logic` | 1 | medium | yes | embedding dim recipe ordered ALTER COLUMN TYPE before UPDATE; index mirrored into schema.sql |
| `ecd6ae877` | #2031 | 2026-06-10 | ENGINE | `driver-encoding` | 1 | high | yes | lone UTF-16 surrogates rejected at ::jsonb cast in addLink/addTimelineEntry (#2011); both engines |
| `03ffc6ebd` | #2015 | 2026-06-09 | ENGINE | `engine-runtime` | 1 | high | no | postgres-engine disconnect awaited _sql.end() unbounded; PgBouncer drain blocked teardown (#1972) |
| `1eb430a2d` | #1999 | 2026-06-08 | ENGINE | `engine-logic` | 1 | high | yes | getPage exact-match read ignored federated sourceIds grant (#1393); both engines |
| `1eb430a2d` | #1999 | 2026-06-08 | ENGINE | `engine-runtime` | 1 | medium | no | postgres-engine config read threw/fell to defaults on transient pooler drop; retry-with-reconnect (#1603) |
| `959af1068` | #1980 | 2026-06-08 | ENGINE | `feature-not-fix` | 1 | medium | n/a | op_checkpoint_paths append-only table added to schema.sql + pglite-schema + migration v115 in lockstep |
| `f7f8512b1` | #1927 | 2026-06-07 | ENGINE | `driver-encoding` | 1 | high | yes | batch inserts bound unnest(${arr}::text[]) literals that broke on special chars; jsonb_to_recordset in both engines (#1861) |
| `f86825740` | #1822 | 2026-06-03 | ENGINE | `engine-runtime` | 1 | high | yes | minion lock claim/renewLock not routed through direct session pool under dual-pool; PGLite no-op executeRawDirect for contract parity |
| `ec5fed292` | #1810 | 2026-06-03 | ENGINE | `engine-runtime` | 1 | high | no | postgres-engine module-mode reconnect nulled the shared singleton under concurrent ops (#1745) |
| `bde11bb18` | #1807 | 2026-06-03 | ENGINE | `driver-encoding` | 1 | high | yes | links_extraction_lag never cleared on Postgres: updated_at lost microseconds; both engines project to_char µs string (#1768) |
| `bea2d3e6c` | #1797 | 2026-06-03 | ENGINE | `unrelated-touch` | 1 | high | no | postgres-engine comment update only (archive/ demoted not excluded) |
| `f3ade6c0c` | #1805 | 2026-06-03 | ENGINE | `engine-runtime` | 1 | high | no | postgres-engine module-singleton ownership: borrower disconnect nulled the cycle engine connection (#1404/#1471) |
| `766604dea` | #1735 | 2026-06-01 | ENGINE | `engine-runtime` | 1 | high | no | postgres-engine sql getter fell through to never-connected module singleton when instance pool went null (#1678) |
| `f79c1306a` | #1656 | 2026-05-30 | ENGINE | `feature-not-fix` | 1 | medium | n/a | sources.newest_content_at column added to schema.sql + pglite-schema + migration in lockstep |
| `041d89bab` | #1620 | 2026-05-29 | ENGINE | `engine-logic` | 1 | high | yes | findOrphanPages not source-scoped; both engines |
| `ffac8ce0f` | #1608 | 2026-05-28 | ENGINE | `engine-runtime` | 1 | medium | no | postgres-engine disconnect audit + null-singleton rebuild on retryable error (#1570) |
| `f56cc619b` | #1456 | 2026-05-25 | ENGINE | `engine-logic` | 1 | medium | yes | nondeterministic chunk ordering (ORDER BY ... chunk_id ASC) fixed in both engines while adding findDuplicatePage (#1309) |
| `dfa15ba22` | #1442 | 2026-05-25 | ENGINE | `feature-not-fix` | 1 | medium | yes | link_source CHECK widened for 'mentions' + backlink-count filter "parity with postgres-engine.ts"; feature side of --by-mention |
| `27b0e14af` | #1405 | 2026-05-25 | ENGINE | `engine-runtime` | 1 | high | no | pglite-engine disconnect: fire-and-forget last_retrieved_at writes kept event loop alive; lock-leak guard (#1247/#1269/#1290) |
| `6a10bad8e` | #1367 | 2026-05-24 | ENGINE | `engine-runtime` | 1 | medium | yes | Postgres NOTICE messages broke stdout-parsing callers; silenced at connection |
| `6987934eb` | #1308 | 2026-05-22 | ENGINE | `engine-logic` | 1 | medium | yes | putPage provenance write-through and getPage projection missing fields; "Mirrors postgres-engine.ts" |
| `83c4ca056` | #1283 | 2026-05-22 | ENGINE | `schema-copy-drift` | 1 | high | n/a | pglite-schema.ts lacked the page_links view present on Postgres ("PGLite page_links schema gap fix") |
| `d0d0e2a64` | #1286 | 2026-05-21 | ENGINE | `schema-copy-drift` | 1 | high | yes | getPGLiteSchema/getPostgresSchema default dims did not track gateway defaults ("v0.36 defaults drift bug class") |
| `9a4ae0962` | #1211 | 2026-05-20 | ENGINE | `engine-logic` | 1 | medium | yes | takes resolved-state filter used resolved_quality IS NOT NULL; 3-state subset in both engines |
| `4446e9f9d` | #1111 | 2026-05-17 | ENGINE | `schema-copy-drift` | 1 | high | yes | 7 missing forward-reference probes (files.source_id/page_id, sources.archived*) added to applyForwardReferenceBootstrap on both engines |
| `24881f60f` | #991 | 2026-05-14 | ENGINE | `engine-logic` | 1 | medium | yes | embed --stale cursor/count not source-scoped; "PGLite mirrors postgres-engine so the engine-parity E2E catches drift" |
| `488e4824e` | #996 | 2026-05-14 | ENGINE | `engine-logic` | 1 | high | yes | source-isolation P0: reads not filtered by source_id / ANY(sourceIds) in both engines |
| `17b190e22` | #879 | 2026-05-11 | ENGINE | `feature-not-fix` | 1 | high | yes | new countUnconsolidatedFacts method implemented in both engines |
| `e493d5f44` | #860 | 2026-05-11 | ENGINE | `engine-logic` | 3 | high | yes | listStaleChunks lacked p.source_id, listPages ignored sourceId, getChunksWithEmbeddings unscoped; both engines |
| `c9652443c` | #898 | 2026-05-11 | ENGINE | `engine-divergence` | 1 | high | no | pglite-engine CJK keyword fallback: PGLite's english websearch tsquery returned nothing for CJK on PGLite brains (+162 PGLite vs +8 Postgres) |
| `182900d07` | #808 | 2026-05-10 | ENGINE | `engine-logic` | 1 | medium | yes | multi-source threading: two-branch queries so reconcileLinks slugs stay in one source (D12); both engines |
| `ff53a4c9b` | #776 | 2026-05-09 | ENGINE | `schema-copy-drift` | 1 | high | yes | v39-v41 column-with-index forward references missing from applyForwardReferenceBootstrap; brains below v39/v41 wedged |
| `1d78013c0` | #697 | 2026-05-06 | ENGINE | `schema-copy-drift` | 1 | high | yes | v0.20 + v0.26.3 forward-reference columns missing from bootstrap; PGLite upgrade wedge |
| `2ea5b7117` | #637 | 2026-05-06 | ENGINE | `engine-runtime` | 1 | high | no | PostgresEngine.disconnect() not idempotent; second call clobbered module singleton |
| `6966623e0` | #440 | 2026-04-28 | ENGINE | `schema-copy-drift` | 1 | high | yes | initSchema replayed schema blob referencing state older brains lacked; applyForwardReferenceBootstrap introduced in both engines |
| `be8fffad7` | #488 | 2026-04-27 | ENGINE | `driver-encoding` | 1 | medium | no | PgBouncer transaction mode silently failed migration column creation; post-migration verifySchema self-heal |
| `e2961c04b` | #447 | 2026-04-26 | ENGINE | `engine-runtime` | 1 | high | no | postgres executeRaw no retry on connection-class errors; session timeout startup params rejected by managed poolers |
| `e2961c04b` | #447 | 2026-04-26 | ENGINE | `engine-logic` | 1 | medium | yes | chunk_text change without new embedding left embedded_at set; embed --stale missed rows |
| `08b3698e9` | #356 | 2026-04-23 | ENGINE | `engine-runtime` | 1 | medium | yes | reserved-connection primitive for migrations (statement_timeout 57014, idle-in-tx timeout) |
| `275158137` | #343 | 2026-04-23 | ENGINE | `engine-logic` | 1 | medium | n/a | schema.sql missing ENABLE ROW LEVEL SECURITY on access_tokens/mcp_request_log; migration backfill |
| `96178d726` | #318 | 2026-04-22 | ENGINE | `unrelated-touch` | 1 | high | yes | type-only fixes for tsc in CI |
| `fcf40a12f` | #301 | 2026-04-21 | ENGINE | `driver-encoding` | 1 | high | no | worker-instance Postgres pools ignored resolvePrepare; "prepared statement does not exist" on PgBouncer |
| `ff10796a0` | #248 | 2026-04-21 | ENGINE | `engine-runtime` | 1 | medium | no | PGLite.create() failures unactionable (#223 macOS WASM); version pin and wrapped error |
| `b5fa3d044` | #259 | 2026-04-20 | ENGINE | `engine-logic` | 2 | high | yes | jsonb_agg(DISTINCT) in legacy traverseGraph (both engines); minion_jobs.max_stalled default in all three schema copies |
| `c0b621923` | #196 | 2026-04-19 | ENGINE | `driver-encoding` | 1 | high | no | JSON.stringify()::jsonb double-encoded under postgres.js; parseEmbedding NaN; "PGLite hid" both |
| `699db50a3` | #198 | 2026-04-19 | ENGINE | `feature-not-fix` | 1 | medium | yes | new addLinksBatch/addTimelineEntriesBatch in both engines to kill an N+1 hang in extract |
| `013b348c2` | #216 | 2026-04-19 | ENGINE | `engine-runtime` | 1 | high | no | postgres searchKeyword/searchVector statement_timeout leaked across pooled client; SET LOCAL in a transaction |
| `b7e3005b5` | #129 | 2026-04-14 | ENGINE | `engine-divergence` | 2 | high | yes | Postgres dead_links query aligned to PGLite; PGLite orphan_pages aligned to Postgres |
| `004ac6c66` | - | 2026-04-12 | ENGINE | `engine-runtime` | 1 | medium | no | postgres statement_timeout applied globally; scoped to search |
| `13773be07` | #65 | 2026-04-12 | ENGINE | `engine-runtime` | 1 | high | no | PGLite concurrent access crashed with Aborted(); file lock |
| `13773be07` | #65 | 2026-04-12 | ENGINE | `engine-logic` | 1 | medium | yes | search DISTINCT ON re-sort and type/exclude_slugs filters not applied |
| `8de04d382` | #38 | 2026-04-10 | ENGINE | `engine-logic` | 1 | medium | no | validateSlug rejected any '..' substring (filenames with '...'); path-segment regex |
| `3e21e9b69` | #28 | 2026-04-10 | ENGINE | `engine-runtime` | 1 | medium | no | initSchema read schema.sql from disk at runtime and concurrent initSchema deadlocked on DDL; embedded schema + advisory lock |
| `f8d1e3936` | #5747 | 2026-09-29 | SYNC | `sync-other` | 1 | high | - | commands/sync.ts isSyncDisabledConfig/runConnectorSync: dispatchers kept queueing syncs for claimed-but-unactivated sources (#5198) |
| `6f3a2a564` | #5694 | 2026-09-29 | SYNC | `sync-other` | 1 | medium | - | performSyncInner: post-import extraction failure was silent; now surfaced in SyncResult (A15) |
| `6e1e82628` | #5689 | 2026-09-29 | SYNC | `sync-other` | 1 | high | - | createSyncBaselineCommit: unresolved db_only declaration silently committed db_only content; now refuses |
| `db56c778e` | #5412 | 2026-09-24 | SYNC | `sync-other` | 1 | medium | - | performSync dispatch: abort/cancel checks and company/managed routing order reworked (assertSyncDispatchActive, interruptedBeforeWork) |
| `6040075c6` | #5381 | 2026-09-23 | SYNC | `sync-other` | 1 | medium | - | sync --retry-failed count and failure ledger scoped to the current source (sync-failure-ledger.ts, performSync) |
| `b272cf234` | #5361 | 2026-09-22 | SYNC | `sync-other` | 1 | high | - | sync --all/--json reported status 'ok' for managed write failures; now 'error' + managed_write diagnostic |
| `44f96edf7` | #5298 | 2026-09-22 | SYNC | `unrelated-touch` | 1 | medium | - | performSync finish() now calls refreshProjectionStatistics; fix lives in search projection stats |
| `7fb6617db` | #5122 | 2026-09-15 | SYNC | `sync-other` | 1 | high | - | Windows path separators: gitRelativePath() + normalizeReconcilePath in planReconcileDeletes |
| `f1fbdfba1` | #5097 | 2026-09-15 | SYNC | `sync-other` | 2 | medium | - | persisted sync.include_hidden ignored by unattended paths (#4901); sweep-only sync did not count retired pages as deleted (#4786) |
| `a6be012a3` | #5027 | 2026-09-10 | SYNC | `sync-other` | 1 | medium | - | performFullSync: runImport double-recorded failure ledger/bookmark (#1939) and pre-lock cancellation not treated as resumable partial |
| `43597b19e` | #4954 | 2026-09-07 | SYNC | `sync-shared-state` | 1 | medium | - | performSyncInner rename vs reconcile: anchor-only slug index needed to tell another file's slug from the pre-rename state of the same file (#4597) |
| `43597b19e` | #4954 | 2026-09-07 | SYNC | `sync-other` | 1 | medium | - | runSync: non --all callers (autopilot, cycle, MCP sync op) passed no strategy (#4899) |
| `e9a14c952` | - | 2026-09-01 | SYNC | `sync-other` | 1 | high | - | performSyncInner rename lane used unguarded resolveSlugsByPaths fallback that could repoint a different file's page (#3942) |
| `3f2f30048` | #4701 | 2026-08-29 | SYNC | `sync-other` | 2 | high | - | persisted sync.exclude ignored by autopilot/minion/cycle callers; embed stall-abort seconds (resolveStallAbortSeconds) |
| `3464179ce` | #4650 | 2026-08-27 | SYNC | `sync-other` | 1 | high | - | sync lock break: resolver asserted source exists so leftover locks of deleted sources were unbreakable |
| `271a707b7` | #4624 | 2026-08-27 | SYNC | `sync-shared-state` | 1 | high | - | performSyncInner rename lane: skipped+error branch did not set closure flag importErrored, so rename was checkpointed and resume skipped it (#2683) |
| `77bb9d8c2` | #4565 | 2026-08-26 | SYNC | `feature-not-fix` | 1 | medium | - | adds --include-hidden glob waiver through collection (1218-line change); no clear sync defect in the area diff |
| `492b55282` | #4567 | 2026-08-24 | SYNC | `feature-not-fix` | 1 | medium | - | adds working-tree drift counting/import on attached HEAD (performSyncInner/performFullSync) |
| `4e4677b1b` | #4496 | 2026-08-23 | SYNC | `sync-shared-state` | 1 | high | - | performSyncInner: import status 'error' not recorded; rename arm called markCompleted(to) so resume filter skipped it forever (#2683 residual) |
| `67e7e8a92` | #4475 | 2026-08-21 | SYNC | `sync-other` | 2 | medium | - | blocked_by_failures lacked code breakdown (#3875); every idle poll wrote an ingest_log row (#3969) |
| `055ac6c75` | #4368 | 2026-08-21 | SYNC | `sync-other` | 1 | high | - | performSyncInner delete lane: re-slugified fallback could delete a page whose origin is a different file; guarded resolveSlugsForRemovedPaths (#3942) |
| `7e3ce95bb` | #4362 | 2026-08-19 | SYNC | `sync-other` | 1 | medium | - | sync could not run while a live serve held the PGLite lock; delegate via resolve-IPC with phase/checkpoint progress seam |
| `07f5d28dc` | #4311 | 2026-08-19 | SYNC | `feature-not-fix` | 1 | high | - | new github source kind path in performSyncInner (API-backed items) |
| `864dec4f1` | #4226 | 2026-08-17 | SYNC | `sync-other` | 1 | high | - | core/sync.ts isWithinRoot Windows path semantics (#4044/#4144) |
| `5ef85ac9e` | #4219 | 2026-08-16 | SYNC | `sync-other` | 1 | high | - | core/sync.ts classifySync: malformed filenames (bracket/control chars) now rejected at import with delete-lane carve-outs |
| `bd4c976a8` | #3561 | 2026-08-13 | SYNC | `sync-other` | 1 | high | - | performSyncInner: above size gate deferred link extraction was only hinted, never queued; links_extracted_at unstamped forever (#2849) |
| `fd0e371d5` | #3891 | 2026-08-13 | SYNC | `sync-other` | 1 | high | - | sync-failure-ledger.ts acknowledgeFailures skipped auto_skipped entries (#3829) |
| `ce156eb8e` | #3899 | 2026-08-12 | SYNC | `sync-other` | 1 | high | - | core/sync.ts buildSyncManifest: git C-style-quoted paths dropped silently (#3897) |
| `0a1890bbf` | #3964 | 2026-08-12 | SYNC | `sync-other` | 1 | high | - | performSyncInner baseline-commit guard treated any rev-parse failure (timeout/lock) as unborn HEAD and committed over a populated repo |
| `636628fdb` | #3735 | 2026-08-12 | SYNC | `sync-other` | 1 | high | - | writeSyncAnchor legacy no-sourceId path wrote global sync.* anchors for a foreign directory (#2114) |
| `c0b28f104` | #3624 | 2026-08-01 | SYNC | `sync-other` | 1 | high | - | performSyncInner: --dry-run still ran git pull; pages outside the sync strategy were deleted |
| `e72d93fdb` | #3479 | 2026-07-29 | SYNC | `sync-other` | 1 | medium | - | performSyncInner rename loop swallowed updateSlug failure/zero-row UPDATE, fell through to import and left stale old row (#3056); local error handling, not shared state |
| `784358f5f` | #3522 | 2026-07-28 | SYNC | `sync-other` | 1 | high | - | core/sync.ts SLUGIFY_KEEP_RE: non-Latin scripts collapsed to empty segments, distinct files merged (#3417) |
| `5f84fb881` | #3415 | 2026-07-28 | SYNC | `sync-other` | 1 | high | - | isPathSafe used string-prefix containment that failed on Windows backslash paths |
| `4beafbae4` | #3431 | 2026-07-27 | SYNC | `feature-not-fix` | 1 | medium | - | adds opt-in include-gitignored mode using the filesystem walker |
| `00bcd66c3` | #3253 | 2026-07-24 | SYNC | `sync-other` | 1 | high | - | failed git pull with zero imports reported up_to_date and advanced last_sync_at; now partial/pull_failed (#3068) |
| `cce774c90` | #3232 | 2026-07-24 | SYNC | `sync-other` | 1 | high | - | discoverGitRoot expected probe failure leaked git fatal line to stderr |
| `11659743a` | #2850 | 2026-07-24 | SYNC | `revert-pair` | 1 | high | - | original of reverted fix; counted on reland d15e2ab8c |
| `d15e2ab8c` | #3337 | 2026-07-23 | SYNC | `sync-other` | 1 | high | - | webhook-submitted sync job gets noExtract:false (reland of 11659743a) |
| `4b38724aa` | #3301 | 2026-07-23 | SYNC | `sync-other` | 1 | high | - | performSyncInner ingest record credited sync to 'default' instead of the written source (#3242 attribution) |
| `f70c3fe9d` | #3202 | 2026-07-23 | SYNC | `sync-shared-state` | 1 | medium | - | performSyncInner resumed run reported toCommit: headCommit instead of the pinned commit (resume/pin state vs result) |
| `69e7e79a1` | #3140 | 2026-07-23 | SYNC | `sync-shared-state` | 1 | high | - | performSyncInner end-of-run auto-embed was handed slugs deleted earlier in the same run via shared pagesAffected (#1284) |
| `22cb07494` | #2879 | 2026-07-23 | SYNC | `sync-other` | 1 | high | - | embedding_disabled sentinel not honored as implicit --no-embed; keyless sync exited 1 |
| `45f85df8f` | #2850 | 2026-07-23 | SYNC | `revert-pair` | 1 | high | - | Revert of 11659743a; relanded as d15e2ab8c |
| `7a1f61a31` | #2734 | 2026-07-23 | SYNC | `sync-other` | 1 | medium | - | performSyncInner: stale '<head>' sentinel from a transient rev-parse timeout never cleared after later verification |
| `bcf3b73dc` | #2967 | 2026-07-21 | SYNC | `sync-other` | 1 | high | - | never-git-initialized default brain dir: self-heal git init + baseline commit; git() 30s timeout aborted baseline (#2964) |
| `3a2033e8e` | #2335 | 2026-07-18 | SYNC | `sync-other` | 1 | high | - | performSyncInner up_to_date early return never bumped last_sync_at; doctor flagged quiet sources stale |
| `42375bded` | #2938 | 2026-07-17 | SYNC | `sync-other` | 3 | high | - | data-loss family: delete loop spared only some unsyncable reasons (#2404), DB-only write-through deleted by full-sync reconcile (#2426), full-sync gate drift (#2607) |
| `ff8ce4d76` | #2315 | 2026-07-17 | SYNC | `sync-other` | 1 | high | - | SYNC_SKIP_FILES missed RESOLVER.md so import walker and sync disagreed |
| `74bc8f8cd` | #2402 | 2026-07-17 | SYNC | `sync-other` | 1 | high | - | performSyncInner renames loop did not wrap importFile like delete/add loops; one bad file crashed sync and froze the checkpoint |
| `f15163f72` | #2836 | 2026-07-17 | SYNC | `sync-other` | 1 | high | - | performFullSync reconcile: Windows separator mismatch made every page look stale and wiped the source; mass-delete valve (#2828) |
| `bb2e88c42` | #2287 | 2026-06-21 | SYNC | `sync-other` | 1 | high | - | performSyncInner import drain wedged ~29 min while alive; progress-aware stall watchdog (#1950) |
| `9bf96db80` | #2255 | 2026-06-17 | SYNC | `sync-other` | 1 | high | - | runBreakLock --force reported terse 'not held' on a wedged sync (BUG 5) |
| `5c49225e4` | #2224 | 2026-06-16 | SYNC | `sync-other` | 1 | high | - | cost gate estimated full-tree tokens every run and wedged the daily cron; delta-aware computeSyncDelta (#2139) |
| `7c27fa129` | #2128 | 2026-06-12 | SYNC | `sync-other` | 1 | high | - | PRUNE_DIR_NAMES lacked vendor/dist/build/venv; code sync walked ~50k dependency files (#1483) |
| `959af1068` | #1980 | 2026-06-08 | SYNC | `sync-other` | 1 | high | - | sync checkpoint not durable under pool exhaustion/kills; append-only checkpoint deltas, time-based flush, lock-thrash fix (#1794) |
| `612753f31` | #1975 | 2026-06-08 | SYNC | `sync-other` | 2 | medium | - | performSyncInner: unreachable/orphaned last_commit forced a full re-walk that never advanced the bookmark (#1970); rename-to-unsyncable left stale page (F-C) |
| `b31de6613` | #1960 | 2026-06-07 | SYNC | `sync-other` | 1 | high | - | performSyncInner validate_repo_state: recloneIfMissing could delete a user working tree; now only gbrain-owned clones (#1881) |
| `5a06af5a5` | #1956 | 2026-06-07 | SYNC | `sync-other` | 2 | high | - | new sync-failure-ledger.ts: parse-failed then deleted file left permanent open ledger row; non-string frontmatter titles crashed import (#1939) |
| `bde11bb18` | #1807 | 2026-06-03 | SYNC | `sync-other` | 1 | high | - | sync hung/piled up orphans with no bound; out-of-band hard-deadline watchdog resolveSyncHardDeadline (#1633) |
| `fd2fde9d2` | #1808 | 2026-06-03 | SYNC | `sync-other` | 1 | medium | - | performSyncInner: killed incremental sync lost all progress; pinned-target op-checkpoint added (#1794) |
| `1036f8f75` | #1804 | 2026-06-03 | SYNC | `sync-other` | 1 | high | - | runBreakLock PID liveness check diverged from tryAcquireDbLock auto-takeover; shared predicate (#1780) |
| `6f26d5e4d` | #1665 | 2026-05-30 | SYNC | `sync-other` | 1 | medium | - | user schema-pack regex could wedge sync (ReDoS); --no-schema-pack escape hatch threaded through performSync and syncOneSource (#1569) |
| `f79c1306a` | #1656 | 2026-05-30 | SYNC | `sync-other` | 1 | high | - | writeSyncAnchor/buildSyncStatusReport: staleness was wall-clock not commit-relative; newest_content_at stamped atomically |
| `f56cc619b` | #1456 | 2026-05-25 | SYNC | `sync-other` | 2 | high | - | performSyncInner cleanup loop deleted metafile pages (log.md, schema.md) (#1433); runSync bypassed resolveSourceWithTier |
| `0b7efd352` | #1440 | 2026-05-25 | SYNC | `sync-other` | 1 | medium | - | lock-busy message without holder info and no --break-lock; new classifyErrorCode patterns (D3) |
| `27b0e14af` | #1405 | 2026-05-25 | SYNC | `sync-other` | 1 | medium | - | performSyncInner phase breadcrumbs for an untriageable sync hang (#1342); diagnostic only, hang not fixed here |
| `d0d0e2a64` | #1286 | 2026-05-21 | SYNC | `sync-other` | 1 | high | - | sync used runEmbed (process.exit) so dim-mismatch killed or was swallowed; switched to runEmbedCore with hint |
| `f1f9199ff` | #1253 | 2026-05-21 | SYNC | `sync-other` | 1 | high | - | core/sync.ts pruneDir walked git submodule directories (#1169) |
| `1bc579916` | #1182 | 2026-05-18 | SYNC | `sync-other` | 2 | high | - | incremental source sync embedded default-source row (sourceId not threaded); Terraform/HCL files invisible to code strategy (#878) |
| `4446e9f9d` | #1111 | 2026-05-17 | SYNC | `sync-other` | 1 | high | - | core/sync.ts manageGitignore/isSyncable: worktrees misclassified as submodules (#889) |
| `3325b405b` | #988 | 2026-05-14 | SYNC | `feature-not-fix` | 1 | high | - | performSyncInner adds sortNewestFirst ordering; checkpoint fix lives in import-checkpoint.ts |
| `cb8d6d872` | #982 | 2026-05-13 | SYNC | `sync-other` | 1 | high | - | git() default 1 MiB maxBuffer: ENOBUFS silently killed sync on large rename diffs |
| `c9652443c` | #898 | 2026-05-11 | SYNC | `sync-other` | 2 | high | - | CJK slugifySegment dropped Han/Kana/Hangul; delete/rename by path orphaned frontmatter-fallback slugs (source_path lookup) |
| `eec2d2bf7` | #773 | 2026-05-09 | SYNC | `sync-other` | 1 | high | - | --strategy code hung on symlink-rich repos: walker followed symlinks and full sync hardcoded markdown walker |
| `ff53a4c9b` | #776 | 2026-05-09 | SYNC | `sync-other` | 2 | high | - | multi-source: deletePage/updateSlug/getPage in sync not scoped to sourceId; detached-HEAD fallback skipped with --no-pull |
| `b5fa3d044` | #259 | 2026-04-20 | SYNC | `sync-shared-state` | 1 | medium | - | performSync (pre-performSyncInner) advanced sync.last_commit even when per-file imports failed (Bug 9); bookmark gated on success |
| `013b348c2` | #216 | 2026-04-19 | SYNC | `sync-other` | 1 | high | - | performSync wrapped add/modify loop in engine.transaction(); PGLite non-reentrant transaction mutex deadlocked (hang) |
| `b7e3005b5` | #129 | 2026-04-14 | SYNC | `sync-other` | 1 | high | - | performFullSync did not persist sync state so next sync was not incremental (C1) |
| `8de04d382` | #38 | 2026-04-10 | SYNC | `sync-other` | 1 | medium | - | isSyncable/slugifyPath ignored .mdx files |
| `3e21e9b69` | #28 | 2026-04-10 | SYNC | `sync-other` | 1 | high | - | pathToSlug did not lowercase slugs |
| `f8d1e3936` | #5747 | 2026-09-29 | DOCTOR | `doctor-new-check` | 1 | medium | - | new connector-checkpoint orphan check (#5686) and wave-check registry doctor/wave-checks.ts; remediation moved to doctor/remediate.ts |
| `6f3a2a564` | #5694 | 2026-09-29 | DOCTOR | `doctor-new-check` | 1 | high | - | new slug_collisions check (A3) surfacing files that sync silently merged |
| `6e1e82628` | #5689 | 2026-09-29 | DOCTOR | `doctor-new-check` | 3 | high | - | buildChecks: new dream paid-loop breaker, managed write capacity/parked effects (#5470/#5612), derived_visibility (#5525) signals |
| `a6eca5ed2` | #5666 | 2026-09-28 | DOCTOR | `unrelated-touch` | 1 | medium | - | connectorsHealthCheck call-site follows connector state move to readConnectorState (per-source keys) |
| `5fffbe5b9` | #5658 | 2026-09-28 | DOCTOR | `doctor-check-logic` | 1 | medium | - | buildChecks dim-mismatch fix hint suggested dropping schema/re-init; now backup + preview migration |
| `6bb88d128` | #5602 | 2026-09-28 | DOCTOR | `doctor-new-check` | 1 | high | - | new doctor/checks/postgres-cancellation.ts postgres_cancellation_driver check |
| `db56c778e` | #5412 | 2026-09-24 | DOCTOR | `unrelated-touch` | 1 | medium | - | 394 deleted lines: checks for retired provider paths removed with the providers |
| `6040075c6` | #5381 | 2026-09-23 | DOCTOR | `unrelated-touch` | 1 | medium | - | sync-failure block removed from buildChecks and backup_coverage peeled to doctor/checks; no doctor defect identifiable from the area diff |
| `287d92281` | #5360 | 2026-09-22 | DOCTOR | `doctor-check-logic` | 3 | high | - | embedding registry, ze_embedding_health, embedding_width_consistency false-warned on embedding_disabled (keyless) brains |
| `44f96edf7` | #5298 | 2026-09-22 | DOCTOR | `doctor-new-check` | 1 | high | - | new doctor/checks/projection-readiness.ts text_projection_readiness |
| `44f96edf7` | #5298 | 2026-09-22 | DOCTOR | `doctor-check-logic` | 1 | medium | - | checkCodeChunkMetadata fix hint wrong (reindex-code --force now --no-embed; content_hash short-circuit text) |
| `668b9bac3` | #5130 | 2026-09-15 | DOCTOR | `doctor-new-check` | 1 | medium | - | checkOauthClientScopeHealth new arm (c) flags privileged self-registered clients; privileged set derived from scope registry |
| `f1fbdfba1` | #5097 | 2026-09-15 | DOCTOR | `doctor-new-check` | 2 | high | - | buildChecks new fts_reindex_incomplete (#4795) and links_link_source_check shape (#4613) |
| `43597b19e` | #4954 | 2026-09-07 | DOCTOR | `doctor-check-logic` | 1 | high | - | extract-atoms backlog check showed brain-wide roster to a source-scoped remote run_doctor caller |
| `43597b19e` | #4954 | 2026-09-07 | DOCTOR | `doctor-new-check` | 1 | medium | - | new computeAtomProvenanceDriftCheck |
| `e9a14c952` | - | 2026-09-01 | DOCTOR | `doctor-other` | 1 | high | - | doctor accepted --skills-dir and silently ignored it; skill checks graded the wrong workspace (#4673) |
| `b2f5ab89d` | #4725 | 2026-08-31 | DOCTOR | `doctor-check-logic` | 1 | high | - | multi_source_drift false-positived git-root-pinned sources; fixed in both buildChecks and doctorReportRemote twins |
| `f9328f1b5` | #4677 | 2026-08-31 | DOCTOR | `doctor-check-logic` | 1 | high | - | computeExtractHealthCheck WARN hid per-kind staleness (7-day sums looked like active failure) |
| `3f2f30048` | #4701 | 2026-08-29 | DOCTOR | `doctor-check-logic` | 1 | high | - | checkProviderSunset date comparison could drift from gateway short-circuit; shared sunsetDateHasPassed |
| `3464179ce` | #4650 | 2026-08-27 | DOCTOR | `doctor-check-logic` | 1 | high | - | checkAbandonedThreads: month-precision since_date ::date cast threw; stub-guard arm accounting |
| `77bb9d8c2` | #4565 | 2026-08-26 | DOCTOR | `doctor-check-logic` | 2 | high | - | body: "detect dangling free-text aliases", "bound sampled entity coverage" |
| `77bb9d8c2` | #4565 | 2026-08-26 | DOCTOR | `doctor-new-check` | 1 | high | - | schema columns check: pooler-swallowed ALTER left ledger current over a narrower table (#4421/#4425) |
| `492b55282` | #4567 | 2026-08-24 | DOCTOR | `doctor-check-logic` | 1 | medium | - | upgrade-errors check kept warning after a later upgrade finished (#4517 superseded record) |
| `eb247ad8f` | #4520 | 2026-08-23 | DOCTOR | `doctor-check-logic` | 1 | medium | - | buildChecks supervisor check asserted 'not running' under --fast where engine is null and the DB-lock fallback is unreachable (#4518) |
| `67e7e8a92` | #4475 | 2026-08-21 | DOCTOR | `doctor-structure` | 1 | high | - | self-upgrade health check existed only in remote twin doctor/report-remote.ts, never in local buildChecks (#3747) |
| `67e7e8a92` | #4475 | 2026-08-21 | DOCTOR | `doctor-new-check` | 1 | medium | - | new pages(source_id, slug) upsert arbiter check (#550) and db_only collector collision |
| `69aea15e8` | #4390 | 2026-08-21 | DOCTOR | `doctor-check-logic` | 1 | high | - | computeWedgedQueueCheck restart hint bounced the default worker for a non-default queue; dream-inline queues never wedged |
| `055ac6c75` | #4368 | 2026-08-21 | DOCTOR | `doctor-check-logic` | 3 | high | - | three checks used db.getConnection() postgres singleton, silently 'Skipped' on PGLite (#1871); engine-coupled check code |
| `b99f4c8b0` | #4327 | 2026-08-20 | DOCTOR | `doctor-new-check` | 1 | high | - | new chat_fallback_chain inert warning (local + remote) |
| `4a269868b` | #4263 | 2026-08-18 | DOCTOR | `doctor-check-logic` | 1 | high | - | orphaned_private_queue false negatives on delayed rows; now uses cycle-lock liveness with ownership correlation (#4250) |
| `864dec4f1` | #4226 | 2026-08-17 | DOCTOR | `doctor-check-logic` | 1 | high | - | conversation-facts type allowlist hand-copied in two check sites; single ALLOWED_TYPES (#4135) |
| `5ef85ac9e` | #4219 | 2026-08-16 | DOCTOR | `doctor-new-check` | 1 | high | - | new malformed_path_pages discovery check |
| `9a19666b2` | #4165 | 2026-08-16 | DOCTOR | `doctor-check-logic` | 1 | high | - | graph_coverage counted soft-deleted entity pages; unclearable WARN |
| `2ae5d60b9` | #3569 | 2026-08-13 | DOCTOR | `doctor-new-check` | 1 | medium | - | new pglite_scratch_probe distinguishing damaged store from broken WASM runtime (#2674) |
| `fd9bb12b4` | #3548 | 2026-08-13 | DOCTOR | `doctor-new-check` | 1 | high | - | new provider_sunset check |
| `b92cc967d` | #4002 | 2026-08-13 | DOCTOR | `doctor-check-logic` | 1 | high | - | checkRerankerHealth did not bucket budget/pricing failures (#3628) |
| `9b720b04a` | #4006 | 2026-08-13 | DOCTOR | `doctor-check-logic` | 1 | high | - | supervisor_singleton read DEFAULT_PID_FILE, false-positive with custom --pid-file |
| `e795324ec` | #3879 | 2026-08-12 | DOCTOR | `doctor-new-check` | 1 | high | - | new pglite_leftovers check (#3856) |
| `130d321d2` | #3902 | 2026-08-09 | DOCTOR | `doctor-check-logic` | 1 | high | - | jsonbIntegrityCheck missed subagent jsonb columns (second double-encode site) (#2251) |
| `f15480b9d` | #3901 | 2026-08-08 | DOCTOR | `doctor-new-check` | 1 | high | - | new pglite_data_dir filesystem check with recurrence escalation (WAL repair wave) |
| `325775849` | #3854 | 2026-08-08 | DOCTOR | `doctor-check-logic` | 1 | high | - | collectMarkdownSlugs skipped all hidden dirs (e.g. .archive/) holding canonical pages |
| `9ada48e60` | #3364 | 2026-08-01 | DOCTOR | `doctor-check-logic` | 1 | high | - | embedding health probe used SDK default retries (~90s) on permanent failures; maxRetries:0 |
| `aa0525588` | #3523 | 2026-08-01 | DOCTOR | `doctor-check-logic` | 1 | high | - | buildChecks image-assets: Windows drive paths under WSL reported missing (#1835) |
| `5773736c6` | #3454 | 2026-08-01 | DOCTOR | `doctor-new-check` | 1 | high | - | new npm_squat check (#505) |
| `f9349ba07` | #3562 | 2026-07-28 | DOCTOR | `doctor-check-logic` | 1 | high | - | checkCycleFreshness: never-cycled sibling source on multi-source install made doctor permanently FAIL (#2540) |
| `9664cad32` | #2908 | 2026-07-28 | DOCTOR | `doctor-check-logic` | 1 | high | - | checkSyncFreshness: clone-unavailable after stateless restart fell through to wall-clock age, false stale/FAIL |
| `07901b188` | #3408 | 2026-07-28 | DOCTOR | `doctor-check-logic` | 1 | high | - | checkSubagentCapability ignored explicit models.subagent / tier config (local and remote) |
| `5ecab70a2` | #3437 | 2026-07-28 | DOCTOR | `doctor-check-logic` | 1 | high | - | checkSubagentCapability had its own truthiness parser that disagreed with the runtime toggle |
| `b30f0aa7c` | #851 | 2026-07-28 | DOCTOR | `doctor-other` | 1 | high | - | --json mode leaked progress output to stderr |
| `0bbaed2e4` | #3459 | 2026-07-27 | DOCTOR | `doctor-check-logic` | 1 | medium | - | buildChecks dimension-mismatch hint named the wrong migration command (#3390) |
| `16782aee7` | #3420 | 2026-07-27 | DOCTOR | `doctor-check-logic` | 1 | medium | - | checkSourceConfigShape repair SQL handled only one nesting shape; canonical REPAIR_SOURCE_CONFIG_SQL |
| `7a65f182a` | #3440 | 2026-07-27 | DOCTOR | `doctor-check-logic` | 1 | high | - | buildChecks embedding registry warned about missing HNSW index on columns above the pgvector HNSW dim cap |
| `32d42454e` | #3373 | 2026-07-24 | DOCTOR | `doctor-check-logic` | 1 | high | - | computeConversationFactsBacklogCheck counted unversioned/partial outcomes as done |
| `540b86ff5` | #3334 | 2026-07-24 | DOCTOR | `doctor-new-check` | 1 | high | - | new source_config_shape check (#2829); reland of e36251c02 |
| `e0a208d7b` | #2837 | 2026-07-23 | DOCTOR | `revert-pair` | 1 | high | - | Revert of e36251c02; relanded as 540b86ff5 |
| `e36251c02` | #2837 | 2026-07-23 | DOCTOR | `revert-pair` | 1 | high | - | original of reverted change; counted on reland 540b86ff5 |
| `38b8b1e41` | #3339 | 2026-07-23 | DOCTOR | `doctor-other` | 1 | high | - | runRemediationPlan printed 'Target unreachable' then 'Brain is at target' (#2151); reland of 74358329e |
| `8078c46ab` | #2151 | 2026-07-23 | DOCTOR | `revert-pair` | 1 | high | - | Revert of 74358329e; relanded as 38b8b1e41 |
| `aae1a5107` | #3300 | 2026-07-23 | DOCTOR | `doctor-new-check` | 1 | high | - | new raw_provenance check (#1978), soft-deleted exclusion within the same PR |
| `3594c316b` | #3139 | 2026-07-23 | DOCTOR | `doctor-check-logic` | 1 | high | - | checkRerankerHealth reported ok while every rerank failed open with reason 'unknown' (#2059) |
| `b91350d77` | #3094 | 2026-07-23 | DOCTOR | `doctor-check-logic` | 1 | high | - | conversation_parser_probe_health was a hardcoded 'Skipped' stub; probe flag read from one config plane only |
| `b0f74017d` | #3077 | 2026-07-23 | DOCTOR | `doctor-check-logic` | 1 | high | - | checkCalibrationFreshness SQL hardcoded an owner holder literal; parameterized via resolveOwnerHolder |
| `d6fe48637` | #3075 | 2026-07-23 | DOCTOR | `doctor-structure` | 1 | high | - | onboard check names pushed into buildChecks were never registered in doctor-categories.ts; unknown-check warning per run |
| `e0d2cbf35` | #2761 | 2026-07-23 | DOCTOR | `doctor-check-logic` | 1 | medium | - | graph_coverage/brain_score labels conflated entity timeline coverage and whole-brain density (#2298) |
| `16eb8cd06` | #2696 | 2026-07-23 | DOCTOR | `doctor-new-check` | 1 | medium | - | queue_health gains no-worker embed-backfill signal (#2557); queue_health block moved |
| `bb5a66942` | #1903 | 2026-07-23 | DOCTOR | `doctor-check-logic` | 1 | high | - | conversation_format_coverage recommended a dead config key |
| `74358329e` | #2151 | 2026-07-22 | DOCTOR | `revert-pair` | 1 | high | - | original of reverted fix; counted on reland 38b8b1e41 |
| `c21d7b253` | #2961 | 2026-07-21 | DOCTOR | `doctor-check-logic` | 1 | high | - | checkSkillConformance required a manifest host workspaces may omit; misaligned with resolver_health |
| `11eebc360` | #2958 | 2026-07-20 | DOCTOR | `doctor-check-logic` | 1 | high | - | conversation facts backlog type list missed imessage types (hand-copied list) |
| `6db4cea2e` | #2971 | 2026-07-20 | DOCTOR | `doctor-check-logic` | 1 | high | - | image_assets statSync'd repo-relative storage_path against cwd; false WARN outside the repo |
| `78bc2fef0` | #2918 | 2026-07-17 | DOCTOR | `doctor-check-logic` | 1 | high | - | multi_source_drift advice referenced a never-built command and an unsafe delete (#1123) |
| `9315fd074` | #1898 | 2026-07-17 | DOCTOR | `doctor-check-logic` | 1 | medium | - | conversation coverage check parsed polished body instead of raw_transcript sidecar |
| `e78f8a159` | #1183 | 2026-07-16 | DOCTOR | `doctor-check-logic` | 1 | high | - | pgvector/jsonb checks used db.getConnection() postgres singleton; false warning on healthy PGLite brains (engine-coupled) |
| `79d8c6773` | #2459 | 2026-07-16 | DOCTOR | `doctor-check-logic` | 1 | high | - | buildRetrievalReflexCheck warned on an intentionally disabled reflex |
| `bb2e88c42` | #2287 | 2026-06-21 | DOCTOR | `doctor-new-check` | 1 | high | - | new autopilot_fanout_concurrency check (#2194) on both surfaces |
| `bb2e88c42` | #2287 | 2026-06-21 | DOCTOR | `doctor-check-logic` | 1 | medium | - | body: doctor read the HOME-derived pidfile rather than the canonical one |
| `9bf96db80` | #2255 | 2026-06-17 | DOCTOR | `doctor-check-logic` | 1 | high | - | checkSyncFreshness reported an actively-running sync as stale; uses live lock (BUG 4) |
| `4ee530f3c` | #2141 | 2026-06-12 | DOCTOR | `doctor-other` | 1 | medium | - | runDoctor set process.exitCode directly; teardown/exit verdict via setCliExitVerdict (pool leak when DB checks throw) |
| `7c27fa129` | #2128 | 2026-06-12 | DOCTOR | `doctor-check-logic` | 4 | high | - | body: "five correctness fixes — stale locks, content sanity, graph coverage, ... gateway guard"; stale-lock report only knew gbrain-sync: prefix |
| `7c27fa129` | #2128 | 2026-06-12 | DOCTOR | `doctor-other` | 1 | medium | - | body: exit code fix among the five doctor correctness fixes |
| `7c27fa129` | #2128 | 2026-06-12 | DOCTOR | `doctor-new-check` | 1 | high | - | new idx_timeline_dedup shape check (#2038) |
| `03ffc6ebd` | #2015 | 2026-06-09 | DOCTOR | `feature-not-fix` | 1 | medium | - | doctor --fix now reaps dead-holder sync/cycle locks (#1972 self-heal path) |
| `5a06af5a5` | #1956 | 2026-06-07 | DOCTOR | `doctor-structure` | 1 | high | - | sync_failures severity computed differently in buildChecks and doctorReportRemote twins; shared decision (#1939) |
| `613da9409` | #1943 | 2026-06-07 | DOCTOR | `doctor-new-check` | 1 | high | - | new supervisor_singleton check (#1849) |
| `f4959348c` | #1824 | 2026-06-03 | DOCTOR | `doctor-check-logic` | 1 | high | - | remote queue_health queried column `state` not `status`; error swallowed so check was a no-op (#1801) |
| `f4959348c` | #1824 | 2026-06-03 | DOCTOR | `doctor-new-check` | 1 | high | - | new wedged_queue check (#1801) |
| `fd2fde9d2` | #1808 | 2026-06-03 | DOCTOR | `doctor-new-check` | 1 | high | - | new pool_budget check for GBRAIN_MAX_CONNECTIONS (#1794) |
| `bea2d3e6c` | #1797 | 2026-06-03 | DOCTOR | `doctor-new-check` | 1 | high | - | new hidden_by_search_policy check (#1777) |
| `766604dea` | #1735 | 2026-06-01 | DOCTOR | `doctor-new-check` | 1 | high | - | new extract_atoms_backlog check (#1678 silent backlog) |
| `f79c1306a` | #1656 | 2026-05-30 | DOCTOR | `doctor-check-logic` | 2 | high | - | checkSyncFreshness: untracked files counted as staleness; remote path shelled out to git on a DB-supplied local_path |
| `041d89bab` | #1620 | 2026-05-29 | DOCTOR | `doctor-check-logic` | 1 | high | - | orphan_ratio not source-scoped; explicit --source parse |
| `ffac8ce0f` | #1608 | 2026-05-28 | DOCTOR | `doctor-new-check` | 1 | medium | - | checkBatchRetryHealth extended with db-disconnect audit signal (#1570) |
| `cb1b5f91f` | #1573 | 2026-05-28 | DOCTOR | `doctor-check-logic` | 1 | high | - | checkSyncFreshness wall-clock age flagged quiet, caught-up repos; git-aware short-circuit |
| `543f9a71b` | #1545 | 2026-05-27 | DOCTOR | `doctor-new-check` | 1 | high | - | new sync --all consolidation nudge check |
| `a74e5d90f` | #1544 | 2026-05-26 | DOCTOR | `feature-not-fix` | 1 | high | - | doctor-categories.ts foundation and --scope=brain scoring |
| `d036a97f9` | #1445 | 2026-05-25 | DOCTOR | `doctor-new-check` | 1 | high | - | new embedding_env_override check on both surfaces (#1421 class) |
| `dfa15ba22` | #1442 | 2026-05-25 | DOCTOR | `doctor-new-check` | 1 | high | - | new orphan_ratio check |
| `0b7efd352` | #1440 | 2026-05-25 | DOCTOR | `doctor-new-check` | 1 | high | - | new stale_locks check (D3) |
| `6a10bad8e` | #1367 | 2026-05-24 | DOCTOR | `doctor-new-check` | 1 | high | - | new subagent_health lease-pressure check (remote surface) |
| `41ab13846` | #1313 | 2026-05-23 | DOCTOR | `unrelated-touch` | 1 | medium | - | refactor: buildChecks seam extracted from runDoctor for tests; no doctor defect |
| `83c4ca056` | #1283 | 2026-05-22 | DOCTOR | `feature-not-fix` | 1 | high | - | runRemediate budget tracker, checkpoint and --resume |
| `3de06b6c2` | #1297 | 2026-05-22 | DOCTOR | `doctor-check-logic` | 1 | high | - | frontmatter_integrity scan recursed into node_modules/.git and hung doctor on 216K-page brains; deadline + partial state |
| `d0d0e2a64` | #1286 | 2026-05-21 | DOCTOR | `doctor-check-logic` | 2 | high | - | checkZeEmbeddingHealth/checkEmbeddingWidthConsistency read DB config not gateway/file plane; skipped warning on fresh install |
| `f1f9199ff` | #1253 | 2026-05-21 | DOCTOR | `doctor-new-check` | 1 | high | - | new source_routing_health check (#1167/#1222) |
| `1bc579916` | #1182 | 2026-05-18 | DOCTOR | `doctor-check-logic` | 1 | high | - | whoknowsHealthCheck resolved fixture from process.cwd(); warned on every install |
| `1bc579916` | #1182 | 2026-05-18 | DOCTOR | `doctor-new-check` | 1 | high | - | new child-table orphan detection check (#1063) |
| `062009412` | #1108 | 2026-05-17 | DOCTOR | `doctor-check-logic` | 1 | high | - | supervisor check counted clean/graceful exits as crashes; shared summarizeCrashes |
| `0c6fcab55` | #1085 | 2026-05-17 | DOCTOR | `doctor-check-logic` | 1 | high | - | supervisor check counted exit code 0 restarts as crashes |
| `0c6fcab55` | #1085 | 2026-05-17 | DOCTOR | `doctor-new-check` | 1 | high | - | new stub-guard fire-count check |
| `c9652443c` | #898 | 2026-05-11 | DOCTOR | `doctor-new-check` | 1 | high | - | new slug_fallback_audit check |
| `29961811a` | #844 | 2026-05-10 | DOCTOR | `doctor-new-check` | 1 | high | - | new subagent provider warning (local + remote) |
| `182900d07` | #808 | 2026-05-10 | DOCTOR | `doctor-new-check` | 1 | high | - | new multi_source_drift check |
| `182900d07` | #808 | 2026-05-10 | DOCTOR | `doctor-structure` | 1 | medium | - | remote doctorReportRemote lacked the migration wedge hint the local doctor had ("same shape as the local doctor") |
| `87840341e` | #804 | 2026-05-10 | DOCTOR | `doctor-check-logic` | 3 | high | - | "doctor stops crying wolf": resolver check saw only thin RESOLVER.md, 'warn: 0%' on undefined, stale command hints |
| `87840341e` | #804 | 2026-05-10 | DOCTOR | `doctor-other` | 1 | medium | - | --fix could rewrite install-tree skills when skills dir came from install-path fallback; safety gate |
| `ff53a4c9b` | #776 | 2026-05-09 | DOCTOR | `doctor-check-logic` | 1 | high | - | doctor skills-dir auto-detect differed from check-resolvable; missed the workspace env var fallback |
| `1d78013c0` | #697 | 2026-05-06 | DOCTOR | `doctor-new-check` | 1 | high | - | new embedding_provider live smoke-test check |
| `e2961c04b` | #447 | 2026-04-26 | DOCTOR | `doctor-check-logic` | 1 | high | - | old partial migration record flagged 'MINIONS HALF-INSTALLED' forever after newer complete migrations |
| `08b3698e9` | #356 | 2026-04-23 | DOCTOR | `doctor-other` | 1 | medium | - | migrate error message referenced gbrain doctor --locks which did not exist; flag added |
| `275158137` | #343 | 2026-04-23 | DOCTOR | `doctor-check-logic` | 1 | high | - | RLS check hardcoded 10 gbrain tables; other public tables invisible |
| `fcf40a12f` | #301 | 2026-04-21 | DOCTOR | `doctor-new-check` | 1 | high | - | new pgbouncer_prepare check |
| `ff10796a0` | #248 | 2026-04-21 | DOCTOR | `doctor-check-logic` | 1 | high | - | schema_version check did not flag migrations-never-ran (#218 postinstall) |
| `ff10796a0` | #248 | 2026-04-21 | DOCTOR | `feature-not-fix` | 1 | medium | - | new opt-in --index-audit |
| `b5fa3d044` | #259 | 2026-04-20 | DOCTOR | `doctor-other` | 1 | medium | - | --fast printed an imprecise DB-skip message (Bug 7) |
| `b5fa3d044` | #259 | 2026-04-20 | DOCTOR | `doctor-new-check` | 1 | high | - | new sync failure trail check (Bug 9) |
| `013b348c2` | #216 | 2026-04-19 | DOCTOR | `doctor-new-check` | 2 | high | - | new jsonb_integrity and markdown_body_completeness detection checks |
| `b7e3005b5` | #129 | 2026-04-14 | DOCTOR | `feature-not-fix` | 1 | medium | - | composite health score and features teaser added to doctor output |
| `6e1e82628` | #5689 | 2026-09-29 | HTTP | `http-auth` | 1 | high | - | serve-http.ts resource-bound token check used exact string compare; now canonicalOAuthResource(); /mcp bearer scope hint read->read,write |
| `668b9bac3` | #5130 | 2026-09-15 | HTTP | `http-auth` | 1 | high | - | oauth-provider.ts GBrainClientsStore.registerClient: DCR scope ceiling via dcrScopeViolation (advisory fix); discovery scopesSupported narrowed |
| `7fb6617db` | #5122 | 2026-09-15 | HTTP | `http-auth` | 1 | high | - | serve-http-oauth.ts withBearerScopeHint adds scope= to WWW-Authenticate; agent scope removed from DCR discovery (read-only OAuth bootstrap) |
| `f1fbdfba1` | #5097 | 2026-09-15 | HTTP | `http-other` | 1 | high | - | serve-http.ts waitForHttpServerLifecycle: close() could wait forever; adds close deadline + WeakRef socket tracker |
| `a6be012a3` | #5027 | 2026-09-10 | HTTP | `http-auth` | 1 | high | - | body "enforce consent ... transactional OAuth grants"; new serve-http-oauth.ts mountConfidentialOAuth /token client auth; oauth-provider grant rework |
| `43597b19e` | #4954 | 2026-09-07 | HTTP | `http-auth` | 1 | medium | - | serve-http.ts protected-resource metadata URL made path-aware via getOAuthProtectedResourceMetadataUrl + legacy PRM path rewrite (OAuth discovery) |
| `e9a14c952` | - | 2026-09-01 | HTTP | `unrelated-touch` | 1 | high | - | serve-http.ts + http-transport.ts call-site swap buildMcpInstructions -> resolveMcpInstructions; fix lives in mcp/instructions.ts |
| `3f2f30048` | #4701 | 2026-08-29 | HTTP | `feature-not-fix` | 1 | medium | - | adds GBRAIN_MCP_INSTRUCTIONS to HTTP initialize responses (new operating-contract instructions), no HTTP defect |
| `c860a411f` | #4654 | 2026-08-28 | HTTP | `http-auth` | 1 | high | - | serve-http.ts /admin/login and /admin/api/issue-magic-link had no rate limiter; adminAuthRateLimiter added |
| `3464179ce` | #4650 | 2026-08-27 | HTTP | `feature-not-fix` | 1 | high | - | new serve-http-metrics.ts + admin-gated /metrics route (#3893 reimplementation); new surface, not a defect in existing code |
| `77bb9d8c2` | #4565 | 2026-08-26 | HTTP | `http-other` | 1 | high | - | serve-http.ts probeLiveness: timed-out SELECT 1 kept running; now abortable engine.executeRaw with AbortController |
| `77bb9d8c2` | #4565 | 2026-08-26 | HTTP | `http-auth` | 1 | high | - | oauth-provider.ts DCR redirect_uri validation (custom schemes/loopback) + asClientMetadataError maps registration errors to 400 not 500 |
| `492b55282` | #4567 | 2026-08-24 | HTTP | `http-other` | 1 | medium | - | serve-http.ts: resolve-IPC socket never bound under --http so lifecycle hooks degraded to no_serve (#4474) |
| `492b55282` | #4567 | 2026-08-24 | HTTP | `http-auth` | 1 | high | - | oauth-provider.ts refresh-token-not-found threw bare Error (500); now InvalidGrantError -> 400 invalid_grant (#4532) |
| `055ac6c75` | #4368 | 2026-08-21 | HTTP | `http-auth` | 1 | high | - | serve-http.ts mountOAuthCorsGate: denied/default-deny OAuth preflight fell through to SDK bare cors() answering '*' (#3845) |
| `07f5d28dc` | #4311 | 2026-08-19 | HTTP | `feature-not-fix` | 1 | medium | - | serve-http.ts new GitHub item webhook flow (extractGitHubItemRef, per-source HMAC candidates); new surface |
| `864dec4f1` | #4226 | 2026-08-17 | HTTP | `http-auth` | 1 | high | - | serve-http.ts SDK-transport /mcp never widened no-grant reads to federated set while http-transport.ts did (#3242 parity between two transports) |
| `4deee227b` | #4131 | 2026-08-14 | HTTP | `http-other` | 1 | high | - | serve-http.ts queryAgentClientSpend: naive date_trunc reinterpreted in session TZ shifted spend day boundary |
| `130d321d2` | #3902 | 2026-08-09 | HTTP | `http-auth` | 1 | medium | - | serve-http.ts admin register-client hardcoded source 'default'/no federated read; now honors source/federatedRead (client scoping) |
| `a948dfd6e` | #3868 | 2026-08-07 | HTTP | `http-auth` | 1 | high | - | oauth-provider.ts verifyAccessToken legacy branch never returned takesHoldersAllowList; two parse paths drifted (#2529) |
| `d71d50503` | #3618 | 2026-08-01 | HTTP | `http-other` | 1 | high | - | serve-http.ts HTTP server lifecycle: SIGINT left orphaned process/sockets; socket teardown in waitForHttpServerLifecycle |
| `a175dd004` | #3598 | 2026-07-30 | HTTP | `http-other` | 1 | high | - | serve-http.ts openAdminSseStream: admin SSE handshake stalled behind reverse proxies; writes ': connected' comment |
| `2118f02fc` | #3599 | 2026-07-30 | HTTP | `http-other` | 1 | high | - | serve-http.ts waitForHttpServerLifecycle: server object not retained / daemon lifetime implicit |
| `c6dc0adf2` | #3610 | 2026-07-29 | HTTP | `unrelated-touch` | 1 | high | - | serve-http.ts only exports types for test fakes (typecheck repair) |
| `11659743a` | #2850 | 2026-07-24 | HTTP | `revert-pair` | 1 | high | - | original of reverted fix; cause counted on reland d15e2ab8c |
| `d15e2ab8c` | #3337 | 2026-07-23 | HTTP | `http-other` | 1 | high | - | serve-http.ts webhook sync job now noExtract:false so push syncs extract links (reland of 11659743a) |
| `69bc37f74` | #3299 | 2026-07-23 | HTTP | `http-auth` | 1 | medium | - | serve-http.ts new requireAdmin /admin/api/rescope-client; DCR clients stuck on default scope had no rescope surface (#1914) |
| `4b38724aa` | #3301 | 2026-07-23 | HTTP | `http-auth` | 1 | high | - | http-transport.ts legacy token path: hasSourceGrant distinguishes operator grant from no-grant floor for federated reads (#3242) |
| `69e7e79a1` | #3140 | 2026-07-23 | HTTP | `http-other` | 1 | medium | - | serve-http.ts embeddingWidthStartupWarning: stateless hosts booted with wrong embedding width silently (#1196) |
| `58606cc92` | #3114 | 2026-07-23 | HTTP | `http-other` | 1 | high | - | serve-http.ts /token rate limit hardcoded 50/15min; now env-configurable (#2463) |
| `b0f74017d` | #3077 | 2026-07-23 | HTTP | `http-other` | 1 | high | - | serve-http.ts calibration routes hardcoded an owner holder literal; now resolveOwnerHolder via config |
| `45f85df8f` | #2850 | 2026-07-23 | HTTP | `revert-pair` | 1 | high | - | Revert of 11659743a (webhook extraction); relanded as d15e2ab8c |
| `d43fb631b` | #1410 | 2026-07-22 | HTTP | `http-auth` | 1 | high | - | serve-http.ts requireBearerAuth lacked resourceMetadataUrl so 401 WWW-Authenticate had no resource_metadata; clients couldn't start OAuth |
| `d61808d80` | #3032 | 2026-07-21 | HTTP | `http-auth` | 1 | high | - | serve-http.ts /revoke: SDK compared plaintext secret vs stored SHA-256 hash; hash-aware confidential revocation added |
| `cd9bd3f73` | #1976 | 2026-07-17 | HTTP | `http-auth` | 1 | medium | - | oauth-provider.ts registerClientManual gains AgentClientBindings (bound_tools/source/brain/slug prefixes); agent clients could not be bound |
| `26d2f8abf` | #2892 | 2026-07-16 | HTTP | `http-other` | 3 | medium | - | serve-http.ts calibration routes: nonexistent takes.page_slug column, raw bigint res.json crash, Date .slice crash / month-precision ::date cast |
| `bb3376e3b` | #2625 | 2026-07-16 | HTTP | `http-auth` | 1 | high | - | serve-http.ts resolveBootstrapToken: generated admin token printed to non-TTY stdout (log leak) (#2624) |
| `dde1132a2` | #2399 | 2026-07-02 | HTTP | `http-auth` | 1 | high | - | oauth-provider.ts GBrainClientsStore: DCR clients defaulted to consent-bypassing client_credentials; now authorization_code unless --enable-dcr-insecure (#1353) |
| `7c27fa129` | #2128 | 2026-06-12 | HTTP | `http-auth` | 1 | high | - | oauth-provider.ts authorize: omitted scope granted empty set, tokens failed insufficient_scope forever; now defaults to registered scope, clamped |
| `1eb430a2d` | #1999 | 2026-06-08 | HTTP | `http-auth` | 1 | high | - | http-transport.ts legacy bearer token federated_read grant (permissions.source_id array) not threaded into AuthInfo (#1336) |
| `6af0c91e5` | #1403 | 2026-05-25 | HTTP | `http-auth` | 2 | high | - | serve-http.ts OAuth CORS lockdown + GBRAIN_HTTP_TRUST_PROXY resolution; pre-register without DCR path did not work |
| `6a10bad8e` | #1367 | 2026-05-24 | HTTP | `feature-not-fix` | 1 | high | - | serve-http.ts new /admin/api/jobs/watch dashboard route |
| `6987934eb` | #1308 | 2026-05-22 | HTTP | `http-other` | 1 | high | - | serve-http.ts /ingest returned 500 HTML on missing body; now 400 JSON (BUG-2) |
| `6987934eb` | #1308 | 2026-05-22 | HTTP | `http-auth` | 1 | medium | - | serve-http.ts admin register-client ignored `scope` and threw on arrays; normalizeScopesInput (WARN-9) |
| `f1f9199ff` | #1253 | 2026-05-21 | HTTP | `http-auth` | 1 | high | - | serve-http.ts confidential-client /token: SDK plaintext secret compare always failed vs stored hashes (#1166) |
| `1bc579916` | #1182 | 2026-05-18 | HTTP | `http-auth` | 3 | high | - | oauth-provider InvalidTokenError so bearerAuth returns 401 not 500; register-client ignored auth_code/PKCE; weak env bootstrap token accepted (#1024) |
| `2504abe47` | #1053 | 2026-05-17 | HTTP | `http-other` | 1 | high | - | serve-http.ts tools/list built param schemas inline and drifted from shared paramDefToSchema used by stdio |
| `488e4824e` | #996 | 2026-05-14 | HTTP | `http-auth` | 2 | high | - | oauth-provider.ts registerClient ignored token_endpoint_auth_method=none (PKCE public clients); serve-http default bind 0.0.0.0 -> loopback |
| `9c60b3a06` | #801 | 2026-05-09 | HTTP | `http-other` | 1 | high | - | serve-http.ts/http-transport.ts auth/admin SQL required postgres.js singleton; broke serve --http on PGLite; engine-aware SqlQuery adapter |
| `ff53a4c9b` | #776 | 2026-05-09 | HTTP | `http-auth` | 1 | high | - | oauth-provider.ts authorize stored raw requested scopes; read client could mint admin token; scope clamp added (auth-code P0) |
| `f7c129407` | #701 | 2026-05-07 | HTTP | `http-other` | 1 | high | - | serve-http.ts /health ran getStats() count(*) queries, false 503s through PgBouncer; probeLiveness SELECT 1 |
| `2ea5b7117` | #637 | 2026-05-06 | HTTP | `http-other` | 1 | high | - | serve-http.ts /health getStats() had no timeout; probeHealth with 3s timeout |
| `cb0293238` | #628 | 2026-05-04 | HTTP | `http-auth` | 2 | high | - | oauth-provider.ts RFC 6749 hardening (auth code/refresh/revocation); serve-http HTTP MCP inlined OperationContext enabling shell-job (remote flag) |
| `1055e10c2` | #593 | 2026-05-03 | HTTP | `driver-encoding` | 1 | high | - | oauth-provider.ts: BIGINT columns returned as strings under prepare:false broke bearerAuth expiresAt/DCR numeric fields; coerce helper |
| `d01a921e0` | #577 | 2026-05-03 | HTTP | `driver-encoding` | 1 | high | - | oauth-provider.ts expiresAt came back as string, SDK bearerAuth rejected client_credentials tokens |
| `d01a921e0` | #577 | 2026-05-03 | HTTP | `http-auth` | 1 | high | - | serve-http.ts OAuth metadata omitted client_credentials grant type; response patched |
| `d3b52edeb` | #483 | 2026-04-28 | HTTP | `feature-not-fix` | 1 | high | - | new src/mcp/http-transport.ts bearer-auth HTTP transport (subject says fix, adds a new transport) |
| `0f03a0f92` | #4125 | 2026-08-14 | MIGRATE | `excluded-migrate-only` | 1 | high | - | migrate.ts-only: claim-time timeout backfill migration; not a schema-copy-drift/bootstrap cause |
| `e7439828f` | #3192 | 2026-08-01 | MIGRATE | `excluded-migrate-only` | 1 | high | - | migrate.ts-only: invalid-index guard on historical CONCURRENTLY sites; not drift |
| `2b00b7abe` | #3191 | 2026-07-24 | MIGRATE | `excluded-migrate-only` | 1 | high | - | migrate.ts-only: CONCURRENTLY remnants in DO block; not drift |
| `7421efc41` | #3080 | 2026-07-23 | MIGRATE | `excluded-migrate-only` | 1 | high | - | migrate.ts-only: skip large-dim HNSW indexes; not drift |
| `b60656245` | #3035 | 2026-07-20 | MIGRATE | `excluded-migrate-only` | 1 | high | - | migrate.ts-only: migration notice to stderr |
| `a46f28a63` | #3019 | 2026-07-20 | MIGRATE | `excluded-migrate-only` | 1 | high | - | migrate.ts-only: migration handler printed to stdout |
| `543f9a71b` | #1545 | 2026-05-27 | MIGRATE | `excluded-migrate-only` | 1 | high | - | migrate.ts-only: index migration per engine; not drift |
| `0b7efd352` | #1440 | 2026-05-25 | MIGRATE | `excluded-migrate-only` | 1 | high | - | migrate.ts-only: lock/credential-preflight wave migration; not drift |
| `9c60b3a06` | #801 | 2026-05-09 | MIGRATE | `excluded-migrate-only` | 1 | high | - | migrate.ts-only: engine-aware auth SQL migration; not drift |
