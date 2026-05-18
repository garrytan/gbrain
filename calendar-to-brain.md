---
id: calendar-to-brain
name: Calendar-to-Brain
version: 0.7.0
description: Google Calendar events become searchable brain pages. Daily files with attendees, locations, and meeting prep context.
category: sense
requires: [credential-gateway]
secrets:
  - name: CLAWVISOR_URL
    description: ClawVisor gateway URL (Option A — recommended, handles OAuth for you)
    where: https://clawvisor.com — create an agent, activate Google Calendar service
  - name: CLAWVISOR_AGENT_TOKEN
    description: ClawVisor agent token (Option A)
    where: https://clawvisor.com — agent settings, copy the agent token
  - name: GOOGLE_CLIENT_ID
    description: Google OAuth2 client ID (Option B — direct API access, you manage tokens)
    where: https://console.cloud.google.com/apis/credentials — create OAuth 2.0 Client ID
  - name: GOOGLE_CLIENT_SECRET
    description: Google OAuth2 client secret (Option B)
    where: https://console.cloud.google.com/apis/credentials — same page as client ID
health_checks:
  - type: any_of
    label: "Auth provider"
    checks:
      - type: http
        url: "$CLAWVISOR_URL/health"
        label: "ClawVisor"
      - type: env_exists
        name: GOOGLE_CLIENT_ID
        label: "Google OAuth"
setup_time: 20 min
cost_estimate: "$0 (both options are free)"
---

# Calendar-to-Brain: Your Schedule Becomes Searchable Memory

Every calendar event becomes a searchable brain page. Your agent knows who you're
meeting tomorrow, what you discussed last time, and what context matters. Meeting
prep happens automatically because the brain already has the history.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Follow these steps precisely.

**Why this matters:** Calendar data is the richest source of relationship history.
13 years of calendar data tells you who you've met with, how often, where, and
with whom. When someone emails you, the brain already knows your meeting history.
When you have a meeting tomorrow, the agent pulls attendee dossiers automatically.

**The output is daily markdown files:** One file per day at
`brain/daily/calendar/{YYYY}/{YYYY-MM-DD}.md` with all events, attendees, and
locations. These files are the foundation for meeting prep, relationship tracking,
and pattern detection.

**Do not skip steps. Verify after each step.**

## Architecture

```
Google Calendar (multiple accounts)
  ↓ (ClawVisor credential gateway, paginated)
Calendar Sync Script (deterministic Node.js)
  ↓ Outputs:
  ├── brain/daily/calendar/{YYYY}/{YYYY-MM-DD}.md   (daily event files)
  ├── brain/daily/calendar/.raw/events-{range}.json  (raw API responses)
  └── brain/daily/calendar/INDEX.md                  (date ranges + monthly summary)
  ↓
Agent reads daily files
  ↓ Judgment calls:
  ├── Attendee enrichment (create/update brain pages for people)
  ├── Meeting prep (pull context before tomorrow's meetings)
  └── Pattern detection (meeting frequency, relationship temperature)
```

## Opinionated Defaults

**Multiple calendar accounts:**
- Work calendar (company domain)
- Personal calendar (gmail.com)
- Previous company calendars (if still accessible)

**Daily file format:**
```markdown
# 2026-04-10 (Thursday)

- 09:00-09:30 **Team standup** (Work) — with Alice, Bob, Carol
- 10:00-11:00 **Board meeting** (Work) 📍 Office — with Diana, Eduardo, Fiona
- 12:00-13:00 **Lunch with Pedro** (Personal) 📍 Chez Panisse — with Pedro Franceschi
- 14:00-14:30 **1:1 with Jordan** (Work) — with Jordan Lee
```

All-day events listed first. Timed events sorted by start time.
Cancelled events are skipped. Attendee names extracted (no email addresses in output).
Calendar label in parentheses. Location with 📍 emoji.

**Historical backfill:** Sync years of calendar data, not just recent. Common ranges:
- Work: 2020-present
- Personal: 2014-present
This builds the full relationship graph from day one.

## Prerequisites

1. **GBrain installed and configured** (`gbrain doctor` passes)
2. **Node.js 18+** (for the sync script)
3. **Google Calendar access** via ONE of:
   - **Option A: ClawVisor** (recommended, handles OAuth for you, no token management)
   - **Option B: Google OAuth2 directly** (you manage tokens, no extra service needed)

## Setup Flow

### Step 1: Choose and Configure Calendar Access

Ask the user: "How do you want to connect to Google Calendar?

**Option A: ClawVisor (recommended)**
ClawVisor handles OAuth, token refresh, and encryption. You never touch Google
credentials directly. If you already use ClawVisor for email, this uses the same setup.

**Option B: Google OAuth2 directly**
Connect to Google Calendar API directly. No extra service needed, but you manage
OAuth tokens yourself. Good if you don't want another dependency."

