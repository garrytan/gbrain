# Session Handoff — Post v0.20.4 Upstream Sync

> **Date**: 2026-04-27 (sync landed 2026-04-25, 2-day soak healthy)
> **From**: Lucien × Jarvis (v0.20.4 sync session)
> **To**: next Claude Code session picking up Jarvis KOS v2 work
> **TL;DR**: Production is healthy, no P0 open. v0.20 sync absorbed cleanly.
> Pick up by reading this file → `skills/kos-jarvis/TODO.md` → done.

---

## 0. 速读 (read this first, 30 seconds)

The brain is **green**. Two days of dream cycles + kos-patrol + notion-poller
all exited 0 (or expected 1 = lint warnings). 1988 → **2091 pages** ingested
naturally over 2 days. Doctor `health 80/100`, brain_score `85/100` (was 86;
orphans drifted 711→814 because new notion ingests don't auto-link to the
existing graph). Nothing is on fire.

**The one routine maintenance task ready to pick up now**: another
`orphan-reducer --apply --limit 100` sweep. Runs ~5 min, costs ~$0.35,
brings orphans from 814 down ~90 to ~724. See §3 below.

**Nothing else is overdue.** Step 2.4 commit-batching checkpoint is
2026-05-07, still 10 days out. Filesystem-canonical is done. v1 archive
is at +14 days (~2026-05-04, 7 days out).

---

## 1. Project state right now

