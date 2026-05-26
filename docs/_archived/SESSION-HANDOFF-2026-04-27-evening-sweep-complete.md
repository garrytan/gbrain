# Session Handoff — Tier 1 Sweep + Long-Tail Closure Complete

> **Date**: 2026-04-27 (late evening)
> **From**: Lucien × Jarvis (post-v0.20.4 maintenance sweep)
> **To**: next Claude Code session picking up Jarvis KOS v2 work
> **TL;DR**: Tier 1 maintenance closed, frontmatter-ref-fix v2 shipped,
> 4 orphan-reducer rounds run (793 → 732). TODO.md archived. Start
> fresh: re-survey upstream gbrain, build new pain-point list.
>
> **Supersedes**: [`SESSION-HANDOFF-2026-04-27-post-v0.20-sync.md`](SESSION-HANDOFF-2026-04-27-post-v0.20-sync.md)
> (use this one).

---

## 0. 速读 (read this first, 30 seconds)

The brain is **green and quieter**. Two evening sweeps cleared every
ergonomic deficit the v0.20.4 sync surfaced:

- 4 lint ERRORs → 0
- 70 unresolved frontmatter long-tail refs → 0 (19 legitimate
  `raw_path:` entries remain, those are correct)
- Orphans 814 → **732** across 4 orphan-reducer rounds
  ($1.354 total, ~$0.34/round)
- New `frontmatter-ref-fix` skill (v1 + v2) lives at
  `skills/kos-jarvis/frontmatter-ref-fix/`

`brain_score` is 85/100 stable (orphans component 12/15 is bucketed;
~100 more deorphans needed to reach 13/15). `gbrain doctor` reports
80/100 with no FAIL — the 3 WARN entries are PGLite-quirk
(`pgvector`, `graph_coverage`, `jsonb_integrity` checks all
documented as "Could not check" on PGLite vs Postgres). Production
is healthy.

**Nothing is overdue.** Step 2.4 commit-batching checkpoint is
2026-05-07 (10 days out). v1 archive is at +14 days (2026-05-04, 7
days out). Re-evaluate 3072-dim Gemini embeddings at +28 days
(2026-05-25).

**The user's instruction for this next session**: re-review upstream
`garrytan/gbrain` for new commits past v0.20.4, then build a fresh
TODO list from whatever the brain currently complains about. Don't
inherit the v1-wiki legacy backlog — it's all closed.

---

## 1. Current state (2026-04-27 23:50 local)

