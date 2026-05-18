---
id: slack-to-brain
name: Slack-to-Brain
version: 0.1.0
description: Slack workspace threads become brain correspondence pages with person match-back via email / Slack user_id. Tracks @-mentions, entity references, and high-signal threads from your daily workspaces.
category: sense
forked_from: imessage-to-brain v0.1.0
requires: []
secrets:
  - name: SLACK_BOT_TOKEN
    description: Slack OAuth bot token with scopes channels:history, groups:history, im:history, mpim:history, users:read, users:read.email
    where: https://api.slack.com/apps → create app → OAuth & Permissions → add bot scopes → install to workspace → copy xoxb-... token
  - name: SLACK_WORKSPACE
    description: Slug used to namespace output paths and cursor file (e.g. "jeeves"). One per Slack workspace you're ingesting.
    where: pick any short slug — used only in filesystem paths under ~/brain/correspondence/slack/<workspace>/
health_checks:
  - type: api_reachable
    url: https://slack.com/api/auth.test
    label: "Slack API reachable"
  - type: dir_exists
    path: ~/brain/correspondence/slack
    label: "Output directory ready"
setup_time: 30 min (OAuth grant + collector) + 5 min per added workspace
cost_estimate: "$0 (Slack Web API is free within rate limits)"
---

# Slack-to-Brain: Workspace Threads Become Searchable Memory

Slack is where most BD relationships actually happen — warm intros, deal updates, half-decisions, the lunch you scheduled in a DM. iMessage-to-brain captures personal threads; this recipe captures the work side.

This is also the **biggest unlock for hash-lemma BD workflows**: the Jeeves workspace already has Hermes authenticated. Every thread Hermes sees should be a brain page that the next session can recall.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Follow precisely.

**Why this matters:** Without this recipe, the brain only knows the meetings — never the half-conversations that produced them. Every "intro from Petri", every "Karel sent a deck", every Cara compliance question lives in Slack threads. Meetings are the punchline; Slack is the setup.

**Output (three writes per substantive thread):**

1. A `correspondence`-type page at `~/brain/correspondence/slack/<workspace>/<channel>-<thread-ts>.md`. Channel name, workspace, thread URL, participants matched back to person slugs, message count, first/last dates. Body is turn-by-turn, truncated past 800KB to dodge tsvector overflow.
2. **Diarization append on matched person pages.** Every participant whose Slack email maps to an existing `people/<slug>` gets a `timeline:` entry: date + one-line summary + link back to the correspondence page. This is the load-bearing diarization step — the person page accumulates evidence of relationship without the agent re-reading every thread. Per [[docs/ethos/thin_harness_fat_skills]] "Read 50 documents, produce 1 page of judgment".
3. **`slack_handles:` frontmatter merge** on matched person pages so future lookups by `<user_id>@<workspace>` resolve immediately. Append-only; never clobbers prior handles.
4. Per-workspace heartbeat at `~/.gbrain/integrations/slack/<workspace>/heartbeat.jsonl`.

Visual representation of the page frontmatter:

```yaml
---
type: correspondence
channel: slack
workspace: jeeves
channel_id: C0AS82R9SV8
channel_name: ebay
thread_ts: "1747234567.123456"
participants: [people/anoop-kansupada, people/petri-basson]
first_message: 2026-05-14
last_message: 2026-05-17
message_count: 23
slack_url: https://jeeves.slack.com/archives/C0AS82R9SV8/p1747234567123456
---
```

## Architecture

```
Slack Web API (events.history / conversations.history)
  ↓ collector pulls per channel since last cursor
  ↓ thread-level aggregation (messages with thread_ts → one thread)
  ↓ filter substantive threads:
        ≥ 5 messages
        OR @-mention of authenticated user
        OR contains tracked entity (people/* or companies/* match)
  ↓ user resolution (Slack user_id → email via users.info)
  ↓ email normalization (lowercase)
  ↓ match-back vs people/*.md (email field) and people/*.md (slack_handles)
  ↓
For each thread:
  ├── if matched person: write ~/brain/correspondence/slack/<workspace>/<thread>.md
  ├── annotate every matched person page with slack_handles frontmatter
  └── heartbeat
```

## Opinionated Defaults