| Layer | Status |
|---|---|
| Engine | PGLite 0.4.4 (fork-pinned), schema v24 latest |
| Pages | 2091 (was 1988 at sync time, +103 from 2 days notion ingest) |
| Chunks | 3963 (100% embedded via Gemini shim) |
| Links | 8666 (frontmatter-derived, includes 14 unresolved cross-dir refs) |
| Timeline entries | 11084 |
| Orphans | 814 (was 711 post-sync; up because new pages don't auto-link) |
| Brain score | 85/100 (embed 35/35, links 25/25, timeline 3/15, orphans 12/15, dead-links 10/10) |
| Doctor health | 80/100 (no FAILs, 7 WARNs all from upstream resolver MECE/DRY) |
| Upstream sync | v0.20.4 (2026-04-25), `git log` HEAD `7e38517` |
| `~/brain` git | 5 ingest commits in last 2 days, no remote pushed yet |
| Production endpoint | `kos.chenge.ink` → cloudflared tunnel → :7220 (kos-compat-api PID 61588) |
| Embed shim | `:7222` gemini-embedding-2-preview (PID 56860) |

### Running services (`launchctl list | grep jarvis`)

| Service | PID | Cadence | Last exit |
|---|---|---|---|
| `com.jarvis.kos-compat-api` | 61588 | always-on | 0 (running) |
| `com.jarvis.gemini-embed-shim` | 56860 | always-on | 0 (running) |
| `com.jarvis.cloudflared` | 56870 | always-on | 0 (running) |
| `com.jarvis.notion-poller` | (cron) | 5min Path B direct bun-run | 0 |
| `com.jarvis.dream-cycle` | (cron) | daily 03:11 local | 0 (partial = lint warnings, expected) |
| `com.jarvis.kos-patrol` | (cron) | daily 03:11 local | 1 (lint ERROR path = expected) |
| `com.jarvis.enrich-sweep` | (cron) | weekly | 1 (no Anthropic key set in env) |
| `com.jarvis.kos-deep-lint` | (cron) | weekly | 0 |

`kos-deep-lint` runs against the v1 archive, not v2. Do not delete until v1 archive in §3.

### Fork-local patches (verified post v0.20.4 sync)

| File | What | Why kept |
|---|---|---|
| `src/core/pglite-schema.ts:65` | `idx_pages_source_id` index commented out | upstream #370 still open; index recreated in v21 migration |
| `src/core/pglite-engine.ts:87` | `SELECT pg_switch_wal()` before `db.close()` | macOS 26.3 WASM persistence bug |
| `src/cli.ts mode 0755` | executable bit | bun shim at `~/.bun/bin/gbrain → src/cli.ts` |

Documents: [`docs/UPSTREAM-PATCHES/v018-pglite-upgrade-fix.md`](UPSTREAM-PATCHES/v018-pglite-upgrade-fix.md), [`v018-pglite-wal-durability-fix.md`](UPSTREAM-PATCHES/v018-pglite-wal-durability-fix.md).

---

## 2. What was just done (the v0.20.4 sync, 2 commits)

```
7e38517 docs: post-v0.20-sync review — close P0 #332, add PGLite/Postgres evaluation, log §6.14
8665afb chore: sync upstream v0.18.2 → v0.20.4
```

### Closed P0

[`garrytan/gbrain#332`](https://github.com/garrytan/gbrain/issues/332) (v0.13 orchestrator partial-forever under bun-runtime install) ... fixed upstream in v0.19.0, our ledger walked through via `apply-migrations --force-retry 0.13.0` + `apply-migrations --yes`. Doctor 60→80.

### Skipped (intentional)

v0.20.2/0.20.3 supervisor + queue_health + wedge-rescue + backpressure-audit — all Postgres-only. Decision recorded in [`docs/UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md`](UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md). **Defer indefinitely** with 4 named trigger conditions.

### Rollback (don't unless needed)

```bash
git reset --hard pre-sync-v0.20-1777105378
cp -R ~/.gbrain/brain.pglite.pre-sync-v0.20-1777105391 ~/.gbrain/brain.pglite
launchctl bootout gui/$(id -u)/com.jarvis.kos-compat-api
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist
```

---

## 3. Next steps (priority-ordered, with concrete commands)

### Tier 1 — opportunistic, ~5 min each, no blockers

**A. Orphan-reducer sweep (orphans 814 → ~724)**

```bash
# always check current count first
bun run src/cli.ts orphans --count

# dry-run on a sample to verify Haiku quality
bun run skills/kos-jarvis/orphan-reducer/run.ts --limit 5 --dry-run

# then apply
export ANTHROPIC_API_KEY="..."   # check ~/.zshrc; the env is set in shell but not always in cron
bun run skills/kos-jarvis/orphan-reducer/run.ts --apply --limit 100
```

Cost ~$0.35, time ~5 min, expected drop: orphans -90, brain_score orphans
component +1 (12/15 → 13/15). Report lands at
`~/brain/.agent/reports/orphan-reducer-<ISO>.md`.

Recommended cadence: weekly until orphans <500. Currently 814 → 500 = ~3 more
sweeps, ~$1.

**B. Frontmatter cross-dir refs cleanup (14 broken)**

The v0.20 sync `extract --include-frontmatter` surfaced 14 dangling refs from
v1-wiki migration ... `../entities/jarvis.md`, `../sources/2026-04-13-...md`,
etc. Cosmetic (dead-end refs in graph), but easy to clean.

Build `skills/kos-jarvis/frontmatter-ref-fix/run.ts`:
1. Walk `~/brain/**/*.md` parsing frontmatter
2. For any `*.md`-suffixed cross-dir ref, rewrite to canonical slug
   (drop `.md`, drop `../entities/` → `entity/`, etc.)
3. `git -C ~/brain commit` per file or batch
4. `gbrain sync` once at end

Estimated 1-2 h. Tracked in `skills/kos-jarvis/TODO.md` P2.

### Tier 2 — calendar checkpoints

| Date | Action |
|---|---|
| 2026-05-04 (~7d) | Stage 4 v1 archive: move `com.jarvis.kos-api.plist.bak` to `~/Library/LaunchAgents/_archive/`, archive v1 GitHub repo |
| 2026-05-07 (~10d) | Step 2.4 commit-batching review: decide if per-ingest commits in `~/brain` git are too noisy (5 commits/2d so far ... fine), and whether to wire `git push` to a private remote |
| 2026-05-25 (~28d) | Re-evaluate Gemini 3072-dim embeddings vs current 1536-dim truncation (P2 in TODO.md) |
| Trigger-based | PGLite → Postgres switch ... see [evaluation doc](UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md) for the 4 triggers |

### Tier 3 — long-tail / open

- **P1 (Path C)**: refactor `kos-compat-api` `/ingest` to import gbrain in-process instead of `spawnSync('gbrain import')`. Removes lock-contention root cause for all callers. ~150 LOC in `server/kos-compat-api.ts`. Path B is the Band-Aid. Not urgent ... Path B has held 5 days.
- **P1 (upstream wait)**: [#370 PGLite upgrade fix](https://github.com/garrytan/gbrain/issues/370) ... when merged, drop our 1-line patch in `src/core/pglite-schema.ts`.
- **P1 (no upstream issue yet)**: WAL durability. The fork patch in `src/core/pglite-engine.ts:87` is the only thing keeping writes durable on macOS 26.3. Worth filing upstream once the repro is reliable enough to script.
- **P2**: Phase 4 calendar import + Phase 5 email import (see `docs/JARVIS-NEXT-STEPS.md` §3-§4).
- **P2**: kos-patrol phase 4 entity-gap stoplist tuning. Currently flags Notion DB column headers ("Has Attachments", "Action Required") as entity gaps. Stoplist landed in commit `a8094d2`, might need expansion as more notion templates land.

---

## 4. Where to look (file map)

### Entry points

- [`CLAUDE.md`](../CLAUDE.md) ... fork preamble + upstream context
- [`skills/kos-jarvis/README.md`](../skills/kos-jarvis/README.md) ... extension pack scope, upgrade policy
- [`skills/kos-jarvis/TODO.md`](../skills/kos-jarvis/TODO.md) ... live tracker, sorted by P0/P1/P2
- [`docs/JARVIS-ARCHITECTURE.md`](JARVIS-ARCHITECTURE.md) ... full architecture, sync history, runbook. §6.14 is the most recent (v0.20.4).

### Recent decision artifacts

- [`docs/UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md`](UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md) ... **read this before suggesting a Postgres switch.**
- [`docs/UPSTREAM-PATCHES/v018-pglite-upgrade-fix.md`](UPSTREAM-PATCHES/v018-pglite-upgrade-fix.md) ... fork patch #1 (#370 upstream)
- [`docs/UPSTREAM-PATCHES/v018-pglite-wal-durability-fix.md`](UPSTREAM-PATCHES/v018-pglite-wal-durability-fix.md) ... fork patch #2 (no upstream)
- [`docs/SESSION-HANDOFF-P1A-FILESYSTEM-CANONICAL.md`](SESSION-HANDOFF-P1A-FILESYSTEM-CANONICAL.md) ... predecessor handoff (Step 2.2/3.0 era), now mostly historical

### Run-state

- `~/.gbrain/brain.pglite/` ... 416 MB dataDir
- `~/.gbrain/brain.pglite.pre-sync-v0.20-1777105391/` ... rollback snapshot (delete after 7-day soak, ~2026-05-02)
- `~/.gbrain/migrations/completed.jsonl` ... migration ledger
- `~/.gbrain/upgrade-errors.jsonl` ... not present = no upgrade errors
- `~/brain/` ... filesystem-canonical brain (43 MB markdown + 21 MB git)
- `~/brain/.agent/dream-cycles/latest.json` ... most recent dream snapshot (read this for daily health)
- `~/brain/.agent/dashboards/knowledge-health-<date>.md` ... kos-patrol output
- `~/brain/.agent/digests/patrol-<date>.md` ... weekly OpenClaw MEMORY reflux
- `~/brain/.agent/reports/orphan-reducer-<ISO>.md` ... orphan sweep history

### Source code (don't edit unless fork patch)

- `src/core/pglite-engine.ts` ... fork patch at line 87
- `src/core/pglite-schema.ts` ... fork patch at line 65
- `src/cli.ts` ... mode 0755 (no content patch)
- `src/commands/migrations/` ... v0.20 added supervisor / wedge-rescue stuff, all Postgres-only
- `server/kos-compat-api.ts` ... fork-only HTTP boundary (NOT in src/, free to edit)
- `workers/notion-poller/run.ts` ... fork-only Notion poller (NOT in src/, free to edit)
- `skills/kos-jarvis/_lib/brain-db.ts` ... shared direct-PGLite reader for kos-jarvis skills

---

## 5. Day-zero checks for next session

```bash
# 1. quick health snapshot
bun run src/cli.ts stats             # expect ~2100 pages by now
bun run src/cli.ts orphans --count   # expect 800-900 absent intervention
bun run src/cli.ts doctor 2>&1 | grep -E "Health score|FAIL|WARN"

# 2. service status (sandbox-aware)
launchctl list | grep -E "jarvis"    # all should show pid or `-` with last_exit 0/1

# 3. last dream cycle
cat ~/brain/.agent/dream-cycles/latest.json | python3 -m json.tool | head -40

# 4. last patrol
ls -t ~/brain/.agent/dashboards/ | head -3

# 5. fork patch sanity
grep -nE "pg_switch_wal" src/core/pglite-engine.ts          # expect line 87
grep -nE "^--.*idx_pages_source_id" src/core/pglite-schema.ts   # expect line 65 commented
ls -l src/cli.ts | awk '{print $1}'                         # expect -rwxr-xr-x@
```

If any of these come back unexpectedly, **read this handoff before diagnosing**
... most "anomalies" are documented above.

---

## 6. Things explicitly NOT on the plate

These are recurring "is this a problem?" questions answered already:

- **Skipping v0.20 supervisor / queue_health**: yes intentional, Postgres-only. See §2.
- **PGLite → Postgres switch**: deferred. See `v020-pglite-postgres-evaluation.md`.
- **`~/brain` git history growing**: 5 ingest commits / 2 days = ~75/month, fine. Step 2.4 checkpoint will revisit batching at 2026-05-07.
- **kos-patrol exit code 1**: lint ERROR path, documented in `skills/kos-jarvis/kos-patrol/SKILL.md`. Expected when there are pages with frontmatter issues. Health 1845 warns is mostly from notion-poller frontmatter `kind:` (KOS) vs `type:` (gbrain native ... fixed in commit `76504eb`).
- **enrich-sweep cron exit 1**: missing `ANTHROPIC_API_KEY` in launchd env. Manual runs in shell work fine.
- **v0.13 partial in old logs**: closed by v0.20.4 sync. Anything reading `completed.jsonl` will see 3 partial + 1 complete entries; the latest `complete` wins per upstream `statusForVersion` logic.

---

## 7. If asked to "do something with the brain"

Likely intent (in order):
1. **Run a query**: use `bun run src/cli.ts query "<text>"` ... that's what `kos.chenge.ink` does.
2. **Check today's patrol**: `cat ~/brain/.agent/dashboards/knowledge-health-$(date +%Y-%m-%d).md`
3. **Add knowledge**: don't shell `gbrain import` ... write a markdown to `~/brain/<kind>/<slug>.md` and let `gbrain sync` pick it up on next dream cycle. Or `curl -X POST kos.chenge.ink/ingest` for the Notion-style payload.
4. **Sweep orphans**: §3 Tier 1A above.

Likely NOT intent:
- Modify `src/*` (fork policy violation unless joining the patch list)
- Edit upstream `skills/*/SKILL.md` (use `kos-jarvis/*/` instead)
- `git push` without asking (fork is technically public via Cloudflare; the
  remote has 50+ unpushed commits; that's a separate decision)

---

## 8. Open upstream issues to watch

| Issue | Status | Action when merged |
|---|---|---|
| [garrytan/gbrain#370](https://github.com/garrytan/gbrain/issues/370) | open as of v0.20.4 | drop fork patch in `src/core/pglite-schema.ts` |
| [garrytan/gbrain#332](https://github.com/garrytan/gbrain/issues/332) | merged in v0.19.0 ✓ | already absorbed in this sync |
| [garrytan/gbrain#394](https://github.com/garrytan/gbrain/issues/394) | open as of v0.20.4 (dream JSON stdout pollution) | remove defensive slice in `skills/kos-jarvis/dream-wrap/run.ts` |
| WAL durability bug | not filed | file when repro is scriptable |

---

## End of handoff

Pick up wherever you want. The code is in good shape; the documents are in
sync; the brain is ingesting and digesting. Most work from here is
maintenance + the calendar/email Phase 4 / Phase 5 expansion.
