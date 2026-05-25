# Production Upgrade Audit: v0.29 → v0.41.2

**Date:** 2026-05-25
**Brain:** ~16K pages, Supabase Postgres, ZeroEntropy embeddings (zembed-1, 1280d)
**Schema pack:** Custom pack extending gbrain-base (39 page types, 9 link verbs, 6 takes kinds)
**MCP server:** HTTP on port 3131

---

## Executive Summary

After upgrading a production brain from v0.29-era to v0.41.2, a comprehensive audit
found **3 critical issues** and **8 features that require manual activation** despite
being available in the codebase. The brain itself is healthy (100% embedded, schema
pack active), but the automation and calibration layers are largely dormant.

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

### 2. `gbrain doctor` crashes on v0.41.2

```
$ gbrain doctor
undefined is not an object (evaluating 's.toLowerCase')
```

Doctor worked fine on v0.41.0 before the upgrade to v0.41.2. Likely a regression
in the `take_domain_assignments` migration or the new domain-aggregator code path
when no `calibration_domains` are declared in the active schema pack.

### 3. Minion worker has no startup/supervision story

Job id 2 (`sync`) has been in `waiting` status since 2026-05-20 — 5 days with no worker
to process it:

```
Job Stats (last 24h):
  No jobs in the last 24 hours.
  Queue health: 1 waiting, 0 active, 0 stalled
```

There's no:
- `gbrain autopilot` documentation for ensuring the worker runs persistently
- Systemd unit / launchd plist / Docker entrypoint example
- Crash-restart wrapper for `gbrain jobs work`
- The healthcheck cron mentioned in docs doesn't exist as a default — operators have to create it manually

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

**What's needed:** Add to pack.yaml:
```yaml
calibration_domains:
  - name: local_politics
    aggregator: scalar_brier
    page_types: [civic-incident, civic-article, civic-policy]
  - name: state_politics
    aggregator: weighted_brier
    page_types: [civic-policy, civic-election]
  - name: entity_assessment
    aggregator: count_based
    page_types: [civic-adversary]
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

**Gap:** No `gbrain autopilot --install` for the worker (only for the dream cycle).
No healthcheck that detects "worker should be running but isn't." Doctor's
`queue_health` check only flags stalled jobs, not a missing worker with waiting jobs.

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
- `[SUGGEST] no worker running but 1 job waiting — start gbrain jobs work`
- `[SUGGEST] custom pack missing phases field — consider adding extract_atoms, synthesize_concepts`

### Connection resilience for long-running operations

The dream cycle, autopilot, and worker all assume a stable DB connection. On managed
Postgres (Supabase, Neon, etc.) with transaction poolers, connections drop after idle
timeouts. Long filesystem-scanning phases (extract on a 16K-page brain) create gaps
where no queries run, triggering pooler eviction.

---

## Recommended Changes (Prioritized)

### P0 — Fix broken things
1. **Fix dream cycle connection resilience** — reconnect between phases or on batch error
2. **Fix doctor crash on v0.41.2** — likely null-safety issue in domain aggregator path when no domains declared

### P1 — Improve upgrade experience
3. **Add `gbrain doctor` suggestions for unused features** — make doctor the upgrade advisor
4. **Document calibration_domains aggregator enum** — operators can't configure what they can't discover
5. **Add worker supervision story** — `gbrain autopilot --install` should optionally also install the worker

### P2 — Feature activation
6. **`gbrain schema review-candidates` should suggest phases + calibration_domains** for custom packs
7. **Add `gbrain upgrade --changelog` or `gbrain doctor --post-upgrade`** — show what's new after version bump
8. **Document the Supabase pooler interaction** — idle timeouts, `GBRAIN_DISABLE_DIRECT_POOL`, prepare mode

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
