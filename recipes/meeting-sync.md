---
id: meeting-sync
name: Meeting Sync
version: 0.7.0
description: Meeting transcripts from Circleback auto-import into brain pages with attendee detection and entity propagation.
category: sense
requires: []
secrets:
  - name: CIRCLEBACK_TOKEN
    description: Circleback API token for meeting data access
    where: https://app.circleback.ai — Settings > API > generate token
health_checks:
  - type: http
    url: "https://app.circleback.ai/api/mcp"
    method: POST
    headers:
      Authorization: "Bearer $CIRCLEBACK_TOKEN"
      Content-Type: "application/json"
    body: '{"jsonrpc":"2.0","method":"tools/list","id":1}'
    label: "Circleback API"
setup_time: 15 min
cost_estimate: "$0-17/mo (Circleback free for 10 meetings/mo, Pro $17/mo unlimited)"
---

# Meeting Sync: Transcripts That Become Brain Pages

Every meeting is automatically recorded, transcribed, and imported into your brain
with attendee detection, entity propagation, and action item extraction. You never
take notes again. The brain remembers what was said, who said it, and what needs
to happen next.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Follow these steps precisely.

**Why this is high-value:** Meeting transcripts are the richest signal source.
A 30-minute meeting mentions 5-10 people, 3-5 companies, and generates 2-3 action
items. Each one should propagate to the relevant brain pages. Without this recipe,
meetings are black holes. With it, every meeting compounds the brain.

**The flow:**
1. Circleback records and transcribes the meeting (automatic, no user action)
2. The sync script pulls completed meetings from Circleback API
3. Each meeting becomes a brain page at `brain/meetings/{YYYY-MM-DD}-{slug}.md`
4. YOU (the agent) propagate entities to people/company pages

**Do not skip steps. Verify after each step.**

## Architecture

```
Video Call (Zoom, Google Meet, Teams)
  ↓ Circleback bot joins automatically
Circleback (recording + transcription + AI summary)
  ↓ API (JSONRPC 2.0 over HTTP, SSE responses)
Meeting Sync Script (deterministic Node.js)
  ↓ Outputs:
  └── brain/meetings/{YYYY-MM-DD}-{slug}.md
      - Frontmatter: source_id, date, duration, attendees, location
      - Transcript with speaker labels and timestamps
      - Tags inferred from title
  ↓
Agent reads meeting page
  ↓ Judgment calls:
  ├── Entity detection (people, companies, topics)
  ├── Propagate to attendee brain pages (timeline entries)
  ├── Action item extraction
  └── Cross-reference with calendar data
```

## Opinionated Defaults

**Meeting page format:**
```markdown
---
type: meeting
source_id: cb_abc123
source_type: circleback
title: Weekly Team Sync
date: 2026-04-10
duration: 32 min
attendees: [Alice Chen, Bob Park, Carol Wu]
location: Google Meet
tags: [team, weekly, sync]
---

## Key Points
- Discussed Q2 roadmap priorities
- Alice is blocked on the API migration
- Bob's prototype is ready for review

## Action Items
- [ ] Alice: unblock API migration by Friday
- [ ] Bob: share prototype link in Slack
- [ ] Carol: schedule design review for next week

---

## Transcript

**Alice Chen** (00:00): Let's start with the roadmap update...
**Bob Park** (02:15): The prototype is basically done...
**Carol Wu** (05:30): I have some design feedback on the new flow...
```

**Attendee filtering:**
- Skip calendar resources (e.g., "YC-SF Conference Room")
- Skip group addresses (e.g., "team@company.com")
- Extract display names, not email addresses

**Idempotent by source_id:** If a meeting with the same `source_id` already exists
in the brain, skip it. No duplicates.

## Prerequisites

