# Session Handoff — Post Path 3 Postgres Migration

> **Date**: 2026-04-29 17:00 local
> **From**: Lucien × Claude (Path 3 PGLite → local Postgres migration, P0 unblock)
> **To**: next Claude Code session picking up Jarvis KOS v2
> **Supersedes**: [`SESSION-HANDOFF-2026-04-29-post-v0.22.8-sync.md`](SESSION-HANDOFF-2026-04-29-post-v0.22.8-sync.md)

---

## 0. 速读 (read this first)

### What landed this session

- **PGLite → Postgres migration** (Path 3 from §3 of the prior handoff). 全部 P0 解锁。
- **Engine**: local Postgres 17 (Homebrew) + pgvector 0.8.2.
  Connection: `postgresql://chenyuanquan@127.0.0.1:5432/gbrain`.
- **Migration**: `gbrain migrate --to supabase` (officially Supabase
  flag, accepts any Postgres URL) transferred 2117 pages, 8231 links,
  11084 timeline entries, 3782/4023 chunks (94 %, 241 stale carry-over).
  ~/.gbrain/config.json auto-rewritten.
- **BrainDb refactor**: `skills/kos-jarvis/_lib/brain-db.ts` now
  detects engine from config and branches between `postgres()` (postgres.js)
  and `PGlite.create()`. All 9 callers untouched. Zero plist edits.
- **All cron jobs back online**: dream-cycle, kos-patrol, enrich-sweep,
  notion-poller. 0 launchd plists modified.
- **First production cycle**: notion-poller ingested **+186 pages in
  5.5 min**, exit 0, **0 zombie subprocesses**. /status latency 90ms
  during burst.

