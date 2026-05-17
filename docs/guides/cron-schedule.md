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
| Every 30 min | Email monitoring | Search sender, update people pages | [google-tools-mcp](../../recipes/google-tools-mcp.md) |
| Every 30 min | X/Twitter collection | Create/update media pages, entity extraction | [x-to-brain](../../recipes/x-to-brain.md) |
| 3x/day (weekdays) | Meeting sync | Full ingestion + attendee propagation | [meeting-sync](../../recipes/meeting-sync.md) |
| Weekly | Calendar sync | Daily files + attendee enrichment | [google-tools-mcp](../../recipes/google-tools-mcp.md) |
| Daily AM | Morning briefing | Search calendar attendees, deal status, active threads | [briefing skill](../../skills/briefing/SKILL.md) |
| Weekly | Brain maintenance | `gbrain doctor`, embed stale, orphan detection | [maintain skill](../../skills/maintain/SKILL.md) |
| Nightly | Dream cycle | Entity sweep, enrich thin spots, fix citations | See below |

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

# Dream cycle — nightly at 2 AM
0 2 * * * /path/to/dream-cycle.sh
```

### Quiet Hours Gate (MANDATORY)

Every cron job that sends notifications MUST check quiet hours first.
See [Quiet Hours](quiet-hours.md) for the full pattern.

```bash
# In every cron script:
if ! bash scripts/quiet-hours-gate.sh; then
  mkdir -p /tmp/cron-held
  echo "$OUTPUT" > /tmp/cron-held/$(basename "$0" .sh).md
  exit 0
fi
# Not quiet hours — send normally
```

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

# Phase 2: Citation hygiene
gbrain doctor --json | jq '.checks[] | select(.status=="warn")'

# Phase 3: Embed any stale content
gbrain embed --stale

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
