# Reference Cron Schedule

## Goal

A production brain runs 20+ recurring jobs that keep it alive, current, and
compounding. This guide shows the schedule, the patterns, and how to set it up.

## What the User Gets

Without this: the brain only updates when you manually ingest data. Pages go
stale, entities are thin, citations break, and the agent answers from old context.

With this: the brain maintains itself. Email, social, calendar, and meetings
flow in automatically. Thin pages get enriched overnight. Broken citations get
fixed. You wake up and the brain is smarter than when you went to sleep.

## The Schedule

| Frequency | Job | Brain Interaction | Recipe |
|-----------|-----|-------------------|--------|
| Every 30 min | Email monitoring | Search sender, update people pages | [email-to-brain](../../recipes/email-to-brain.md) |
| Every 30 min | X/Twitter collection | Create/update media pages, entity extraction | [x-to-brain](../../recipes/x-to-brain.md) |
| 3x/day (weekdays) | Meeting sync | Full ingestion + attendee propagation | [meeting-sync](../../recipes/meeting-sync.md) |
| Weekly | Calendar sync | Daily files + attendee enrichment | [calendar-to-brain](../../recipes/calendar-to-brain.md) |
| Daily AM | Morning briefing | Search calendar attendees, deal status, active threads | [briefing skill](../../skills/briefing/SKILL.md) |
| Weekly | Brain maintenance | `gbrain doctor`, embed stale, orphan detection | [maintain skill](../../skills/maintain/SKILL.md) |
| Nightly | Dream cycle | Entity sweep, enrich thin spots, fix citations | See below |

### Prefer gbrain's native schedulers where they fit

System cron is the lowest common denominator, but gbrain ships its own
scheduling surfaces — reach for these first:

- **`gbrain dream`** — the shipped nightly maintenance cycle (lint,
  backlinks, extract, sync, embed, synthesize). Schedule THIS instead of
  hand-rolling the dream cycle below.
- **`gbrain jobs` / minions** — queue shell jobs or LLM subagents with retry,
  backoff, and an audit trail. See the `minion-orchestrator` skill.
- **`gbrain autopilot`** — the long-lived background daemon that runs cycles
  on its own cadence.
- **`cron-scheduler` skill** (`skills/cron-scheduler/`) — teaches an agent to
  manage its harness's scheduler.
- **Bootstrap session-triggered schedules** — `gbrain bootstrap` installs
  HEARTBEAT.md-driven schedules that fire on session activity; see
  [bootstrap.md](bootstrap.md).

For scheduling `sync` + `embed --stale` specifically, the home doc is
[live-sync.md](live-sync.md).

## Implementation: Setting Up Cron Jobs

```bash
# Email collector — every 30 minutes
*/30 * * * * cd /path/to/email-collector && node email-collector.mjs collect && node email-collector.mjs digest

# X/Twitter collector — every 30 minutes
*/30 * * * * cd /path/to/x-collector && node x-collector.mjs collect >> /tmp/x-collector.log 2>&1

# Meeting sync — 10 AM, 4 PM, 9 PM on weekdays
0 10,16,21 * * 1-5 cd /path/to/meeting-sync && node meeting-sync.mjs >> /tmp/meeting-sync.log 2>&1

# Calendar sync — Sundays at 10 AM
0 10 * * 0 cd /path/to/calendar-sync && node calendar-sync.mjs --start $(date -v-7d +%Y-%m-%d) --end $(date +%Y-%m-%d)

# Brain health — weekly Mondays at 6 AM
0 6 * * 1 gbrain doctor --json >> /tmp/gbrain-health.log 2>&1 && gbrain embed --stale

# Autopilot health gate — daily at 7 AM. The exit code is the signal:
# 0 fresh (or nothing installed), 1 needs attention (stale heartbeat,
# never ran, or paused), 2 the daemon took itself out of rotation.
# Status is filesystem-only, so it works even during a DB outage.
0 7 * * * gbrain autopilot --status >> /tmp/gbrain-autopilot-health.log 2>&1 || your-notify "gbrain autopilot needs attention"

# Dream cycle — nightly at 2 AM
0 2 * * * /path/to/dream-cycle.sh
```

