---
id: calendar-to-brain
name: Calendar-to-Brain
version: 1.0.0
description: Google Calendar events become searchable brain pages via the native google source kind, with attendees, locations, and meeting prep context.
category: sense
requires: [credential-gateway]
secrets:
  - name: GOOGLE_CLIENT_ID
    description: Google OAuth2 client ID (Option A — native connector; env intake works, `--client-json` is preferred)
    where: https://console.cloud.google.com/auth/clients — create a Desktop app OAuth client
  - name: GOOGLE_CLIENT_SECRET
    description: Google OAuth2 client secret (Option A)
    where: https://console.cloud.google.com/auth/clients — same client, click Download JSON
  - name: CLAWVISOR_URL
    description: ClawVisor gateway URL (Option B — alternative hosted gateway)
    where: https://clawvisor.com — create an agent, activate Google Calendar service
  - name: CLAWVISOR_AGENT_TOKEN
    description: ClawVisor agent token (Option B)
    where: https://clawvisor.com — agent settings, copy the agent token
health_checks:
  - type: command
    argv: ["gbrain", "google", "status", "--json"]
    label: "Google connector"
  # The old heartbeat_max_age freshness check is gone: heartbeat checks read
  # the recipe's OWN id (~/.gbrain/integrations/calendar-to-brain/), but the
  # connector's funnel events land under ~/.gbrain/integrations/google/.
  # Freshness is enforced natively instead: `gbrain waiting` refuses on stale
  # google sources, and `gbrain google status` live-probes each account.
  - type: any_of
    label: "Auth provider"
    checks:
      - type: env_exists
        name: GOOGLE_CLIENT_ID
        label: "Google OAuth"
      - type: http
        url: "$CLAWVISOR_URL/health"
        label: "ClawVisor"
# No output_paths: event pages materialize under the google source's MANAGED
# DIR (calendar/{YYYY}/{MM}/...), not the brain repo, so there is no
# repo-relative collector output for the db_only collision check to guard.
setup_time: 20 min
cost_estimate: "$0 (Calendar API is free within quota)"
---

# Calendar-to-Brain: Your Schedule Becomes Searchable Memory

Every calendar event becomes a searchable brain page. Your agent knows who you're
meeting tomorrow, what you discussed last time, and what context matters. Meeting
prep happens automatically because the brain already has the history.

## IMPORTANT: Instructions for the Agent

**You are the installer — but you no longer write a sync script.** Earlier
versions of this recipe had you build a deterministic calendar sync script
(pagination, chunking, daily-file generation). All of that is now IMPLEMENTED
in gbrain's google source kind — see `docs/guides/google-connect.md`. Do NOT
re-implement it; the connector handles pagination, cursors (`syncToken` with
automatic 410 recovery), cancelled-event handling, and resumable backfill
correctly and under test.

**Why this matters:** Calendar data is the richest source of relationship history.
13 years of calendar data tells you who you've met with, how often, where, and
with whom. When someone emails you, the brain already knows your meeting history.
When you have a meeting tomorrow, the agent pulls attendee dossiers automatically.

**What the connector produces:** one page per event, `type: meeting`, under
`calendar/{YYYY}/{MM}/` in the source's managed dir (NOT the brain repo), with
attendees, location, and calendar label — flowing through the standard import
pipeline (chunks, embeds, aliases, links). Contacts sync (`people/` pages)
runs first so attendee names resolve to person pages.

**Do not skip steps. Verify after each step.**

## Architecture

```
Google Calendar (multiple accounts)
  ↓ (BYO OAuth via gbrain google connect; tokens in ~/.gbrain/credentials.json)
gbrain google source kind (--services includes calendar)
  ↓ Materializes in the source's MANAGED DIR:
  ├── calendar/{YYYY}/{MM}/...md   (type: meeting — one page per event)
  └── people/...md                 (type: person — attendee resolution via Contacts)
  ↓ standard import pipeline (chunks, embeds, aliases, links)
Agent reads meeting pages
  ↓ Judgment calls:
  ├── Attendee enrichment (create/update brain pages for people)
  ├── Meeting prep (pull context before tomorrow's meetings)
  └── Pattern detection (meeting frequency, relationship temperature)
```