**Substantive filter** — drop:
- threads with `< 5` messages UNLESS they @-mention the authenticated user OR reference a tracked entity
- broadcast channels (`#general`, `#announcements`) — they're noise, not relationships
- bot-only threads (every message from `bot_id`-tagged users)
- single-reaction "threads" with no text

**Allow-list mode (recommended for first run):** ingest only channels on a curated list. The user provides channel IDs or names. Default: all DMs + private channels where authenticated user is a member; never public channels until explicitly added. Expand iteratively.

**Privacy:** never write the raw message body to logs. Don't paste thread contents into Claude conversations unless the user explicitly requests a query against them. The brain MCP retrieves them on demand. For sensitive channels (legal, M&A), use an exclude-list — they get NO thread bodies, only metadata (participants + count + last_active).

**Schema is shared with linkedin / iMessage / telegram** (`type: correspondence`). See the YAML block in "Instructions for the Agent" above.

## Prerequisites

1. **Slack workspace** where the user (or their bot) has been added to relevant channels
2. **Slack app** with OAuth scopes: `channels:history`, `groups:history`, `im:history`, `mpim:history`, `users:read`, `users:read.email`. Create at api.slack.com/apps.
3. **Bot token** stored at `~/.gbrain/integrations/slack/<workspace>.token` OR `SLACK_BOT_TOKEN_<WORKSPACE>` env var
4. **gbrain doctor** passes; brain repo + collector dir writable
5. **Python 3 + requests** OR **bun + slack-sdk** (collector lang is implementer's choice; Python shown below for parity with imessage-to-brain)

## Setup Flow

### Step 1: Provision Slack app + token

Tell the user:
> "Open api.slack.com/apps → 'Create New App' → 'From scratch' → name it `gbrain-<workspace>`. Under OAuth & Permissions, add bot scopes: `channels:history`, `groups:history`, `im:history`, `mpim:history`, `users:read`, `users:read.email`. Install to workspace. Copy the `xoxb-...` bot token."

For hash-lemma specifically: Hermes already has a Slack app installed in Jeeves workspace as `@jeeves`. Reuse that token if scopes are sufficient; otherwise add the read scopes via OAuth & Permissions and reinstall.

Validate:
```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN_JEEVES" https://slack.com/api/auth.test | jq .
```
Should print `{ok: true, team: "Jeeves", user: "...", ...}`.

### Step 2: Build the collector

```bash
mkdir -p ~/slack-collector && cd ~/slack-collector
mkdir -p ~/.gbrain/integrations/slack/jeeves
```

Build `slack-collector.py`. **This is a sketch, not a copy-paste.** The implementing agent picks language and structure based on the user's environment. Python below shows only the load-bearing shape; everything else (rate-limit handling, cursor persistence, allow/exclude list loading, redaction, frontmatter merge) follows from the architecture diagram + opinionated-defaults section above.

```python
# ----- Skeleton, ~30 lines. Implementing agent expands.
import json, os, re, requests
from pathlib import Path

TOKEN = os.environ["SLACK_BOT_TOKEN"]
WORKSPACE = os.environ.get("SLACK_WORKSPACE", "default")
BRAIN = Path.home() / "brain"

def slack(method, **params):
    """Call Slack Web API. Implementer adds: rate-limit retry, error classification."""
    r = requests.get(f"https://slack.com/api/{method}",
                     headers={"Authorization": f"Bearer {TOKEN}"}, params=params)
    return r.json()

def is_substantive(thread_msgs, tracked_names, self_user_id):
    """≥5 msgs OR @-mention of self OR mentions a tracked entity. See Opinionated Defaults."""
    text = " ".join((m.get("text") or "").lower() for m in thread_msgs)
    return (len(thread_msgs) >= 5
            or f"<@{self_user_id}>" in text
            or any(n.lower() in text for n in tracked_names))

def match_back(participants, people_by_email):
    """Slack user_id → email (slack users.info) → people/<slug>. Implementer adds caching."""
    return [people_by_email[u["email"]] for u in participants if u.get("email") in people_by_email]

def write_thread(slug, frontmatter, body_lines):
    """Write correspondence page + diarization-append on each matched person page.
       Implementer: idempotent body truncation past 800KB; reverse-merge slack_handles frontmatter
       without clobbering prior values; append a timeline: entry per matched person."""
    ...

# main: walk channels → walk threads → filter substantive → match back → write_thread → heartbeat
```

What the implementing agent fills in (not shown):

- Rate-limit handling: catch `ratelimited` errors, sleep `Retry-After`, max 5 retries
- Cursor persistence: per-channel `last_ts` in `~/.gbrain/integrations/slack/<workspace>/cursors.json`
- Allow / exclude list loading from `<workspace>-allowlist.txt` / `<workspace>-exclude.txt`
- Redaction path for excluded channels (metadata-only, no body)
- Reverse merge of `slack_handles:` frontmatter on matched person pages (preserve existing handles; append new)
- Timeline-append on matched person pages: `- YYYY-MM-DD Slack #<channel> — <summary>` linking to the correspondence page
- Body truncation past 800KB
- Heartbeat JSONL append

Reference implementations to crib from: `gbrain integrations show imessage-to-brain` (the iMessage analog) and `gbrain integrations show linkedin-export-to-brain` (frontmatter-merge pattern). Both live in the upstream gbrain recipes directory.


### Step 3: Dry-run with allow-list

Before running on the full workspace, restrict to 1-2 channels:

```bash
echo "C0AS82R9SV8" > ~/.gbrain/integrations/slack/jeeves-allowlist.txt   # the #ebay channel
echo "your-dm-channel-id" >> ~/.gbrain/integrations/slack/jeeves-allowlist.txt
SLACK_WORKSPACE=jeeves python3 ~/slack-collector/slack-collector.py
ls ~/brain/correspondence/slack/jeeves/
```

Spot-check 2-3 generated pages. Confirm:
- participants are resolved person slugs (not raw user_ids)
- `slack_url` points to the actual thread
- bodies are non-empty and end before the 800KB cap
- redaction works for any channel in the excludelist

### Step 4: Promote to scheduled run

LaunchAgent: `~/Library/LaunchAgents/com.gbrain.slack-jeeves.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.gbrain.slack-jeeves</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/python3</string>
    <string>/Users/jarvis/slack-collector/slack-collector.py</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>SLACK_WORKSPACE</key><string>jeeves</string>
  </dict>
  <key>StandardOutPath</key><string>/Users/jarvis/.gbrain/integrations/slack/jeeves/run.log</string>
  <key>StandardErrorPath</key><string>/Users/jarvis/.gbrain/integrations/slack/jeeves/run.err</string>
</dict>
</plist>
```

15-minute cadence is the default. Tune higher for active channels, lower if rate-limit issues appear.

### Step 5: Register with gbrain

```bash
gbrain integrations enable slack-to-brain --workspace jeeves
gbrain doctor   # should now see 1 more event source healthy
```

## Failure modes

| Failure | Symptom | Recovery |
|---|---|---|
| Token expired | `auth.test` returns `invalid_auth` | Re-OAuth via api.slack.com/apps; replace token file |
| Rate-limit storm | `ratelimited` errors flooding heartbeat | Increase `StartInterval` to 1800; reduce channel list |
| Channel not visible | thread never appears | Bot not in channel — invite via `/invite @gbrain-<workspace>` |
| Match-back finds nothing | `matched_persons: 0` consistently | People pages missing `email:` frontmatter — backfill from Google Contacts first |
| tsvector overflow on a big thread | gbrain sync errors on a specific file | The 800KB truncation should prevent this; if it still fires, lower to 500KB |

## What this recipe deliberately does NOT do

- **Doesn't write back to Slack.** Read-only by design. The brain consumes Slack; Slack doesn't consume the brain. (Hermes handles Slack replies separately.)
- **Doesn't process reactions.** Emoji-only threads filtered as noise.
- **Doesn't track presence / channel membership / call invites.** Just message threads.
- **Doesn't try to be a Slack search replacement.** Slack's own search is excellent for "find that quote." This recipe is for "what relationship has this thread been part of."
- **Doesn't ingest public Slack archives** (e.g., #general). Use the allow-list to opt those in deliberately.

## Why this recipe lives upstream, not in hash-lemma

Per `docs/ethos/markdown_skills_as_recipes`: the moat is taste, not code. Slack-to-brain is a generic capability every gbrain user with a Slack workspace wants. It belongs in the upstream `gbrain/recipes/` catalog so anyone running `gbrain integrations list` sees it as AVAILABLE. The hash-lemma-specific configuration (Jeeves workspace, channel allow-list) lives in `~/.gbrain/integrations/slack/jeeves-*` files, not in the recipe.