### Quiet Hours Gate (MANDATORY)

Every cron job that sends notifications MUST check quiet hours first. The
gate is a small script YOU create (it doesn't ship with gbrain) and call at
the top of every notification-sending cron script; held output goes to a
holding directory that the morning briefing drains. See
[Quiet Hours](quiet-hours.md) for the gate script and the full pattern —
don't copy a snippet from here, that page is the single home.

### Travel-Aware Timezone Handling

The agent reads your calendar for flights, hotels, and out-of-office blocks to
infer your current location and timezone. All times shown in YOUR local timezone.

```
// Example: user flew to Tokyo
// 2 PM Pacific = 3 AM Tokyo = quiet hours
// Hold the notification, fold into morning briefing

get_user_timezone():
  calendar = gbrain search "flight" --type calendar --recent 7d
  if recent_flight:
    return infer_timezone(flight.destination)
  return config.default_timezone  // fallback: US/Pacific
```

When you travel: cron jobs that would fire during your waking hours at home but
hit your sleeping hours at the destination get held and folded into the next
morning briefing. Zero config change needed.

## The Dream Cycle

The most important cron job. Runs while you sleep.

**gbrain ships this**: `gbrain dream` runs the maintenance half of the cycle
(lint, backlinks, extract, sync, embed, synthesize) as one command — schedule
it nightly and Phase 4 below (plus most of Phase 2's hygiene checks) is
covered. The pseudocode that follows is the harness-side variant for agents
that also do LLM-driven entity sweeps and memory consolidation on top.

### Synthesis cost control: the triage cascade

The synthesize phase is a two-stage cascade: a cheap scored triage
(utility-tier model, one call per new transcript) gates the expensive
per-transcript synthesis subagents. The dials:

- `dream.triage.threshold` (default 0.5) — the score bar, and the first of the
  two ways a transcript passes the gate (the verified-segment rescue below is
  the second). Scores are cached, so retuning it re-gates instantly with
  **zero** new LLM calls. Raise it if too much routine content synthesizes;
  lower it if real signal is being skipped.
- `models.dream.triage` — the triage model (default: utility tier / Haiku).
- `dream.triage.max_chars` (default 24000, floor 1000) — per-transcript
  sample window (head/middle/tail) sent to the judge. Not part of cache
  validity — after changing it, `gbrain dream retriage --force` re-judges
  under the new sampling.
- `dream.triage.max_tokens` (default 2048, floor 256) — judge output budget.
- `dream.triage.concurrency` (default 4, clamped 1–16) — concurrent judge
  calls.
- **Verified-segment rescue** (buried-signal recovery, $0): a transcript whose
  score lands in `[dream.triage.rescue_floor, threshold)` still passes when at
  least `dream.triage.rescue_min_segments` (default 2; **0 disables**) of the
  judge's own quoted segments verify as substrings of the transcript AND its
  content type is in `dream.triage.rescue_content_types` (default
  `mixed,reflection,idea,strategy,people` — never routine/technical). Zero
  extra LLM calls; works on cached verdicts; `dream retriage` reads the same
  gate, so a reconcile sweep never cancels rescued jobs. Telemetry:
  `details.triage.rescue_checked` / `rescue_fired`.
- `dream.synthesize.quote_verify` (default on) — the mechanical post-write
  quote verify/repair pass on newly-created dream pages (paraphrased "quotes"
  are repaired to verbatim transcript slices or unquoted; never invented).
  The off switch is the incident escape hatch; telemetry lands in
  `details.synthesis.quote_verify`.
- `dream.synthesize.max_turns` (default 16) — synthesis turn budget for
  agentic children and oneshot fallbacks (the default oneshot path — see
  the next section — is a single completion and never spends turns). The
  triage map hands the subagent pre-extracted segments, so the mid-tier
  default model (`models.dream.synthesize`, tier `reasoning`) with a 16-turn
  budget is the intended pairing — frontier-model overrides are unnecessary
  and slow the queue. Completeness comes from triage coverage (every file
  scored, minus files deferred under the `max_ms` budget below) plus
  segment-guided prompts, not model size. If written-page counts
  drop after upgrading, set it back to 30 and check
  `details.synthesis.avg_turns` for cap pressure.
- `dream.triage.max_ms` (default 5 min) — per-cycle wall-clock budget for
  judging NEW files; a big cold corpus triages across a few cycles (cached
  files are free). Deferred files are labeled "not yet triaged", never
  silently rejected.
- `dream.synthesize.max_submissions_per_source_per_day` (default 0 = off) —
  opt-in backstop cap on synthesis jobs per source; 200/day is a sane value
  for busy deployments.

Maintenance recipe — after changing the threshold, upgrading through a
`TRIAGE_VERSION` bump (the eval fix wave ships v2: peak-not-average scoring —
the first post-upgrade cycle re-judges the corpus within the `max_ms` budget
and defers the rest to following cycles), or to drain a queued synthesis
backlog:

```bash
gbrain dream retriage --dry-run          # what would change (zero LLM calls)
gbrain dream retriage --reconcile-queue  # re-score + cancel queued jobs that fail the gate
gbrain dream retriage --audit-rejects 20 # synthesis-model second opinion on 20 gate rejects
```

### Synthesis speed: oneshot mode + the drain pool

Above the triage cascade sit the execution dials (#4216/#4194):

- `dream.synthesize.mode` (default `oneshot`) — how each synthesis child
  runs. `oneshot` makes ONE tool-less completion against a prompt that
  already carries a pre-retrieved **LINK CANDIDATES** manifest and the write
  allow-list, then validates and writes the pages programmatically (slug
  grammar, allow-list, transcript hash suffix, exact-match wikilinks — all
  checked before any write; embeds deferred out of the model path and
  backfilled at phase end by a bounded pass over just the pages the phase
  wrote — never a source-wide sweep). A response that fails any check automatically
  falls back to the classic agentic loop **in the same job** — no lost work,
  no resubmission. Typical effect: 10+ provider round-trips per transcript
  (up to the 16-turn default cap, more on raised `max_turns`) → 1. Revert
  dial: `gbrain config set dream.synthesize.mode agentic`.
- `dream.synthesize.link_manifest` (default on) — the zero-embed
  pre-retrieval manifest (built from the triage verdict's cached entities +
  segment notes). Benefits BOTH modes: agentic children stop burning turns
  on low-yield searches; oneshot children get their link targets up front.
- `dream.synthesize.inline_concurrency` (default 1, clamp 1–8) — concurrent
  drain loops for the per-run child queue on Postgres (PGLite always drains
  serially). Provider ceilings stay with the rate leases (every provider
  round-trip on every path holds a lease slot), so this dial only removes
  queue-wait, never over-drives the API.

Reading the phase report (`details.synthesis`): `mode`, `oneshot_jobs` /
`fallback_jobs` / `agentic_jobs` + a `fallback_reasons` histogram (a rising
fallback rate means the model is failing the output contract — check the
top reason before considering the agentic revert), `queue_wait_ms_p50/p95`
and `child_runtime_ms_p50/p95` (a slow-but-healthy drain is visible instead
of indistinguishable from a stuck one), and `dead_jobs`/`degraded`. A run
with any non-completed child does NOT stamp the cooldown, so the next
nightly retries exactly the failed transcripts; a run whose EVERY child
died fails the phase loudly. Synthesis children also fail (dead-letter)
when every attempted page write failed — `completed` can no longer mean
"zero pages written".

Three more fields answer "what did that cost and did it land":

- `spend` — what the phase actually spent, `cost_basis: 'in+out+cache_read'`.
  Children are summed from `minion_jobs` token counts priced at the configured
  synthesis model; triage comes from the pass's own usage. `total_usd` is
  `null` unless BOTH price, so an unpriced model reads as unknown rather than
  as a fake `0`. `details.triage` carries the judge's own `tokens_in` /
  `tokens_out` / `cost_usd` on the same terms.
- `children_zero_pages` — children that completed but wrote no page. A number
  that climbs here means the model is producing valid-but-empty output, which
  a green phase status alone would hide.
- `quote_verify` — what the post-write quote pass touched: spans checked,
  repaired, and stripped, pages skipped as pre-existing, unbalanced paragraphs,
  and the warn-only ungrounded numeric/date claim count.

Per-call spend also lands in the `chat_usage_log` ledger with a phase tag:
the orchestrator's own calls under `phase:synthesize`, each drained child
under its own `job:<name>`, so the two never double-count.

### What It Does

```
dream_cycle():
  // Phase 1: Entity Sweep
  conversations = get_todays_conversations()
  for message in conversations:
    entities = detect_entities(message)
    for entity in entities:
      page = gbrain search "{entity.name}"
      if not page:
        create_page(entity)        // new entity, create + enrich
      elif page.is_thin():
        enrich_page(entity)        // thin page, fill it out
      else:
        update_timeline(entity)    // existing page, add today's mentions

  // Phase 2: Fix Broken Citations
  pages = gbrain list --type person --limit 100
  for page in pages:
    for entry in page.timeline:
      if not entry.has_source_attribution():
        fix_citation(entry)        // add [Source: ...] where missing
      if entry.has_tweet_url() and not entry.url_is_valid():
        fix_url(entry)             // broken tweet links

  // Phase 3: Consolidate Memory
  patterns = detect_patterns_across_conversations()
  for pattern in patterns:
    promote_to_memory(pattern)     // ephemeral → durable knowledge

  // Phase 4: Sync
  gbrain sync --no-pull --no-embed
  gbrain embed --stale
```

### Setting Up the Dream Cycle

**OpenClaw:** Ships with DREAMS.md as a default skill. Three phases (light,
deep, REM) run automatically during quiet hours.

**Hermes Agent:**
```bash
/cron add "0 2 * * *" "Dream cycle: search today's sessions for
  entities I mentioned. For each person, company, or idea: check
  if a brain page exists (gbrain search), create or update it if
  thin. Fix any broken citations. Then consolidate: read MEMORY.md,
  promote important signals, remove stale entries."
  --name "nightly-dream-cycle"
```

**Claude Code / Custom agents:** Create a script:
```bash
#!/bin/bash
# dream-cycle.sh

# Check quiet hours (should be quiet — that's when we run)
echo "Dream cycle starting at $(date)"

# Phase 1: Entity sweep (spawn sub-agent)
# Read today's conversation logs, extract entities, update brain

# Phase 2: Shipped maintenance cycle (lint, backlinks, extract, sync, embed, synthesize)
gbrain dream

# Phase 3: Surface anything the cycle flagged
gbrain doctor --json | jq '.checks[] | select(.status=="warn")'

echo "Dream cycle complete at $(date)"
```

## Tricky Spots

1. **The dream cycle is NOT optional.** Without it, signal leaks out of every
   conversation. With it, nothing is lost. This is the difference between an
   agent that forgets and one that remembers.

2. **Quiet hours gate on EVERY notification job.** If you skip it, the user
   gets pinged at 3 AM. One 3 AM ping and they'll disable the whole system.

3. **Don't over-cron.** 20+ jobs sounds like a lot. Start with: email (30 min),
   dream cycle (nightly), brain health (weekly). Add more as you add
   integration recipes.

4. **Timezone changes are automatic.** Don't make the user reconfigure cron
   when they travel. Read the calendar, infer the timezone, adjust delivery.

5. **Held messages MUST be picked up.** If quiet hours hold a notification,
   the morning briefing MUST include it. Otherwise information is lost.

## How to Verify

1. **Quiet hours:** Set quiet hours to current hour. Run a notification cron.
   Verify output went to `/tmp/cron-held/`, not to messaging.
2. **Dream cycle:** Run the dream cycle manually. Check that thin entity pages
   got enriched and broken citations were fixed.
3. **Email collector cron:** Wait 30 minutes. Check `data/digests/` for new digest.
4. **Morning briefing:** Check that held messages appear in the briefing.
5. **Health check:** Run `gbrain doctor --json`. All checks should pass.

---

*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md). See also: [Quiet Hours](quiet-hours.md), [Operational Disciplines](operational-disciplines.md)*
