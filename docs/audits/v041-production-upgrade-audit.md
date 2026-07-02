# Production Upgrade Audit: v0.29 → v0.41.2

**Date:** 2026-05-25
**Brain:** ~16K pages, Supabase Postgres, ZeroEntropy embeddings (zembed-1, 1280d)
**Schema pack:** Custom pack extending gbrain-base (39 page types, 9 link verbs, 6 takes kinds)
**MCP server:** HTTP on port 3131

---

**Snapshot:** taken at v0.41.2.0 (commit ca68633f).
**Revalidated against:** v0.41.7.0 HEAD on 2026-05-25.

This is a new convention for `docs/audits/` — the directory has no prior
precedent. Future audits in this directory should follow the same snapshot +
revalidation pattern so readers can tell at a glance what's still
load-bearing.

Findings are observations from a single production upgrade; severity tags
reflect impact at time of audit. Several gaps below are independently
re-derived from existing TODOS.md entries — inline cross-refs added during
revalidation. Cross-refs use stable TODO headings rather than line numbers
because line numbers rot on the next TODOS.md edit.

The original snapshot reported a third critical issue ("`gbrain doctor`
crashes with `s.toLowerCase`"). On revalidation, no `.toLowerCase()` site
in `src/core/calibration/*.ts` or `src/commands/doctor.ts` matches the
proposed root cause (each is guarded by a `typeof` check or `Array.isArray`
filter). The original report itself used "likely" and offered no stack
trace. That finding was removed from this snapshot rather than carried
forward as an unverified critical issue. If the symptom resurfaces with a
real stack trace, please file a fresh issue against the version it hits
rather than amending this snapshot.

Use-case-specific page types and calibration domain names in the audit
examples below have been replaced with placeholder `domain-a-*` /
`domain-b-*` strings; the original audit was taken against a brain with a
specific real-world taxonomy that's not relevant to the findings.

---

## Executive Summary

After upgrading a production brain from v0.29-era to v0.41.2, a comprehensive
audit found **2 critical issues** and **8 features that require manual
activation** despite being available in the codebase. The brain itself is
healthy (100% embedded, schema pack active), but the automation and
calibration layers are largely dormant.

---

## Critical Issues

### 1. Dream cycle fails with "No database connection" on Supabase pooler

**Severity:** P0 — blocks all DB-dependent maintenance phases

After upgrading to v0.41.0 and running `gbrain dream`, most phases fail:

```
Dream cycle (partial) in 10.8s:
  ! lint        0 fix(es) applied, 1246 remaining
  ✓ backlinks   10 missing back-link(s) found
  ✗ sync        [InternalError/UNKNOWN] No database connection: connect() has not been called.
  ✗ synthesize  [InternalError/SYNTH_PHASE_FAIL] No database connection: connect() has not been called.
  ✓ extract     0 link(s), 0 timeline entries
  ✗ extract_facts  No database connection: connect() has not been called.
  ✗ resolve_symbol_edges  No database connection: connect() has not been called.
  ✗ patterns    No database connection: connect() has not been called.
  ✗ recompute_emotional_weight  No database connection: connect() has not been called.
  ✗ consolidate  No database connection: connect() has not been called.
  ✗ propose_takes  No database connection: connect() has not been called.
  ✗ grade_takes  No database connection: connect() has not been called.
  ✗ calibration_profile  No database connection: connect() has not been called.
  ✗ embed       No database connection: connect() has not been called.
  ✗ orphans     No database connection: connect() has not been called.
  - schema-suggest  skipped
  ✗ purge       No database connection: connect() has not been called.
```

The extract phase partially completed — scanned 15,752 files but lost ~381 timeline
rows in batches at 95-99%:

```
[extract.timeline_fs] 15010/15752 (95%)
  batch error (100 timeline rows lost): No database connection: connect() has not been called.
[extract.timeline_fs] 15168/15752 (96%)
  batch error (100 timeline rows lost): No database connection: connect() has not been called.
```

**Analysis:** The connection drops mid-cycle. The filesystem extract phase takes time
scanning 16K files; the Supabase PgBouncer transaction pooler (port 6543) likely kills
idle backend connections before the DB-heavy phases resume. The `GBRAIN_DISABLE_DIRECT_POOL`
env var is set, forcing all traffic through the pooler.

**Observations:**
- `connectEngine()` in cli.ts successfully connects at startup (lint/backlinks work)
- The connection drops sometime during the long filesystem scan
- No reconnect/retry logic in the cycle runner for mid-cycle connection loss
- The `connectWithRetry` in db.ts handles initial connection but not mid-run drops

**Suggested fixes:**
- Add connection health check between cycle phases (ping/reconnect if stale)
- Add reconnect-on-error in the batch insert path for extract phases
- Document Supabase pooler idle timeout behavior and `GBRAIN_DISABLE_DIRECT_POOL` interaction
- Consider: should the dream cycle use a direct connection (port 5432) instead of the pooler for long-running maintenance?

**Status on revalidation (v0.41.7.0):** still active. `PostgresEngine.reconnect()`
exists at `src/core/postgres-engine.ts:4137` but is supervisor-driven only;
`src/core/cycle.ts` never calls it between phases, and `src/commands/extract.ts:535-540`
catches batch errors and reports "rows lost" with no retry. Filed as a new
TODOS.md entry (stable heading: `v0.41.x+: Dream cycle reconnect-between-phases`)
which enumerates 4 design options + per-phase idempotency audit before
implementation, because picking the right reconnect strategy (phase-boundary
ping vs reconnect-on-specific-errors vs direct-connection vs bounded batch
retry) is real architecture work that this audit doesn't decide.

### 2. `queue_health` doctor check misses "waiting jobs, no live worker"

Job id 2 (`sync`) has been in `waiting` status since 2026-05-20 — 5 days with no worker
to process it:

```
Job Stats (last 24h):
  No jobs in the last 24 hours.
  Queue health: 1 waiting, 0 active, 0 stalled
```

**The original audit framed this as "Minion worker has no supervision story."**
That framing is wrong: `gbrain jobs supervisor` is a first-class CLI
crash-restart wrapper (`src/commands/jobs.ts:141`), documented at
`docs/guides/minions-deployment.md` with PID file + exponential backoff +
lifecycle events + systemd snippet (`docs/guides/minions-deployment-snippets/systemd.service`)
+ fly.toml partial + Procfile. `gbrain autopilot` spawns **`gbrain jobs work`**
as a child via `ChildWorkerSupervisor` at `src/commands/autopilot.ts:192` — not
`gbrain jobs supervisor`; the two are distinct lifecycle paths.

**The actual gap is twofold:**

- **Discoverability.** An operator hitting a stuck queue won't find the answer
  unless they grep `docs/guides/`. The supervision story exists; the discovery
  path doesn't.
- **Detection.** gbrain has two doctor checks here that split coverage
  incompletely. `queue_health` (at `src/commands/doctor.ts:4395-4505`) checks
  stalled-active jobs / waiting-depth-per-name / RSS-watchdog-kills /
  prompt_too_long terminal failures, but does NOT detect "waiting jobs with no
  live worker." A separate `supervisor` check (at `src/commands/doctor.ts:2448`)
  fires only when a supervisor was previously observed — for
  never-installed/unknown workers, neither check fires. The stuck job above
  would be flagged by neither.

**Already filed:** TODOS.md `B7 minion_workers heartbeat table for queue_health
doctor` (stable heading). The heartbeat table would give doctor a ground-truth
signal for "is a worker actually running" instead of inferring it from
side-channel observations.

---

## Feature Activation Gap Analysis

### Features that auto-activate (no action needed) ✅

| Feature | Version | How it activates |
|---|---|---|
| Graph signals in search (adjacency, hub, diversify) | v0.40.4 | Default ON in balanced/tokenmax mode |
| Trajectory routing in `gbrain think` | v0.40.2 | Default `think.trajectory_enabled=true` |
| Content sanity gate (junk/oversize blocks) | v0.40.10 | Default ON, sensible thresholds |
| Contextual retrieval (title-prefix embeddings) | v0.40.3 | Auto after re-embed |
| Reranking (zerank-2) | v0.35.0 | Active if ZeroEntropy key set |
| Schema pack resolution (7-tier chain) | v0.38.0 | Auto if pack exists |
| Phantom-redirect in extract | v0.35.8 | Auto during dream cycle |
| Brainstorm domain-bank (prefix-stratified far pages) | v0.37.0 | Auto in brainstorm/lsd |
| Cost caps on brainstorm (`--max-cost`) | v0.39.0 | Available, opt-in per call |

### Features that require manual activation ⚠️

#### 1. Calibration domains (v0.41.2)

The `take_domain_assignments` migration creates the table but it stays empty without
`calibration_domains` in the schema pack manifest.

**What's needed:** Add to pack.yaml (example uses placeholder domain names):
```yaml
calibration_domains:
  - name: domain_a_realtime
    aggregator: scalar_brier
    page_types: [domain-a-event, domain-a-article, domain-b-policy]
  - name: domain_a_aggregate
    aggregator: weighted_brier
    page_types: [domain-b-policy, domain-b-election]
  - name: domain_b_assessment
    aggregator: count_based
    page_types: [domain-b-entity]
```

**Gap:** No `gbrain schema add-domain` CLI command. Operators must hand-edit YAML
and know the valid `aggregator` enum values. The aggregator names aren't documented
outside the source code (`src/core/calibration/domain-aggregators.ts`).

#### 2. Dream cycle phases for atom extraction (v0.41.2)

The `gbrain-creator` lens pack includes `phases: [extract_atoms, synthesize_concepts]`
but custom packs that extend `gbrain-base` don't inherit these. If an operator has
a custom pack (common for any non-trivial brain), they miss auto-atom-extraction
entirely unless they know to add the `phases:` field.

**Gap:** `gbrain schema review-candidates` doesn't suggest missing phases. A brain
with 900+ atoms created by external tooling gets no hint that gbrain can now maintain
them natively.

#### 3. Nightly quality probe (v0.41.1)

```bash
gbrain config set autopilot.nightly_quality_probe.enabled true
gbrain config set autopilot.nightly_quality_probe.max_usd 5
```

**Gap:** This exists but `gbrain doctor` doesn't flag it as a recommendation.
`gbrain upgrade --status` doesn't mention new config knobs available after upgrade.
An operator upgrading from v0.29 to v0.41 has no way to discover this exists without
reading source code.

#### 4. Eval gate / search baseline (v0.41.1)

`gbrain bench publish` + `gbrain eval gate` exist but there's no getting-started
workflow. An operator needs to:
1. Know the commands exist
2. Generate a baseline
3. Wire it into their CI or cron

**Gap:** No `gbrain init --eval` or `gbrain doctor` suggestion for brains with 0
eval baselines.

#### 5. Minion worker daemon

`gbrain jobs work` is the only way to process queued jobs. Required for:
- Subagent fleet (v0.41.0)
- Embed backfill jobs
- Self-fix remediation
- Any future async pipeline

**Gap (revised on revalidation):** the supervision story exists but is
under-discoverable. `gbrain jobs supervisor` (`src/commands/jobs.ts:141`) wraps
`gbrain jobs work` with PID file + exponential backoff + lifecycle events;
`docs/guides/minions-deployment.md` covers systemd / fly.toml / Procfile
deployment shapes; `gbrain autopilot` already spawns `gbrain jobs work` as a
child via `ChildWorkerSupervisor` (`src/commands/autopilot.ts:192`). What's
missing is detection: doctor's `queue_health` doesn't flag "waiting jobs with
no live worker" (see Critical Issue #2). `Already filed:` TODOS.md `B7
minion_workers heartbeat table for queue_health doctor`.

#### 6. Code intelligence (v0.33-v0.34, v0.40.9)

`gbrain code-def`, `code-traversal`, SQL grammar indexing. Powerful but completely
undiscoverable. An operator with code in their brain has no hint these commands exist.

### Features that are dormant (single-source brain) — expected

| Feature | Version | Activates when |
|---|---|---|
| Federation sync v2 | v0.40.5 | Second source mounted |
| Parallel `sync --all` | v0.40.6 | Multiple sources |
| Cross-source hub signals | v0.40.4 | Multiple sources |
| Push-trigger webhooks | v0.40.5 | Webhook configured |
| Per-source cycle locks | v0.39.2 | Multiple sources |

---

## Upgrade Experience Gaps

### No upgrade guide

An operator upgrading from v0.29 to v0.41 gets:
- Automatic schema migrations (good)
- No changelog summary of what's new
- No list of new config knobs to consider
- No `gbrain upgrade --what-changed` command
- No doctor checks for "you're on v0.41 but haven't configured X"

### Schema pack drift

Custom packs that extend `gbrain-base` don't automatically inherit new features
that require pack-level declarations (`calibration_domains`, `phases`). There's no
mechanism to:
- Notify operators that gbrain-base has new fields their custom pack should consider
- Auto-suggest additions via `gbrain schema review-candidates`
- Diff a custom pack against the latest gbrain-base to show what's available

### Doctor should be the upgrade advisor

`gbrain doctor` is the natural place for post-upgrade recommendations. Currently it
checks health but doesn't advise on feature activation. Suggested additions:

- `[SUGGEST] calibration_domains not declared — run gbrain schema add-domain to enable per-topic accuracy tracking`
- `[SUGGEST] nightly quality probe disabled — gbrain config set autopilot.nightly_quality_probe.enabled true (~$10/mo)`
- `[SUGGEST] no eval baseline published — run gbrain bench publish to protect search quality`
- `[SUGGEST] custom pack missing phases field — consider adding extract_atoms, synthesize_concepts`

Note: "no worker running but N jobs waiting" deliberately omitted from this
list — it's an operational warn/fail signal, not optional advice, and belongs
in `queue_health` rather than a SUGGEST tier. Filed as TODOS.md `B7
minion_workers heartbeat table for queue_health doctor` rather than the
SUGGEST framework.

**Already filed on revalidation:** the SUGGEST framework decision is split
into two TODOs (stable headings: `v0.41.x+: Doctor [SUGGEST] tier — framework
design` and `v0.41.x+: Doctor [SUGGEST] tier — initial suggestion list`). The
framework TODO covers taxonomy + JSON shape + suppression model + scoring +
SUGGEST/WARN boundary rule before any specific suggestions land.

### Connection resilience for long-running operations

The dream cycle, autopilot, and worker all assume a stable DB connection. On managed
Postgres (Supabase, Neon, etc.) with transaction poolers, connections drop after idle
timeouts. Long filesystem-scanning phases (extract on a 16K-page brain) create gaps
where no queries run, triggering pooler eviction.

`Related TODO:` `extract.ts N+1 reads over Supabase pooler` (same Supabase
pooler topology theme; different bug class — read-side N+1 vs write-side
reconnect).

---

## Recommended Changes (Prioritized)

### P0 — Fix broken things
1. **Fix dream cycle connection resilience** — reconnect between phases or on
   batch error. **Filed on revalidation** as TODOS.md `v0.41.x+: Dream cycle
   reconnect-between-phases — design needed before implementation` with 4
   design options + per-phase idempotency audit requirement.

### P1 — Improve upgrade experience
2. **Add `gbrain doctor` suggestions for unused features** — make doctor the
   upgrade advisor. **Filed on revalidation** as two TODOs: `v0.41.x+: Doctor
   [SUGGEST] tier — framework design` (taxonomy + suppression model + boundary
   rule with WARN) and `v0.41.x+: Doctor [SUGGEST] tier — initial suggestion
   list` (blocked by the framework TODO).
3. **Document calibration_domains aggregator enum** — operators can't
   configure what they can't discover.
4. **Surface worker absence via `queue_health` doctor check** — pair the
   already-existing `gbrain jobs supervisor` discoverability with a real
   doctor signal (see Critical Issue #2 + TODOS.md `B7 minion_workers
   heartbeat table for queue_health doctor`).

### P2 — Feature activation
5. **`gbrain schema review-candidates` should suggest phases + calibration_domains** for custom packs
6. **Add `gbrain upgrade --changelog` or `gbrain doctor --post-upgrade`** — show what's new after version bump
7. **Document the Supabase pooler interaction** — idle timeouts, `GBRAIN_DISABLE_DIRECT_POOL`, prepare mode

---

## Environment Details

```
gbrain: 0.41.2.0
engine: postgres (Supabase, port 6543 pooler)
schema pack: custom, extends gbrain-base
pages: 15,796
chunks: 37,685 (100% embedded)
embedding: zeroentropyai:zembed-1 (1280d)
image embedding: voyage:voyage-multimodal-3 (1024d)
reranker: active
graph signals: enabled (balanced/tokenmax)
schema version: 94 (current)
GBRAIN_DISABLE_DIRECT_POOL: set
```
