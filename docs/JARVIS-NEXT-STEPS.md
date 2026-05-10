# Jarvis KOS v2 — Post-Cutover Roadmap

> 2026-04-17 | Status: v2 migration complete, Notion Agent + Feishu live on gbrain
> Primary author: Lucien × Jarvis (drafted in the migration session, to be executed in fresh sessions)

This document is the execution plan for the weeks **after** the four-week
migration (documented in [`JARVIS-ARCHITECTURE.md`](JARVIS-ARCHITECTURE.md)).
It exists so a fresh Claude Code session can pick up without re-reading the
migration conversation. Cross-reference rather than duplicate — every section
below points at existing docs for the full story.

---

## 0. What you need to know before picking up this plan

**Skim in this exact order** (under 15 minutes total):

1. [`README.md`](../README.md) — fork boundary and what makes this repo different from upstream GBrain
2. [`CLAUDE.md`](../CLAUDE.md) — hard rules: don't touch `src/*`, keep kos-jarvis in its sandbox, Gemini via shim
3. [`docs/JARVIS-ARCHITECTURE.md`](JARVIS-ARCHITECTURE.md) — topology, deployment, Jarvis triangle
4. [`skills/kos-jarvis/README.md`](../skills/kos-jarvis/README.md) — extension pack inventory
5. [`skills/kos-jarvis/TODO.md`](../skills/kos-jarvis/TODO.md) — outstanding work with P0/P1/P2 labels
6. [`skills/kos-jarvis/PLAN-ADJUSTMENTS.md`](../skills/kos-jarvis/PLAN-ADJUSTMENTS.md) — deltas discovered during migration (what the upstream docs get wrong vs reality)

**Current state snapshot** (verify with commands before assuming):
- 2718 pages, 5548 chunks, embedding via native v0.27 Vercel AI SDK gateway (`google:gemini-embedding-001`, 1536 dim) — gemini-embed-shim retired 2026-05-10 (M3)
- `launchctl list | grep com.jarvis` shows `kos-compat-api` (KeepAlive) + 4 cron services (dream-cycle, kos-patrol, enrich-sweep, notion-poller) — no shim
- `kos.chenge.ink` routes to port 7225 (v2 TypeScript)
- OpenClaw 4 crons + Feishu skill migrated to HTTP on 2026-04-17 (Feishu signal-detector retired 2026-05-05)
- v1 frozen at tag `v1-frozen` in `~/Projects/jarvis-knowledge-os/`, repo untouched

---

## 1. Goal hierarchy

Primary goals, in order of importance to Lucien:

| Goal | Why | Current state |
|------|-----|---------------|
| **G1 — Automatic person/company relationship extraction & maintenance** | The stated top reason for migrating to GBrain. Tier 1/2/3 enrichment was the biggest v1 gap. | Underutilized: only 3 `entities/` pages (jarvis, lucien-chen, hermes-agent) despite 85-page corpus that mentions 50+ people/orgs |
| **G2 — Compounding knowledge without manual ingest** | Signal-detector captures entity mentions from every message; brain grows ambiently. | Not wired into Feishu yet |
| **G3 — Calendar/email data onboarding** | Unlock meeting/correspondence history as enrichment fuel. | No pipeline yet |
| **G4 — Ship quality preserved through migration** | DIKW compile, evidence gates, lint, patrol. | Skills exist as SKILL.md; most lack `run.ts`. P0 TODO is `kos-patrol/run.ts` |

Secondary / cross-cutting:
- G5: close P1/P2 items in TODO.md
- G6: maintain sustainable upstream merge cadence
- G7: archive v1 cleanly after 7-day soak

---

## 2. Phased roadmap

Five phases, each with a gate. Don't advance until the gate passes.

```
Phase 1 (48h)   Phase 2 (2d)      Phase 3 (3-5d)        Phase 4 (1w)    Phase 5 (1-2w)
┌──────────┐   ┌──────────┐      ┌──────────────┐      ┌──────────┐   ┌──────────┐
│ Observe  │ → │ Signal   │ →    │ Enrich sweep │ →    │ Calendar │ → │ Email    │
│          │   │ detector │      │  (G1 payoff) │      │ import   │   │ (scoped) │
│          │   │ on Feishu│      │              │      │          │   │          │
└──────────┘   └──────────┘      └──────────────┘      └──────────┘   └──────────┘
     │              │                    │                    │              │
     ▼              ▼                    ▼                    ▼              ▼
   health        ambient             20-40 new            meeting pages   correspondence
   baseline      capture             entity pages         + attendees     graph + tone
                 enabled             auto-built           enriched        signals

Cross-cutting: close P0 kos-patrol/run.ts during Phase 3; close P1 helpers during Phase 4
```