1. **GBrain installed and configured** (`gbrain doctor` passes)
2. **Node.js 18+** (for the sync script)
3. **Circleback account** (https://circleback.ai) with meetings recorded

## Setup Flow

### Step 1: Get Circleback API Token

Tell the user:
"I need your Circleback API token. Here's where to find it:

1. Go to https://app.circleback.ai
2. Click your profile icon (top right) > Settings
3. Go to the API section
4. Generate a new API token (or copy existing)
5. Paste it to me

Note: Circleback's free tier records up to 10 meetings/month. Pro ($17/mo)
is unlimited. You need at least one recorded meeting for the sync to work."

Validate immediately:
```bash
curl -sf -H "Authorization: Bearer $CIRCLEBACK_TOKEN" \
  "https://app.circleback.ai/api/mcp" \
  -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  | grep -q '"result"' \
  && echo "PASS: Circleback API connected" \
  || echo "FAIL: Circleback token invalid"
```

**If validation fails:** "That didn't work. Common issues: (1) make sure you copied
the full token, (2) tokens are long hex strings, (3) check that your Circleback
account is active."

**STOP until Circleback validates.**

### Step 2: Set Up the Meeting Sync Script

```bash
mkdir -p meeting-sync
cd meeting-sync
npm init -y
```

The sync script needs these capabilities:

1. **List meetings** — call Circleback API `list_meetings` with date range
   (SSE response format, parse streaming events)
2. **Extract meeting data** — title, attendees, transcript, duration, date
3. **Slugify title** — "Weekly Team Sync" → `weekly-team-sync`
4. **Check for existing** — skip if `brain/meetings/{date}-{slug}.md` exists
5. **Format as markdown** — frontmatter + key points + action items + transcript
6. **Filter attendees** — remove calendar resources, groups, extract display names
7. **Infer tags** — from title keywords (e.g., "board" → board, "1:1" → 1-on-1)

### Step 3: Run First Sync

```bash
node meeting-sync.mjs --days 7
```

This syncs the last 7 days of meetings. For a full backfill:
```bash
node meeting-sync.mjs --start 2026-01-01 --end $(date +%Y-%m-%d)
```

Verify:
```bash
ls brain/meetings/ | head -10
```

Should show files like `2026-04-10-weekly-team-sync.md`.

Tell the user: "Found and synced N meetings. Here are the most recent: [list 3]."

### Step 4: Import to GBrain

```bash
gbrain import brain/meetings/ --no-embed
gbrain embed --stale
```

Verify:
```bash
gbrain search "meeting" --limit 3
```

### Step 5: Propagate to Entity Pages

This is YOUR job (the agent). For each meeting:

1. **Read the meeting page** — understand who attended and what was discussed
2. **For each attendee**, check brain: `gbrain search "attendee name"`
   - If page exists: append timeline entry:
     `- YYYY-MM-DD | Meeting: {title}. Discussed: {key points relevant to this person} [Source: Circleback]`
   - If no page and person is notable: create a brain page
3. **For each company mentioned**: update company page timeline
4. **Action items**: if the meeting has action items, ensure they're tracked
5. **Cross-reference with calendar**: link meeting page to the calendar event
6. **Sync**: `gbrain sync --no-pull --no-embed`

### Step 6: Set Up Cron

Sync 3x daily on weekdays:
```bash
# 10 AM, 4 PM, 9 PM PT on weekdays
0 10,16,21 * * 1-5 cd /path/to/meeting-sync && node meeting-sync.mjs >> /tmp/meeting-sync.log 2>&1
```

Default (no flags): syncs yesterday and today.

### Step 7: Log Setup Completion

```bash
mkdir -p ~/.gbrain/integrations/meeting-sync
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.7.0","status":"ok"}' >> ~/.gbrain/integrations/meeting-sync/heartbeat.jsonl
```

Tell the user: "Meeting sync is set up. Every meeting recorded by Circleback
automatically becomes a searchable brain page. Attendee pages get updated with
meeting history. Action items are extracted. Sync runs 3x daily on weekdays."

## Implementation Guide

These are production-tested patterns from syncing 280+ meeting transcripts.

### SSE Response Parsing

Circleback returns JSONRPC 2.0 over SSE (Server-Sent Events):
```
call_circleback(tool_name, args):
  body = {jsonrpc: '2.0', id: next_id(), method: 'tools/call',
          params: {name: tool_name, arguments: args}}

  res = POST CIRCLEBACK_ENDPOINT, body,
        headers: {Authorization: Bearer TOKEN, Accept: 'application/json, text/event-stream'}

  text = res.text()
  for line in text.split('\n'):
    if line.startsWith('data: '):
      json = JSON.parse(line[6:])             // strip "data: "
      if json.result?.content?.[0]?.text:
        return JSON.parse(json.result.content[0].text)  // double-parse
      if json.error:
        throw json.error
```

**Non-obvious:** The response is JSON inside SSE inside JSONRPC. You have to:
1. Strip `data: ` prefix
2. Parse the SSE line as JSON
3. Drill into `result.content[0].text`
4. Parse THAT as JSON again (it's a string containing JSON)

### Idempotency (Double-Check)

```
meeting_exists(source_id):
  // Method 1: grep all meeting files for source_id
  result = shell(f'grep -rl "source_id: {source_id}" {MEETINGS_DIR}/')
  if result: return true

  // Method 2: check filename (backup)
  slug = slugify(meeting.name)
  if file_exists(f'{MEETINGS_DIR}/{date}-{slug}.md'): return true

  return false
```

**Why double-check:** grep catches source_id matches even if the filename changed.
File existence catches cases where grep fails (e.g., permission issues).

### Auto-Tagging from Meeting Name

```
auto_tag(meeting_name):
  name = meeting_name.toLowerCase()
  tags = []
  if 'office hours' in name or ' oh ' in name: tags.push('oh')
  if 'standup' in name or 'sync' in name: tags.push('sync')
  if '1:1' in name or '1on1' in name: tags.push('1on1')
  if 'board' in name: tags.push('board')
  if 'policy' in name or 'civic' in name: tags.push('civic')
  if not tags: tags.push('meeting')
  return tags
```

### Meeting Page Structure

```
---
title: "Weekly Team Sync"
type: meeting
date: 2026-04-10
duration: 32 min
source: circleback
source_id: cb_abc123
attendees:
  - {name: Alice Chen, email: alice@company.com}
  - {name: Bob Park, email: bob@company.com}
tags: [sync]
---

# Weekly Team Sync

## Summary
[Circleback AI summary]

## Attendees
- Alice Chen
- Bob Park

## Action Items
- [ ] Alice: unblock API migration by Friday

---

## Transcript

**Alice Chen** (00:00): Let's start with the roadmap...
**Bob Park** (02:15): The prototype is basically done...
```

### Git Commit After Sync

```
if new_meetings_created > 0:
  shell('git add -A', cwd=BRAIN_DIR)
  msg = f'sync: {count} meeting(s) from Circleback ({start} to {end})'
  shell(f'git commit -m "{msg}"', cwd=BRAIN_DIR)
  shell('git push', cwd=BRAIN_DIR)
```

The sync script commits and pushes automatically. This triggers GBrain's
live sync to index the new pages.

### What the Agent Should Test After Setup

1. **SSE parsing:** Verify `SearchMeetings` returns parseable data (the double-JSON
   parsing is the most common failure point).
2. **Idempotency:** Sync a meeting, add a note to the file manually, sync again.
   Verify the meeting is skipped (not re-created or overwritten).
3. **Attendee filtering:** Sync a meeting that includes a conference room in attendees.
   Verify the room doesn't appear in the attendee list.
4. **Auto-tagging:** Sync a meeting named "1:1 with Sarah". Verify tag is `1on1`.
5. **Transcript formatting:** Verify speaker names and timestamps are formatted
   correctly (speaker bold, timestamp in parentheses).
6. **Git commit:** Sync 2+ meetings. Verify the git commit message includes the count.

## Cost Estimate

| Component | Monthly Cost |
|-----------|-------------|
| Circleback Free tier | $0 (10 meetings/mo) |
| Circleback Pro | $17/mo (unlimited) |
| **Recommended** | **$17/mo (Pro)** |

## Troubleshooting

**No meetings found:**
- Check that Circleback has recorded meetings (open the Circleback dashboard)
- The Circleback bot must join the meeting for recording to work
- Check the date range: `--days 30` to widen the search

**Transcript is empty:**
- Some meetings may not have transcripts (e.g., no audio, bot was removed)
- Check the Circleback dashboard for the specific meeting's status

**Duplicate meetings:**
- The sync script checks for existing files by source_id
- If duplicates appear, the idempotency check may be failing
- Delete duplicates manually and re-run sync