## Prerequisites

1. **GBrain installed and configured** (`gbrain doctor` passes)
2. **Google access** via the **[credential-gateway](credential-gateway.md)**
   recipe (Option A native connector recommended; Option B ClawVisor is the
   hosted alternative)

## Setup Flow

### Step 1: Connect and Register the Source

The fast path (`gbrain google setup`) includes calendar by default. The
explicit pieces:

```bash
gbrain google connect --account you@example.com
gbrain sources add gcal-you --kind google --account you@example.com \
  --services calendar,contacts --history-days 3650
gbrain sync --source gcal-you
```

- `--services` defaults to `gmail,calendar,contacts`; narrow it to
  `calendar,contacts` for a calendar-only source. (One source with all three
  services is the usual setup — email and calendar share attendee resolution.)
- `--history-days N` sets the backfill window. Deep history is the point:
  3650 (~10 years) builds the full relationship graph from day one.
- Multiple accounts (work + personal + previous companies still accessible):
  repeat `connect --account` + `sources add` per account; each has independent
  cursors and locks.

**Relay `[SHOW USER]` blocks verbatim** during connect — the whole setup is
exactly two user interactions (GCP checklist + one consent click).

### Step 2: Verify

```bash
gbrain google status --json          # refresh probe per account
gbrain search "meeting" --limit 3    # should return type: meeting pages
```

### Step 3: Continuous Sync

Google sources sync like any source: `gbrain sync --source <id>`,
`gbrain sync --all`, and autopilot pick them up. **A bare un-targeted
`gbrain sync` (repo mode) does not** — target it or use `--all`. No weekly
cron script of its own; incremental syncs ride the calendar `syncToken`, so
they're cheap.

### Step 4: Attendee Enrichment

This is YOUR job (the agent). For each person who appears in calendar events:

1. **Check brain**: `gbrain search "attendee name"` — do they have a page?
2. **Create page if missing**: notable attendees (appears 3+ times) get a brain page
3. **Update existing pages**: add meeting history to timeline:
   `- YYYY-MM-DD | Meeting: {event title} [Source: Google Calendar]`
4. **Relationship tracking**: note meeting frequency in compiled truth:
   "Met 12 times in last 6 months. Regular 1:1 cadence."

Attendee lists render as they appear on the event (entries without an email
address are dropped); conference-room/resource filtering is not yet applied.

## What the Agent Should Test After Setup

1. **Event pages exist:** `gbrain search "<a real recent meeting title>"`
   returns a `type: meeting` page with attendees and location.
2. **Cancelled events:** cancel a test meeting, `gbrain sync --source <id>`,
   verify it's gone.
3. **Attendee resolution:** an attendee who is also a contact links to their
   `people/` page.
4. **Backfill depth:** spot-check a meeting from years ago (within your
   `--history-days` window) — it should be searchable.

## Cost Estimate

| Component | Monthly Cost |
|-----------|-------------|
| Google Calendar API (your own OAuth client) | $0 (within free quota) |

## Troubleshooting

Every connector failure maps to a typed error code with the fix attached —
`docs/guides/google-connect.md#troubleshooting` is the canonical table.

**No events returned:**
- Check the source's `--services` list includes `calendar`
- Check the account: `gbrain google status --json` (probe should be `ok`)
- `api_not_enabled` errors carry the exact enable link for the Calendar API
- Some calendars may be empty for the requested window (`--history-days`)

**Attendee names missing:**
- Include `contacts` in `--services` — person pages give attendees stable
  names and aliases; without them, only what Calendar returns is available