---

## 3. Phase 1 — Observation (next 48 hours)

**Goal**: catch regressions from the cutover before stacking new complexity.

**Acceptance gate**: 48 hours of stable service, no rollback to v1.

### Daily health ritual (twice/day, morning + evening)

```bash
TOKEN=$(plutil -extract EnvironmentVariables.KOS_API_TOKEN raw \
  ~/Library/LaunchAgents/com.jarvis.kos-api.plist 2>/dev/null || \
  echo "<paste from v1 plist>")

# 1. Services up?
launchctl list | grep com.jarvis
# expect 2 services with PID (not "-")

# 2. Endpoint healthy?
curl -s -H "Authorization: Bearer $TOKEN" https://kos.chenge.ink/status | jq .

# 3. Page count monotonic? Log it somewhere.
curl -s -H "Authorization: Bearer $TOKEN" https://kos.chenge.ink/status \
  | jq -r '"\(.total_pages) pages @ \(now | strftime("%Y-%m-%d %H:%M"))"' \
  >> ~/brain/agent/uptime-log.txt

# 4. Recent ingests compile cleanly?
bun run ~/Projects/jarvis-knowledge-os-v2/src/cli.ts doctor
# expect: status=ok or status=warnings (no critical errors)
# (kos-lint retired 2026-05-10 M1; frontmatter check now via upstream
# `frontmatter-guard` skill + `gbrain doctor`)

# 5. kos-compat-api logs clean?
tail -30 ~/Projects/jarvis-knowledge-os-v2/server/kos-compat-api.stderr.log
# should be empty or just startup banner. Native gateway means no shim
# log to check post-M3 cutover.
```

### What to do if something breaks

See [`scripts/launchd/README.md`](../scripts/launchd/README.md) §Rollback.
30 seconds to revert to v1.

### What NOT to do in Phase 1

- No new skills
- No `enrich-sweep` or other batch operations
- No touching OpenClaw Feishu skill beyond what was done on 2026-04-17
- No committing to `master` (force fresh-start if stable; retreat if not)

### Exit criteria to Phase 2

- [ ] 48 hours elapsed
- [ ] `total_pages` monotonically non-decreasing (drops = disaster)
- [ ] At least one real Feishu ingest landed and was auto-embedded
- [ ] Lucien has used Notion Knowledge Agent at least twice without regression complaints
- [ ] No rollback triggered

---

## 4. Phase 2 — Signal-detector on Feishu (2 days)

**Goal**: ambient knowledge capture. Every Feishu message silently contributes
to the brain without manual `ingest` commands.

**Acceptance gate**: after a week, see ≥ 5 auto-created `people/` or
`companies/` stubs from Feishu-only signals.

### Reference

- Upstream skill: [`skills/signal-detector/SKILL.md`](../skills/signal-detector/SKILL.md)
  — already installed, already in RESOLVER.md "Always-on". The skill assumes
  the agent spawns a parallel cheap-model call per message to detect (a) original
  thinking → brain page, (b) entity mentions → enrichment trigger.
- OpenClaw integration point: `~/.openclaw/workspace/skills/knowledge-os/SKILL.md`
  (already updated to HTTP/bun by the 2026-04-17 Feishu-bridge migration)

### Implementation outline

OpenClaw side (external to this repo):
1. Edit the Feishu agent config so every inbound message, **before** the agent
   decides how to reply, forks a parallel branch that reads
   `skills/signal-detector/SKILL.md` and runs its extraction logic.
2. The forked branch writes findings directly via the compat-api:
   - original thinking → `POST /ingest` with a synthesized source page
   - entity mentions → maintain a queue file (e.g.
     `~/brain/agent/pending-enrich.txt`) to be consumed by the Phase 3 sweep
3. Key design: keep it cheap. Use Haiku or similar for extraction so the cost
   per message stays in noise. Signal-detector explicitly permits noisy output
   since brain-ops dedupes and lint prunes.

v2 side (this repo) — likely no changes needed, but if the queue file idea is
adopted, add a short SKILL.md at `skills/kos-jarvis/pending-enrich/` documenting
the queue format so Phase 3's `enrich-sweep` script can consume it uniformly.

