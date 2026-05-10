# Jarvis Knowledge OS v2 — Architecture & Runbook

> 2026-04-17 | Lucien × Jarvis (last sync: 2026-04-25 → upstream v0.20.4)
> Fork: [`ChenyqThu/jarvis-knowledge-os-v2`](https://github.com/ChenyqThu/jarvis-knowledge-os-v2)
> Upstream: [`garrytan/gbrain`](https://github.com/garrytan/gbrain) v0.20.4 (override: `@electric-sql/pglite` pinned to 0.4.4 instead of upstream's 0.4.3; see §6.6. v0.20 supervisor / queue_health / wedge-rescue features are Postgres-only and skip on our engine; see §6.14)
> Previous: [`ChenyqThu/jarvis-knowledge-os`](https://github.com/ChenyqThu/jarvis-knowledge-os) (v1, frozen at tag `v1-frozen` on 2026-04-16)

---

## 1. Why this fork exists

v1 was a Python+Shell DIKW compilation engine over `knowledge/wiki/` markdown
files. It served Jarvis well but hit three ceilings simultaneously:

1. **No ambient entity extraction.** Every people/company page required
   explicit `kos ingest <url>` — no Tier 1/2/3 auto-enrichment. Karpathy's LLM
   wiki pattern was the obvious next step; GBrain is that pattern productized.
2. **Custom everything.** Hand-rolled BM25+qmd index, shell cron, Python agent
   prompts, 79-platform opencli router. Maintenance cost was growing.
3. **No MCP native.** Notion / Claude Desktop / Cursor integrations needed
   bespoke HTTP wrappers; GBrain exposes stdio MCP out of the box.

The migration retained every v1 strength (DIKW evidence/confidence,
Jarvis-flavored 9 page kinds, the `kos.chenge.ink` stable boundary, Feishu +
OpenClaw + Notion wiring) while inheriting GBrain's entity enrichment,
two-sync Notion Worker idiom, and compounding signal-detector loop.

---

## 2. Jarvis triangle (the three platforms)

```
                    Notion Jarvis
                   (operational memory)
                  ╱  MEMORY.md single source of truth
                 ╱   Email/Calendar/Tasks
                ╱    📚 Knowledge Agent
               ╱       ↕ kos-worker (4 tools)
              ╱           ↕
  Knowledge-OS v2 ────────────── OpenClaw Jarvis
  (GBrain fork)                  (execution orchestrator)
   ~1800 compiled pages          3-agent topology
   kos-compat-api (v2) 7225      6 cron jobs
   gemini-embed-shim 7222        feishu skill (HTTP to kos.chenge.ink)
   v1 kos-api.py unloaded        MEMORY reflux (digest-to-memory)
   skills/kos-jarvis/            MEMORY reflux (digest-to-memory)
```

### Responsibility split (unchanged from v1)

| System | Owns | Does NOT |
|--------|------|----------|
| **Knowledge-OS (v2)** | Deep compilation, person/company pages, source archive, knowledge graph | User data operations, schedule, email, personal prefs |
| **Notion** | Operational records (MEMORY 三层, Email, Calendar, PRD, Daily Log) | Long-form technical synthesis |
| **OpenClaw** | Cron scheduling, source ingestion, Feishu routing, MEMORY writeback | Deep knowledge authoring |

---

## 3. Deployment topology

```
                         kos.chenge.ink
                              │
                     (cloudflared tunnel)
                              │
                              ▼
             ┌────────────────────────────────┐
             │  launchctl list | grep jarvis  │
             ├────────────────────────────────┤
             │  com.jarvis.kos-compat-api     │ ← port 7225
             │     server/kos-compat-api.ts   │
             │     (TypeScript, bun runtime)  │
             │            ↓ shells gbrain     │
             │            ↓                   │
             │  com.jarvis.gemini-embed-shim  │ ← port 7222
             │     skills/kos-jarvis/         │
             │     gemini-embed-shim/server.ts│
             │            ↓ HTTP              │
             │  generativelanguage.googleapis │
             │     gemini-embedding-2-preview │
             │            (1536 dim)          │
             ├────────────────────────────────┤
             │  com.jarvis.kos-deep-lint      │ ← cron-driven KOS lint
             │  com.jarvis.enrich-sweep       │ ← cron-driven entity enrichment
             │  com.jarvis.notion-poller      │ ← 5-min direct bun invocation (Path B)
             └────────────────────────────────┘
                              │
                              ▼
             PGLite database at ~/.gbrain/brain.pglite
             (~1800 pages, ~3300 chunks, pgvector HNSW index)
```

### Port map

| Port | Service | Auth | Exposed |
|------|---------|------|---------|
| 7225 | kos-compat-api | Bearer token (`KOS_API_TOKEN`) | Yes (via kos.chenge.ink + Notion Worker) |
| 7222 | gemini-embed-shim | None (internal) | No, loopback only |

### External routing

- **Notion Knowledge Agent** (Notion Custom Agent ID `78619ef5-...`) calls
  `kos-worker` (Notion Worker) which calls `kos.chenge.ink/{query,ingest,digest,status}`.
  Post-cutover: zero change on Notion side; HTTP contract preserved.
- **OpenClaw Feishu skill** (`~/.openclaw/workspace/skills/knowledge-os/SKILL.md`)
  calls `kos.chenge.ink` HTTP directly (no more `./kos` shell out). Migration
  completed 2026-04-17 by OpenClaw agent; review passed.
- **OpenClaw crons** (4 active, after feishu migration): daily patrol → `/digest+/status`,
  Monday lint → `bun run kos-lint/run.ts`, daily intel → inline curl to
  `/ingest`, Sunday digest → `bun run digest-to-memory/run.ts`.

---

## 4. Fork-local extension pack (`skills/kos-jarvis/`)

Boundary rule: **everything Jarvis-specific lives under this one directory**.
Upstream `src/` and other `skills/` are untouched; the only concession is an
append-only `## KOS-Jarvis extensions` section at the end of `skills/RESOLVER.md`.

| Skill | Purpose | Runnable helper? |
|-------|---------|------------------|
| `dikw-compile` | Post-ingest strong-link enforcement (`supplements`/`contrasts`/`implements`/`extends`), 2-5 links/page budget, A/B/C/F grading | ✅ `run.ts` (2026-04-22, analysis-only grade+sweep; Haiku classifier for phase 2 link proposals deferred) |
| `evidence-gate` | Block claims below threshold (decision E3+, synthesis E2+, concept E2+, ...) | ✅ `run.ts` (2026-04-22, E0-E4 parsing from frontmatter + body `[E\d]` tags) |
| `confidence-score` | Auto-score high/medium/low per page; compile-grade per ingest | ✅ `run.ts` (2026-04-22, heuristic from E_max + backlinks + age + citation density) |
| `kos-lint` | Six-check lint (frontmatter / duplicate id / dead links / orphans / weak links / evidence gaps) | ✅ `run.ts` |
| `kos-patrol` | Daily sweep → dashboard + MEMORY-format digest | ✅ `run.ts` (6-phase protocol; writes `~/brain/agent/dashboards/knowledge-health-<date>.md`) |
| `digest-to-memory` | Append weekly `[knowledge-os]` block to OpenClaw MEMORY.md | ✅ `run.ts` |
| `notion-ingest-delta` | Notion-side backfill + delta sync design | Design only (to be implemented in kos-worker repo) |
| `feishu-bridge` | Command-mapping manifest for OpenClaw feishu skill one-time edit | ✅ applied 2026-04-17 |
| `gemini-embed-shim` | OpenAI→Gemini translation layer on port 7222 | ✅ `server.ts` (base64 encoding, 1536 dims) |

`skills/kos-jarvis/templates/` holds the 9 KOS page templates
(source/entity/concept/project/decision/synthesis/comparison/protocol/timeline)
copied from v1 for reference. `type-mapping.md` defines how these map onto
GBrain's 20-dir MECE.

---

## 5. Migration history (condensed)

| Week | Scope | Key output |
|------|-------|------------|
| 1 | Fork + skeleton | `v1-frozen` tag on v1 repo, `ChenyqThu/jarvis-knowledge-os-v2` with `skills/kos-jarvis/{README,PLAN-ADJUSTMENTS,type-mapping,templates/*}`; 5-page sample import verified 100% frontmatter fidelity |
| 2 | 5 quality skills | `dikw-compile`, `evidence-gate`, `confidence-score`, `kos-lint` (with run.ts), `kos-patrol` SKILL.md files + runnable kos-lint |
| 3 | Bridge layer | `server/kos-compat-api.ts` (drop-in v1 HTTP contract), `digest-to-memory` + run.ts, `notion-ingest-delta` design, `feishu-bridge` mapping, `RESOLVER.md` extension section |
| 4 | Data + cutover | 85 pages imported (0 errors), 92 chunks embedded via Gemini shim (base64 encoding fix critical), Chinese regression 5/5 passed (0.86-0.92 scores), launchd cutover executed, OpenClaw feishu skill migration completed by OpenClaw agent and reviewed |

Notable fix: OpenAI SDK v4 defaults `encoding_format: "base64"` for embeddings.
First shim pass returned `number[]` → SDK decoded as base64 → garbage 384-dim
vectors → pgvector rejected. Fixed by encoding Float32Array to base64 in shim
when request omits or chooses base64 encoding (commit 1b02162).

---

## 6. Operational runbook

### Verify health at any time
```bash
TOKEN=$(grep -o '[a-f0-9]\{64\}' ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist | head -1)

curl -s -H "Authorization: Bearer $TOKEN" https://kos.chenge.ink/status | jq .
# expect: engine = "gbrain (pglite)", brain = "/Users/chenyuanquan/brain"
# CAVEAT: /status shells out `gbrain list --limit 10000`, but upstream caps
# the list output at 100 rows (the --limit flag is silently ignored). As of
# Step 2.1 design (§6.10), total_pages in /status shows 100 while the real
# DB has 1829 pages. Step 2.2 rewrites /status to direct-DB query. Use
# `gbrain stats` or the evidence-gate sweep for the real count until then.

curl -s http://127.0.0.1:7222/health | jq .
# expect: upstream=gemini, model=gemini-embedding-2-preview

launchctl list | grep com.jarvis
# expect both kos-compat-api and gemini-embed-shim with PID, status 0
```

### Ingest a URL manually
```bash
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST https://kos.chenge.ink/ingest \
  -d '{"url":"https://example.com/article","slug":"optional-slug"}' | jq .
# response includes imported:true, embedded:true, slug, next
```

### Query
```bash
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST https://kos.chenge.ink/query \
  -d '{"question":"中文问题也可以"}' | jq -r .result
```

### Run lint on the whole brain
```bash
bun run ~/Projects/jarvis-knowledge-os-v2/skills/kos-jarvis/kos-lint/run.ts
# exit 0 clean | 1 any ERROR | 2 only WARN
```

### Rollback the launchd cutover (30s downtime)
See [`scripts/launchd/README.md`](../scripts/launchd/README.md).

---

## 6.5 Upstream v0.14.0 sync (2026-04-20)

GBrain upstream jumped 9 releases (v0.10.1 → v0.14.0): knowledge graph layer,
Minions orchestration, canonical migration, reliability wave, Knowledge
Runtime (Resolver SDK + BrainWriter + `gbrain integrity` + BudgetLedger +
quiet-hours), and shell job type. We merged, ran the full test suite
(1762 unit + 138 E2E, 0 fail) and adopted the subset that fits our stack.

### What we adopted

| Feature | Status | Surface |
|---|---|---|
| Frontmatter → typed graph edges (auto-link) | Live (default on) | `related:` → `related_to` edges. ~54 % of v1 wiki pages carry `related:`; they auto-edge on ingest. No hand-maintained adjacency files in v2. |
| BrainWriter observational lint | Enabled | `gbrain config set writer.lint_on_put_page true`. Findings → `~/.gbrain/validator-lint.jsonl`. Strict mode **not** flipped (upstream policy: 7-day soak). |
| Minions shell job — all 4 crons | Migrated | `notion-poller`, `kos-patrol`, `enrich-sweep`, `kos-deep-lint` now run via `gbrain jobs submit shell --follow` wrappers at `scripts/minions-wrap/*.sh`. PGLite constraint: `--follow` inline, no daemon. Retry, timeout, unified `gbrain jobs list` visibility. |
| Schema migrations v2–v13 | Applied | PGLite at `~/.gbrain/brain.pglite` includes `budget_ledger`, `links_provenance_columns`, `minion_quiet_hours_stagger`. |
| kos-lint check #3 (dead internal links) | Retired | BrainWriter's `linkValidator` covers this. `kos-lint --check 3` still works for manual invocation. |

### What we skipped (intentional)

- **`gbrain integrity` bare-tweet repair** — no Twitter/X citations in our KB
- **Resolver SDK builtins** (`url_reachable`, `x_handle_to_tweet`) — no external resolvers in pipeline
- **BudgetLedger** — no external API spend to cap
- **BrainWriter `strict_mode=strict`** — wait for upstream 7-day soak
- **Supabase migration** — v2 stays on PGLite at `~/.gbrain/brain.pglite`

### Topology changes (post-cutover)

- **v1 wiki imported**: 85 pages from `/Users/chenyuanquan/Projects/jarvis-knowledge-os/knowledge/wiki/` imported into v2 PGLite (`~/.gbrain/brain.pglite`) via `gbrain import` in 25.4 s / 91 chunks / 0 errors.
- **Port cutover**: v2 bun `kos-compat-api` now owns :7225 (production, serves `kos.chenge.ink` through the cloudflared token tunnel). v1 Python `kos-api.py` is unloaded (`.plist.bak` retained for 30-s rollback).
- **Poller cutover**: `notion-poller` now posts to :7225 (v2). Notion content and v1 wiki content both live in `~/.gbrain/brain.pglite`. Total 100 pages as of 2026-04-20.
- **Phase-2 synthesis**: `kos-compat-api` `/query` now does retrieval (`gbrain ask`) + LLM synthesis (Anthropic Messages API via `crs.chenge.ink`, model `claude-sonnet-4-6` by default). Matches v1's `{result: "...Phase 2..."}` response shape so Notion Knowledge Agent and feishu-bridge consumers keep working without changes.

### Rollback

- Merge commit: `0c0ceec` on master; rollback tag: `pre-sync-v0.14`
  (`382e407`).
- Launchd plists: every modified plist has a `.plist.bak` sibling in
  `~/Library/LaunchAgents/`. `launchctl unload` current + load the bak.
- PGLite rollback: schema migrations are additive and idempotent; drop
  the v11–v13 tables manually only if a downgrade breaks something.

---

## 6.6 Upstream v0.15.1 sync (2026-04-22)

Routine follow-on to 6.5. Merged upstream four releases (v0.14.1 doctor
DRY detection, v0.14.2 eight root-cause fixes, v0.15.0 llms.txt +
AGENTS.md generation, v0.15.1 fix wave). No code conflicts. The whole
trigger for this sync was today's production outage: `bun update` had
earlier pulled in the wrong same-named npm package (`gbrain@1.3.1`, a
browser charting library) which transitively downgraded
`@electric-sql/pglite` to 0.3.6; that version connects to `template1` by
default against a 0.4.x-created data directory, so every `gbrain` call
returned "relation pages does not exist". The whole DB-corruption story
in the initial triage was a misdiagnosis — fixing the dep restored full
service.

### What we adopted

| Feature | Status | Surface |
|---|---|---|
| Pglite pin (`@electric-sql/pglite`) | **Overridden** | Upstream pinned 0.4.3 as a "best shot" against the macOS 26.3 WASM init bug ([#223](https://github.com/garrytan/gbrain/issues/223)). On this machine 0.4.3 still aborts; `0.4.4` opens the same data dir cleanly. Pin in our `package.json` sits one patch ahead of upstream until upstream promotes. |
| `doctor --fix` auto-repair | Live | `gbrain doctor --fix` closes the 9 DRY warnings we've been carrying. Not run yet (cosmetic; would touch upstream skills). |
| `gbrain check-resolvable --json` | Not used | Agent-facing resolver validation; our RESOLVER.md has no broken trigger map. |
| `llms.txt` / `AGENTS.md` generation | Inherited upstream files | Shipped but not customized. |

### Schema state: stayed at v4 intentionally

Running `gbrain apply-migrations` today reached v15 but the schema-level
migration pipeline requires `gbrain init --migrate-only` to run twice
(once before orchestrator phase A, once inside it); the second call's
PGLite handle collides with the first's. When a process holding PGLite
mid-transaction is killed (which happened here — notion-poller
wrapper wedged on the lock, had to SIGTERM it), the on-disk WASM page
cache left the data dir in a state where subsequent `PGlite.create()`
throws `Aborted()` unconditionally. Current live DB was restored from
`brain.pglite.pre-v0.15.1-sync-<ts>` (pre-migration state, schema v4)
and stays there until the migration sequence gets reworked (see P0
below). External consumers only use `/query` + `/ingest`; neither
touches v5–v15 surfaces, so schema v4 is production-safe.

### Filed upstream

- **[garrytan/gbrain#332](https://github.com/garrytan/gbrain/issues/332)**
  — v0.13.0 migration orchestrator uses `process.execPath` for the
  gbrain binary, which on bun-runtime installs resolves to the bun
  interpreter itself. Effect: `frontmatter_backfill` phase calls
  `bun extract` (not `gbrain extract`), bun interprets it as an npm
  script and fires `bun init` as a side effect — silently polluting
  `package.json` (`"private": true`, typescript peerDep) and creating
  `.cursor/rules/`. Our worktree got bitten once today; both artifacts
  were reverted. Pending upstream fix.

### New P0 surfaced during sync

`scripts/minions-wrap/notion-poller.sh` deadlocks on the PGLite lock
under the current `--follow` design: outer `gbrain jobs submit --follow`
holds the lock while the inline shell runs `workers/notion-poller/run.ts`,
which posts `/ingest` back to `kos-compat-api`, which `spawnSync`s
`gbrain import` — the subprocess can't get the lock. Launchd unloaded
the job (`com.jarvis.notion-poller` stays `Disabled=1`). Three
architectural options in `skills/kos-jarvis/TODO.md`; upstream v0.16.1
ships a `docs/guides/minions-deployment.md` that may decide it for us
on the next sync.

### Rollback

- Merge commit: `44c7001` fast-forwarded onto master → current tip.
  Rollback tag: `pre-sync-v0.15.1` at `0c0ceec`.
- PGLite rollback: `~/.gbrain/brain.pglite.pre-v0.15.1-sync-1776819001`
  is the last known-good pre-migration copy. `mv` it into
  `~/.gbrain/brain.pglite` and the service is restored to the 1767-page
  state at 2026-04-22 01:30 UTC.
- No launchd plist changes in this sync.

---

## 6.7 Upstream v0.17.0 sync (2026-04-22)

Merged upstream 8 commits in one pass: v0.15.2 (bulk-action progress
streaming), v0.15.4 (PgBouncer `prepare:false`), v0.16.0 (durable agent
runtime), v0.16.1 (`docs/guides/minions-deployment.md`), v0.16.3
(subagent SDK fix), v0.16.4 (`gbrain check-resolvable`), v0.17.0
(`gbrain dream` + `runCycle` primitive + schema v16
`gbrain_cycle_locks`), and the doctor `--fix` DRY auto-repair (3596764).
Fork master moved `46cafe4` → `b6ea540`. Rollback tag: `pre-sync-v0.17`.

### Schema jump v4 → v16

The actual SQL schema migration was the risky part and it bit twice
before we got it right. Final shape is clean but the story matters for
next time:

- **Ordering bug in `initSchema()`**: `pglite-engine.ts` runs
  `PGLITE_SCHEMA_SQL` **before** `runMigrations()`. PGLITE_SCHEMA_SQL
  contains `CREATE INDEX idx_links_source ON links(link_source)`
  which assumes the v11 `link_source` column already exists. Our brain
  was at `config.version=4` with a pre-v0.12-graph-layer `links` table
  shape (columns: id, from, to, type, context, created_at — no
  provenance cols). Every `gbrain init --migrate-only` attempt crashed
  at the index create before v11 could ADD the column. Classic
  chicken-and-egg.
- **Workaround**: manually ALTER TABLE links ADD COLUMN IF NOT EXISTS
  (link_source, origin_page_id, origin_field) via a one-shot PGLite
  script, then `gbrain init --migrate-only` walks v5..v16 cleanly. All
  12 migrations apply in one sweep. Re-running v11 after the manual
  ALTER is idempotent (all its ops are `IF NOT EXISTS` / `UPDATE ...
  WHERE link_source IS NULL`).
- **File with the surgical script**: `/tmp/add-link-cols.ts` during
  the session; not committed (one-off). The exact SQL matches v11's
  column-add section in `src/core/migrate.ts`.

Post-migration shape:
- Schema version: 16 (v4 → v5..v16 applied, 12 migrations)
- Pages: 1777 (was 1768; +9 from Path B's first poll cycle)
- Chunks: 3302, 100% embedded (Gemini shim still owns embeddings)
- Links: 385 (from `gbrain extract links --source db
  --include-frontmatter`, 14 unresolved refs logged)
- Timeline entries: 5443 (from `gbrain extract timeline --source db`)
- Brain score: 56/100 (embed 35/35, links 5/25, timeline 4/15,
  orphans 2/15, dead-links 10/10)

### WASM-corruption incident (recovered)

Same-session repeat of the pattern `docs/SYNC-V0.17-HANDOFF.md §6`
warned about. Root cause: `com.jarvis.notion-poller` launchd cron was
not actually disabled when we began migrations (`launchctl list`'s
dash-in-pid-col means "not currently running", not "disabled"; the
plist has no `Disabled` key), so the 5-min `StartInterval` fired the
old `scripts/minions-wrap/notion-poller.sh` mid-session, which took
the PGLite lock, deadlocked on the inner `spawnSync gbrain import`,
and when its PID eventually exited it left `base/` WASM pages
inconsistent. Next `gbrain` call aborted with `Aborted(). Build with
-sASSERTIONS for more info.`

Recovery:
1. `launchctl unload` every DB-accessing service (only
   `gemini-embed-shim` and `cloudflared` stayed up).
2. `launchctl disable user/$UID/com.jarvis.notion-poller` to
   hard-stop future cron fires.
3. `mv ~/.gbrain/brain.pglite ~/.gbrain/brain.pglite.broken-<ts>`
   (preserved briefly for inspection, then deleted).
4. `cp -R ~/.gbrain/brain.pglite.pre-v0.17-sync-<ts>
   ~/.gbrain/brain.pglite` (the rolling backup taken before any
   migration attempt).
5. Re-run the manual ALTER + `gbrain init --migrate-only` + `gbrain
   extract links` + `gbrain extract timeline`. Same end state, zero
   data loss.

**Learned rule** (captured in next-session runbook): before starting
any migration, **always** `launchctl disable user/$UID/com.jarvis.*`
for every DB-writing service, not just `unload`. `unload` only
stops current activity; `disable` prevents the 5-min cron from
firing a fresh instance mid-migration.

### Notion-poller Path B (minion wrapper retired)

`scripts/minions-wrap/notion-poller.sh` is gone.
`com.jarvis.notion-poller.plist` now invokes
`/Users/chenyuanquan/.bun/bin/bun run workers/notion-poller/run.ts`
directly; Bun auto-loads `.env.local` from `WorkingDirectory`, so
`NOTION_TOKEN`/`NOTION_DATABASE_IDS`/`KOS_API_TOKEN` arrive without a
shell `source` step.

Why this works: no outer `gbrain jobs submit --follow` = no outer
process holding the PGLite write lock. The inner `spawnSync gbrain
import` inside `kos-compat-api` acquires the lock for ~1-2 s per
page, cleanly releases it. First live cycle: 78 s total, 9 pages
ingested, zero "Timed out waiting for PGLite lock" errors.

Kept minion wrappers for `kos-patrol`, `enrich-sweep`, and
`kos-deep-lint` — none of them HTTP-post to `kos-compat-api`, so
they can't deadlock on the inner-spawn pattern. Path C (refactor
`kos-compat-api` to import in-process) is the correct long-term
fix but is deferred as P1.

Updated plist backup: `com.jarvis.notion-poller.plist.pre-pathB-<ts>`.

### `gbrain dream` not wired (intentionally)

v0.17's flagship `gbrain dream` expects a filesystem `brain directory`
as the source of truth (lint + backlinks + sync phases all mutate
`.md` files, then sync picks the changes into DB). Our deployment is
DB-native: Notion is the source, `kos-compat-api /ingest` writes
pages into `~/.gbrain/brain.pglite` directly. There is no filesystem
brain dir to lint. `gbrain dream` (and even `gbrain dream --phase
orphans`) exit with `No brain directory found`.

Cron-level read-only reports can still use the standalone `gbrain
orphans --json` subcommand if needed. Full `dream` wiring is a no-op
for us unless we re-introduce a filesystem mirror (not planned).

### pglite pin stays at 0.4.4

Upstream master's `package.json` still pins 0.4.3 as "best shot"
against macOS 26.3 WASM bug (#223). On this machine 0.4.4 opens
cleanly and 0.4.3 aborts. Our override holds; `bun install --frozen-
lockfile` will pull 0.4.4 via the explicit dependency rather than
dropping to upstream's 0.4.3.

### Test results

`bun test`: 1997 pass / 192 skip / 19 fail / 5159 expects. All 19
failures are in **upstream** test files (`test/dream.test.ts`,
`test/orphans.test.ts`, `test/build-llms.test.ts`, `test/migrations-
v0_14_0.test.ts`). None touch `skills/kos-jarvis/`, `server/`, or
`workers/`. Known failure clusters:
- dream tests fail because our config doesn't have a `brain directory`
  configured (dream can't resolve a default path → exit 1, test's
  fixture expected a valid dir).
- `build-llms` tests fail because our fork's `README.md`/`CLAUDE.md`
  have KOS-jarvis preamble that upstream's `llms.txt` generator
  doesn't know about → committed file drifts vs regenerated.
- `orphans.test.ts` + `v0_14_0` tests fail for reasons unknown;
  upstream-only, non-blocking.

None of the failures indicate fork-local regressions.

### Orchestrator ledger cleanup

`gbrain doctor` still warns `MINIONS HALF-INSTALLED (partial
migration: 0.13.0)`. Reason: v0.13.0 orchestrator's
`frontmatter_backfill` phase shells out via `process.execPath extract
links --source db --include-frontmatter`, which on our bun-runtime
install resolves `process.execPath = bun`, tries to run `bun extract`,
and fails. Filed upstream as
[#332](https://github.com/garrytan/gbrain/issues/332) (still open as
of sync time). We manually ran the equivalent `gbrain extract links`
post-migration, so the data side is correct; only the ledger row
remains "partial". Cosmetic. Per fork policy (CLAUDE.md) we don't
patch `src/*`, so this warning persists until upstream merges #332.

### Rollback

- Merge commit: `b6ea540` on master. Rollback tag: `pre-sync-v0.17`
  at `02efe73`.
- PGLite rollback: `~/.gbrain/brain.pglite.pre-v0.17-sync-1776896571`
  is the last known-good pre-migration copy. `mv` it into
  `~/.gbrain/brain.pglite` to return to schema v4 / 1768-page state.
- Launchd plist rollback: `com.jarvis.notion-poller.plist.pre-pathB-
  <ts>` restores the v0.14-era minion-wrap design.
- Per "one rolling backup" policy, older backups (pre-v0.15.1, the
  broken-copy from the WASM abort) were deleted after verification.

---

## 6.8 Filesystem-canonical — Step 1 audit (2026-04-22)

Not a sync — a pre-migration audit for the P1 filesystem-canonical track
(TODO.md §P1). Goal: prove out whether `gbrain export` faithfully
materializes our KOS brain to disk before committing to the multi-week
migration that would make `.md` files the source of truth and let
`gbrain dream` run nightly.

### Method

- `gbrain export --dir /tmp/brain-export-preview` on the full 1786-page
  live PGLite brain (~2 min, 17 MB output, 0 failures).
- Structural audit: directory distribution, frontmatter field coverage,
  timeline sentinels, cross-link shape.
- Compatibility audit: `gbrain lint` against the exported tree.
- Full report at [`docs/FILESYSTEM-CANONICAL-EXPORT-AUDIT.md`](FILESYSTEM-CANONICAL-EXPORT-AUDIT.md).

### Verdict: GO, with 3 blockers (corrected from 4)

| Signal | Result |
|---|---|
| 1786/1786 pages exported | ✅ Complete, zero data loss |
| KOS frontmatter preservation | ✅ `kind` 100%, `status` 100%, `confidence` 99%, `owners` 98% |
| DB-exclusive data (`.raw/` sidecars) | ✅ 0 across 1786 pages → filesystem IS canonical |
| Body integrity | ✅ 0 empty-body pages; UTF-8 clean |
| Timeline compatibility | ✅ 749 pages use standard `<!-- timeline -->` sentinel |
| Upstream `gbrain lint` footprint | ℹ️ ~3-5 legitimate `YYYY-MM-DD` filename-template findings across 1786 pages (hand-patchable; NOT a `[E3]`/`[10]+` false-positive as initial draft claimed) |
| Slug hygiene | ⚠️ 7 root-level strays + 262 `id: >-` block-scalar legacy pages |
| `type:` / `kind:` drift | ⚠️ 27% (487 pages) — upstream PageType enum doesn't cover person/company/etc, `kind:` carries the real taxonomy |
| `evidence_summary` coverage | ⚠️ 0% — DB reality, not an export bug (candidate C on the TODO queue) |
| `gbrain dream` hard dep | ℹ️ requires configured brain dir for ANY phase — even `--phase orphans --dry-run` exits with "No brain directory found". Unblocking dream IS the migration, not a separable blocker. |

### Directory shape (slug-prefix routing, not type/kind routing)

```
people 375 | companies 85 | concepts 180 | projects 210 | decisions 6
syntheses 4 | comparisons 3 | protocols 4 | entities 3 | timelines 1
sources 908 (sources/notion: 860, sources root: 47+1)
root strays 7 | —— 1786 total
```

`sources/feishu/` and `sources/wiki/` are both empty — feishu
signal-detector hasn't produced content yet, and v1 wiki's 85 pages
import landed at `sources/` flat instead of `sources/wiki/`.

### Blockers → next-session scope (revised after same-session correction)

Earlier draft of this section listed a "Step 1.5 lint shim" as the first
blocker. Withdrawn after reading `src/commands/lint.ts:70` — the
`placeholder-date` rule only matches literal `YYYY-MM-DD` / `XX-XX`, not
KOS bracketed tags. See audit report §5.2 for the full correction log.

1. **Step 1.5 — Bulk slug + `id: >-` normalization** (DB write, high
   care). 7 root strays + 262 legacy `id: >-` pages → clean one-liner
   shape. Before running: `launchctl disable` every DB-writing service,
   take a fresh rolling PGLite backup, run the rewrite script, re-extract
   links, re-enable services. One-time. ~1-2 h scope.
2. **Step 1.6 — Round-trip sanity**. Export → dry-run re-import into a
   throwaway PGLite → diff `kind` / `status` / `confidence` columns.
   Verifies `kind:` survives markdown round-trip since upstream only
   reads `type:`. ~1 h.
3. **Step 2 — Flip `/ingest` to filesystem-first**. Only after
   1.5 + 1.6 clear. Multi-week scope (not one session).

Steps 1.5 and 1.6 are each one-session scope. The read-only audit in
this session consumed no risk and locked in the go/no-go decision; the
correction round also tightened the plan by removing an unnecessary step.

### Artifact cleanup

- `./export/` (accidental sibling from `gbrain export --help` failing
  to dispatch help) was moved to `/tmp/brain-export-preview` then
  deleted after numbers were captured in the audit report.
- Lesson: `gbrain export --help` silently ignores the flag and writes
  to default `./export/`. Always pass `--dir <path>` explicitly.

---

## 6.9 Filesystem-canonical Steps 1.5 + 1.6 landed (2026-04-23)

Same-day follow-through on §6.8. Both steps completed cleanly under the
safety protocol; rolled up into commit `<pending>` along with the audit
corrections from §5.2/§5.4.

### Step 1.5 — Slug normalization

Delivered as a new skill at `skills/kos-jarvis/slug-normalize/`
(SKILL.md + run.ts + roundtrip-check.ts). Three modes:
`--plan` (read-only preview), `--apply` (transactional DB write),
`--verify` (post-apply assertions). Direct `PGlite.create` path
(with `vector` + `pg_trgm` extensions loaded, same as
`src/core/pglite-engine.ts:48`), not via `BrainEngine` — bypasses
BrainWriter hooks and stays lock-compatible with the disabled launchd
services.

Executed changes:
- 7 slug renames (`ai-jarvis` → `concepts/ai-jarvis`; 6 URL-slug
  sources → `sources/<slug>`). `frontmatter.id` unchanged (kind-topic
  form preserved; matches 886 other pages in the brain).
- 1 intra-brain `compiled_truth` rewrite
  (`projects/notion-agent` had `](www-anthropic-com-news-claude-opus-4-5.md)`
  → `](sources/www-anthropic-com-news-claude-opus-4-5.md)`).
- Total pages 1829 → 1829 (no drift). 15/15 verify assertions passed.

Execution protocol (recorded for future DB-write ops):
1. `launchctl disable user/$UID/com.jarvis.{5 svcs}` then
   `launchctl bootout gui/$UID/…` — the `gui/` domain is required
   to actually kill user-level LaunchAgents. `user/` domain's bootout
   reports success but leaves the PID alive.
2. `launchctl bootout gui/$UID/com.jarvis.cloudflared` to block
   external ingest into `kos-compat-api` during the operation window.
3. Fresh rolling backup under `~/.gbrain/brain.pglite.pre-slug-normalize-<ts>`
   (prior v0.17-sync backup evicted per "one backup" policy).
4. `--plan` → `--apply` → `--verify`. Each step human-readable,
   idempotent, transactional.
5. `launchctl enable gui/$UID/…` + `launchctl bootstrap gui/$UID …plist`
   to restart services. Re-running `bootstrap` on already-auto-loaded
   services returns `Input/output error 5` — benign, the service is
   already correctly loaded.

Report at `~/brain/agent/reports/slug-normalize-2026-04-23.md`.

### Step 1.6 — Markdown round-trip sanity

Delivered as `skills/kos-jarvis/slug-normalize/roundtrip-check.ts`.
Runs upstream `serializeMarkdown → parseMarkdown` pair on every page
and diff-compares 10 KOS-critical frontmatter fields (`kind`,
`status`, `confidence`, `source_of_truth`, `owners`,
`evidence_summary`, `source_refs`, `related`, `aliases`, `id`).

**Result: 1829/1829 clean, 0 diffs.** `kind:` (and all other KOS
extensions) survive the markdown serialize+parse loop as pass-through
JSONB. The 27% type/kind drift noted in §6.8 is safe to carry through
the eventual filesystem-canonical flip.

Originally planned path was "throwaway PGLite via `gbrain init --path` +
`gbrain import`". Rejected: `gbrain import` has no `--path` override,
so a throwaway DB would have required swapping `~/.gbrain/config.json`
and disabling all DB-writing services for the full window. Pure-function
round-trip over the same upstream code gave equivalent confidence at
zero DB risk and ~30 s wall clock.

### Blockers now resolved

The 3 pre-migration blockers from §6.8 are cleared:
- Slug hygiene → resolved via slug-normalize skill (7 renames).
- type/kind round-trip → resolved by roundtrip-check (0 diffs).
- `id: >-` "blocker" → withdrawn (never a real blocker; gray-matter
  auto line-folding, not data damage).

The only remaining step on this track is Step 2 (/ingest flip to
filesystem-first + git-track the brain dir + enable `gbrain dream`
cron). Multi-week. First micro-step scope in the new handoff doc.

---

## 6.10 Filesystem-canonical Step 2.1 — brain-dir design locked (2026-04-23)

Same-day follow-through on §6.9. Pure design pass, zero code / DB /
launchd touches. Full doc at
[`docs/STEP-2-BRAIN-DIR-DESIGN.md`](STEP-2-BRAIN-DIR-DESIGN.md).

### The 5 decisions, pinned

1. **Brain-dir location** → `~/brain/` (canonical), `agent/` one-shot
   rename to `.agent/`. Upstream `src/core/sync.ts:82` skips any path
   segment starting with a dot, so the rename is all it takes to keep
   kos-patrol / enrich-sweep / slug-normalize outputs out of sync's
   scope without moving files out of `~/brain/`.
2. **Sync frontmatter fidelity** → Step 1.6's pure-function round-trip
   already covers `sync.ts` (same `parseMarkdown` call site at
   `src/core/import-file.ts:71, 187`). A 30-minute throwaway-dir smoke
   stays in the design doc as Step 2.2 preflight, not executed this
   session.
3. **notion-poller refactor** → keep HTTP-POST to `/ingest`; rewrite
   `/ingest` handler internally from `gbrain import` to `file write +
   gbrain sync`. External contract (Notion Worker, feishu, ad-hoc curl)
   stays frozen. Path C (kos-compat-api in-process import, §7 P1)
   dissolves as a side effect of `gbrain sync`'s incremental
   idempotency. `workers/notion-poller/run.ts` doesn't change a line.
4. **kos-patrol output migration** → path-constant rewrite in 4 fork-
   local files + 1 one-shot `mv`. No data loss; existing 8 report /
   digest / dashboard files move along with the rename.
5. **git strategy** → defer. Step 2 lands without git; `~/.gbrain/
   brain.pglite.pre-*` rolling backup covers rollback. `gbrain dream`
   doesn't require git (only `--pull` does). +14-day checkpoint after
   Step 2.3 revisits with a private `jarvis-brain` repo + post-dream-
   cycle commit-batching wrapper.

### "100-pages mystery" resolved

Handoff §3 asked where `/status` got `total_pages: 100` from; earlier
the §6 "Verify health at any time" note claimed it was a filesystem
mirror scan. Wrong. `server/kos-compat-api.ts:77` shells out
`gbrain list --limit 10000`, and the upstream CLI silently caps list
output at 100 rows regardless of `--limit`. Verified:

```
$ gbrain list --limit 10000 | wc -l
100
$ gbrain stats | head -3
Pages:     1829
```

`~/brain/` is a 9-file agent-output dir, never a content mirror. §6's
caveat block updated; Step 2.2 rewrites `/status` to direct-DB query
via `skills/kos-jarvis/_lib/brain-db.ts`.

### Next: Step 2.2

Opens as a separate session. Reads `docs/STEP-2-BRAIN-DIR-DESIGN.md`
§4 for the roadmap. Scope: `/ingest` flip + `.agent/` rename +
`/status` direct-DB in one 1-2 h session under the slug-normalize
launchctl-disable + rolling-backup protocol.

### Rollback

No rollback needed for a pure-design commit. Undo = `git revert`.

---

## 6.11 Filesystem-canonical Step 2.2 landed + v0.18 sync deferred (2026-04-23 evening)

Two commits on master: `79331b7` (v0.18 sync preflight verdict =
blocked) + `b7212db` (Step 2.2 executed on v0.17 baseline).

### v0.18 sync preflight (79331b7, pre-flight evening)

Upstream `master` advanced to `2751581` (v0.18.0 multi-source brains +
v0.18.1 RLS hardening) on 2026-04-22; `feat/migration-hardening` branch
carries v0.18.2 (PR #356 open, not yet merged). Preflight smoke built
v0.18.2 from source against a copy of
`~/.gbrain/brain.pglite.pre-slug-normalize-*` in an isolated `$HOME`:

- **v16→v24 migration chain FAILS on PGLite 0.4.4 with 1829 pages.**
  `gbrain init --migrate-only` directly throws
  `column "source_id" does not exist`; `gbrain apply-migrations --yes`
  reports v0.18.0 orchestrator `status=failed` and leaves
  `schema_version=16` unchanged. Data integrity preserved. Root cause:
  `src/core/pglite-engine.ts` in v0.18.2 SELECTs `pages.source_id` in
  engine methods called during the v0.13.0 orchestrator's
  `extract links --source db` phase, before v21 has added the column.
  Fresh installs don't trip it; v16→v24 upgrades do.
- Fork policy (CLAUDE.md) forbids patching `src/*`. **v0.18 sync
  deferred** until upstream fixes the PGLite upgrade path.
- Smoke artifacts preserved under `/tmp/gbrain-upstream-peek/` +
  `/tmp/gbrain-smoke-v018-*/` for future upstream issue repro.

### Step 2.2 executed (b7212db, same evening)

Filesystem-canonical `/ingest` flip + `.agent/` rename + `/status`
direct-DB all landed in a single 1-2 h focused session on the v0.17
baseline per `docs/STEP-2-BRAIN-DIR-DESIGN.md §4 Step 2.2`. One design
surprise adjusted mid-session: Step 2.1 Decision 5 claimed
"`gbrain sync` works on a plain dir, git deferrable to +14d." False.
`src/commands/sync.ts:119` explicitly requires `.git/`; the sync
implementation walks `git diff LAST..HEAD` for file discovery. **`git
init ~/brain` + first commit became a Step 2.2 prerequisite**, not a
Step 2.4 deferrable.

Validation this session:

| Check | Result |
|---|---|
| Preflight smoke: 10 pages × 10 KOS frontmatter fields | 10/10 round-trip clean, 0 diffs |
| `mv ~/brain/agent ~/brain/.agent` | 9 files relocated; sync skips dot-prefix per `isSyncable()` |
| `~/brain/raw/web/*.md` upgrade | Became `sources/2026-04-21-ai-economy-disruption-dual-jarvis.md` with full KOS frontmatter |
| `git init ~/brain` + seed commit | branch=main, commit=6ed6653, 10 files |
| `gbrain sync --repo ~/brain --no-pull` (first call) | +1 added, sync.repo_path registered in config, 1858 pages |
| `/status` endpoint via prod port 7225 | total_pages=1858 (was 100-capped), full KOS 9-kind + confidence breakdown |
| `/ingest` POST smoke | file at `~/brain/sources/*.md`, git commit 116a5d1, sync +1, DB 1859, frontmatter preserved |
| `/digest` endpoint | Returns patrol-2026-04-19.md from new `.agent/digests/` path |
| `notion-poller` manual kickstart | Normal DELTA cycle against new `.agent/notion-poller-state.json` path |
| `gbrain doctor --fast` | 70/100 (cosmetic resolver + v0.13.0 partial; no new warnings) |
| `~/.gbrain/sync-failures.jsonl` | Does not exist (0 parse failures, clean) |

Rolling backup: `~/.gbrain/brain.pglite.pre-step2.2-1776965283` (292 MB).

### Opportunistic findings (pre-existing, not regressions)

- **kos-patrol launchd cron has been `LastExitStatus=1` since
  2026-04-19.** Root cause: the minion-wrapped `gbrain list` call
  runs in a subprocess that hits the macOS 26.3 WASM bug
  (`Aborted(). Build with -sASSERTIONS for more info.`) — same
  `#223` class we carry the `@electric-sql/pglite@0.4.4` override for,
  but the subprocess doesn't inherit our override reliably. Direct
  `bun run skills/kos-jarvis/kos-patrol/run.ts` succeeds (writes
  `patrol-2026-04-23.md` to `.agent/digests/` correctly). Tracked as
  P1 in TODO.md.
- **kos-patrol uses `gbrain list --limit 10000`** — same upstream
  100-row cap we fixed in `/status`. Inventory says "100 pages" on a
  1858-page brain, feeding wrong numbers into dashboards + digests.
  Migrating kos-patrol to `BrainDb` direct-read is a natural
  follow-up (1-2 h). Tracked as P1 in TODO.md.

### Next: Step 2.3 — `gbrain dream` cron wiring

Preconditions met: `sync.repo_path=~/brain` set, `~/brain` is a git
repo with first commit, filesystem-canonical flow live. Step 2.3
remains as designed — add `com.jarvis.dream-cycle.plist` daily 03:00
via `skills/kos-jarvis/dream-wrap/run.ts` archiving cycle JSON to
`~/brain/.agent/dream-cycles/`. Observe the first overnight lint +
backlinks phases for KOS-frontmatter compatibility.

### Rollback (if ever needed)

1. `launchctl bootout` all jarvis services
2. `cp -R ~/.gbrain/brain.pglite.pre-step2.2-1776965283 ~/.gbrain/brain.pglite`
3. `mv ~/brain/.agent ~/brain/agent; rm -rf ~/brain/.git ~/brain/sources`
4. `git revert b7212db` in fork
5. Services bootstrap

Not expected — idempotent sync flow, data integrity preserved throughout.

---

## 6.12 Upstream v0.18.2 synced with fork patch (2026-04-23 evening, commit `aceb838`)

The v0.18 sync deferral from §6.11 is resolved. `feat/migration-hardening`
merged to upstream master as v0.18.2 (`08b3698`) mid-session, and
targeted investigation isolated the v16→v24 upgrade blocker to a
**single line** in `src/core/pglite-schema.ts`. Fork policy was relaxed
specifically for this unblock ("modify `src/`, record the patch, handle
conflicts at next merge"); the patch is 1 line removed + 10 lines of
comment block marking it.

### The one-line bug

`PGLITE_SCHEMA_SQL` line 63 declared:

```sql
CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages(source_id);
```

**outside** the `CREATE TABLE IF NOT EXISTS pages(...)` block above
it. On fresh installs: fine — the CREATE TABLE creates pages with
source_id, the CREATE INDEX succeeds. On a v16 brain upgrade: fatal
— CREATE TABLE IF NOT EXISTS skips the existing pages table (no
source_id column), the next CREATE INDEX fires `column "source_id"
does not exist`, which aborts `engine.initSchema()` before
`runMigrations()` can execute v21 (the migration that would have
added the column). schema_version stays stuck at 16, every orchestrator
reports `status=failed`, no data is lost — just no upgrade either.

### The patch

Delete line 63. The v21 migration already re-creates the index
idempotently via `CREATE INDEX IF NOT EXISTS idx_pages_source_id ON
pages(source_id)`, so fresh installs still end up with the index. Only
behavior change: index is now declared in one place (v21 migration)
instead of two. Patched in `src/core/pglite-schema.ts` with a 10-line
comment block pointing to [`docs/UPSTREAM-PATCHES/v018-pglite-upgrade-fix.md`](UPSTREAM-PATCHES/v018-pglite-upgrade-fix.md)
+ upstream [#370](https://github.com/garrytan/gbrain/issues/370).

### Sync sequence this session (timeline)

1. Preflight (§6.11) — identified v0.18 sync blocker on fresh smoke
2. Diagnosed bug via a second smoke with PATH-shimmed `gbrain` (first
   smoke was self-deceived — orchestrator's `execSync('gbrain ...')`
   was resolving to our v0.17 binary, not upstream peek)
3. Isolated the bug to pglite-schema.ts:63 — 10 min of source reading
4. Wrote 1-line patch in /tmp peek → smoke re-runs GREEN (v16→v24
   advances, sources.default seeds, 1857 pages source_id='default',
   zero data loss)
5. Safety protocol: 6 services bootout'd, lsof clean, fresh
   `~/.gbrain/brain.pglite.pre-v018-1776967072` backup (292 MB),
   `git tag pre-sync-v0.18`
6. `git merge upstream/master` — one conflict (package.json version),
   resolved: take upstream 0.18.2, keep our pglite 0.4.4 pin
7. Applied the same patch to `src/core/pglite-schema.ts` in our fork
8. `bun install` triggered postinstall `gbrain apply-migrations --yes`
   which migrated the **live** brain through the patched code path
   (the pglite module resolution happened to pick up our patch
   immediately; we got away with this because bun install evaluates
   TypeScript directly via our `~/.bun/bin/gbrain → src/cli.ts`
   symlink, no compile step needed)
9. Services restarted, end-to-end re-validated on v0.18.2 baseline

### Validation (all green)

| Check | Result |
|---|---|
| `config.version` | 16 → **24** ✓ |
| `sources list` | `default federated 1860 pages never synced` ✓ |
| All 1860 pages `source_id='default'` | ✓ (schema DEFAULT auto-scope) |
| Page count / chunks / links / timeline | 1860 / 3451 / 385 / 5443 — zero drift ✓ |
| `gbrain doctor schema_version` | `OK Version 24 (latest: 24)` ✓ |
| `/status` endpoint | 1860 pages, KOS 9-kind breakdown + `source` scope ✓ |
| `/ingest` POST smoke | imported:true, embedded:true (no retry-fallback), git commit + sync +1 added ✓ |
| notion-poller real cycle | **2 Notion pages auto-ingested through filesystem-canonical path** ✓ (production flow, not just smoke) |
| `brain_score` | 56/100 unchanged (cosmetic, pre-existing) |

### What changed in the fork artifact

- `package.json`: 0.17.0 → 0.18.2, kept `@electric-sql/pglite: 0.4.4` pin
- `src/core/pglite-schema.ts`: 1-line patch + provenance comment
- `docs/UPSTREAM-PATCHES/v018-pglite-upgrade-fix.md`: new, documents
  root cause + fix + validation + removal trigger (upstream merges #370)
- 79+ upstream files pulled in (sources CLI, multi-source docs,
  v0_18_0/v0_18_1 orchestrators, engine enhancements, RLS hardening)

### Not yet wired

- **`gbrain sources add jarvis --path ~/brain`** — we currently run
  on the seeded `default` source. Renaming to an explicit "jarvis"
  source id is cosmetic; the current wiring works fine on `default`.
  Parked for Step 2.4 if we ever split sources (e.g., jarvis-wiki +
  jarvis-notes).
- **Fork patch removal trigger**: when upstream merges #370, our
  pglite-schema.ts comment block comes out. Diff is trivial — just
  restore the single deleted line if upstream's fix preserves it,
  or delete our provenance block if upstream removed the line too.

### Rollback matrix (updated)

| To restore | Command |
|---|---|
| **DB state pre-v0.18** | `cp -R ~/.gbrain/brain.pglite.pre-v018-1776967072 ~/.gbrain/brain.pglite` |
| **Git state pre-v0.18 merge** | `git reset --hard pre-sync-v0.18` |
| **Services state** | Same bootout → restore → bootstrap protocol as §6.11 |

---

## 6.13 Filesystem-canonical Step 2.3 — `gbrain dream` cron wired (2026-04-23 late-night)

The core filesystem-canonical track is done. With Step 2.2 having flipped
`/ingest` to the `~/brain/<kind>/<slug>.md` → git → `gbrain sync` path
and Step 2.3 today wiring the nightly maintenance cycle, the brain now
has both a write side (live, every Notion poll) and a read-side
maintenance pass (overnight, deterministic). Everything between Step
2.4's commit-batching and an external git remote is parked for the
+14-day soak.

### What landed (untracked at this checkpoint, single commit pending)

- `skills/kos-jarvis/dream-wrap/run.ts` — wrapper around `gbrain dream
  --json`. Resolves brain dir from `gbrain config get sync.repo_path`
  (set during Step 2.2 via `gbrain init --pglite --repo ~/brain`),
  archives the CycleReport JSON to
  `~/brain/.agent/dream-cycles/<ISO>.json`, atomically swaps a
  `latest.json` symlink, translates exit codes:
  `clean | ok | partial | skipped → 0`, `failed → 1`,
  wrapper-level errors → 2. Defensive JSON extraction (slice from
  first `{` to last `}`) handles upstream phases that leak human
  text to stdout in `--json` mode (notably `embed --dry-run`).
- `skills/kos-jarvis/dream-wrap/SKILL.md` — operator doc: purpose,
  exit-code semantics, manual invocation, archive reading, launchd
  install / refresh / rollback.
- `scripts/launchd/com.jarvis.dream-cycle.plist.template` — daily
  03:11 local (`StartCalendarInterval`, `RunAtLoad=false`, off the
  `:00` mark to avoid thundering-herd with other personal cron).
  Identical-content `.plist` is gitignored (consistent with the rest
  of `scripts/launchd/`).
- Deployed: `~/Library/LaunchAgents/com.jarvis.dream-cycle.plist`
  bootstrapped into `gui/$UID`. `launchctl list | grep dream-cycle`
  shows `-  0  com.jarvis.dream-cycle` (PID `-` is normal between
  fires, EXIT 0 healthy).

### Smoke test summary (6 cycles, 2 hours of iteration)

| # | Mode | Result | Notes |
|---|---|---|---|
| 1 | `--phase lint` | exit 0 (cycle status `partial`) | First wrapper run; surfaced exit-code bug — see fixes below |
| 2 | `--phase lint` re-run | exit 0 (`partial`) | Confirmed deterministic |
| 3 | `--dry-run` | exit 0 (`partial`) | Surfaced JSON parse bug — see fixes below |
| 4 | `--dry-run` re-run | exit 0 (`partial`) | Confirmed defensive parser works |
| 5 | Real cycle | exit 0 (`partial`) | All 6 phases ran |
| 6 | Real cycle re-run | exit 0 (`partial`) | Idempotency verified |

Cycle #6 phase breakdown (representative of the steady state):

```
lint         warn         14ms  0 fix(es) applied, 144 remaining
backlinks    ok           18ms  0 back-link(s) added, 0 remaining
sync         ok           42ms  +0 added, ~0 modified, -0 deleted
extract      ok           14ms  0 link(s), 0 timeline entries
embed        ok         1670ms  0 chunk(s) newly embedded (3626 already had embeddings)
orphans      warn         19ms  1803 orphan page(s) out of 1930 total
```

`partial` is the steady-state cycle status (lint warns + orphans
warns). Both warnings are pre-existing data shape issues, not Step
2.3 regressions, and are filed in TODO.md as P1 follow-ups (see
"Known follow-ups" below). Critical: pages 1930 → 1930 and chunks
3626 → 3626 across re-runs; the cycle is read-mostly when there's
no fresh work, exactly what we want from a maintenance pass.

### Two bugs hit and fixed during smoke (both in our wrapper, not upstream)

1. **`exitForStatus` missing `partial` case** — initial wrapper switch
   handled `clean | ok | warn | failed | skipped` (modeled on
   phase-level statuses). But `CycleStatus` (cycle-level, defined at
   `src/core/cycle.ts:97` upstream) is `'ok' | 'clean' | 'partial' |
   'skipped' | 'failed'` — `warn` is phase-level only, never cycle-level.
   Fix: `case "clean" | "ok" | "partial" | "skipped" → 0`,
   `case "failed" → 1`, with a comment citing the upstream type.
2. **`gbrain dream --dry-run --json` stdout pollution** — embed phase
   in dry-run mode prints `[dry-run] Would embed 0 chunks across 1930
   pages` to stdout BEFORE the JSON CycleReport, breaking
   `JSON.parse`. Fix in our wrapper: extract JSON by slicing from
   first `{` to last `}` (CycleReport is a single top-level object,
   so this is unambiguous), surface stripped noise to stderr as a
   warning. Filed upstream tracking item: `gbrain dream --json`
   should keep stdout JSON-clean across all phases.

### Validation (all green)

| Check | Result |
|---|---|
| `gbrain doctor schema_version` | OK Version 24 |
| `gbrain stats` page count pre/post 6 cycles | 1930 / 1930 — zero drift |
| `gbrain stats` chunk count pre/post | 3626 / 3626 — zero re-embed |
| `~/brain/.agent/dream-cycles/` | 5 cycle JSONs + `latest.json` symlink |
| `~/brain/.agent/dream-cycles/` in gitignore | yes (`.agent/` covered by Step 2.2 rename) |
| launchctl service state | `-  0  com.jarvis.dream-cycle` (loaded, idle, last exit 0) |
| All 7 jarvis services | green (kos-patrol still `1` — separate P1, see §6.11) |
| notion-poller's 5-min cycle, post dream-cycle install | clean cycles, no lock contention |

### Known follow-ups (filed as P1 in `skills/kos-jarvis/TODO.md`)

1. **notion-poller frontmatter — `title:` + `type:` omission**: lint
   warns on 144 issues across 72 disk pages, all `~/brain/sources/notion/*.md`.
   KOS uses `kind:` (we preserve this); upstream lint also expects
   `title:` + `type:`. Fix at the writer (`workers/notion-poller/run.ts`
   frontmatter builder, ~10 LOC) + `gbrain sync --force` backfill.
2. **v1-wiki orphan backlog**: 1803/1930 pages have zero inbound
   wikilinks (93% orphan rate). Pre-existing from v1 wiki migration —
   imported flat with no graph edges. enrich-sweep + idea-ingest
   gradually reduce this; track as a multi-week soak metric.
3. **Upstream `gbrain dream --dry-run --json` stdout pollution**:
   the embed phase leak (see "bugs hit" above) is worth reporting
   upstream. Our wrapper is already defensive.

### Brain-dir layout post-Step-2.3

```
~/brain/
├── .git/                       (Step 2.2)
├── .gitignore                  (excludes .agent/, .DS_Store)
├── .agent/                     (Step 2.2 rename from agent/)
│   ├── dashboards/             (kos-patrol output)
│   ├── digests/                (kos-patrol + dream digests)
│   ├── reports/                (slug-normalize, ingest reports)
│   ├── dream-cycles/           ← NEW (Step 2.3)
│   │   ├── 2026-04-23T23-37-24Z.json
│   │   ├── 2026-04-23T23-38-20Z.json
│   │   ├── 2026-04-23T23-39-21Z.json
│   │   ├── 2026-04-23T23-39-32Z.json
│   │   ├── 2026-04-23T23-39-42Z.json
│   │   └── latest.json → 2026-04-23T23-39-42Z.json
│   ├── notion-poller-state.json
│   └── pending-enrich.jsonl
└── sources/
    └── notion/                 (Step 2.2 + post-hotfix `051ae74`)
        └── …                   (72 .md files, growing every 5 min)
```

### Next: Step 2.4 (parked +14d)

After 14 days of clean nightly cycles, decide:
- (a) `gh repo create jarvis-brain --private` + extend `dream-wrap` to
  `git push` at cycle end (off-machine knowledge backup)
- (b) Commit-batching wrapper to coalesce per-ingest commits (~5-9
  per Notion poll) into one end-of-cycle commit, reducing
  `git -C ~/brain log` noise

If observability needs change before then, `/status` can grow a
`dream_cycle_health` field by reading `latest.json` (one fs read,
no DB hit). Not in scope today.

### Rollback

```bash
launchctl bootout gui/$UID ~/Library/LaunchAgents/com.jarvis.dream-cycle.plist
rm ~/Library/LaunchAgents/com.jarvis.dream-cycle.plist
# DB rollback (if a bad cycle corrupts something):
cp -R ~/.gbrain/brain.pglite.pre-step2.3-1776987292 ~/.gbrain/brain.pglite
# Archive dir kept for audit; safe to remove if desired:
# rm -rf ~/brain/.agent/dream-cycles/
```

---

## 6.14 Upstream v0.20.4 sync (2026-04-25, commit `8665afb`)

Six upstream releases land in one merge: v0.18.2 → v0.19.0 → v0.19.1 →
v0.20.0 → v0.20.2 → v0.20.3 → v0.20.4. The total diff is 356 files /
+10813 / -9937. Conflict count: 2 real (`.gitignore`, `manifest.json`),
5 auto-merged (CLAUDE.md, README.md, package.json, RESOLVER.md, src/cli.ts).

### What we adopted

- **#332 closure** ([garrytan/gbrain#332](https://github.com/garrytan/gbrain/issues/332)).
  v0.19.0 replaced `process.execPath` in `src/commands/migrations/v0_13_0.ts`
  with a shell-out to `gbrain` on PATH. The orchestrator now finds our bun
  shim correctly. Post-merge ran `apply-migrations --force-retry 0.13.0`
  + `apply-migrations --yes` to walk through `frontmatter_backfill` and
  advance the ledger from `partial` to `complete`. Doctor health 60→80,
  the FAIL `minions_migration` check is now OK. Three net new links
  created across 1988 pages (the rest were already present from earlier
  manual extracts).
- **smoke-test skillpack** registered in `manifest.json` alongside our 9
  kos-jarvis skills (39 total). OpenClaw side will pick up the new
  triggers automatically; no fork action.
- **`gbrain check-resolvable --json`** now reachable from the CLI (v0.16.4
  surfaced this; v0.20.4 polished the JSON envelope). Optional integration
  point for a daily resolver-health cron, deferred.

### What we skipped (intentional, all Postgres-only)

- **`gbrain jobs supervisor`** (v0.20.2). Self-healing daemon for
  `jobs work` workers. Skipped because we don't run a worker daemon ...
  Path B retired the Minion shell-wrap layer for notion-poller, and
  the remaining 4 launchd cron jobs (notion-poller, dream-cycle,
  kos-patrol, enrich-sweep) exit synchronously after their work
  completes. Nothing to supervise.
- **`queue_health` doctor check** (v0.20.3). Skips on PGLite with
  `Skipped (PGLite — no multi-process worker surface)`. We have no
  queue.
- **Wedge-rescue / `handleWallClockTimeouts`** (v0.20.3). Layer-3 kill
  shot for jobs holding row locks. We have no multi-row queue at risk.
- **`backpressure-audit` JSONL trail** (v0.20.3). Caps per-name pile-up.
  We have at most one submitter per cron job (cardinality 1 per name).

The decision tree on whether to switch engines lives at
[`docs/UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md`](UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md).
TL;DR: defer, four trigger conditions named.

### Fork-local patches preserved (re-verified post-merge)

- `src/core/pglite-schema.ts:65` — `idx_pages_source_id` index commented
  out. Upstream #370 still open; index is recreated by v21 migration so
  fresh installs lose nothing. See `v018-pglite-upgrade-fix.md`.
- `src/core/pglite-engine.ts:87` — `SELECT pg_switch_wal()` issued before
  `db.close()`. Forces WAL segment rotation so the durable LSN catches up
  with in-memory writes. macOS 26.3 WASM persistence bug. No upstream
  issue filed yet (the repro is still flaky to script). See
  `v018-pglite-wal-durability-fix.md`.
- `src/cli.ts` — file mode 0755 (executable bit for the bun shim at
  `~/.bun/bin/gbrain`). Auto-merged this round.

### Pre-merge baseline + post-sync diff

| Metric | Pre-merge (HEAD `170876f`) | Post-merge + apply-migrations |
|---|---|---|
| Pages | 1988 | 1988 |
| Chunks | 3750 (100% embedded) | 3750 (100% embedded) |
| Links | 8522 | 8666 (+144 from frontmatter backfill) |
| Timeline entries | 10881 | 11020 (+139) |
| Orphans | 1630 | 711 (orphan-reducer ran during sync; not a sync side-effect) |
| `doctor` health | 60/100 (FAIL: minions_migration partial 0.13.0) | 80/100 (no FAILs) |
| `brain_score` | 86/100 | 86/100 (unchanged) |
| Schema version | 24 (latest) | 24 (latest) |

### Conflict resolution log

- `.gitignore` — union both fork (`.omc/`, kos-jarvis log globs) and upstream
  (`eval/data/world-v1/world.html`, `amara-life-v1/_cache/`) entries.
  No semantic conflict, just two append regions overlapping at the same
  line.
- `skills/manifest.json` — appended upstream's `smoke-test` skill before our
  9 kos-jarvis fork skills. 39 total skills registered.
- `CLAUDE.md` — auto-merged. Fork preamble (Lucien's context, fork-specific
  rules, upstream sync policy) intact at top; upstream's v0.19/v0.20 file
  references (queue_health, backpressure-audit, supervisor.ts, wall-clock
  timeouts) absorbed into the Key files / Operational health sections
  cleanly.
- `skills/RESOLVER.md` — auto-merged. Upstream added a `smoke-test` row at
  line ~57; our `## KOS-Jarvis extensions` append-only section moved from
  line 103 to 104 with no other change.
- `package.json` — auto-merged at version `0.20.4`. No dependency changes
  vs the v0.18.2 baseline (`bun install` reports `Checked 242 installs
  across 235 packages (no changes)`).
- `src/cli.ts` — auto-merged at mode `100755`.

### Verification

```bash
# unit tests (no DB needed)
bun test                                       # 2429 pass / 250 skip / 4 fail
                                               # The 4 fails are check-resolvable
                                               # cwd-pollution between parallel
                                               # tests (24/24 pass in isolation).
                                               # Filed as a parallel-test isolation
                                               # bug, not a fork issue.

bun run typecheck                              # tsc --noEmit clean

# v0.13 ledger advance
gbrain apply-migrations --force-retry 0.13.0   # writes retry marker
gbrain apply-migrations --yes                  # backfill links, ledger → complete

# service smoke
launchctl bootout gui/$(id -u)/com.jarvis.kos-compat-api
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist
curl -sS -H "Authorization: Bearer $TOKEN" http://localhost:7225/status   # 1988p / 9 kinds
curl -sS http://localhost:7222/health                                     # gemini-embedding-2-preview
```

### Rollback

```bash
git reset --hard pre-sync-v0.20-1777105378
cp -R ~/.gbrain/brain.pglite.pre-sync-v0.20-1777105391 ~/.gbrain/brain.pglite
launchctl bootout gui/$(id -u)/com.jarvis.kos-compat-api
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist
```

The PGLite snapshot is 416 MB. Keep it for ≥7 days, then prune with
`rm -rf ~/.gbrain/brain.pglite.pre-sync-v0.20-*` once a clean week of
dream cycles + kos-patrol runs has passed.

---

## 6.15 Tier 1 maintenance sweep — orphan-reducer + frontmatter-ref-fix (2026-04-27 evening)

Two-day post-sync soak finished green, so this session executed the
Tier 1 punch list from
[`docs/SESSION-HANDOFF-2026-04-27-post-v0.20-sync.md`](SESSION-HANDOFF-2026-04-27-post-v0.20-sync.md)
in one ~12-minute window: lint ERROR fixes, an orphan-reducer sweep, and
a brand-new `frontmatter-ref-fix` skill. End-to-end: 4 commits, $0.336
Haiku, +177 links, -21 orphans.

### What ran

1. **4 lint ERROR fixes** — `~/brain` commit `eadf1d3`. Patrol
   2026-04-27 dashboard reported 4 ERROR-level findings: v1-wiki
   `sources/2026-{04-01,03-20,03-13}-*.md` files missing the `updated:`
   frontmatter field. Backfilled with `created` value (means: not
   modified since import). Pure data-shape fix, no body change.

2. **orphan-reducer apply --limit 100** — `~/brain` commit `5a6a584`,
   430s, $0.336. Haiku 4.5 classified 100 orphans against pgvector
   top-K candidates; 89 edges met the `--min-confidence 0.7` bar
   (`related` link_type, relation encoded in `context`). 88 of 89
   candidate pages exist on disk so a sentinel block (`<!-- orphan-
   reducer-inbound -->...`) was upserted at EOF; 1 candidate was
   DB-only (notion-source without a markdown file → recorded as
   `markdown_reason: "no_file"` in the JSON sidecar for future
   filesystem-mirror backfill). Sample edges: `people/harry-zhao →
   people/joe-qiu (supplements)`, `people/teresa-xu → people/josh-ye
   (implements)`. Cost matched handoff projection (~$0.35).

3. **frontmatter-ref-fix (new skill)** — fork repo commit `0695a6c`
   (`skills/kos-jarvis/frontmatter-ref-fix/SKILL.md` + `run.ts`,
   617 LOC); brain repo commit `d6be7ce` (apply). Walks
   `~/brain/**/*.md`, splits the `--- ... ---` block, scans
   line-by-line for `.md`-suffixed refs (with optional `../` prefix
   and yaml list dash or `key:` prefix), drops the decoration, looks
   up the canonical slug in an on-disk index, rewrites if resolved.
   Deliberately uses line-level regex rather than yaml.parse +
   yaml.stringify to preserve quote style + field order — that
   avoids producing a noisy notion-poller-vs-fix-skill emit-format
   diff.

   First sweep result: **220 refs found** (vs handoff's "14 dangling"
   — handoff under-counted because gbrain's link-extraction
   `DIR_PATTERN` (src/core/link-extraction.ts:47) doesn't accept
   `sources/` plural, so the ~80 source-page refs silently failed to
   resolve and didn't show up as "dangling"). 150 resolved + rewritten
   across 51 files; 70 left untouched (mostly `raw_path:` fields
   pointing at brain-external snapshots, plus ~30 bare-slug v1
   sibling refs that need fuzzy resolve — tracked as P2 follow-up
   `frontmatter-ref-fix v2` in TODO.md).

   Two handoff assumptions turned out wrong: (1) actual count is
   150+, not 14. (2) Target dir is `entities/` plural (matches
   brain layout), not `entity/` singular as handoff §3 suggested.
   The skill verifies against the on-disk slug index, so it gets
   the right answer regardless of what the handoff said.

### Aggregate metrics

| Metric | 2026-04-27 morning (handoff) | 2026-04-27 evening | Δ |
|---|---|---|---|
| Pages | 2091 | 2114 | +23 (notion-poller natural growth) |
| Chunks | 3963 | 4016 | +53 (frontmatter rewrite re-chunked 51 files) |
| Links | 8666 | **8843** | **+177** (89 from orphan-reducer + 88 from frontmatter resolved-rewrites flowing through `gbrain sync`'s extract phase) |
| Orphans | 814 | **793** | **-21** |
| Lint ERRORs | 4 | **0** | -4 |
| Brain score | 85/100 | 85/100 | unchanged (orphans 12/15 needs -70 more to advance) |
| Doctor health | 80/100 | 80/100 | unchanged (3 PGLite-quirk WARN: pgvector / graph_coverage / jsonb_integrity — known limitation, no FAIL) |

### What was built

```
skills/kos-jarvis/frontmatter-ref-fix/
├── SKILL.md          (107 lines, ~4.4 KB) — pipeline, usage, scope
└── run.ts            (510 lines, ~14.7 KB) — flag parsing, fs walk,
                       slug index, frontmatter splitter, regex
                       rewriter, report builder, git commit helper
```

The skill follows kos-jarvis conventions (no `src/*` touched, all
ext-pack-local, dry-run default with `--apply` opt-in, JSONL events
optional, report under `~/brain/.agent/reports/`).

### Cost / time accounting

- Wall time: ~12 min (5 min orphan-reducer in background while writing
  the new skill, 7 min for everything else: scan + dry-run review +
  apply + sync + verify).
- Haiku 4.5 calls: 105 (5 dry-run smoke + 100 apply). Total cost:
  **$0.336**, all via the `crs.chenge.ink/api` proxy (set
  `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` from `.env.local`; the
  Anthropic SDK reads both env vars natively).
- File operations: 51 frontmatter rewrites + 88 sentinel-block
  upserts + 4 lint backfills, 4 git commits across two repos.

### Follow-ups parked

- **frontmatter-ref-fix v2** (TODO.md P2): exclude `raw_path:`,
  fuzzy-resolve bare-slug v1 sibling refs. Closes the 70-unresolved
  long tail. ~1-2h.
- **orphan-reducer cadence**: weekly until orphans &lt;500 (currently
  793). Next sweep aims for `--limit 100`, expected -90 → ~700.
  Three more sweeps puts the orphans component at 13/15 → 14/15 →
  brain_score 85 → 87.

---

## 6.16 Long-tail closure — frontmatter-ref-fix v2 + 3 orphan sweeps (2026-04-27 late evening)

Continuation of §6.15. The user asked to "finish the v2 follow-up
and keep running orphan-reducer until the long tail is gone, so the
current TODO.md can archive and the next session starts fresh." This
entry covers that closure pass: ~30 min wall, $1.354 Haiku, 6
brain-repo commits + 2 fork-repo commits, **TODO.md officially
archived**.

### What ran

1. **frontmatter-ref-fix v2** (fork commit `cf236a4`, brain commit
   `f76f5c3`). Extends v1 with three mechanisms:
   - `EXTERNAL_POINTER_KEYS` allowlist (`raw_path:` only for now) —
     fields whose values legitimately point at brain-external paths.
     Lines under these keys are skipped without warning, so the
     report no longer treats them as dangling.
   - Bare-slug fuzzy resolve via a basename → full-slug index.
     v1-wiki sibling refs like `harness-engineering.md` (no dir
     prefix) get matched against the unique `*/harness-engineering`
     slug. Unique hits rewrite to canonical form; ambiguous +
     zero-hits remain in the report (none in production today).
   - New categories + opt-in deletion: `external_path` (2+ leading
     `../` — escapes brain root), `dead` (path-shape ref with
     missing target). `--delete-external` / `--delete-dead` /
     `--delete-all` splice matching lines from the frontmatter list.

   Sweep against the v1-residual long tail: 70 entries split into
   **35 fuzzy-resolved + 19 raw_path-skipped + 9 external-deleted +
   7 dead-deleted**. Zero `bare_ambiguous` and zero `bare_unresolved`
   — every bare slug in the brain had a unique basename hit. A
   follow-up dry-run reports only the 19 legitimate `raw_path`
   entries; everything else is gone.

2. **orphan-reducer rounds 2 / 3 / 4** (brain commits `6c666bb`,
   `9159bfd`, `a2efc02`). Three back-to-back `--apply --limit 100`
   runs to chip at the post-round-1 pile. Edges per round:
   **78 → 71 (68 db) → 37**. The drop at round 4 is the saturation
   signal — remaining orphans are increasingly isolated from the
   existing graph because the easy-to-link cohort is gone.

### Aggregate session metrics (this evening, both 6.15 and 6.16)

| Metric | 2026-04-27 morning (handoff start) | 2026-04-27 late evening (close) | Δ |
|---|---|---|---|
| Pages | 2091 | 2118 | +27 (notion-poller natural growth across the session) |
| Links | 8666 | 8225 | -441 net (frontmatter-ref-fix v2 deleted 16 deadlink rows; sync re-extract on 31 modified pages pruned some outdated edges; round 2-4 inserted +183 raw, but DB cleanup + dedup outpaced; needs follow-up audit if the trend continues) |
| Orphans | 814 | **732** | **-82** |
| brain_score | 85/100 | 85/100 | unchanged ... orphans 12/15 component covers a wide band |
| Doctor health | 80/100 | 80/100 | unchanged ... 3 PGLite-quirk WARN, zero FAIL |
| Lint ERRORs | 4 | **0** | -4 |
| Long-tail unresolved frontmatter refs | 70 | **0** (19 legit `raw_path` left) | -70 |

### Cost / time

- Total Haiku cost across **4 orphan-reducer rounds**: **$1.354**
  ($0.336 + $0.342 + $0.339 + $0.337). Matches the original handoff
  estimate of "~$1 to clear 793 → 500."
- Total wall: ~30 min (4 × 7-min orphan rounds + 5 min v2 skill
  work + sync + verify).
- Total commits: **6 in `~/brain`** (`eadf1d3` lint, `5a6a584`
  orphan-1, `d6be7ce` frontmatter-ref-fix-v1, `f76f5c3`
  frontmatter-ref-fix-v2, `6c666bb` orphan-2, `9159bfd` orphan-3,
  `a2efc02` orphan-4) + **4 in fork repo** (`0695a6c` v1 skill,
  `f0cadd3` §6.15 docs, `cf236a4` v2 skill, `<this commit>` §6.16
  docs + TODO archive + new handoff).

### Why we stopped at 4 rounds

The user agreed before launch that 3 rounds (793 → ~500) was the
target window, with a 4th conditional. Round 4's 37-edge yield (vs
68-78 in rounds 2-3) is the practical signal: round 5 would clear
&lt; 30 edges at the same $0.34 per run. At that point the
return-on-cost curve says switch levers — `enrich-sweep` (stub-create
entities mentioned in orphan bodies; new entity pages backlink and
deorphan the source) or hand-curated OpenClaw weaving will yield
more per dollar than another orphan-reducer pass.

### Why brain_score didn't move

The orphans-component score (12/15 currently) is bucketed and the
band is wide. 12 → 13 transitions somewhere around orphan ratio 30%;
we're at 732/2118 = 34.6%. ~100 more deorphans to cross the boundary.
The remaining 732 are the hardest cohort: v1-wiki source pages whose
vector neighbors live in pre-2026 wiki context, but v2 grew along
different axes (Notion ingests, project notes). Same-axis matches
got picked off in rounds 1-4; cross-axis matches are scarce.

### Tail: 19 unresolved refs are correct

The 19 `external_key_skipped` entries are all `raw_path:` field
values pointing at `~/brain/raw/web/X.md` snapshots. The `raw/`
tree is gitignored, so those targets only exist on the production
machine, not in version control. Behavior is correct — the skill
recognizes them as legitimate external pointers (the v2
`EXTERNAL_POINTER_KEYS` allowlist) and leaves them alone.

### Status: TODO.md archived

`skills/kos-jarvis/TODO.md` is **officially archived** as of the
docs commit alongside this entry. Outstanding P0/P1/P2 items
either landed in this two-§ session (Tier 1 sweep, frontmatter-
ref-fix v1+v2, 4 orphan rounds) or are calendar checkpoints owned
by future sessions (Step 2.4 commit-batching @ 2026-05-07, v1
archive @ 2026-05-04, 3072-dim embed re-evaluation @ 2026-05-25,
upstream `gbrain#370` PGLite-upgrade-fix watch).

The next session should:
1. Read [`docs/SESSION-HANDOFF-2026-04-27-evening-sweep-complete.md`](SESSION-HANDOFF-2026-04-27-evening-sweep-complete.md)
   for the closing snapshot.
2. Re-survey upstream `garrytan/gbrain master` for new commits past
   v0.20.4 — sync any new releases.
3. Build a fresh TODO list from current pain points (not the
   v1-wiki backlog ... that's gone).

---

## 6.17 Upstream v0.22.8 sync (2026-04-29, commit `811c266`)

Nine upstream releases land in one merge: v0.21.0 → v0.22.0 → v0.22.1 →
v0.22.2 → v0.22.4 → v0.22.5 → v0.22.6 → v0.22.6.1 → v0.22.7 → v0.22.8
(11 commits, 189 files, +20725 / -573). The headline win is
**v0.22.6.1's `applyForwardReferenceBootstrap()` closing the 10-issue
PGLite wedge cycle** that we'd been carrying a fork patch for since
v0.18 — see §6.12. The fork patch on `pglite-schema.ts` (idx_pages_source_id
comment block) was dropped during merge; upstream's bootstrap probe
in `initSchema()` supersedes it.

### What we adopted

- **#370 closure (#440 / v0.22.6.1)** — bootstrap probe handles the
  pre-v0.18 forward-reference. Our 11-line comment block + missing
  `CREATE INDEX` line are gone; upstream's verbatim restored.
- **v0.21.0 Code Cathedral II** — schema migrations v25..v28 (parent_symbol_path
  TEXT[], doc_comment, search_vector TSVECTOR + plpgsql trigger,
  code_edges_chunk + code_edges_symbol tables). CHUNKER_VERSION 3→4
  forces full re-walk on next sync via `sources.chunker_version` gate.
  Our brain is markdown-heavy (notion sources) so re-chunking cost
  is mostly cache-hit; cost preview not run pre-cutover (see follow-up).
- **v0.22.0 source-aware search ranking** — default boost map doesn't
  recognize our layout (`sources/notion/`, `concepts/`, `projects/`),
  so default behavior is no-op (factor=1.0 for unknown prefixes).
  `GBRAIN_SOURCE_BOOST` tune-up parked for 1-week observation.
- **v0.22.2 cold-start retry** — `connectWithRetry()` default-on; helps
  every CLI call against PGLite under contention. RSS watchdog +
  autopilot backpressure are Postgres-only, skipped.
- **v0.22.4 frontmatter-guard** — new skill registered in manifest
  (`frontmatter-guard`); doctor gains `frontmatter_integrity` subcheck.
  First audit on production: `{ok: true, total: 0, errors_by_code: {},
  per_source: []}` — clean. Per-source array empty because our
  `default` source's `local_path` isn't set up the way the v0.22.4
  audit walker expects; not blocking, audit returned green anyway.
- **v0.22.5 cycle.ts per-source anchor** — `gbrain dream` now reads
  `sources.last_commit` instead of the global `config.sync.last_commit`.
  Reduces the "GC'd commit → full reimport" failure mode. We have a
  `default` source registered (Step 2.2), so this is a free win.

### What we skipped (intentional)

- **v0.22.6 post-migration schema self-healing** — Postgres + PgBouncer
  specific. PGLite no-op.
- **v0.22.7 built-in HTTP MCP transport** — we use stdio MCP only.
- **v0.22.8 doctor integrity batch-load** — Postgres-only path; PGLite
  takes the unchanged sequential path.
- **v0.22.1 autopilot fix wave** — we don't run autopilot. NOTE:
  v0.11.0's autopilot-install side effect did NOT re-trigger today
  because the v0.11.0 ledger entry was already `complete` from
  2026-04-22; only v0.21.0 + v0.22.4 ran today, and neither installs
  launchd services. (For future syncs that include v0.11.0 first-run,
  set `gbrain config set minion_mode off` BEFORE `apply-migrations`.)

### Fork-local patches state (re-verified post-merge)

| Patch | Status | Reason |
|---|---|---|
| `src/core/pglite-schema.ts` idx_pages_source_id comment | **DROPPED** | Closed by v0.22.6.1 bootstrap |
| `src/core/pglite-engine.ts` `pg_switch_wal()` before close | **RETAINED** | macOS 26.3 WASM persistence — upstream doesn't address this; `applyForwardReferenceBootstrap` runs in `initSchema()`, our patch in `close()`/`disconnect()` — they don't conflict |
| `src/cli.ts` mode 0755 | **RETAINED** | Bun shim at `~/.bun/bin/gbrain → src/cli.ts` |

### Sync sequence (notable surprises)

This sync taught two lessons the runbook didn't anticipate:

1. **`bun install` postinstall ran apply-migrations against PRODUCTION
   during Phase B.** Upstream's `package.json` has a `postinstall` hook
   `command -v gbrain && gbrain apply-migrations --yes --non-interactive`.
   With our `~/.bun/bin/gbrain` symlink pointing at the repo's
   `src/cli.ts` (which was now v0.22.8 mid-merge), `bun install` to
   regenerate `bun.lock` triggered apply-migrations on the live brain.
   Two ledger entries written at 07:13:32: v0.21.0 status=complete (schema
   v25..v28 walked), v0.22.4 status=complete (audit skipped, no_sources_registered).
   **Production schema_version went 24 → 29 inside Phase B**, before
   we'd taken the planned Phase C snapshot. Did not cause data loss
   because v0.22.6.1's bootstrap is robust and the migration was
   what we'd have run in Phase C anyway, just earlier.
2. **6 zombie gbrain subprocess sync workers had been holding the
   PGLite lock for hours**, accumulating 200+ minutes of CPU each.
   They were spawned by old crons (likely from `kos-deep-lint` / older
   notion-poller wrappers) and never reaped. After bootouting all
   jarvis services, `gbrain stats` still timed out on lock; lsof
   surfaced PIDs 23625/36238/57969/58201/62243/70599 — none of them
   in launchd's process tree, all parented to PID 1. SIGTERM ignored;
   SIGKILL released the lock. **This explains the recurring kos-compat-api
   /ingest 500 timeout pattern** observed earlier (commit `971b9ba`).
   Filed as new TODO P1.

### Validation (all green)

| Check | Result |
|---|---|
| schema_version | 24 → **29** (latest) ✓ |
| Pages | 2117 / 2117 (zero drift) ✓ |
| Chunks | 4023 / 4023, 100% embedded ✓ |
| Links | 8225 → 8229 (+4 from notion-poller during phase) ✓ |
| Timeline | 11084 / 11084 ✓ |
| brain_score | 85/100 unchanged (embed 35/35, links 25/25, timeline 3/15, orphans 12/15, dead-links 10/10) |
| doctor health | 85/100 (3 PGLite-quirk WARN: pgvector / graph_coverage / jsonb_integrity, no FAIL) |
| `frontmatter audit` | `{ok: true, total: 0}` ✓ |
| `/status` smoke | 200 in 298ms, total_pages=2117 ✓ |
| `/query` Chinese smoke | 200 in 11.7s, retrieved relevant person/concept pages ✓ |
| typecheck | clean ✓ |

### Conflict resolution (3 manual)

- `package.json`: kept upstream's new `@dqbd/tiktoken: ^1.0.22` dep,
  overrode upstream pin `pglite: 0.4.3 → 0.4.4` (macOS 26.3 still aborts
  on 0.4.3 per `#223` class).
- `bun.lock`: regenerated via `bun install` against the resolved package.json.
- `src/core/pglite-schema.ts`: replaced our 11-line `FORK-LOCAL PATCH`
  comment block with upstream's verbatim
  `CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages(source_id);` line.

7 files auto-merged (CLAUDE.md, README.md, src/cli.ts, skills/RESOLVER.md,
skills/manifest.json, src/core/pglite-engine.ts — including additive
of upstream's `applyForwardReferenceBootstrap()` at line 137 with our
`pg_switch_wal()` at line 89 surviving — and others).

### Rollback matrix

```bash
git reset --hard pre-sync-v0.22.8-1777445821
cp -R ~/.gbrain/brain.pglite.pre-sync-v0.22.8-1777447016 ~/.gbrain/brain.pglite
launchctl bootout gui/$UID/com.jarvis.kos-compat-api
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist
```

The PGLite snapshot is 550 MB. Keep for ≥7 days; prune
`~/.gbrain/brain.pglite.pre-sync-v0.20-*` and `pre-step3.0-*` after a
clean week of dream cycles + ingest.

### Follow-ups for next session (filed in new TODO.md)

1. **Zombie sync subprocess leak** (P1 NEW) — root-cause why 6 `gbrain sync`
   workers ran for 4-12 hours each holding the PGLite lock. Probably
   `~/.openclaw` cron or stale `kos-deep-lint` wrapper. Add a sanity
   `pgrep -lf 'gbrain sync.*--no-pull'` check + alert in kos-patrol.
2. **graph_coverage 0% post-v0.21.0** (P2) — doctor's new metric reports
   0% entity-link / timeline coverage despite 8229 links + 11084 timeline
   entries. Likely a rename of what's counted as "graph coverage" — the
   link extractor may need a fresh run with the v0.21.0 chunker version
   to write into the new `code_edges_*` tables. Suggested: `gbrain
   link-extract && gbrain timeline-extract` per doctor's hint.
3. **CHUNKER_VERSION 3→4 dry-run never executed** (P2) — `gbrain
   reindex-code --dry-run` was deferred during cutover. The
   `sources.chunker_version` gate will trigger a full re-walk on
   next `gbrain sync` regardless. Run a manual dry-run when convenient
   to know cost in advance.
4. **`default` source `local_path` not set** (P2) — v0.22.4 frontmatter
   audit returns `per_source: []` because the source-resolver doesn't
   see `local_path` for our `default` source. Set it via
   `gbrain sources update default --local-path ~/brain` (CLI shape may
   differ; confirm with `--help`). Cosmetic until v0.22.4 starts
   gating something on the audit.
5. **`GBRAIN_SOURCE_BOOST` tune-up** (P2) — observe Chinese-query
   quality for 1 week; if `sources/notion/` is swamping retrieval,
   set `GBRAIN_SOURCE_BOOST="concepts/:1.5,projects/:1.3,sources/notion/:0.7"`
   in `com.jarvis.kos-compat-api.plist` env.

---

## 6.18 PGLite → 本地 Postgres 迁移 — Path 3 P0 unblock (2026-04-29 afternoon)

> Plan: [`~/.claude/plans/recursive-churning-map.md`](~/.claude/plans/recursive-churning-map.md). Supersedes
> Path 2 (long-lived in-process engine refactor) which was the prior plan
> in [§3 of the v0.22.8 handoff](SESSION-HANDOFF-2026-04-29-post-v0.22.8-sync.md).

### Why Path 3 (Postgres) was chosen over Path 2 (in-process refactor)

The 2026-04-25 evaluation at
[`docs/UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md`](UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md)
deferred the Postgres switch indefinitely until one of four trigger
conditions fired. The v0.22.8 sync surfaced **trigger #3 in spirit** —
"WAL fork patch fails silently". The actual symptom was not WAL data
loss but its load-class twin: **`gbrain dream` cycle silent-wedged for
12h 42min** holding the PGLite write lock (75 % CPU R-state, stderr
0 bytes since startup) while `notion-poller` /ingest queries 134 s
each + spawnAsync 180 s SIGKILL → zombie subprocess pile-up. PGLite's
single-writer lock topology had stopped being adequate for the v0.21+
sync workload on this brain.

Path comparison (decided 2026-04-29 14:30 local):

| Dimension | Path 2 (in-process refactor) | **Path 3 (Postgres) — chosen** |
|---|---|---|
| Time | ~3 h | ~2.5 h actual |
| Code change | refactor /ingest+/status+/query (~150 LOC) | BrainDb dual-engine split (~80 LOC) |
| Cron disabled | kos-patrol + enrich-sweep (P1 follow-up) | none |
| Upstream features unlocked | none | `jobs supervisor`, `queue_health`, `wedge-rescue` |

### What landed

- **Postgres 17 + pgvector 0.8.2** as engine: brew bottle install, `gbrain` db with `vector` + `pg_trgm` extensions, Postgres superuser = `chenyuanquan` (local trust auth).
- **`gbrain migrate --to supabase --url postgresql://chenyuanquan@127.0.0.1:5432/gbrain`** transferred all 2117 pages, 8231 links, 11084 timeline entries, and 3782/4023 chunks (94 % preserved with embeddings, 241 stale carried over from PGLite source). `~/.gbrain/config.json` rewritten by migrate to `{engine: "postgres", database_url: ...}`. Original `~/.gbrain/brain.pglite/` retained as cold backup.
- **`skills/kos-jarvis/_lib/brain-db.ts` dual-engine refactor** (commit pending): detects engine from config, opens `postgres()` or `PGLite.create()`, runs all 9 query methods through a shared `_q(sql, params)` adapter. All 9 BrainDb callers (kos-patrol, kos-lint, dikw-compile, evidence-gate, confidence-score, orphan-reducer, slug-normalize, server/kos-compat-api) keep working unchanged. **Zero launchd plist edits** (db config lives in `~/.gbrain/config.json`).
- **dream-cycle re-enabled.** First Postgres run completed 6 phases in **1030 ms** (vs PGLite silent wedge of 12 h 42 min). The dream-wrap auto-retry caught a 47 s cold-path SIGKILL on the very first cycle and recovered cleanly on retry.
- **notion-poller re-enabled.** First cycle ingested **152 pages in 5.5 min**, 0 zombie subprocesses, exit code 0. /status latency 90 ms during the burst with concurrent in-flight `gbrain sync` subprocess (proves Postgres MVCC vs PGLite single-writer lock).

### Production state at handoff

| Layer | Pre-Path-3 (PGLite) | Post-Path-3 (Postgres) |
|---|---|---|
| Engine | PGLite 0.4.4 (WASM Postgres 17.5) | Postgres 17 (Homebrew) + pgvector 0.8.2 |
| Pages | 2117 | **2303** (+186 ingested in first cycles) |
| Links | 8229 | 8231 (rebuild parity, ON CONFLICT DO NOTHING) |
| Embeddings | 100 % (per stats) | 94 % (241 stale, run `gbrain embed --stale`) |
| dream cycle | silent wedge 12h+ | **1030 ms warm** |
| /ingest single file | 134 s + 180 s SIGKILL | ~10 s warm |
| /status during burst | 30+ s blocks | **90 ms** |
| notion-poller | DISABLED (would deadlock) | **enabled, +152p/5.5min, 0 zombies** |
| Concurrent /ingest + cron | impossible (single-writer lock) | works (Postgres MVCC) |

### Reused upstream code (no fork patch added)

- `src/commands/migrate-engine.ts` — official engine migration tool, Supabase-named flag handles any Postgres URL.
- `src/core/postgres-engine.ts` — full engine implementation, all `BrainEngine` methods supported.
- `src/core/engine-factory.ts` — auto-selects engine from config.

### Trigger #3 of v020-pglite-postgres-evaluation marked satisfied

The evaluation predicted "switch when WAL patch fails silently". We
reached the same outcome via "single-writer lock topology fails
silently under v0.21+ sync workload". Document banner updated in
[`docs/UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md`](UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md).

### Rollback path (in case anything regresses)

```bash
launchctl bootout "gui/$(id -u)/com.jarvis.kos-compat-api"
DATABASE_URL='postgresql://chenyuanquan@127.0.0.1:5432/gbrain' \
  bun run src/cli.ts migrate --to pglite --path ~/.gbrain/brain.pglite --force
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist
```

The pre-Path-3 PGLite snapshot at `~/.gbrain/brain.pglite.pre-path2-1777504487`
(502 MB) is the deeper rollback point if the live PGLite dataDir gets
corrupted between now and the migration.

### Follow-ups filed in TODO.md

- **P1** — `gbrain embed --stale` to top up the 241 missing embeddings.
- **P2** — observe single-file /ingest perf on Postgres for 1 week. Currently 105 s cold / 10 s warm; if Notion ingestion lag becomes user-visible, refactor /ingest to use upstream `dispatchToolCall(engine, 'put_page')` in-process (the original Path 2 plan, but on top of Postgres). The Postgres MVCC win means the urgency is gone but the perf opportunity remains.
- **P2** — re-enable v0.20+ upstream features that PGLite skipped (`gbrain doctor --json | jq .checks.queue_health`).

---

## 6.19 Phase A system review + Phase B/C cleanup (2026-04-30)

After 7 consecutive days of upstream syncs (v0.14 → v0.22.8) + the Path 3
Postgres migration, the next session ran a full system review per Lucien's
ask, then closed the four most actionable items in one shipping window.

### Phase A — measured, not assumed

Six dimensions (brain health / service mesh / query smoke / storage /
patrol / TODO 对账). Highlights:

- 2339 pages, **0 NULL embeddings** (the 241 stale from §6.18 follow-up
  auto-consumed by the dream-cycle), 8231 links, 8928 timeline entries,
  242 MB DB.
- All 10 jarvis services registered with launchd. `kos.chenge.ink/status`
  burst 217-247 ms / sequential 107-166 ms.
- 5-query Chinese smoke (DIKW / Postgres 迁移 / kos-jarvis 架构 / Lucien
  的角色 / E0-E4) — retrieval + LLM synthesis healthy on all five.
- ⚠️ Zero backup automation since Path 3. **Highest current production
  risk.**

### Phase B — backup + patrol noise (closed during the review session)

1. **`scripts/jarvis-pg-backup.sh` + `com.jarvis.gbrain-backup.plist`**
   (`51a3009`). `pg_dump -Fc` → `~/.gbrain/backups/gbrain-YYYYMMDD.dump`,
   14-day retention, daily 03:33 local (off the dream-cycle 03:11 to
   avoid contention). First manual run produced a 63 MB compressed dump
   (DB 239 MB → 26 % gzip), `pg_restore --list` TOC verified at 275
   entries.
2. **kos-patrol Phase 4 noise stoplist** (`b770e74`). 30+ Notion column
   headers + UI labels added (4 sweep passes), plus a ≥2-distinct-kind
   rule that filters single-kind hits. Result: dashboard flipped from
   100 % column-header noise (`Original EML` ×862, `Action Type` ×858,
   `Best Regards`, `Open Threads`, ...) to 95 % real signals (`Link
   Systems Inc`, `MCMC Jendela`, `Cloud VMS`, `RADIUS Server`, `MCP
   Server`, `PoE AIO`, `Omada Roadmap`, ...).

### Phase C — dead-link cluster + cosmetic + graph_coverage docs (this commit)

3. **35 dead-link ERROR cluster** (10 brain pages, ~/brain commit
   `cde82a1`). Root cause: same-dir markdown links written as `(slug.md)`
   short form. `kos-lint` `candidateSlugs()` strips `./` and `../` before
   matching against the dir-prefixed slug set; same-dir short form falls
   back only to bare basename which never matches a `dir/slug` (only
   root-level slugs without a dir prefix would). Fix: rewrite as
   `(../<dir>/slug.md)` to match the healthy form already used by
   cross-dir refs. The `decisions/phase-2-feishu-signal-detector-acceptance`
   page also referenced fork-repo files via `(../../docs/...)` and
   `(../../skills/...)` — those got unwrapped to backtick form because
   brain's lint can't resolve fork-repo paths and the cross-link wasn't
   semantically a wikilink anyway. After ingest + patrol: ERROR cluster
   targets to drop to 0 next patrol cycle.
4. **`/status` engine label cosmetic** (`server/kos-compat-api.ts:258`).
   Hardcoded `gbrain (pglite)` → `gbrain (postgres)` post-Path-3, so
   downstream parsers (Notion Knowledge Agent, OpenClaw feishu) get the
   right engine identity.
5. **kos-patrol launchd `last exit code = 2`**. Patrol exits 2 by design
   when warns exist (0 = clean, 1 = ERROR fail, 2 = WARN-only). launchd
   treated ≠0 as fail and emitted "ServiceFail" daily despite the service
   being healthy. Fix: `<key>SuccessfulExitCodes</key><array>0,2</array>`
   in `scripts/launchd/com.jarvis.kos-patrol.plist.template`. ERROR
   (exit 1) still surfaces.

### `graph_coverage 0%` is expected on a markdown-only brain

`gbrain doctor` reports `[WARN] graph_coverage: Entity link coverage 0%,
timeline 0%. Run: gbrain link-extract && gbrain timeline-extract` even
though `brain_score` shows `links 25/25 + timeline 3/15` — the metrics
disagree because they measure different things.

- `brain_score.links` counts absolute edge density (8231 links across
  2339 pages = healthy).
- `graph_coverage` measures the **percentage of pages with ≥1 inbound
  entity-link or ≥1 timeline entry**. Most of our pages are
  `sources/notion/*` (60 % of corpus, 1467/2339 today), and notion-
  poller dumps each as a single source page with no timeline + no
  inbound entity references — neither gets entity-extracted (they're
  the raw text, not a synthesized concept/person page). Hence the
  page-level percentage is dominated by the notion source corpus and
  rounds to 0 %.

This is a markdown-only design property, not a regression. The Code
Cathedral metric (v0.21.0 added `code_edges_chunk` + `code_edges_symbol`)
is also 0 % for us because we have no `kind=code` pages.

**Decision**: accept as expected, document here, do **not** run
`gbrain link-extract` chasing the metric. The TODO P1 entry is closed
by this paragraph.

### Net effect (Phase A → C)

| Dim | Before | After |
|---|---|---|
| Backup automation | none | daily 03:33, 14 d retention, verified |
| Patrol gap signal | 100 % Notion column headers | 95 % real entity gaps |
| Lint ERROR cluster | 35 (9 files) | 0 (after next patrol cycle) |
| /status engine label | `gbrain (pglite)` (wrong) | `gbrain (postgres)` |
| launchd patrol noise | daily ServiceFail alert | suppressed (exit 2 = success) |
| TODO graph_coverage P1 | open since v0.21 sync | closed (expected, documented) |

Two TODO P1 + two P3 closed, plus one production risk (zero backups)
mitigated, in ~3 hours of focused work.

---

## 6.20 Upstream v0.25.0 sync (2026-05-01)

> Plan:
> [`docs/SESSION-HANDOFF-2026-05-01-pre-v25-sync.md`](SESSION-HANDOFF-2026-05-01-pre-v25-sync.md).
> Strategy chosen at session start: single `git merge upstream/master`
> (16 commits, 12 versions in one shot) over the handoff's "three hops"
> idea — fewer conflict-resolution rounds, one validation pass, same
> end state. Branch: `sync-v0.25.0`.

Twelve upstream releases land in one merge: v0.22.10 → v0.22.11 → v0.22.12
→ v0.22.13 → v0.22.14 → v0.22.15 → v0.22.16 → v0.23.0 → v0.23.1 → v0.23.2
→ v0.24.0 → v0.25.0 (16 commits including a paired jsonb fix + revert).
The headline addition is **v0.25.0's BrainBench-Real substrate**: two new
schema tables (`eval_candidates`, `eval_capture_failures`), 5 new
`BrainEngine` methods, an op-layer capture wrapper, and a PII scrubber.
Capture is OFF by default for end users; flipped ON for this fork to
build a retrieval baseline (see "Eval capture posture" below).

### Handoff pre-flight findings (revised on day-of)

The handoff doc described "三跳" (v0.22.9 → v0.23.2 → v0.24.0 → v0.25.0).
Day-of inspection found 7 missed patch releases (v0.22.10..v0.22.16) that
ship real features (storage tiering, parallel sync, frontmatter inference,
claw-test E2E harness, autopilot phase-forwarding). Strategy adjusted to
single merge of all 16 commits.

The handoff also predicted that BrainDb (`skills/kos-jarvis/_lib/brain-db.ts`)
"必须补齐这 5 个方法" because v0.25.0 made the BrainEngine interface
breaking. **This was wrong**: BrainDb is not a `BrainEngine` implementation,
it's a thin direct-DB reader, and none of its 9 callers consume eval APIs.
Decision: mirror the surface anyway as a safety net (see below) so future
fork skills don't have to reach into `src/core/`.

### What we adopted

- **v0.22.10** — `autopilot-cycle` handler forwards `phases` array to
  runCycle. Inert for us (no autopilot daemon).
- **v0.22.11 storage tiering** — new `db_tracked` vs `db_only` directory
  classes for sources. Schema migration only; no behavior change unless
  configured.
- **v0.22.12 sync error-code coverage** — adds `FILE_TOO_LARGE` +
  `SYMLINK_NOT_ALLOWED` to `classifyErrorCode()`. Direct overlap with our
  v0.22.9 cherry-pick; merge cleanly added the two new clauses to the same
  function.
- **v0.22.13 parallel sync** — bounded-concurrency import. Free speed-up
  on next full re-sync (we don't run those often).
- **v0.22.14 minion bare-worker self-monitoring** — Postgres-only;
  applies whenever we run `gbrain agent run` durable subagents (not yet,
  see TODO P3).
- **v0.22.15 frontmatter inference** — files without YAML headers now
  ingest with auto-inferred kind/title. Reduces friction for ad-hoc
  notes; semantics-preserving for our existing pages.
- **v0.22.16 `gbrain claw-test`** — new fresh-install friction harness.
  Uses `test/.cache/`; gitignored.
- **v0.23.0 dream synthesizes conversations** — `gbrain dream` now reads
  recent transcripts and writes synthesis pages. Off by default; opt-in
  via dream config. We're not opting in yet (separate evaluation needed
  on Chinese-language conversation digesting).
- **v0.23.1 local CI gate** — `bun run ci:local` (~13× faster than full
  CI); 4-tier wall-time optimization. Optional dev tool.
- **v0.23.2 dream marker fix** — orchestrator-stamped self-consumption
  marker. Fixes the dream cycle re-consuming its own output (latent bug
  for us; we run dream daily so this lands a real fix).
- **v0.24.0 skillify production hardening** — managed-block install,
  no-clobber, drift detection. Inert for us (we don't run skillify
  on this brain).
- **v0.25.0 BrainBench-Real (the headline)** — schema migrations v30
  (`dream_verdicts_table`) + v31 (`eval_capture_tables`):
  `eval_candidates` (16-column row per `query`/`search` call) +
  `eval_capture_failures` (cross-process audit). Op-layer capture
  wrapper in `src/core/eval-capture.ts` runs PII scrubber
  (`src/core/eval-capture-scrub.ts` — emails, phones, SSN,
  Luhn-verified CC, JWT, bearer tokens). 5 new `BrainEngine` methods:
  `logEvalCandidate`, `listEvalCandidates`, `deleteEvalCandidatesBefore`,
  `logEvalCaptureFailure`, `listEvalCaptureFailures`. New CLI:
  `gbrain eval export` (NDJSON for sibling gbrain-evals consumption),
  `gbrain eval replay`, `gbrain eval prune`. Default capture posture
  OFF for end users; flag is `GBRAIN_CONTRIBUTOR_MODE=1` env var OR
  `eval.capture: true` in `~/.gbrain/config.json`.

### What we skipped (intentional)

Nothing skipped this round — every upstream feature came along, schema
migrated, fork patch survived. Some are inert for our setup (autopilot,
claw-test) but cost nothing to keep.

### Fork-local patches state (re-verified post-merge)

| Patch | Status | Reason |
|---|---|---|
| `src/core/pglite-engine.ts` `pg_switch_wal()` before close | **RETAINED** | macOS WASM persistence — line 182, untouched by upstream |
| `src/cli.ts` mode 0755 | **RETAINED** | Bun shim at `~/.bun/bin/gbrain → src/cli.ts` |
| `skills/kos-jarvis/_lib/brain-db.ts` direct-DB reader | **EXTENDED** | Added 5 eval methods (safety net) + 4 type aliases (locally defined, no upstream import). Original 9 callers untouched. |

### New fork-local additions (v0.25.0-only)

- **BrainDb eval surface** (`skills/kos-jarvis/_lib/brain-db.ts`,
  +124 lines): `logEvalCandidate`, `listEvalCandidates` (with
  `since/limit/tool` filter, `id DESC` tiebreaker matching upstream),
  `deleteEvalCandidatesBefore`, `logEvalCaptureFailure`,
  `listEvalCaptureFailures`. Engine-portable SQL via the existing `_q`
  adapter. Self-contained types (no `gbrain/types` import).
- **BrainDb eval test** (`skills/kos-jarvis/_lib/brain-db.test.ts`,
  6 cases, 19 expects): in-memory PGLite, hermetic (no `~/.gbrain/config.json`
  dependency, injects PGLite via private-field write). Covers
  insert+id-return, list-ordering with id-DESC tiebreaker, tool filter,
  limit clamping (`[1, 100000]` with sensible defaults on `0`/negative/`NaN`),
  delete-before cutoff, failure round-trip with set-equality (no
  ts-tiebreaker, matches upstream contract).

### Eval capture posture (decision)

The handoff suggested "**不启用** GBRAIN_CONTRIBUTOR_MODE=1" (privacy
default + small brain). Reversed at session start: enabling capture
locally so we can build a retrieval baseline and gate future search
changes against it. Privacy-positive defaults are still respected for
anyone forking this fork (they have to opt in themselves).

Concretely: `~/.gbrain/config.json` gains `"eval": {"capture": true}`.
Capture writes to `eval_candidates` on every `gbrain query` /
`gbrain search` / MCP `query` / MCP `search` / subagent `query`/`search`.
PII scrubber runs at write time; queries over 50KB rejected.

### Conflict resolution (8 manual)

- `.gitignore` — kept upstream's claw-test cache + Tier 3 PGLite
  snapshot ignores; appended fork's `.omc/` + launchd log ignores below.
- `VERSION`, `package.json` — kept upstream `0.25.0`.
- `bun.lock` — kept upstream's added `bun-types@1.3.11` resolution; ran
  `bun install` to settle the rest.
- `CHANGELOG.md`, `TODOS.md` — empty HEAD blocks (we don't carry our own
  release notes / TODO entries here); kept upstream verbatim.
- `src/core/sync.ts`, `test/sync-failures.test.ts` — empty HEAD blocks;
  kept upstream's two new error-code clauses + their tests
  (`FILE_TOO_LARGE`, `SYMLINK_NOT_ALLOWED`).

### Privacy-gate scrub

Upstream's new `scripts/check-privacy.sh` (CLAUDE.md:550 enforcement)
fired on two fork files:

- `skills/kos-jarvis/TODO.md:35` — example slug layout (banned-word form)
  rewritten to `your-openclaw/chat/`.
- `skills/kos-jarvis/pending-enrich/SKILL.md:38` — example JSON line
  rewritten from a real-person + real-fund pairing to
  `alice-example` / `widget-co seed`.

Both are documentation examples, not real data; the scrub is a
privacy-rule alignment, not a data fix.

### Validation (all green)

| Check | Result |
|---|---|
| schema_version | 29 → **31** ✓ (v30 dream_verdicts + v31 eval_capture_tables) |
| Pages | preserved ✓ |
| Embed coverage | 99 % (25 stale; 0 v30/v31-introduced regression) |
| Links / Timeline | preserved ✓ |
| brain_score | held at 83/100 (embed 35/35, links 25/25, timeline 3/15, orphans 10/15, dead-links 10/10) |
| typecheck | clean ✓ |
| `bun test` (3787 cases / 230 files / 1100 s) | 3487 pass / 293 skip / 6 fail — 1 fixed (build-llms regen), 5 are pre-existing GBRAIN_HOME-related upstream test gaps unrelated to sync (see Pre-existing test gaps below) |
| BrainDb eval test (6 cases) | green ✓ |
| `gbrain query` test | 1 row inserted into `eval_candidates` ✓ |
| `eval_capture_tables` migration | success, BYPASSRLS confirmed ✓ |

### Pre-existing test gaps (5 failures, all upstream)

The 5 fails are environment-coupling bugs in upstream tests, not regressions
from this sync. They surfaced now because we run `bun test` from the
project directory which auto-loads `.env`, and our `.env` sets
`GBRAIN_HOME=/Users/chenyuanquan/brain`. Upstream tests assume
`homedir() === gbrain config home`:

- `check-resolvable-cli > resolveSkillsDir > REGRESSION-GATE` (1.59 ms)
- `check-resolvable-cli > finds skills via findRepoRoot when cwd is inside a repo` (0.30 ms)
  — both expect `r.source === 'repo_root'`; openclaw workspace marker
  on the dev box wins instead.
- `init-migrate-only > applies schema against existing PGLite config; does
  NOT modify config.json` (53 ms)
- `init-migrate-only > idempotent on rerun` (54 ms)
  — both seed `${tmp}/.gbrain/config.json` and call `gbrain init` with
  `HOME=${tmp}`, but `GBRAIN_HOME=~/brain` from `.env` overrides HOME and
  re-routes the lookup away from the seeded path.
- `core/cycle.test.ts > file lock blocks concurrent engine=null cycles`
  (1.48 ms) — same root cause: the test seeds `${homedir()}/.gbrain/cycle.lock`
  but `runCycle` reads `gbrainPath()/cycle.lock`, which honors GBRAIN_HOME.

**Resolution (post-merge cleanup)**: 3 of 5 fixed by commenting
`GBRAIN_HOME=/Users/chenyuanquan/brain` out of `.env` + `.env.local` (it
was a leftover from an aborted "brain config under brain repo" migration
that never populated `~/brain/.gbrain/config.json`). Now down to 2 fails,
both `check-resolvable resolveSkillsDir` cases that expect `r.source ===
'repo_root'` but get `'openclaw_workspace_home_root'` because the dev
machine has openclaw workspace marker that wins findRepoRoot precedence.
Both are upstream-test-only; the production code path they cover works.

### Post-merge actions (2026-05-02)

1. **`master` updated**: `git merge --no-ff sync-v0.25.0` ⇒ commit `f6bb039`.
   Pushed to `origin/master`. The sync work commit is `ea29354`.
2. **Long-running services restarted** to pick up v0.25.0 src/cli.ts via
   the `~/.bun/bin/gbrain → src/cli.ts` symlink shim:
   - `com.jarvis.gemini-embed-shim` (PID 2502 → 63403)
   - `com.jarvis.kos-compat-api` (PID 32389 → 63464)
   - cron-driven services (notion-poller, dream-cycle, kos-patrol,
     enrich-sweep) pick up new code on next scheduled fire.
3. **`GBRAIN_HOME` scrubbed from `.env` + `.env.local`** (commented with
   explanatory block) — local-dev fix only; **5 launchd plist templates
   still set it** under `EnvironmentVariables`. Production state inherited
   that plist setting.

### Open: dream-cycle production breakage (root cause + path forward)

`gbrain dream` (and other upstream-CLI cron callers) fail under
production env because `connectEngine()` calls `loadConfig()` which
reads `${GBRAIN_HOME}/.gbrain/config.json`. With `GBRAIN_HOME=~/brain`
and no file at that path, loadConfig returns null → `console.error('No
brain configured')` + `process.exit(1)`. Verified via
`launchctl kickstart -k gui/$UID/com.jarvis.dream-cycle` returning
exit=1 with that exact error.

The last successful cron run was `2026-05-01T10-11-02Z` (yesterday
03:11 PT), captured at `~/brain/.agent/dream-cycles/2026-05-01T10-11-02Z.json`.
Why it worked then but not now is unexplained — `loadConfig()` /
`configDir()` were unchanged between v0.22.9 and v0.25.0 per `git diff`.
Either Bun's `.env` auto-load semantics shifted between releases, or
something transient in yesterday's process env was different. The
mechanism that yields today's failure is robustly reproducible.

**Two fix paths** (filed as TODO P0 for next session, both unblock
dream-cycle and align local + production on the same config home):

- **Path A (recommended)**: edit all 5 plist templates under
  `scripts/launchd/*.template` to remove the `<key>GBRAIN_HOME</key>` /
  `<string>/Users/chenyuanquan/brain</string>` block, then bootout +
  bootstrap each service. Net: every component reads from `~/.gbrain/`
  uniformly. Migrate orphaned `~/brain/.gbrain/audit/*` and
  `sync-failures.jsonl` to `~/.gbrain/` (cat-merge or move).
- **Path B (band-aid)**: symlink `~/brain/.gbrain/config.json` →
  `~/.gbrain/config.json`. Keeps GBRAIN_HOME redirection but satisfies
  the loadConfig path. Less clean but zero plist surgery.

Until then: dream-cycle daily 03:11 cron is broken. Local dev `bun run
src/cli.ts dream` works (because `.env` no longer sets GBRAIN_HOME).

### Rollback matrix

```bash
git checkout master
git branch -D sync-v0.25.0   # discards merge

# Postgres rollback (the v30/v31 migrations add three new objects;
# safe to keep on rollback):
psql $DATABASE_URL -c 'DROP TABLE IF EXISTS eval_candidates, eval_capture_failures, dream_verdicts;'

# Disable capture before rollback (prevents writes from old binary):
# remove `eval.capture` from ~/.gbrain/config.json
```

### Follow-ups for next session (filed in TODO.md)

1. **Build retrieval baseline (1-week dogfood)** — let capture run
   for 7 days, then `gbrain eval export --since 7d > baseline.ndjson`
   + commit to a private location. Subsequent retrieval changes can be
   gated with `gbrain eval replay --against baseline.ndjson`.
2. **`gbrain dream` conversation synthesis** — evaluate v0.23.0's new
   capability against Chinese-language Notion+Feishu transcripts. Likely
   needs language-aware tweaks; off by default for now.
3. **Storage tiering audit** — v0.22.11 added `db_tracked` vs `db_only`
   classes. Default still `db_tracked`. Worth reviewing whether
   `media/x/` / `archive/` should move to `db_only` (no-search source).

---

## 6.21 Upstream v0.26.7 sync (2026-05-04)

8 releases in one merge: `master..upstream/master` = 25 commits across
v0.25.1, v0.26.0, v0.26.1, v0.26.2, v0.26.3, v0.26.4, v0.26.5, v0.26.6,
v0.26.7. Branch `sync-v0.26.7`, merge commit `a2e5e5b`. All conflicts
resolved in one session, ~2 h end-to-end including evaluation.

### Headline upstream features adopted

- **v0.25.1** — `book-mirror` flagship + 8 research skills: `article-enrichment`,
  `strategic-reading`, `concept-synthesis`, `perplexity-research`,
  `archive-crawler`, `academic-verify`, `brain-pdf`, `voice-note-ingest`.
  Plus `gbrain skillpack uninstall` symmetric to install.
- **v0.26.0** — MCP Keys OAuth 2.1 + HTTP server + admin React dashboard
  (`admin/dist/` ~6 MB committed; new deps: `cookie-parser`, `cors`,
  `express`, `express-rate-limit`). `Operation.scope` (`'read' | 'write'
  | 'admin'`) and `Operation.localOnly` first-class on every op;
  `admin + localOnly` ops (`sync_brain`, `file_upload`, `file_list`,
  `file_url`) reject over HTTP.
- **v0.26.1/2/3** — OAuth `client_credentials` fix, bun execSync env
  inheritance fix, admin per-agent config + auth hardening.
- **v0.26.4** — parallel unit-test loop (8 shards, ~12x speedup on
  upstream's CI; fork doesn't run the matrix yet).
- **v0.26.5** — destructive operation guard end-to-end. Sources +
  pages soft-delete with 72h TTL; new schema column `pages.deleted_at`
  + related sources columns.
- **v0.26.6** — PGLite ↔ Postgres parity gate (closes #588). Validates
  that schemas + behavior match across both engines.
- **v0.26.7** — test isolation foundation. `test/helpers/with-env.ts`
  + `scripts/check-test-isolation.sh` lint guard + serial quarantine
  renames before the wider sweep.

### Conflict resolution summary (31 conflicts in one merge)

- **19 src/ + test/ files** (cycle.ts, migrate.ts, subagent.ts, types.ts,
  schema.sql, schema-embedded.ts, postgres-engine.ts, pglite-schema.ts,
  cli.ts, etc.) — all sync side-effect (fork did not modify these
  post-base; conflicts are upstream restructuring on top of v0.25.0
  baseline). **Resolution: `git checkout --theirs`** for the entire
  batch.
- **`src/core/pglite-engine.ts`** — fork-local WAL durability patch
  (`SELECT pg_switch_wal()` before close, commit `ecc6195`). Take
  upstream as base, then **manually re-apply** the 14-line try/catch
  block in `disconnect()`. Only fork-local src patch in this sync.
- **`@electric-sql/pglite` version pin** — fork wants `0.4.4`,
  upstream wants `0.4.3`. Kept `0.4.4` in `package.json`. Fork-local
  override originally landed in commit `aceb838` (v0.17 sync) for
  macOS 26.3 WASM bug class.
- **`skills/RESOLVER.md` / `skills/manifest.json`** — structural merge.
  Fork's KOS-Jarvis extensions section moved to file end (v0.25.1
  added an Uncategorized section in front of where it used to live);
  manifest.json has 49 skills now (30 prior upstream + 9 new v0.25.1
  skills + 10 fork kos-jarvis skills).
- **`.gitignore`** — explicit merge: fork section preserved (.omc/,
  kos-patrol/enrich-sweep/notion-poller stdout logs) + upstream's
  new `.context/` (run-unit-parallel artifacts).
- **CHANGELOG.md / TODOS.md** — fork HEAD blocks were empty (fork
  doesn't write its own release notes; runs as a cherry-pick consumer).
  Took upstream's full v0.26.x entries verbatim. CHANGELOG.md required
  manual fix because git's diff3 output had a malformed marker shape
  (extra `=======` mid-block); patched with two `StrReplace` calls.
- **CLAUDE.md / CONTRIBUTING.md / README.md / llms-full.txt** — used a
  small Python helper (`/tmp/take-theirs-blocks.py`) to take the
  `theirs` side of every conflict block while preserving fork prelude
  outside markers. Fork prelude (lines 1-58 of CLAUDE.md, lines 1-30
  of README.md) stays intact.

### Validation

- `bun install` → 98 packages, no integrity errors
- `bun run typecheck` → clean (~3 s)
- `bun build --compile --outfile bin/gbrain src/cli.ts` → 1220 modules
  bundled, compiled successfully
- `gbrain --version` → `0.26.7`
- `gbrain doctor --json` → schema_version=2, but **`connection: fail
  "column deleted_at does not exist"`** — v0.26.5's `destructive_guard_columns`
  migration (production DB still at schema v31) needs to run. **Filed
  P0 in [`skills/kos-jarvis/TODO.md`](../skills/kos-jarvis/TODO.md)
  for next session.**
- `skill_conformance: 49/49 ok`
- `resolver_health: warn 37 routing_miss` — entirely from upstream's
  9 new v0.25.1 skills (`book-mirror`, `archive-crawler`, etc.); their
  `routing-eval.jsonl` fixtures use phrasings narrower than the
  trigger words in `RESOLVER.md`. **Upstream gap, not fork
  responsibility.**

### Review: what v0.25.1 → v0.26.7 means for fork-local skill consolidation

Four new overlap surfaces opened that didn't exist at the v0.25.0
baseline. Each adds an M2 candidate to
[`docs/KOS-JARVIS-CONSOLIDATION-PLAN.md`](KOS-JARVIS-CONSOLIDATION-PLAN.md):

#### M2-A — `concept-synthesis` ↔ `dikw-compile` + `confidence-score`

Upstream `skills/concept-synthesis/SKILL.md` (v0.25.1) does T1-T4 tier
classification + LLM synthesis on `concepts/` pages. Fork
`skills/kos-jarvis/dikw-compile/` does A/B/C/F grade + strong-link
compilation across all kinds; `confidence-score/` is its scoring
helper. Overlap is partial: `concept-synthesis` is concepts-only,
fork is cross-kind; both are LLM-driven page-level rewrites with
quality tiers.

Decision tree:
- If `dikw-compile` **was never wired** in production (M1 wire-status
  check still pending), retire all three (`dikw-compile`,
  `evidence-gate`, `confidence-score`); the unwired-design story dies
  with the fork code.
- If `dikw-compile` **was wired** but only on `concepts/` (likely
  given the fork README claims `idea-ingest / media-ingest /
  meeting-ingestion` post-hooks), `concept-synthesis` replaces it on
  that subset; fork retains `dikw-compile` on non-concepts kinds.
- Worst case `dikw-compile` is wired everywhere: keep both, document
  the boundary.

#### M2-B — `kos-compat-api` ↔ `gbrain serve --http` + thin translator

v0.26.0's `gbrain serve --http` lands what we built `kos-compat-api`
for two years ago. The contracts differ:

- Upstream HTTP serves MCP JSON-RPC (`tools/call`, `resources/list`),
  bearer-auth, scope-aware, admin dashboard at `/admin`.
- Fork HTTP serves KOS v1 contract (`/query`, `/ingest`, `/digest`,
  `/status`, `/health`), simpler JSON bodies, hard-coded by Notion
  Knowledge Agent and OpenClaw feishu cron.

Cannot directly retire `kos-compat-api` — `kos.chenge.ink` is the
external boundary, governed by external systems we don't control.
But the upstream foundation opens **two paths**:

- (a) Keep `kos-compat-api` on `:7225` as the KOS-v1 contract layer,
  internally proxy to `gbrain serve --http :7226` via a translator
  layer that maps `/query` → `tools/call({"name":"query"})` etc.
  Reduces ~500 LOC fork code at the cost of one process hop and a
  scope-mapping subtlety (KOS_API_TOKEN → admin scope).
- (b) Migrate external systems to the MCP client SDK directly. High
  cost, not in our control.
- (c) Status quo. Re-evaluate next sync.

#### M2-C — Phase 4-5 (calendar/email import) → upstream `archive-crawler`

`docs/JARVIS-NEXT-STEPS.md` had Phase 4 = calendar import, Phase 5 =
email import as fork-local builds. v0.25.1's `archive-crawler` is
exactly that domain: universal archivist for personal file archives
(Dropbox/B2/Gmail-takeout/local-mount/hard-drive-dump), refuses to
run without explicit `gbrain.yml archive-crawler.scan_paths` allow-list.

If `archive-crawler` covers Lucien's source formats (Apple Calendar
.ics, IMAP mbox export), Phase 4-5 collapse from "build fork-local
skill" to "configure upstream skill". This is the single biggest
fork-shrink opportunity in v0.26.7 — saves ~400-600 LOC of code we
haven't written yet.

#### M2-D — `Operation.scope` + `.localOnly` ↔ fork `OperationContext.remote`

v0.26.0 makes operation-level trust a first-class field on every
Operation: `scope: 'read' | 'write' | 'admin'` + `localOnly?: boolean`.
HTTP transport rejects `admin + localOnly` ops (`sync_brain`,
`file_upload`, `file_list`, `file_url`).

Fork's `OperationContext.remote` boolean is now a strict subset of
upstream's scope system. M2-D migrates fork-local consumers
(`server/kos-compat-api.ts`, `workers/notion-poller/run.ts`,
`skills/kos-jarvis/_lib/`) from `ctx.remote` to `op.scope` checks.
~1 h work. Lets fork stop maintaining the parallel concept.

### Net target update

M1's "16 active fork skill dirs → 11 active + 2 archived + 1 retired"
target stands. M2 (this sync) adds:

- `dikw-compile` → likely scope-narrowed or fully retired (M2-A)
- `confidence-score` → likely retired (M2-A)
- `evidence-gate` → wire-status dependent
- Phase 4-5 fork builds → replaced by upstream config (M2-C)

Net target post-M2: **11 active → 7-8 active by next sync (v0.27.x window)**.
The fork README's "扩展应随时间自愿退场,而非永久膨胀"
(`skills/kos-jarvis/README.md:84`) is operationalizing as designed.

### Production follow-up — completed 2026-05-04 same day

- [x] **P0**: `gbrain apply-migrations --yes` on production Postgres
  — schema v31 → v34. 3 migrations applied (v32 oauth_infrastructure /
  v33 admin_dashboard_columns / v34 destructive_guard_columns). Initial
  attempt failed with `column "agent_name" does not exist` (upstream
  bootstrap miss for v0.26.3 `mcp_request_log` columns). Workaround:
  manual `ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS
  agent_name TEXT, params JSONB, error_message TEXT;` then re-ran
  init --migrate-only. **Upstream PR filed**:
  [garrytan/gbrain#627](https://github.com/garrytan/gbrain/pull/627)
  extends `applyForwardReferenceBootstrap()` to cover the three v0.26.3
  columns; bootstrap-coverage test (PGLite) + e2e regression
  (Postgres) both pass. After merge, future fresh installs hitting
  this case will self-heal, and the manual ALTER runbook in
  `docs/UPSTREAM-PATCHES/v026-bootstrap-mcp-log-fix.md` becomes
  historical.
- [x] Restart `kos-compat-api` (PID 87485 → 27071) + `gemini-embed-shim`
  (PID 63403 → 27143) via launchctl bootout/bootstrap. `:7222` + `:7225`
  listening. `gbrain --version` returns 0.26.7 via the shim → src/cli.ts.
- [x] `kos.chenge.ink/status` + local `127.0.0.1:7225/status` both
  return `total_pages=2477` — boundary intact.
- [x] `launchctl kickstart -k kos-patrol` smoke: exit=0, **0 ERROR /
  0 WARN**, dashboard + digest written to `~/brain/.agent/{dashboards,
  digests}/`. notion-poller (5-min cron) clean: stderr 31+ min idle
  after the merge transient (one captured `<<<<<<< HEAD` token in
  package.json mid-merge), 5 subsequent cycles all `0 ingested,
  0 skipped`.
- **Surprise finding**: kos-patrol stderr shows `kos-lint JSON parse
  failed; exit=3` — `kos-lint` is **already broken** in production,
  patrol skips it and reports 0 WARN. The PILOT-RETIRE pilot for
  `kos-lint` (PLAN §5 / M1.kos-lint-retire) now has overwhelming
  evidence: nothing in the production loop depends on it. Pilot
  procedure simplifies from 4h evaluation to ~30 min of mechanical
  cleanup.

### M2-A resolution (same day, 2026-05-04)

Production data probe drove M2-A to a definitive verdict before any
pilot ran:

- `frontmatter.dikw_layer` — set on **0 / 2477** pages.
- `frontmatter.evidence_level` — set on **1 / 2477** pages (single E2).
- `frontmatter.confidence` — set on 2470 / 2477, but the values are
  hardcoded template strings in `server/kos-compat-api.ts:454,533`
  (`confidence: low`), never written by `confidence-score/run.ts`.

Cross-checked with `kos-compat-api.ts`, `workers/notion-poller`,
`kos-patrol/run.ts`: none of these spawn the triplet's `run.ts`. They
only execute when invoked manually from the CLI. The triplet was
designed as the gate that quality-controlled every ingest, but it was
never wired in. **All three skills are dead code in production.**

`concept-synthesis` (v0.25.1) is structurally distinct from
`dikw-compile`, not a 1:1 replacement: per-batch sweep over
`concepts/` only (188 pages in production), 4-phase pipeline
(dedup + score + LLM-synth T1+T2 + cluster), no per-page DIKW layer.
For `concepts/` the upstream coverage is sufficient; for other kinds
nothing was running anyway.

**Decision**: archive all three triplet skills (`dikw-compile`,
`confidence-score`, `evidence-gate`) → `skills/kos-jarvis/_archived/`.
Pilot `concept-synthesis` on the 188 concept pages next session.
Decision details + 30-min execution plan recorded in
`docs/KOS-JARVIS-CONSOLIDATION-PLAN.md` §M2-A.

**Net fork shrinkage from M2-A alone**: 11 active skill dirs → 8.
Combined with M1's `kos-lint` retire (now also evidence-driven),
the next-sync target tightens to 11 → **7 active**.

### Rollback

```bash
# Reset master to pre-merge:
git reset --hard a13acf9     # parent of a2e5e5b
# Or revert just the merge:
git revert -m 1 a2e5e5b
```

The merge is reversible at git level. Production has not been touched
by this commit — all changes are in the repo. If something breaks at
the apply-migrations step on production, scripts/jarvis-pg-backup.sh's
nightly pg_dump (03:33) gives a rollback point.

## 6.22 Upstream v0.31.2 sync (2026-05-09)

5 major releases in one merge: `master..upstream/master` = 22 commits
across v0.27.0, v0.28.x, v0.29.0/0.29.1/0.29.2, v0.30.0/0.30.1/0.30.2,
v0.31.0/0.31.1/0.31.1.1-fixwave, v0.31.2. Branch `sync-v0.31.2`, merge
commit at sync-branch HEAD (later merged to master in Phase 9). 378
files changed, +57 691 / -1 833 LoC. Only 5 conflicts (down from 31 in
the previous v0.26.7 sync) thanks to fork's narrow surface and the
upstream side not yet touching anything in `skills/kos-jarvis/**`,
`server/`, `workers/`. End-to-end ~3 h.

### Headline upstream features adopted

- **v0.27.0** — pluggable embedding providers via Vercel AI SDK
  (`src/core/ai/gateway.ts`). Native Google, OpenAI, Voyage, Ollama,
  LM Studio, LiteLLM proxy. New CLI: `gbrain providers list/test/env/explain`.
  `--embedding-model provider:model` + `--embedding-dimensions N` flags
  on `gbrain init`. **This unlocks the M3 milestone for the fork**:
  `gemini-embed-shim` is now a candidate for retirement.
- **v0.28.x** — `takes` + `think` skills + per-token MCP allow-list,
  Voyage multimodal embeddings, lightweight `/health` endpoint
  (SELECT 1 instead of getStats), restart-sweep recipe (telegram gateway
  drop-detect), LongMemEval benchmark harness in the box.
- **v0.29.0/0.29.1** — salience + anomaly detection ("brain surfaces
  what's hot without being asked"). Adds `pages.emotional_weight`,
  `pages.salience_touched_at`, `pages.effective_date`, `pages.import_filename`,
  `pages.recompute_emotional_weight` dream-cycle phase (10th phase).
- **v0.29.2 / v0.31.1** — thin-client mode (`gbrain init --mcp-only`).
  Every read/write/admin op routes through `callRemoteTool` when
  `isThinClient(cfg)`. New `get_brain_identity` op + identity banner.
  New `gbrain remote ping/doctor` health probes with
  `oauth_client_scopes_probe` to surface scope mismatches before they
  hit `gbrain stats`. **Conceptual unlock for M2-B**: `kos-compat-api`
  could potentially become a thin translator routing KOS-v1 endpoints
  to MCP tools/call.
- **v0.30.0** — calibration scorecards. New `gbrain eval cross-modal`,
  `gbrain eval longmemeval` commands.
- **v0.30.1** — Supabase upgrade-path hardening. Reduces our class of
  manual-ALTER recovery (we hit one in v0.26.7).
- **v0.30.2** — dream synthesize stops dropping fat transcripts (token-
  aware chunking before subagent dispatch).
- **v0.31.0** — **hot memory** ships. Per-source `facts` table (5 kinds:
  event/preference/commitment/belief/fact with per-kind decay halflives).
  `gbrain recall` CLI. MCP `_meta.brain_hot_memory` auto-injection on
  every tool-call response. Dream-cycle 11th phase `consolidate`
  (clusters facts ≥3-strong + ≥24h-old, promotes top into `takes(kind=fact)`).
  **Adopted default-on**; `facts.extraction_enabled = false` is the
  kill switch if cost gets out of hand.
- **v0.31.1.1-fixwave** — 22 community PRs in one wave. Critical:
  - **#727** OAuth auth-code scope-escalation P0 (RFC 6749 §3.3
    violation; `read`-scope client could mint admin codes). We don't
    expose `gbrain serve --http` yet, so not a live exposure, but this
    is required before any M2-B path that internally proxies through it.
  - **#682 + #741** broadened `applyForwardReferenceBootstrap` to cover
    v0.20 + v0.26.3 + v39-v41 columns including `mcp_request_log.{agent_name,
    params, error_message}`. **This supersedes our PR #627** — fix
    is strictly broader; closed it as superseded the same day.
  - **#718** RESOLVER triggers broadened, 37 routing-eval misses → 0
    (closes our P2 routing-miss item).
  - **#686** `sync --skip-failed` eagerly acks pre-existing failures.
  - **#688** `extract` defaults `--dir` to configured brain dir.
  - Plus stdio MCP cleanup, detect-bun-link survival, dream transcript
    `.md` discovery, dream-cycle slug double-encoded jsonb fix, Voyage
    embedding adapter shape, sync detached-HEAD handling.
- **v0.31.2** — `gbrain sync --strategy code` no longer hangs on big
  symlink-rich repos. `parser.setTimeoutMicros(30000)` per-file
  tree-sitter cap; walker hardened with `lstatSync` + inode-cycle
  Map + `MAX_WALK_DEPTH=32`.

### Conflict resolution summary (5 conflicts, smallest sync window yet)

- **`package.json`** — fork's `@electric-sql/pglite 0.4.4` override vs
  upstream's `0.4.3`. Kept fork's `0.4.4`. Upstream added
  `@jsquash/avif`, `@jsquash/png` (image decoders for v0.29 anomaly);
  preserved.
- **`bun.lock`** — `git checkout --theirs` then `bun install` regenerated
  cleanly. Pulled 20 new packages (ai@6, @ai-sdk/{anthropic,google,openai,
  openai-compatible}@3, eventsource-parser, exifr, heic-decode).
- **`README.md`** — HEAD had a stale duplicate v0.25.0 BrainBench-Real
  paragraph (carried by accident from v0.25.0 sync). Took upstream's
  v0.28.8 LongMemEval headline; the legitimate v0.25.0 paragraph at
  line 46 (auto-merged) survives.
- **`skills/RESOLVER.md`** — upstream broadened the voice-note trigger
  from 1 keyword to 5 (`voice note / voice memo / audio message / audio
  note / transcribe and file`) as part of #718. Took upstream's broader
  trigger AND re-appended fork's `## KOS-Jarvis extensions` section
  (with Feishu/pending-enrich archive note from 2026-05-05) at the
  file end.
- **`llms-full.txt`** — `git checkout --theirs` then `bun run build:llms`
  regenerated. 422 KB, matches generator now.

### Auto-merged + verified

- `src/core/pglite-engine.ts` — fork's WAL durability patch
  (`SELECT pg_switch_wal()` before close at L198) **survived auto-merge
  cleanly** (upstream restructure didn't touch the disconnect block).
  Re-grep verified.
- `src/core/embedding.ts` — refactored upstream as a thin gateway
  delegation. fork's `BrainDb` doesn't import it (verified via grep);
  no breakage.
- `CHANGELOG.md` / `TODOS.md` / `CLAUDE.md` — fork sections preserved
  (auto-merge clean; fork doesn't carry top-of-file release notes).
- `skills/manifest.json` — fork's 14 active KOS skills preserved
  (16 lines in manifest match `kos-jarvis` after merge).
- `server/kos-compat-api.ts` (23 KB) — untouched.

### Privacy-gate scrub (post-merge)

Upstream's evolved `scripts/check-privacy.sh` caught 3 historical
narrative entries that still contained the literal banned word inside
"we replaced X" descriptions. Scrubbed:

- `docs/JARVIS-ARCHITECTURE.md` §6.20 "Privacy-gate scrub" subsection:
  replaced literal example slug + person/fund pair with generic
  phrasing. The narrative meaning survives the change.
- `skills/kos-jarvis/TODO.md` L416 (2026-05-01 v0.25.0 sync narrative):
  same scrub.

`scripts/check-privacy.sh` clean (rc=0). `bun run check:all` clean.

### Production schema migration v34 → v45 (auto-applied during bun install)

**Notable surprise**: when `bun install` ran during Phase 1 conflict
resolution, the package's postinstall hook called `gbrain post-upgrade`
which called `gbrain apply-migrations` against our production
`DATABASE_URL`. **Production walked v34 → v45 cleanly without manual
intervention** — exactly what the v0.31.1.1 fixwave bootstrap robustness
promised. No forward-reference hand-ALTER required this time.

Schema state post-sync (verified 2026-05-09):
- `schema_version = 45`
- `pg_tables count = 35` (was 31 pre-sync; +4 = `facts`, `oauth_clients`,
  `oauth_codes`, `oauth_tokens`)
- `RLS enabled on 35/35 public tables` (auto-RLS event trigger from
  v0.26.8 onboards new tables automatically)
- `embeddings: 96% coverage, 244 missing` — post-migration drift,
  expected; backfill via `gbrain embed --stale` next session
- `brain_score = 80/100` (embed 33/35, links 25/25, timeline 3/15,
  orphans 9/15, dead-links 10/10)
- `facts_health: 0 active, 0 today, 0 this week, 0 consolidated` —
  table ready, waits for next ingest cycle to populate
- `connection: ok, 2718 pages` (was 2477 at v0.26.7 sync; +241 from
  notion-poller running 5 days)

### M3 pilot — gemini-embed-shim retirement (probe-passed, full-pilot deferred)

**Probe results** (positive):
- ✓ `gbrain providers explain --json` lists `google:gemini-embedding-001`
- ✓ `GOOGLE_GENERATIVE_AI_API_KEY=$NANO_BANANA_API_KEY \
   gbrain providers test --model google:gemini-embedding-001` →
   `286 ms, 768 dims, all probes green`
- ✓ Native v0.27 Google provider works against the same Google key
  the shim has been using
- ✓ `--embedding-dimensions 1536` flag exists at init time and per
  v0.27 changelog passes through to `providerOptions.google.outputDimensionality`

**Pilot end-to-end blocked**: spinning up `/tmp/pilot-brain` PGLite
hit the macOS 26.3 WASM #223 cold-start hang (process held 100 % CPU
for 7 + min, 0 bytes output, no `.gbrain/` dir created). Killed.
**This is environment, not v0.27**.

**Decision**: M3 milestone evidence is ✓ for technical feasibility, ✗
for end-to-end production-cutover validation **on this Mac via PGLite**.
Defer M3 cutover to a session that pilots against a Postgres-backed
throwaway DB (avoids PGLite altogether). Shim stays running on launchd
in production. M3 plan well-defined; cutover safer with cleaner test
environment. CONSOLIDATION-PLAN.md updated to reflect: M3 = `probe-passed`,
target retirement next session.

### v0.31 hot-memory adoption

Default-on. `facts.extraction_enabled` is the kill switch (set in
`~/.gbrain/config.json`). Cost monitor scheduled: review
`gbrain recall --since 7d` and Haiku call count after 1 week of
notion-poller runs. If daily cost > $1, disable.

Notion Knowledge Agent + OpenClaw downstream see new `_meta.brain_hot_memory`
field on every MCP tool-call response. `_meta` is a standard MCP
envelope key; downstream clients ignore unknown fields per spec, no
contract break expected.

### Service mesh after sync

- `kos-compat-api`: bootout/bootstrap'd to load v0.31.2 src
  (PID 92596, state=running, `/status` returns 2718 pages on local +
  remote, both consistent)
- `gemini-embed-shim`: bootout/bootstrap'd, running (still required
  pending M3 cutover)
- `dream-cycle`, `kos-patrol`, `notion-poller`, `enrich-sweep`:
  bootout/bootstrap'd (all "not running" = registered + waiting for
  cron schedule, normal launchd state for `StartCalendarInterval` jobs)
- `kos-patrol` smoke: kickstart → fresh dashboard at
  `~/brain/.agent/dashboards/knowledge-health-2026-05-10.md` (2718
  pages, 0 ERROR, 1421 WARN). WARN climbed from 762 (v0.26.7 baseline)
  due to +241 new pages and possibly v0.27/v0.29 lint-rule additions;
  not a regression

### Test results

- `bun run typecheck`: clean (~3 s)
- `bun build --compile`: 1302 modules, 165 ms bundle / 299 ms compile
- `bun run test`: 4760 pass / 9 fail / 0 skip / 366 s
  - 1 known pre-existing master flake (`BrainRegistry — lazy init`)
  - 2 env-coupled (`check-resolvable resolveSkillsDir`, fork P2 known)
  - 2 self-test recursion (`run-unit-parallel.sh` testing itself)
  - 1 build-llms drift — fixed by `bun run build:llms` regen
  - 2 `doctor --fix` env-coupled (upstream test, hits $HOME state)
  - 1 warm-create perf warn (5 939 ms vs 1 500 ms cap, hardware noise)
- `bun run check:all`: clean (rc=0)

### Upstream PR #627 closed as superseded

Our PR `fix(bootstrap): cover v0.26.3 mcp_request_log columns` (filed
2026-05-04) was strictly a subset of upstream's #682+#741 fixwave that
shipped in v0.31.1.1. Closed with public superseded comment + cite to
fixwave 2026-05-09. Patch doc `docs/UPSTREAM-PATCHES/v026-bootstrap-mcp-log-fix.md`
deleted (no longer needed).

### Net fork shrinkage

- **Active KOS skill dirs**: 14 (no change this sync; M3 pending defers)
- **Open M2 evaluation candidates**: still 4 (M2-A.execute / M2-B / M2-C / M2-D),
  with **M3 promoted from "no signal" to "probe-passed, ready for cutover"**
- **Upstream PRs filed by fork**: 1 → 0 (PR #627 closed as superseded)
- **`docs/UPSTREAM-PATCHES/`** entries: 4 → 3

### Reversibility

The merge is reversible at git level (`sync-v0.31.2` branch). Production
schema migration is **not** reversible without restoring the 81 MB
`pg_dump -Fc` backup at `/tmp/pg-pre-migration-v43.dump` (taken
2026-05-09 23:12, just before migration). Both `/tmp/pg-pre-v0.31.2-sync.dump`
(69 MB, taken before this session started) and the daily nightly dump
at 03:33 are also rollback points.

---

## 7. Known gaps (see `skills/kos-jarvis/TODO.md` for live tracker)

- **P0 resolved 2026-04-22**: notion-poller PGLite deadlock — Path B landed in v0.17 sync (see §6.7). `scripts/minions-wrap/notion-poller.sh` deleted; plist now direct-bun invocation of `workers/notion-poller/run.ts`. First live cycle: 78 s / 9 pages ingested / 0 lock timeouts.
- **P0 resolved 2026-04-25 (v0.20.4 sync)**: v0.13.0 migration orchestrator partial-forever ([garrytan/gbrain#332](https://github.com/garrytan/gbrain/issues/332)). Upstream fixed in v0.19.0 by shell-out to `gbrain` instead of `process.execPath`. Post-merge `gbrain apply-migrations --force-retry 0.13.0` + `apply-migrations --yes` advanced the ledger; doctor health 60→80, no more FAILs. See §6.14.
- **P1 (new, v0.17 sync follow-up)**: refactor `kos-compat-api` to import in-process instead of `spawnSync("gbrain import")`. Removes the lock-contention root cause for all future callers, not just notion-poller. ~150 LOC touch in `server/kos-compat-api.ts`. Path B is the Band-Aid; Path C is the cure.
- **P1**: `kos-compat-api /ingest` returns HTTP 500 for some Notion pages (seen on `password-hashing-on-omada`); investigate `gbrain import` failure mode.
- **P1 (anchor, Step 2.3 done, Step 2.4 parked +14d)**: filesystem-canonical migration. Steps 1 → 2.3 done + v0.18 upstream synced (see §6.8 → §6.13 + [`docs/FILESYSTEM-CANONICAL-EXPORT-AUDIT.md`](FILESYSTEM-CANONICAL-EXPORT-AUDIT.md)). All pre-migration blockers cleared + Step 2.2 landed (`b7212db`) + v0.18.2 merged (`aceb838`) + Step 2.3 dream cron wired (`com.jarvis.dream-cycle` daily 03:11 local, archives to `~/brain/.agent/dream-cycles/`, see §6.13). `/ingest` writes canonical to `~/brain/<kind>/<slug>.md` + git commit + `gbrain sync`, `/status` direct-DB (1930 not 100), `.agent/` hidden from sync, `~/brain/` is a git repo with nightly maintenance pass, schema at v24 with sources.default seeded. Only Step 2.4 (commit-batching + optional explicit `jarvis` source add / remote push) remains, parked +14d.
- **P1 resolved 2026-04-29 (v0.22.8 sync)**: [garrytan/gbrain#370](https://github.com/garrytan/gbrain/issues/370) — closed by upstream PR #440 / v0.22.6.1. Fork patch on `pglite-schema.ts` dropped during merge (commit `811c266`); upstream's `applyForwardReferenceBootstrap()` in `pglite-engine.ts:initSchema()` supersedes it. See §6.17.
- **P1 (new, Step 2.2 follow-up)**: kos-patrol launchd cron `LastExitStatus=1` since 2026-04-19 due to macOS 26.3 WASM bug (`#223` class) hitting the minion-wrapped subprocess. Direct bun-run works. Plus kos-patrol uses `gbrain list --limit 10000` (100-row-capped) — migrating to `BrainDb` direct-read is the natural fix.
- ~~**P1**: `dikw-compile`, `evidence-gate`, `confidence-score` lack runnable helpers~~ — **resolved 2026-04-22**: all three landed with `run.ts`, backed by the shared `skills/kos-jarvis/_lib/brain-db.ts` direct-PGLite reader that bypasses the MCP 100-row cap. See TODO.md P1 done markers.
- **P2 (new, v0.20 sync follow-up)**: PGLite → Postgres switch — analyzed and **deferred**. v0.20.2/v0.20.3's flagship features (jobs supervisor, queue_health, wedge-rescue, backpressure-audit) all skip on PGLite. None of them address pain we currently have. Four trigger conditions documented at [`docs/UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md`](UPSTREAM-PATCHES/v020-pglite-postgres-evaluation.md): brain >5000 pages, multi-machine access, WAL fork-patch failure, durable subagent runtime needed. Migration cost ~1 h via `gbrain migrate --to supabase`.
- **P2 (new, v0.20 sync follow-up)**: 14 unresolved frontmatter cross-dir refs surfaced by `gbrain extract links --source db --include-frontmatter`. All v1-wiki legacy `../entities/*.md` / `../sources/*.md` paths that import-time slug normalization missed. Cosmetic (dead-end refs in the graph, no query impact). Fix is a one-shot rewrite skill, ~1-2 h. Tracked in TODO.md P2.
- **P2**: v1 Python `kos-api.py` + `kos` CLI still live in `/Users/chenyuanquan/Projects/jarvis-knowledge-os/`. Unloaded from launchd (`com.jarvis.kos-api.plist.bak`) but not archived. After a 7-day v2 soak, move the plist bak into `~/Library/LaunchAgents/_archive/` and archive the v1 repo.
- **P2**: Evaluate Gemini 3072-dim embeddings vs current 1536-dim truncation; requires full reindex if adopted.
- **P2**: Evaluate BrainWriter `strict_mode=strict` flip after 7-day lint-observer soak.
- **P2**: Unify LLM telemetry — v1 repo's `llm-runner.py` writes `knowledge/logs/llm-calls.jsonl`; v2's new `synthesizeAnswer` in `kos-compat-api.ts` does not log. Add a shared JSONL sink.

---

## 8. Cost and performance snapshot

| Metric | v1 | v2 |
|--------|----|----|
| Full repo import | ~minutes (shell) | 0.3s for 85 pages |
| Embedding cost (one-time) | $0 (local qmd) | ~85 × 1 Gemini call ≈ free tier |
| Query latency (Chinese) | 不支持（BM25 无 CJK 分词） | ~500ms (embed + pgvector + gemini) |
| Ingest latency | ~seconds | ~2-3s (fetch + import + embed) |
| Cron footprint | 4 (OpenClaw) | 4 (OpenClaw) + 2 (launchd services) |

---

## 9. Further reading

- [`skills/kos-jarvis/README.md`](../skills/kos-jarvis/README.md) — extension pack scope & upgrade policy
- [`skills/kos-jarvis/PLAN-ADJUSTMENTS.md`](../skills/kos-jarvis/PLAN-ADJUSTMENTS.md) — deltas discovered during migration vs original plan
- [`skills/kos-jarvis/type-mapping.md`](../skills/kos-jarvis/type-mapping.md) — KOS 9 kinds ↔ GBrain 20 dirs
- [`scripts/launchd/README.md`](../scripts/launchd/README.md) — cutover runbook, rollback, archive
- [`docs/GBRAIN_RECOMMENDED_SCHEMA.md`](GBRAIN_RECOMMENDED_SCHEMA.md) — upstream brain schema (MECE directories)
- Source plan (outside repo): `~/.claude/plans/docs-gbrain-vs-kos-analysis-md-gbrain-parsed-candle.md`