#### Option A: ClawVisor Setup

Tell the user:
"I need your ClawVisor URL and agent token.
1. Go to https://clawvisor.com
2. Create an agent (or use existing)
3. Activate the **Google Calendar** service
4. Create a standing task with purpose: 'Full calendar access for historical
   backfill and ongoing sync. List events, read event details, search across
   all calendars.'
   IMPORTANT: Be EXPANSIVE in the task purpose. Narrow purposes block requests.
5. Copy the gateway URL and agent token"

Validate:
```bash
curl -sf "$CLAWVISOR_URL/health" && echo "PASS: ClawVisor reachable" || echo "FAIL"
```

**STOP until ClawVisor validates.**

#### Option B: Google OAuth2 Setup

Tell the user:
"I need Google OAuth2 credentials. Here's exactly how to set them up:

1. Go to https://console.cloud.google.com/apis/credentials
   (create a Google Cloud project if you don't have one)
2. Click **'+ CREATE CREDENTIALS'** at the top, select **'OAuth client ID'**
3. If prompted, configure the OAuth consent screen first:
   - User type: **External** (or Internal if you have Google Workspace)
   - App name: anything (e.g., 'GBrain Calendar')
   - Scopes: add **'Google Calendar API .../auth/calendar.readonly'**
   - Test users: add your own email
4. Back on Credentials, create the OAuth client ID:
   - Application type: **Desktop app**
   - Name: anything (e.g., 'GBrain')
5. Click **'Create'**. You'll see the Client ID and Client Secret.
6. Copy both and paste them to me.

Also enable the Calendar API:
7. Go to https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
8. Click **'Enable'**"

Validate the credentials are set:
```bash
[ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ] \
  && echo "PASS: Google OAuth credentials set" \
  || echo "FAIL: Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET"
```

Then run the OAuth flow to get an access token:
```bash
# The sync script should handle the OAuth flow:
# 1. Open browser to Google auth URL with calendar.readonly scope
# 2. User grants access
# 3. Script receives auth code, exchanges for access + refresh token
# 4. Stores tokens in ~/.gbrain/google-tokens.json
# 5. Auto-refreshes on expiry
```

**STOP until OAuth flow completes and tokens are stored.**

### Step 2: Identify Calendar Accounts

Ask the user: "Which Google Calendar accounts should I sync? Common setup:
- Work email (e.g., you@company.com)
- Personal email (e.g., you@gmail.com)
- Any previous company emails with calendar history"

For each account, note:
- Email address
- Start year (how far back to sync)
- Label (Work, Personal, etc.)

### Step 3: Set Up the Calendar Sync Script

Create the sync directory:
```bash
mkdir -p calendar-sync
cd calendar-sync
npm init -y
```

The sync script needs these capabilities:

1. **Paginated event retrieval** — Google Calendar API returns max 50 events per
   request. The script must paginate through large date ranges. Use monthly chunks
   for sparse periods, weekly for dense ones.
2. **Daily markdown generation** — group events by date, format as markdown with
   times, attendees, locations, calendar labels
3. **Merge with existing files** — if a daily file already has manual notes, preserve
   them when updating calendar data
4. **Index generation** — create INDEX.md with date ranges, event counts, monthly summary
5. **Raw JSON preservation** — save raw API responses to `.raw/` for provenance

### Step 4: Run Historical Backfill

This is the big initial sync. It may take 10-30 minutes depending on how many
years of calendar data you have.

```bash
node calendar-sync.mjs --start 2020-01-01 --end $(date +%Y-%m-%d)
```

Tell the user: "Syncing calendar history from [start year]. This creates one
markdown file per day. For 4 years of data, expect ~1,400 daily files."

Verify:
```bash
ls brain/daily/calendar/2026/ | head -10
```

Should show daily files like `2026-04-01.md`, `2026-04-02.md`, etc.

### Step 5: Import Calendar Data to GBrain

```bash
gbrain import brain/daily/calendar/ --no-embed
gbrain embed --stale
```

Verify:
```bash
gbrain search "meeting" --limit 3
```

Should return calendar pages with event details.

### Step 6: Attendee Enrichment

This is YOUR job (the agent). For each person who appears in calendar events:

1. **Check brain**: `gbrain search "attendee name"` — do they have a page?
2. **Create page if missing**: notable attendees (appears 3+ times) get a brain page
3. **Update existing pages**: add meeting history to timeline:
   `- YYYY-MM-DD | Meeting: {event title} [Source: Google Calendar]`
4. **Relationship tracking**: note meeting frequency in compiled truth:
   "Met 12 times in last 6 months. Regular 1:1 cadence."

### Step 7: Set Up Weekly Sync

The calendar should sync weekly to stay current:
```bash
# Cron: every Sunday at 10 AM
0 10 * * 0 cd /path/to/calendar-sync && node calendar-sync.mjs --start $(date -v-7d +%Y-%m-%d) --end $(date +%Y-%m-%d)
```

After sync, import new data:
```bash
gbrain sync --no-pull --no-embed && gbrain embed --stale
```

### Step 8: Log Setup Completion

```bash
mkdir -p ~/.gbrain/integrations/calendar-to-brain
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.7.0","status":"ok","details":{"accounts":"ACCOUNT_COUNT","start_year":"YYYY"}}' >> ~/.gbrain/integrations/calendar-to-brain/heartbeat.jsonl
```

Tell the user: "Calendar-to-brain is set up. You have [N] days of calendar history
indexed. I can now prep you for meetings by pulling attendee context from the brain.
Weekly sync keeps it current."

## Implementation Guide

These are production-tested patterns from syncing 13 years of calendar data.

### Smart Chunking (Monthly vs Weekly)

```
generate_chunks(start, end, dense_after='2023-01-01'):
  chunks = []
  current = start

  while current < end:
    if current < dense_after:
      next = current + 1_MONTH    // sparse period: monthly
    else:
      next = current + 7_DAYS     // dense period: weekly

    chunks.append({from: current, to: min(next, end)})
    current = next

  return chunks
```

**Why:** Monthly chunks for sparse years (2014-2023) = ~96 API calls for 8 years.
Weekly for everything would be ~600+ calls. Per-calendar `startYear` avoids
pulling empty months (e.g., don't query 2014-2020 for a calendar created in 2020).

### Attendee Filtering

```
filter_attendees(attendees):
  return attendees.filter(a =>
    !a.email?.includes('@resource.calendar.google.com') AND  // conference rooms
    !a.email?.includes('@group.calendar.google.com') AND     // mailing lists
    !a.name?.startsWith('YC-SF-')                            // internal distros
  )
```

Without this, your attendee list is polluted with "Conference Room A" and
"engineering-all@company.com". You want actual people.

### Merge with Existing Files (Preserve Manual Notes)

```
write_daily_file(date, events, dir):
  path = f'{dir}/{date}.md'
  calendar_md = format_events(events)

  if file_exists(path):
    existing = read(path)
    if '## Calendar' in existing:
      // Replace ONLY the calendar section, keep everything else
      before = existing.split('## Calendar')[0]
      after_match = regex_search(existing, /## [A-Z](?!alendar)/)  // next section
      after = after_match ? existing[match_index:] : ''
      write(path, f'{before}## Calendar\n\n{calendar_md}\n{after}')
    else:
      write(path, f'## Calendar\n\n{calendar_md}\n---\n\n{existing}')
  else:
    write(path, calendar_md)
```

**Critical:** Only touch `## Calendar`. Everything else is preserved. If you
manually added `## Notes` to a daily file, it survives re-sync.

### Date/Time Parsing Edge Cases

```
parse_event_date(event):
  // All-day: event.start = "2024-01-15" (no T)
  // Timed: event.start = "2024-01-15T10:00:00-08:00" (with T)
  if 'T' in event.start:
    return event.start[0:10]    // extract date from datetime
  return event.start            // already a date

format_time(iso_str):
  if not iso_str or 'T' not in iso_str: return 'all-day'
  // Extract hours:minutes, convert to 12-hour
  // Edge: 00:00 = 12:00 AM, 12:00 = 12:00 PM, 13:00 = 1:00 PM
```

### What the Agent Should Test After Setup

1. **Monthly vs weekly:** Run from 2014 with dense_after=2023. Verify pre-2023
   makes ~12 API calls per year, post-2023 makes ~4 per month.
2. **Attendee filtering:** Create a meeting with a conference room and a mailing
   list. Sync. Verify neither appears in the daily file.
3. **Merge preservation:** Add `## Notes` to a daily file manually. Sync calendar.
   Verify notes are preserved.
4. **All-day events:** Create an all-day event and a timed event on the same day.
   Verify all-day appears first, timed events sorted by start time.
5. **Cancelled events:** Cancel a meeting. Sync. Verify it doesn't appear.
6. **Per-calendar startYear:** Sync a calendar created in 2022 with startYear=2022.
   Verify no API calls for years before 2022.

## Cost Estimate

| Component | Monthly Cost |
|-----------|-------------|
| ClawVisor (free tier) | $0 |
| Google Calendar API | $0 (within free quota) |
| **Total** | **$0** |

## Troubleshooting

**No events returned:**
- Check the calendar account email is correct
- Check ClawVisor has Google Calendar service activated
- Check the standing task purpose is expansive enough
- Some calendars may be empty for the requested date range

**Attendee names missing:**
- Google Calendar sometimes returns email addresses instead of display names
- The sync script should extract the display name from the attendee object
- If no display name, use the email prefix (before @)

**Duplicate events:**
- The sync script should be idempotent (same date range = same output)
- If running multiple times, existing daily files are overwritten (not appended)