### Exit criteria to Phase 3

- [ ] Feishu message → signal-detector → write to brain observed in shim log
- [ ] At least one pending-enrich entry created organically (without Lucien
  saying "摄入 XXX")
- [ ] No regression in Feishu response latency (< 2s end-to-end added overhead)

---

## 5. Phase 3 — Enrich sweep on existing 85 pages (3-5 days) **⭐ primary G1 payoff**

**Goal**: Lucien's top priority. Scan the 85 pages that are already in the
brain, surface every person/company/project entity mentioned, create stub pages
for the ones that don't have one yet, and classify by tier for enrichment depth.

**Acceptance gate**: 20-40 new `people/` + `companies/` stubs, confidence
distribution matches expectation, no duplicates merged-away.

### Why this phase is the right place to start the G1 sprint

- Zero new-data risk: operates only on content that's already lint-clean and
  committed.
- Immediate ROI: current brain has ≈3 entity pages despite mentioning 50+ real
  people/orgs in `sources/`, `decisions/`, `syntheses/`. Obvious gold vein.
- Validates the Tier 1/2/3 pipeline on Lucien's own data before we trust it at
  scale with calendar/email imports.
- Independent of external enrichment APIs: we can run Tier 3 (brain-only
  cross-reference) first without any Tavily/Exa/Crustdata keys, and gate Tier
  1/2 until those are configured.

### Pre-flight checks

1. `GOOGLE_GENERATIVE_AI_API_KEY` available in the shell running the sweep
   (native v0.27 Vercel AI SDK gateway path, post-M3 cutover 2026-05-10).
2. `GBRAIN_EMBEDDING_MODEL=google:gemini-embedding-001` and
   `GBRAIN_EMBEDDING_DIMENSIONS=1536` either in env or `~/.gbrain/config.json`.
3. **External enrichment APIs**: check if Lucien has any of these configured:
   - Tavily / Brave / Exa (web search)
   - Crustdata / Proxycurl / People Data Labs (structured people data)
   - Circleback / Otter / Fireflies (meeting history)
   - Gmail OAuth (email context)
   - If **none are available**, the sweep runs Tier 3 only (brain cross-ref
     stubs, no external enrichment). Still worth doing — Phase 4/5 fills these
     APIs in later. Document this clearly in the sweep's output so Lucien can
     decide whether to get a web-search key to unlock Tier 2.

### Implementation plan

New skill to build: `skills/kos-jarvis/enrich-sweep/`
```
skills/kos-jarvis/enrich-sweep/
├── SKILL.md         — protocol (follows the Tier 1/2/3 GBrain pattern)
├── run.ts           — executable sweep
└── report.template.md — dashboard writeback
```

