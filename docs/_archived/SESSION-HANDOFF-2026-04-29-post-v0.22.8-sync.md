# Session Handoff — Post v0.22.8 Sync + Event-Loop Fix

> **⚠️ SUPERSEDED 2026-04-29 17:00 by [`SESSION-HANDOFF-2026-04-29-post-postgres-migration.md`](SESSION-HANDOFF-2026-04-29-post-postgres-migration.md).**
> Path 3 (PGLite → Postgres migration) closed all P0 in this handoff.
> See [`docs/JARVIS-ARCHITECTURE.md §6.18`](JARVIS-ARCHITECTURE.md#618-pglite--本地-postgres-迁移--path-3-p0-unblock-2026-04-29-afternoon)
> for the migration story. This handoff body retained for the
> diagnosis trail it left.

> **Date**: 2026-04-29 (extended into early morning ~04:30 local)
> **From**: Lucien × Claude (v0.22.8 sync + notion-poller deadlock root-cause + 方案 A fix)
> **To**: next Claude Code session picking up Jarvis KOS v2
> **Supersedes**: [`SESSION-HANDOFF-2026-04-27-evening-sweep-complete.md`](SESSION-HANDOFF-2026-04-27-evening-sweep-complete.md)

---

## 0. 速读 (read this first)

**Two waves landed in this session:**

### Wave 1 — upstream v0.22.8 sync (commit `811c266` + `bae3833`)
9 minor releases merged. Schema v24 → v29. Fork patch on
`pglite-schema.ts` (#370) **dropped** because v0.22.6.1's
`applyForwardReferenceBootstrap()` supersedes it. WAL patch on
`pglite-engine.ts:89` + `cli.ts` +x retained. Brain healthy at
2117 pages.

### Wave 2 — notion-poller deadlock fix (commits `093601e` + `3af5275`)

The user's [bug report](bug-reports/notion-poller-pglite-lock-deadlock.md)
matched what Phase C uncovered: notion-poller was hammering /ingest,
each call freezing the Bun event loop for 30s+ via `spawnSync gbrain
sync`, deadlocking external requests. **kos.chenge.ink was unreachable
externally** for ~30+ min during the bad period.

**方案 A landed** ([server/kos-compat-api.ts:111-184](../server/kos-compat-api.ts#L111)):
all 4 `spawnSync` call sites replaced with Promise-wrapped `spawn`.
Concurrency proof: while /ingest's gbrain sync is in flight (134s),
5 concurrent /status probes return HTTP 200 in **138-193ms**
(pre-fix: 30+s blocks).

External kos.chenge.ink is now responsive, BUT **notion-poller is
still bootouted + disabled** because individual /ingest is still slow
(`gbrain sync` 134s for one new file → spawnAsync 180s timeout, /ingest
returns 500 to caller). Fixing the event-loop block unblocks /status
+ /query + external Cloudflare tunnel users, but doesn't make /ingest
itself fast.

**P0 unblock paths** (see [TODO.md](../skills/kos-jarvis/TODO.md)):
1. **Maintenance window full re-walk** — try `gbrain sync --repo
   ~/brain --no-pull` to completion (no timeout), let it do whatever
   the v0.21.0 chunker walk wants. Tried this session for 18 min,
   produced 0 progress lines after `[sync.imports] start`. Maybe
   needs hours? Or there's a sync-internal wedge to investigate.
2. **方案 B** — refactor /ingest to use BrainDb in-process (no
   subprocess, no PGLite cross-process lock, no spawnAsync timeout
   cliff). ~150 LOC. The proper cure.

Manual settle was attempted: `UPDATE sources SET chunker_version='4',
last_commit='<HEAD>'` to bypass the gate. Subsequent sync still slow
(134s for one file) → implies the slowness is NOT the chunker gate but
something else in sync's import/extract/embed phases on this brain.

### Other surprise from Wave 1
- 6 zombie `gbrain sync` subprocesses (200-700 min CPU each, parented
  to PID 1, ignored SIGTERM) had been holding the PGLite lock for
  hours. SIGKILL released them. spawnAsync's timeout-driven SIGKILL
  should prevent regression but D-state children may still leak.
- v0.21.0 doctor's `graph_coverage` reports 0% despite 8229 links +
  11084 timeline entries existing. Likely new metric only counts
  `code_edges_*` tables. P2 follow-up.

---

## 1. Current state (2026-04-29 04:30 local)

| Layer | Status |
|---|---|
| Engine | PGLite 0.4.4 (fork-pinned), schema **v29** |
| Pages | 2117 (incl. 2 test pages from spawnAsync smoke: `sources/test-async-smoke-2026-04-29.md` + `test-async-smoke-2-2026-04-29.md`) |
| Chunks | 4023 (100% embedded) |
| Links | 8229 |
| Timeline | 11084 |
| Orphans | 732 (4-27 close baseline) |
| brain_score | 85/100 stable |
| doctor health | 85/100 (3 PGLite-quirk WARN + new graph_coverage WARN, no FAIL) |
| Upstream sync | **v0.22.8** (was v0.20.4); commit `811c266` |
| `sources.chunker_version` | **manually pinned to '4'** by SQL UPDATE this session — NOT settled by a real walk |
| `sources.last_commit` | **manually pinned** to `3dee3c4f...` (HEAD as of 03:30) — may have drifted since |
| Production endpoint | `kos.chenge.ink` → cloudflared → :7225 (latest PID at handoff time: 37656) |
| Embed shim | :7222 gemini-embedding-2-preview (PID 2502) |

### Running services (`launchctl print gui/$UID`) — **partially down**

| Service | State |
|---|---|
| `com.jarvis.kos-compat-api` | ✅ running (re-bootstrapped post-fix on async code) |
| `com.jarvis.gemini-embed-shim` | ✅ running |
| `com.jarvis.cloudflared` | ✅ running (kos.chenge.ink tunnel) |
| `com.jarvis.dream-cycle` | ✅ idle (will fire daily 03:11 local) |
| `com.jarvis.kos-patrol` | ✅ idle |
| `com.jarvis.enrich-sweep` | ✅ idle |
| `com.jarvis.kos-deep-lint` | ✅ idle (weekly Mon) |
| `com.jarvis.star-office-ui-backend` | ✅ running (unrelated) |
| **`com.jarvis.notion-poller`** | **🔴 BOOTOUTED + DISABLED** — see P0 in TODO.md |

**Why notion-poller is down**: re-enabling it without P0 unblock would
re-introduce the deadlock loop. Wave 2 fixed the event-loop block
(/status now stays responsive), but each individual /ingest is still
slow (90-180s). notion-poller fires every 5 min → would spawn N gbrain
sync subprocesses queuing on PGLite lock. spawnAsync's timeout-SIGKILL
prevents zombie pile-up but ingestion would still fail
(500 returned to notion-poller per page). **Notion → KOS ingestion is
paused** until P0 unblocks via Path 1 (full re-walk) or Path 2 (方案 B).

### Fork-local patches state

| File | What | Status |
|---|---|---|
| `src/core/pglite-schema.ts` idx_pages_source_id | **DROPPED** (closed by v0.22.6.1) | upstream verbatim restored |
| `src/core/pglite-engine.ts:89` `pg_switch_wal()` | RETAINED | macOS 26.3 WASM persistence — upstream doesn't address |
| `src/cli.ts` mode 0755 | RETAINED | bun shim symlink |

---

## 2. What the previous session did

[`docs/JARVIS-ARCHITECTURE.md §6.17`](JARVIS-ARCHITECTURE.md#617-upstream-v0228-sync-2026-04-29-commit-811c266)
has the full story. Summary:

- **Phase 0 (5 min)** — diagnosed kos-compat-api `-9` from launchctl print
  as the legitimate `:7220 → :7225` cutover sequence (commit `05046c4`).
  Not a bug.
- **Phase A (15 min)** — `/tmp/gbrain-changelog-peek` smoke against a
  453MB copy of production brain.pglite. Confirmed v0.22.6.1's
  `applyForwardReferenceBootstrap()` walks v24 → v29 cleanly. Side
  effect discovered: v0.11.0's autopilot orchestrator unconditionally
  installs `com.gbrain.autopilot` launchd which conflicts with our
  brain dir. Mitigation: not needed today (v0.11.0 ledger was already
  `complete` from 2026-04-22), but for future first-runs set
  `gbrain config set minion_mode off` BEFORE `apply-migrations`.
- **Phase B (~20 min)** — `git merge upstream/master`. 7 files
  auto-merged, 3 manual (package.json, bun.lock, pglite-schema.ts).
  Commit `811c266`. **Surprise**: `bun install` to regenerate
  `bun.lock` triggered `postinstall` hook = `gbrain apply-migrations
  --yes --non-interactive` against PRODUCTION brain. Worked fine
  thanks to v0.22.6.1 bootstrap; production schema went 24 → 29
  inside Phase B (v0.21.0 + v0.22.4 ledger entries at 07:13:32 UTC).
- **Phase C (~30 min)** — bootouted 6 jarvis services, took
  550MB PGLite snapshot at `~/.gbrain/brain.pglite.pre-sync-v0.22.8-1777447016`,
  ran doctor (schema=29 ✓), bootstrapped services back. **Surprise**:
  `gbrain stats` initially timed out on lock — investigation surfaced
  6 zombie `gbrain sync` subprocesses (PIDs 23625/36238/57969/58201/62243/70599)
  with 200-700 min CPU each. SIGTERM ignored; SIGKILL released. Production
  /status 200 in 298ms, /query (Chinese) 200 in 11.7s.
- **Phase D (~10 min)** — wrote `§6.17`, this handoff, new TODO.md,
  updated `v018-pglite-upgrade-fix.md` with closed-by-v0.22.6.1
  status check.

---

## 3. Next session: what to do

**Primary mission**: unblock notion-poller (P0). Two paths in TODO.md;
prefer Path 1 first because it's lower-risk.

### Step 1: production health re-check (5 min)

```bash
# 1. external + internal /status both alive?
TOKEN=$(grep -o '[a-f0-9]\{64\}' ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist | head -1)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7225/status | jq .total_pages
curl -s -H "Authorization: Bearer $TOKEN" https://kos.chenge.ink/status | jq .total_pages
# expect: both = 2117 (notion-poller bootouted means count is frozen)

# 2. zero zombies?
pgrep -lf 'gbrain sync\|gbrain extract\|workers/notion-poller'
# expect: empty

# 3. notion-poller still bootouted?
launchctl print "gui/$(id -u)/com.jarvis.notion-poller" 2>&1 | head -2
# expect: "Bad request. Could not find service..."

# 4. concurrency proof — spawnAsync fix still working
( curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7225/ingest \
    -X POST -H 'Content-Type: application/json' \
    -d '{"markdown":"# health check","slug":"smoke-'$(date +%s)'","source":"test","kind":"source","title":"smoke"}' &
)
sleep 1
time curl -s --max-time 5 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7225/status -o /dev/null
# expect: /status <500ms even though /ingest is in flight
```

### Step 2: P0 — pick a path to unblock notion-poller

#### Path 1 — full re-walk in maintenance window (try this first)

This session attempted Path 1 for 18 min and got 0 progress lines after
`[sync.imports] start`. Either it needs much longer, OR there's a real
wedge. Worth re-trying with closer observation:

```bash
# 1. Eliminate contention
launchctl bootout gui/$(id -u)/com.jarvis.kos-compat-api
pgrep -lf 'gbrain' | xargs -r kill -9
rm -rf ~/.gbrain/brain.pglite/.gbrain-lock

# 2. Reset chunker_version + last_commit to NULL (force a clean re-walk)
bun -e "import {BrainDb} from './skills/kos-jarvis/_lib/brain-db.ts';
const db = new BrainDb(); await db.open();
await (db as any).pg.query(\"UPDATE sources SET chunker_version=NULL, last_commit=NULL WHERE id='default'\");
await db.close();"

# 3. Fresh snapshot (the long op may need rollback)
cp -R ~/.gbrain/brain.pglite ~/.gbrain/brain.pglite.pre-rewalk-$(date +%s)

# 4. Run sync with NO timeout, log to file, observe via polling
gbrain sync --repo ~/brain --no-pull > /tmp/rewalk.out 2>&1 &
SP=$!
while kill -0 $SP 2>/dev/null; do
  sleep 30
  echo "T+$(ps -o etime= -p $SP 2>/dev/null | xargs):"
  tail -3 /tmp/rewalk.out
done
echo "DONE; verify settle"
bun -e "import {BrainDb} from './skills/kos-jarvis/_lib/brain-db.ts';
const db = new BrainDb(); await db.open();
console.log(await (db as any).pg.query('SELECT id, chunker_version, last_commit FROM sources').then(r=>r.rows));
await db.close();"

# 5. Bootstrap kos-compat-api back, smoke ingest speed
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist
TOKEN=$(grep -o '[a-f0-9]\{64\}' ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist | head -1)
time curl -s -H "Authorization: Bearer $TOKEN" -X POST http://127.0.0.1:7225/ingest \
  -H 'Content-Type: application/json' \
  -d '{"markdown":"# settle test","slug":"settle-test-'$(date +%s)'","source":"test","kind":"source","title":"settle"}'
# expect: <5 sec total (single-file diff against now-set last_commit)

# 6. If green, re-enable notion-poller + watch one cycle
launchctl enable user/$(id -u)/com.jarvis.notion-poller
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jarvis.notion-poller.plist
sleep 360  # one 5-min cycle
pgrep -lf 'gbrain sync'   # expect: empty (no zombies)
```

If the sync wedges with 0 progress for 10+ min after `[sync.imports]
start`: STOP. Capture state via `sample $SP 30` or `lldb -p $SP` to
see what it's blocked on. May need an upstream issue. Defer to Path 2.

#### Path 2 — 方案 B: in-process BrainDb writes

If Path 1 is unworkable, refactor `server/kos-compat-api.ts` `/ingest`
to call BrainDb's TypeScript API directly. ~150 LOC, depends on
extending [`skills/kos-jarvis/_lib/brain-db.ts`](../skills/kos-jarvis/_lib/brain-db.ts) with:

- `putPage(slug, frontmatter, body, contentHash)` — DB upsert + chunk + replace
- `extractLinks(slug)` — port of upstream's `link-extraction.ts`
- `extractTimeline(slug)` — port of upstream's timeline parser
- `embedChunks(slug, chunkIds)` — call gemini-embed-shim HTTP, write back

After this lands, /ingest runs everything in-process: no spawn, no
PGLite cross-process lock, no timeout cliff, no zombies. Re-enable
notion-poller post-merge.

### Step 3: graph_coverage 0% (P2, can defer)

```bash
bun run src/cli.ts link-extract 2>&1 | tail -10
bun run src/cli.ts timeline-extract 2>&1 | tail -10
bun run src/cli.ts doctor 2>&1 | grep graph_coverage
```

If still 0%, accept it as a code-edge-only metric (we have ~no code)
and document in README/handoff so future syncs don't re-investigate.

### Step 4 (optional): unfinished calendar checkpoints

| Date | Action |
|---|---|
| 2026-05-04 (5 days) | Stage 4 v1 archive: move `com.jarvis.kos-api.plist.bak` to `~/Library/LaunchAgents/_archive/`, archive v1 GitHub repo |
| 2026-05-07 (8 days) | Step 2.4 commit-batching review |
| 2026-05-25 (26 days) | Re-evaluate Gemini 3072-dim embeddings vs current 1536-dim truncation |
| Trigger-based | PGLite → Postgres switch — `docs/UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md` |

---

## 4. Where to look (file map)

### Entry points
- [`CLAUDE.md`](../CLAUDE.md) — fork preamble + upstream context
- [`skills/kos-jarvis/README.md`](../skills/kos-jarvis/README.md) — extension pack scope
- **THIS FILE** — start here
- [`skills/kos-jarvis/TODO.md`](../skills/kos-jarvis/TODO.md) — fresh post-v0.22.8 TODO
- [`docs/JARVIS-ARCHITECTURE.md`](JARVIS-ARCHITECTURE.md) — full architecture, **§6.17 = most recent**

### Recent decision artifacts
- [`docs/UPSTREAM-PATCHES/v018-pglite-upgrade-fix.md`](UPSTREAM-PATCHES/v018-pglite-upgrade-fix.md) — annotated CLOSED 2026-04-29
- [`docs/UPSTREAM-PATCHES/v018-pglite-wal-durability-fix.md`](UPSTREAM-PATCHES/v018-pglite-wal-durability-fix.md) — still active
- [`docs/UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md`](UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md) — read before Postgres switch

---

## 5. Day-zero checks (sandbox-aware)

```bash
# 1. service health
launchctl print gui/$(id -u) 2>&1 | grep com.jarvis | head -10

# 2. brain stats (run in fork repo dir, with sandbox bypass if needed)
bun run src/cli.ts stats 2>&1 | head -10

# 3. doctor health
bun run src/cli.ts doctor 2>&1 | grep -E "Health score|FAIL"

# 4. fork patch sanity
grep -n "pg_switch_wal" src/core/pglite-engine.ts                   # ~line 89
grep -n "applyForwardReferenceBootstrap" src/core/pglite-engine.ts  # ~line 137 (upstream, not fork)
grep -n "idx_pages_source_id" src/core/pglite-schema.ts             # exists at line ~66 (RESTORED upstream verbatim)
ls -l src/cli.ts | awk '{print $1}'                                 # -rwxr-xr-x

# 5. zombie sync subprocess check
pgrep -lf 'gbrain sync.*--no-pull' || echo "no zombies (good)"

# 6. config sanity
cat ~/.gbrain/config.json
```

---

## 6. Things off the plate (still)

- v0.22.6 schema self-healing — Postgres + PgBouncer, PGLite no-op
- v0.22.7 built-in HTTP MCP transport — we use stdio MCP
- v0.22.8 doctor integrity batch-load — Postgres-only path
- v0.22.0 source-aware boost tune-up — defer 1 week to observe baseline

---

## 7. Open upstream issues to watch

| Issue | Status | Action when merged |
|---|---|---|
| ~~[#370](https://github.com/garrytan/gbrain/issues/370)~~ | **CLOSED 2026-04-26 (v0.22.6.1 / PR #440)** | done — fork patch already dropped |
| [#394](https://github.com/garrytan/gbrain/issues/394) `gbrain dream --json` stdout pollution | open as of v0.22.8 | remove defensive slice in `dream-wrap/run.ts` |
| WAL durability bug | not filed | file when repro is scriptable |

---

## End of handoff

Production:
- Code: v0.22.8 fork master, pushed to `origin/master` (4 commits beyond
  the v0.22.8 sync alone).
- Schema: v29, 2117 pages, brain_score 85/100, doctor health 85/100.
- External: `kos.chenge.ink` ✅ responsive (recovered from earlier
  CF-tunnel block via Wave-2 spawnAsync fix).
- Notion-poller: 🔴 **DISABLED**. Notion → KOS ingestion is paused
  until P0 unblocks. Re-enable only after Path 1 (full re-walk) or
  Path 2 (方案 B in-process) lands successfully.

Next session's mission: P0 — pick a path and execute. See §3 above.