Story in [`docs/JARVIS-ARCHITECTURE.md §6.18`](JARVIS-ARCHITECTURE.md#618-pglite--本地-postgres-迁移--path-3-p0-unblock-2026-04-29-afternoon).
Plan in [`~/.claude/plans/recursive-churning-map.md`](~/.claude/plans/recursive-churning-map.md).

### Why Path 3 instead of Path 2 (in-process refactor)

Discovered via dream-cycle inspection that PGLite was not just slow
but **structurally wedging** under v0.21+ sync workload. Trigger #3 of
[`docs/UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md`](UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md)
("WAL fork patch fails silently") materialized as the load-class twin:
single-writer file lock fail. ~2.5h migration vs ~3h refactor + cron
disable + P1 follow-up. Postgres MVCC eliminates lock contention as
a problem class.

---

## 1. Current state (2026-04-29 17:00 local)

| Layer | Status |
|---|---|
| Engine | **Postgres 17 (Homebrew) + pgvector 0.8.2** |
| Connection | `postgresql://chenyuanquan@127.0.0.1:5432/gbrain` |
| Schema | v29 (migrated cleanly via runMigrations during connect) |
| Pages | **2303** (was 2117 pre-cycle; +186 ingested first run) |
| Chunks | 4023 source / 3782 with embeddings (94 %, run `gbrain embed --stale` to top up 241) |
| Links | 8231 |
| Timeline | 11084 (transferred unchanged) |
| Orphans | TBD post-ingest re-extract (was 732 baseline) |
| brain_score | TBD next dream cycle |
| doctor health | TBD `gbrain doctor` |
| Production endpoint | `kos.chenge.ink` → cloudflared → :7225 (kos-compat-api pid varies) |
| Embed shim | :7222 gemini-embedding-2-preview |

### Running services (`launchctl print gui/$UID`)

| Service | State |
|---|---|
| `com.jarvis.kos-compat-api` | ✅ running on :7225 |
| `com.jarvis.gemini-embed-shim` | ✅ running on :7222 |
| `com.jarvis.cloudflared` | ✅ running (kos.chenge.ink tunnel) |
| `com.jarvis.dream-cycle` | ✅ enabled, daily 03:11 (verified 1030 ms warm cycle) |
| `com.jarvis.kos-patrol` | ✅ idle, daily 08:07 (verified dry-run pass) |
| `com.jarvis.enrich-sweep` | ✅ idle, Sunday 22:13 |
| `com.jarvis.kos-deep-lint` | ✅ idle (v1 frozen, monthly 1st 09:00) |
| `com.jarvis.star-office-ui-backend` | ✅ running (unrelated) |
| `com.jarvis.notion-poller` | **✅ enabled**, every 5 min (verified +186p first cycle, 0 zombies) |

### Fork-local patches state

| File | What | Status |
|---|---|---|
| `src/core/pglite-schema.ts` idx_pages_source_id | DROPPED 2026-04-29 (closed by v0.22.6.1) | upstream verbatim |
| `src/core/pglite-engine.ts:89` `pg_switch_wal()` | RETAINED | macOS WASM persistence — unused on Postgres but keeps PGLite cold-backup viable |
| `src/cli.ts` mode 0755 | RETAINED | bun shim symlink |
| `skills/kos-jarvis/_lib/brain-db.ts` | **NEW dual-engine** (Path 3) | this session |

### Cold backup retention

- `~/.gbrain/brain.pglite/` — original PGLite dataDir (untouched by migrate). Keep ≥30 days; rolling back via `gbrain migrate --to pglite --force` will repopulate it from current Postgres state.
- `~/.gbrain/brain.pglite.pre-path2-1777504487` (502 MB) — pre-migration snapshot taken in this session as belt-and-suspenders insurance.

---

## 2. What the previous session did

[`docs/JARVIS-ARCHITECTURE.md §6.18`](JARVIS-ARCHITECTURE.md#618-pglite--本地-postgres-迁移--path-3-p0-unblock-2026-04-29-afternoon)
has the full story. Summary:

- **Phase 0 (~30 min)** — diagnosis of dream-cycle silent wedge.
  pid 4875 had been R-state at 75 % CPU for 12h 42min, stderr 0 bytes
  since 03:11 startup, holding the PGLite write lock. SIGKILL'd to
  unblock. Disabled `com.jarvis.dream-cycle` in launchd to prevent
  03:11 recurrence. Took 502MB snapshot at
  `~/.gbrain/brain.pglite.pre-path2-1777504487`.
- **Phase 1 (~15 min)** — Postgres prep. `brew install pgvector` (0.8.2,
  bottled). Created `gbrain` db, enabled `vector` + `pg_trgm`
  extensions. Postgres superuser = `chenyuanquan` (local trust auth).
- **Phase 2 (~20 min)** — `gbrain migrate --to supabase --url
  postgresql://chenyuanquan@127.0.0.1:5432/gbrain`. 2117 pages
  copied, all schema migrations 1→29 applied to Postgres on connect,
  config.json auto-rewritten. Verify: pages match, embeddings 94 %
  (241 stale), schema v29.
- **Phase 3 (~30 min)** — `skills/kos-jarvis/_lib/brain-db.ts`
  refactor. Added `engine` config detection, dual-path open/close,
  shared `_q(sql, params)` adapter that handles both
  `pg.query()` (PGLite) and `pg.unsafe()` (postgres.js). All 9 query
  methods adjusted; signatures unchanged so 9 callers (kos-patrol,
  kos-lint, dikw-compile, evidence-gate, confidence-score,
  orphan-reducer, slug-normalize, server) keep working.
- **Phase 4 (~20 min)** — bootstrap kos-compat-api, smoke tests:
  /status 112 ms, /ingest single 105 s cold / 10 s warm, /query
  11 s end-to-end, 5 concurrent /status during in-flight /ingest all
  < 100 ms.
- **Phase 5 (~15 min)** — dream-cycle re-enable. First Postgres run
  cold-path SIGKILL at 47 s; dream-wrap auto-retried, second run
  completed in **1030 ms** with all 6 phases. kos-patrol dry-run
  succeeded via BrainDb postgres path (BrainDb refactor verified
  end-to-end).
- **Phase 6 (~15 min + 5.5 min cycle wait)** — notion-poller
  re-enable + manual kickstart. Cycle exit 0, **+186 pages ingested**,
  **0 zombie `gbrain sync` subprocesses**, /status 90 ms during burst.
- **Phase 7 (~30 min)** — docs (this file, §6.18, TODO close P0,
  v020 banner) + commit (next).

---

## 3. Next session: what to do

**P0 — full system review + TODO re-prioritization** (Lucien explicitly
asked: "很久没有系统 review 了,新 session 完整 review 下,然后结合 todo
一起重新评估待办工作,推进系统优化")。

> **Paste-ready next-session prompt** (copy this block to start the next session):
>
> ```
> 开始 P0 — full system review + TODO 重排
>
> 入口文档:
> - docs/SESSION-HANDOFF-2026-04-29-post-postgres-migration.md (主要)
> - skills/kos-jarvis/TODO.md (P0 是这次 session 的目标)
> - docs/JARVIS-ARCHITECTURE.md §6.18 (Path 3 migration 故事)
>
> 上次 session 已完成:
> - PGLite → Postgres migration (commit 33c0410) — 2117 pages 迁完,
>   notion-poller +186p/5.5min/0 zombies,/status 90ms during burst,
>   dream-cycle 1030ms warm,所有 cron jobs back online。
> - 8 commits ahead of origin/master,未 push。
> - 241 stale embeddings 待 `gbrain embed --stale` 收尾。
>
> 本 session 任务:**完整 system review + TODO 重新评估 + 推进系统优化**。
>
> Phase A — System Review (~80 min,产出 ≤500 字 report):
>  1. Brain health (15 min):gbrain doctor + stats + orphans --count;
>     Postgres `pg_stat_activity` 看活跃连接;1 周内 dream cycle JSON
>     一致性。
>  2. Service mesh (15 min):9 个 launchd 各 last-run exit + log 大小;
>     cloudflared 隧道健康;notion-poller 真实 cycle 频率。
>  3. Query quality smoke (15 min):5-10 中文 query,手动评 top-3 相关性。
>     现在 ~6 天 Postgres 满,可以决定 GBRAIN_SOURCE_BOOST tune-up。
>  4. Storage + backup audit (10 min):du ~/.gbrain;pg_dump 数据规模;
>     当前**没有 Postgres 自动备份**,评估风险。
>  5. TODO re-evaluation (15 min):对账 P1/P2/P3,降级/归档/新增。
>  6. 产出 ranked top-3 work items + scope estimate,等 Lucien 选。
>
> Phase B — Execute selected work item(s)(0-3h,depending on Lucien):
>  - 候选(从 TODO P1):241 stale embed,Postgres backup 策略,kos-patrol
>    stoplist,graph_coverage 解决。
>  - 推完一个之后再问 Lucien 是否继续下一个。
>
> 起步命令(sandbox-aware):
>   git log --oneline -3                         # 应见 33c0410 在 HEAD
>   ps -axo pid,etime,command | grep gbrain | grep -v grep
>   TOKEN=$(grep -o '[a-f0-9]\{64\}' \
>     ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist | head -1)
>   curl -s -H "Authorization: Bearer $TOKEN" \
>     https://kos.chenge.ink/status | jq '.total_pages, .by_kind'
>   gbrain doctor 2>&1 | tail -25
>   psql -d gbrain -c "SELECT COUNT(*) FROM pages;
>     SELECT COUNT(*) FROM content_chunks WHERE embedding IS NULL;"
>   ls -lt ~/brain/.agent/dream-cycles/*.json | head -3
>
> 成功标准:
>  - Phase A report 落地(plan 文件或 inline)。
>  - TODO.md 更新反映 review 后的状态。
>  - Phase B 至少推进 1 个 P1,verified+committed。
> ```

### Step 1: production health re-check (5 min)

```bash
TOKEN=$(grep -o '[a-f0-9]\{64\}' ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist | head -1)
curl -s -H "Authorization: Bearer $TOKEN" https://kos.chenge.ink/status | jq '.total_pages, .by_kind'
ps -axo pid,etime,command | grep -E 'gbrain sync|notion-poller' | grep -v grep || echo "0 zombies"
launchctl print "gui/$(id -u)/com.jarvis.notion-poller" | grep -E "state|runs|exit"
gbrain doctor 2>&1 | tail -25
```

Expected: total_pages > 2303 (further notion-poller cycles ran), 0 zombies, doctor health > 80, no FAIL.

### Step 2: top up the 241 stale embeddings (P1, 5 min)

```bash
gbrain embed --stale 2>&1 | tail -10
psql -d gbrain -c "SELECT COUNT(*) FROM content_chunks WHERE embedding IS NULL;"
# expect: 0 (or close to 0)
```

These are markdown chunks that v0.21+ added but never got embedded
on the PGLite side; transferred to Postgres with NULL embedding.
The shim at :7222 handles them.

### Step 3: open P2/P3 items in TODO.md (whatever Lucien is in the mood for)

See [`skills/kos-jarvis/TODO.md`](../skills/kos-jarvis/TODO.md).

Notable now-cheaper tasks given Postgres:
- **kos-patrol Phase 4 stoplist** — surfaces 20 entity gaps, all
  Notion email/UI labels. ~1 h. Real candidates have to appear in ≥2
  distinct kinds.
- **graph_coverage 0 % investigation** — v0.21.0 metric likely needs
  `code_edges_*` populated. Run `gbrain reindex-code --dry-run` to
  see cost preview; if cheap, run `--yes`. We have ~no code so likely
  stays 0 % and we accept-and-document.
- **`GBRAIN_SOURCE_BOOST` tune-up evaluation** — 1 week of v0.22.8
  Postgres soak before deciding. notion-source pages are 60 % of
  brain; may swamp Chinese queries.

### Step 4: take advantage of newly-unlocked v0.20+ upstream features (P2)

Postgres unlocks `gbrain jobs supervisor`, `queue_health` doctor
check, `wedge-rescue` wall-clock sweep, `backpressure-audit` JSONL.
We don't run a worker daemon today, but:

```bash
gbrain doctor --json | jq '.checks.queue_health'
# expect: not skipped (Postgres-only feature), reports ok or warn
```

If interested in `gbrain agent run` durable subagent runtime
(v0.16), now possible. Out-of-scope for tonight.

---

## 4. Where to look (file map)

### Entry points
- [`CLAUDE.md`](../CLAUDE.md) — fork preamble + upstream context
- [`skills/kos-jarvis/README.md`](../skills/kos-jarvis/README.md) — extension pack scope
- **THIS FILE** — start here
- [`skills/kos-jarvis/TODO.md`](../skills/kos-jarvis/TODO.md) — P0 closed, P1/P2 live
- [`docs/JARVIS-ARCHITECTURE.md`](JARVIS-ARCHITECTURE.md) — full architecture, **§6.18 = most recent**

### Recent decision artifacts
- [`docs/UPSTREAM-PATCHES/v018-pglite-upgrade-fix.md`](UPSTREAM-PATCHES/v018-pglite-upgrade-fix.md) — annotated CLOSED 2026-04-29
- [`docs/UPSTREAM-PATCHES/v018-pglite-wal-durability-fix.md`](UPSTREAM-PATCHES/v018-pglite-wal-durability-fix.md) — still active for PGLite cold-backup viability; no longer hot path
- [`docs/UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md`](UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md) — banner-flagged migrated 2026-04-29
- [`docs/bug-reports/notion-poller-pglite-lock-deadlock.md`](bug-reports/notion-poller-pglite-lock-deadlock.md) — annotated CLOSED 2026-04-29 via Path 3
- `~/.claude/plans/recursive-churning-map.md` — Path 3 plan (artifact, not in repo)

---

## 5. Day-zero checks (sandbox-aware)

```bash
# 1. service health
launchctl print gui/$(id -u) 2>&1 | grep com.jarvis | head -10

# 2. brain stats (Postgres path now)
gbrain stats 2>&1 | head -10

# 3. doctor health
gbrain doctor 2>&1 | grep -E "Health score|FAIL"

# 4. fork patch sanity
grep -n "engine === \"postgres\"" skills/kos-jarvis/_lib/brain-db.ts   # should match
grep -n "pg_switch_wal" src/core/pglite-engine.ts                       # ~line 89, dormant
ls -l src/cli.ts | awk '{print $1}'                                     # -rwxr-xr-x

# 5. zombie check (should always be empty post-Path-3)
ps -axo pid,etime,command | grep -E 'gbrain sync' | grep -v grep || echo "0 zombies"

# 6. config sanity
cat ~/.gbrain/config.json
# expect: {"engine":"postgres","database_url":"postgresql://..."}

# 7. Postgres health
psql -d gbrain -c "SELECT COUNT(*) FROM pages;"
brew services list | grep postgres
```

---

## 6. Things off the plate

- **PGLite migration**: done.
- **Path 2 (in-process refactor)**: superseded by Path 3, no longer needed.
- v0.20 upstream features now available; enabling specific ones is P2.
- 4-week kos-patrol Phase 4 stoplist debt (P1, ~1h).

---

## 7. Open upstream issues to watch

| Issue | Status | Action when merged |
|---|---|---|
| ~~[#370](https://github.com/garrytan/gbrain/issues/370)~~ | CLOSED 2026-04-26 (v0.22.6.1 / PR #440) | done |
| [#394](https://github.com/garrytan/gbrain/issues/394) `gbrain dream --json` stdout pollution | open as of v0.22.8 | remove defensive slice in `dream-wrap/run.ts` |
| WAL durability bug | not filed | not affecting us anymore (PGLite is cold backup) |

---

## End of handoff

Production:
- Code: v0.22.8 fork master + Path-3 BrainDb refactor + docs (commit pending).
- Engine: **Postgres 17 + pgvector 0.8.2**.
- Schema: v29, 2303+ pages, all cron jobs healthy.
- External: `kos.chenge.ink` ✅ responsive.
- Notion-poller: ✅ **steady-state**, +186p first cycle, 0 zombies, /status 90ms during burst.

Next session's mission: P1/P2 — pick from TODO.md.