**Algorithm** (see upstream [`skills/enrich/SKILL.md`](../skills/enrich/SKILL.md)
for the Tier logic; we reuse it, don't reinvent):

```
Phase A — collect entity candidates
  for each page in gbrain list --limit 10000:
    read body
    run named-entity extraction via Anthropic (cheap pass; Haiku 4.5)
    emit candidate list: {name, kind guess, source_slug, mention_context}

Phase B — dedupe & count
  merge candidates by fuzzy-match on name (use people's alias rule from
    docs/GBRAIN_RECOMMENDED_SCHEMA.md §Aliases)
  count mentions per canonical entity
  drop noise (single mention + no contextual weight)

Phase C — tier classification
  tier 1 candidate: mentions ≥ 8 OR appears in decisions/meetings with Lucien
    — defer unless external enrichment APIs are configured
  tier 2 candidate: mentions 3-7 across ≥ 2 source files
  tier 3 candidate: 1-2 mentions with useful context
  (For Phase 3 initial run: treat everyone as tier 3 unless external APIs
  are configured. Avoids the entire stub-then-never-fill problem.)

Phase D — write stubs
  for each tier 3+ candidate that doesn't yet have a page:
    create ~/brain/<dir>/<slug>.md using template that matches schema
    set confidence: low, source_of_truth: brain-synthesis
    populate State from brain-only context (what other pages say)
    populate Timeline with first mention timestamp from source page
    commit via gbrain put + gbrain link to every mentioning source
  run `gbrain embed <slug>` for each new stub

Phase E — report
  write ~/brain/agent/reports/enrich-sweep-<date>.md
    - new pages created: count, list by dir
    - existing pages updated: count, list
    - tier distribution
    - blocked-by-missing-API: count, list (these want Tier 1/2 but no web search)
    - confidence before vs after (roll up from confidence-score SKILL.md rubric)
```

**Estimated scale**: 20-40 new stubs (rough guess from scanning the 85-page
corpus manually). Gemini cost ≈ one embedding call per stub + one extraction
call per source page = trivial (< $0.50 total, free-tier on Gemini).

**Blast radius**: writes new files to `~/brain/`, creates pgvector chunks,
updates link graph. Fully reversible via `gbrain delete <slug>` if a stub is
bad. **Do a dry-run first** (`run.ts --dry`) that prints the plan without
writing anything, for Lucien's review.

### Cross-dependency on P0 TODO

`kos-patrol/run.ts` (P0 TODO) consumes the link-graph state. Ship `enrich-sweep`
first for the direct G1 payoff; then finish `kos-patrol/run.ts` so the next
day's patrol report shows the new entity network properly. Both together
before Phase 4.

### Exit criteria to Phase 4

- [ ] `enrich-sweep/run.ts --dry` produced a sensible plan (Lucien reviewed)
- [ ] Live run produced the expected number of stubs
- [ ] `gbrain query "Lucien's core collaborators"` returns 3+ relevant people
  pages (currently would return only lucien-chen.md)
- [ ] `kos-patrol/run.ts` shipped; first daily run produces dashboard + digest
- [ ] Lint clean: no new broken links, no orphans among new stubs
- [ ] If Tier 1/2 was blocked by missing APIs, Lucien made an explicit
  decision (get key vs. stay Tier 3)

---

## 6. Phase 4 — Calendar import (1 week)

**Goal**: lightest structured data source. Each calendar event → meeting page
→ attendees trigger enrich. Exercise the GBrain integration pipeline.

**Acceptance gate**: 30 days of calendar history imported, attendees cross-linked
with Phase 3 entity pages.

### Reference

- Upstream recipes dir: `recipes/` (check `gbrain integrations list` output)
- Upstream skill: [`skills/meeting-ingestion/SKILL.md`](../skills/meeting-ingestion/SKILL.md)

### Implementation outline (detailed planning lives in a Phase-4-specific doc once we enter this phase)

1. Confirm which calendar: Google Calendar via OpenClaw OAuth? Notion's
   calendar? Direct .ics feed?
2. Configure the recipe (provides a two-sync pattern similar to notionToBrain).
3. Decide cutoff window: 30 days back? 90? (recommend 30 for first run, extend
   if noise is low)
4. Filter rules: skip all-day "vacation" events, skip recurring standups unless
   attendee set changes, skip events with no attendees
5. Auto-enrich: each attendee name passes through Phase 3's enrich-sweep queue
6. Meeting page template: reuse [`docs/GBRAIN_RECOMMENDED_SCHEMA.md`](GBRAIN_RECOMMENDED_SCHEMA.md)
   §Meeting template (analysis above the line, transcript/notes below)

### Risks to plan for

- Duplicate attendee names (two "Mike Chen"s): disambiguate via calendar
  domain/email
- Privacy-sensitive events (1on1 health topics, family): tag filter or
  explicit opt-out list
- Calendar API quotas: pacer configuration per @notionhq/workers pattern

### Exit criteria to Phase 5

- [ ] 30 days of events in `meetings/`
- [ ] ≥ 20 attendee enrichments cross-linked with Phase 3 entity pages
- [ ] At least one meeting-driven "missing entity" gap auto-detected by
  kos-patrol

---

## 7. Phase 5 — Email import (1-2 weeks)

**Goal**: highest-yield highest-noise source. Enable with tight scoping.

**Acceptance gate**: curated subset imported, signal-to-noise acceptable
(< 20% of ingested emails produce useful enrichment).

### Scoping options (pick one for initial rollout)

| Option | What goes in | Data volume | Enrichment yield | Recommended first? |
|--------|--------------|-------------|------------------|---------------------|
| A | Sent mail only, last 90 days | Low (~hundreds) | Medium (reveals Lucien's actual contacts) | **Yes, start here** |
| B | Inbox + label `#intel` + `#1on1` | Low-medium | High per-item | Good follow-up |
| C | Inbox last 30 days full | Medium-high | High noise, ~10% useful | Not recommended for first cut |
| D | All-time full inbox | Very high | Garbage fire | Never |

### Implementation outline

See `skills/executive-assistant/` and Gmail recipe in `recipes/gmail/` upstream
when we get to this phase. The `enrich` skill handles the hard part (tier
decisions, API orchestration); email ingest is mostly the "pull correct subset
→ call enrich per sender/thread" wiring.

### Risks to plan for

- Newsletter / transactional / notification email flood: aggressive pre-filter
- Sensitive threads (HR, legal, personal): allowlist approach safer than
  blocklist
- API cost: OpenAI (if we add query expansion) + any structured people API
  (Crustdata etc). Budget explicitly before turning on.
- Ingest velocity: even Option A (~hundreds of sent messages) triggers
  hundreds of enrichments. Rate-limit via pacer to avoid spiky spend and API
  bans.

### Exit criteria (end of Phase 5)

- [ ] Scoped subset imported
- [ ] Total entity page count grown to ≥ 100 people/companies (rough target)
- [ ] No runaway cost spike
- [ ] Weekly patrol report shows entity network health (avg degree,
  orphan rate, staleness distribution)

---

## 8. Cross-cutting items (should land during Phases 3-5, not in their own phase)

- [ ] **P0**: `kos-patrol/run.ts` (see `skills/kos-jarvis/TODO.md`). Land
  during Phase 3.
- [ ] **P1**: `kos-lint` path resolver (112 false-positive dead links). Land
  during Phase 3.
- [ ] **P1**: `dikw-compile/run.ts`, `evidence-gate/run.ts`,
  `confidence-score/run.ts`. Land during Phase 4 (after enrich-sweep proves
  the manual agent-driven path works, helpers productize it).
- [ ] **P2**: `notionToBrain` sync in `~/Projects/jarvis-knowledge-os/workers/
  kos-worker/src/index.ts`. Land during Phase 5 — by then email data shows
  whether Notion real-time sync is still needed or if manual `#ingest-to-wiki`
  scans suffice.
- [ ] **P2**: `kos-compat-api /ingest` accepts `markdown` payload. Same
  timeline as notionToBrain (they depend on each other).
- [ ] **Cleanup**: after 7 days stable (target date: ≥ 2026-04-24), archive
  `com.jarvis.kos-api.plist` and retire `com.jarvis.kos-deep-lint`. See
  `scripts/launchd/README.md`.

---

## 9. Open decisions Lucien needs to make before picking up

Answer these early — they shape Phase 3 and onward:

1. **External enrichment APIs**: Get a Tavily / Brave / Exa key?
   Crustdata/Proxycurl for LinkedIn-like people data? Yes unlocks Tier 1/2;
   no keeps everything Tier 3 (stubs only).
2. **OpenAI key** (still open from migration): Phase 5 query expansion may
   noticeably improve recall. Gemini alone is enough to ship; OpenAI is
   nice-to-have for later.
3. **Calendar source**: Google via OAuth, or export .ics periodically?
4. **Email scope for Phase 5**: confirm Option A (sent mail, 90 days) is
   acceptable first cut, or choose different.
5. **Privacy allowlist / blocklist**: especially for email. Draft before
   Phase 5.

---

## 10. Handoff checklist for the fresh session that picks this up

If you're a new Claude Code session starting Phase 3:

1. Confirm [state snapshot §0](#0-what-you-need-to-know-before-picking-up-this-plan)
   still holds — run the health ritual.
2. Read the 6 docs in §0 order.
3. Re-check `skills/kos-jarvis/TODO.md` — P0 item may have moved since this
   doc was written.
4. Confirm Phase 1+2 gates passed with Lucien before starting Phase 3.
5. Ask Lucien about §9 open decisions.
6. Draft Phase-3-specific plan in `.claude/plans/` (Claude Code plan-mode).
7. Execute `enrich-sweep` in dry-run first. Show Lucien the plan. Wait for go.

Don't treat any of this doc as committed. It's the best-read at the time of
migration completion. Lucien's priorities may have shifted; start by asking.

---

## 11. Further reading

- Migration source plan: `~/.claude/plans/docs-gbrain-vs-kos-analysis-md-gbrain-parsed-candle.md`
- Original comparison write-up: `~/Projects/jarvis-knowledge-os/docs/gbrain-vs-kos-analysis.md`
- Feishu migration PR trail: commit range `eadc5e1..ca9d4f7` on this fork
- Upstream GBrain enrich contract: [`skills/enrich/SKILL.md`](../skills/enrich/SKILL.md)
- Upstream GBrain schema reference: [`docs/GBRAIN_RECOMMENDED_SCHEMA.md`](GBRAIN_RECOMMENDED_SCHEMA.md)