| Layer | Status |
|---|---|
| Engine | PGLite 0.4.4 (fork-pinned), schema v24 latest |
| Pages | 2118 |
| Chunks | 4023 (100% embedded) |
| Links | 8225 (frontmatter-derived; net -441 from morning's 8666 because v2 deleted 16 deadlinks + sync re-extract pruning; needs an audit pass next session if the count keeps drifting down) |
| Timeline entries | 11084 |
| Orphans | **732** (was 814 at sync time) |
| Brain score | 85/100 (embed 35/35, links 25/25, timeline 3/15, orphans 12/15, dead-links 10/10) |
| Doctor health | 80/100 (3 PGLite-quirk WARN, no FAIL) |
| Upstream sync | v0.20.4 (2026-04-25), latest fork commit `<§6.16-docs>` (this commit) |
| `~/brain` git | 13 ingest + 6 sweep commits across 24h, no remote pushed |
| Production endpoint | `kos.chenge.ink` → cloudflared → :7225 (kos-compat-api PID 61588) |
| Embed shim | `:7222` gemini-embedding-2-preview (PID 56860) |

### Running services (`launchctl list | grep jarvis`)

All 9 services unchanged from morning's handoff. PIDs steady, last
exits 0/1 (1 = lint-warn path, expected). PGLite handle is held by
PID 61588; CLI commands (`gbrain stats`, `gbrain orphans --count`)
will time out unless `kos-compat-api` is briefly bootouted. The
in-process direct-PGLite reader at `skills/kos-jarvis/_lib/brain-db.ts`
sidesteps this for skill code (orphan-reducer, kos-patrol,
frontmatter-ref-fix all use it via subprocess `gbrain link`).

### Fork-local patches (re-verified)

| File | What | Status |
|---|---|---|
| `src/core/pglite-schema.ts:65` | `idx_pages_source_id` index commented out | upstream #370 still open |
| `src/core/pglite-engine.ts:87` | `SELECT pg_switch_wal()` before `db.close()` | macOS 26.3 WASM persistence bug (no upstream issue yet) |
| `src/cli.ts mode 0755` | executable bit | bun shim at `~/.bun/bin/gbrain → src/cli.ts` |

---

## 2. What the previous session did

Two consecutive sweeps in one ~30-minute window:

### §6.15 — Tier 1 maintenance sweep

- 4 lint ERROR fixes (sources/* missing `updated:` field) — brain `eadf1d3`
- orphan-reducer round 1 — `--apply --limit 100` → 89 edges, $0.336, brain `5a6a584`
- frontmatter-ref-fix **v1** (new skill) — 150 of 220 refs normalized,
  brain `d6be7ce`, fork `0695a6c`
- Docs — fork `f0cadd3`

### §6.16 — Long-tail closure

- frontmatter-ref-fix **v2** (extends v1):
  `EXTERNAL_POINTER_KEYS` allowlist + bare-slug fuzzy resolve via
  basename index + opt-in `--delete-external` / `--delete-dead`.
  Sweep cleared the v1 long tail (70 → 0): 35 fuzzy + 19
  `raw_path`-skipped + 9 external-deleted + 7 dead-deleted. Fork
  `cf236a4`, brain `f76f5c3`.
- orphan-reducer rounds 2-4 — 78 + 71 + 37 = **186 edges** added,
  $1.018, brain `6c666bb` / `9159bfd` / `a2efc02`. Round 4's drop
  to 37 edges is the practical saturation signal.
- Docs (this commit) — TODO.md archived, §6.16 written, this handoff.

Full story in [`docs/JARVIS-ARCHITECTURE.md §6.15-§6.16`](JARVIS-ARCHITECTURE.md#615-tier-1-maintenance-sweep--orphan-reducer--frontmatter-ref-fix-2026-04-27-evening).

---

## 3. Next session: what to do

The previous TODO.md (`skills/kos-jarvis/TODO.md`) is archived. The
v1-wiki legacy backlog that drove most of those entries is gone.
**Don't try to keep working from that file.** Read it for archeology
only.

### Step 1: re-survey upstream

```bash
cd /Users/chenyuanquan/Projects/jarvis-knowledge-os-v2
git fetch upstream
git log --oneline pre-sync-v0.20-1777105378..upstream/master | head -30
# scan for commits past v0.20.4. If any look meaningful, queue a sync.
```

### Step 2: re-survey production state

```bash
# brain count drift since 2026-04-27 close (expect +N from notion-poller).
bun run src/cli.ts stats 2>&1 | head -20

# health (expect Health 80/100 still).
bun run src/cli.ts doctor 2>&1 | grep -E "Health score|FAIL|WARN" | head -15

# patrol's most recent dashboard.
ls -t ~/brain/.agent/dashboards/ | head -3

# dream cycle's last run.
cat ~/brain/.agent/dream-cycles/latest.json | python3 -m json.tool | head -40
```

### Step 3: build a fresh TODO list

Identify pain from current production, not the closed v1-wiki backlog:

- New `dangling_refs` count after a fresh `gbrain extract --include-frontmatter`.
- Lint ERROR / WARN count vs the closing 0/837.
- Orphans count drift — is notion-poller piling new orphans faster
  than weekly orphan-reducer can clear them?
- New cron failures in `launchctl list | grep jarvis | grep -v 0$`.
- Doctor warnings beyond the 3 PGLite-quirk entries.

Then write a NEW `skills/kos-jarvis/TODO.md` from scratch (or append
under a fresh header) — not by editing the archived one.

### Step 4 (optional): unfinished calendar checkpoints

| Date | Action |
|---|---|
| 2026-05-04 (~7d) | Stage 4 v1 archive: move `com.jarvis.kos-api.plist.bak` to `~/Library/LaunchAgents/_archive/`, archive v1 GitHub repo |
| 2026-05-07 (~10d) | Step 2.4 commit-batching review: per-ingest commits in `~/brain` are still un-batched; decide if it's worth wrapping dream-cycle with end-of-cycle commit amalgamation |
| 2026-05-25 (~28d) | Re-evaluate Gemini 3072-dim embeddings vs current 1536-dim truncation |
| Trigger-based | PGLite → Postgres switch — see [evaluation doc](UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md) |

---

## 4. Where to look (file map, unchanged from morning)

### Entry points

- [`CLAUDE.md`](../CLAUDE.md) ... fork preamble + upstream context
- [`skills/kos-jarvis/README.md`](../skills/kos-jarvis/README.md) ... extension pack scope
- **THIS FILE** ... 2026-04-27 evening close (start here)
- [`skills/kos-jarvis/TODO.md`](../skills/kos-jarvis/TODO.md) ... ARCHIVED, archeology only
- [`docs/JARVIS-ARCHITECTURE.md`](JARVIS-ARCHITECTURE.md) ... full architecture, §6.16 = most recent

### Fork-local skills

- [`skills/kos-jarvis/orphan-reducer/`](../skills/kos-jarvis/orphan-reducer/) ... $0.34/100 orphans, weekly cadence
- [`skills/kos-jarvis/frontmatter-ref-fix/`](../skills/kos-jarvis/frontmatter-ref-fix/) ... v2 (this session); idempotent
- [`skills/kos-jarvis/kos-patrol/`](../skills/kos-jarvis/kos-patrol/) ... daily 03:11 cron dashboard generator
- [`skills/kos-jarvis/_lib/brain-db.ts`](../skills/kos-jarvis/_lib/brain-db.ts) ... shared direct-PGLite reader

### Recent decision artifacts

- [`docs/UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md`](UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md) ... read before suggesting Postgres switch
- [`docs/UPSTREAM-PATCHES/v018-pglite-upgrade-fix.md`](UPSTREAM-PATCHES/v018-pglite-upgrade-fix.md)
- [`docs/UPSTREAM-PATCHES/v018-pglite-wal-durability-fix.md`](UPSTREAM-PATCHES/v018-pglite-wal-durability-fix.md)

---

## 5. Day-zero checks for next session (sandbox-aware)

```bash
# 1. service health (PIDs should be stable from this handoff)
lsof -iTCP:7225 -sTCP:LISTEN | tail -1                 # kos-compat-api
lsof -iTCP:7222 -sTCP:LISTEN | tail -1                 # gemini-embed-shim
ls -t ~/brain/.agent/dashboards/ | head -1             # latest patrol

# 2. brain stats (CLI will fight kos-compat-api for the PGLite lock; if
#    timeout, that's expected — read the patrol dashboard instead).
bun run src/cli.ts stats 2>&1 | head -10

# 3. doctor (Health 80/100 expected, 3 PGLite-quirk WARN)
bun run src/cli.ts doctor 2>&1 | grep -E "Health score|FAIL"

# 4. fork patch sanity (3/3 should still be in place)
grep -nE "pg_switch_wal" src/core/pglite-engine.ts                    # ~line 87
grep -nE "^--.*idx_pages_source_id" src/core/pglite-schema.ts         # line 65
ls -l src/cli.ts | awk '{print $1}'                                   # -rwxr-xr-x

# 5. ANTHROPIC_BASE_URL via crs (used by orphan-reducer + future Haiku skills)
grep "ANTHROPIC_BASE_URL\\|ANTHROPIC_API_KEY" .env.local
```

---

## 6. Things explicitly off the plate (still)

Same as morning's handoff:

- Skipping v0.20 supervisor / queue_health / wedge-rescue /
  backpressure-audit ... all Postgres-only, defer indefinitely.
- PGLite → Postgres switch ... 4 named trigger conditions in the
  evaluation doc; none currently met.
- `~/brain` git history is at ~85 commits across 5 days. Not noisy
  enough to batch yet — Step 2.4 checkpoint at 2026-05-07 will revisit.
- kos-patrol exit code 1 is the lint-ERROR path, documented behavior.
  After this session lint ERRORs went 4 → 0; future patrol exits
  may go to 0 too. Both are fine.
- enrich-sweep cron exit 1 is the missing-`ANTHROPIC_API_KEY`-in-
  launchd-env path; manual runs work fine. Not blocking.

---

## 7. Open upstream issues to watch

| Issue | Status | Action when merged |
|---|---|---|
| [garrytan/gbrain#370](https://github.com/garrytan/gbrain/issues/370) | open as of v0.20.4 | drop fork patch in `src/core/pglite-schema.ts` |
| [garrytan/gbrain#394](https://github.com/garrytan/gbrain/issues/394) | open as of v0.20.4 (dream JSON stdout pollution) | remove defensive slice in `skills/kos-jarvis/dream-wrap/run.ts` |
| WAL durability bug | not filed | file when repro is scriptable |

---

## End of handoff

Pick up. The brain is healthy and the v1-wiki legacy is closed. Next
session has a clean slate.
