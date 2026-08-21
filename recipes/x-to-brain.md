---
id: x-to-brain
name: X-to-Brain
version: 0.9.0
description: Twitter timeline, mentions, and keyword monitoring flow into brain pages. Tracks deletions, engagement velocity, OCR on images, and alerts.
category: sense
requires: []
secrets:
  - name: X_API_BEARER_TOKEN
    description: X API v2 Bearer token for Option A
    where: https://developer.x.com/en/portal/dashboard — create a project + app, copy the Bearer Token from "Keys and tokens"
    group: x-api
  - name: XQUIK_API_KEY
    description: Xquik API key. Option B reads public X data without an X developer account.
    where: Create an API key at https://xquik.com/dashboard/api-keys
    group: xquik
  - name: X_HANDLE
    description: Your X username without the @
    where: Your X profile — the handle in your profile URL, e.g. x.com/yourhandle → yourhandle
health_checks:
  - type: any_of
    label: "X data provider"
    checks:
      - type: http
        url: "https://api.x.com/2/users/by/username/$X_HANDLE"
        auth: bearer
        auth_token: "$X_API_BEARER_TOKEN"
        label: "X API"
      - type: http
        url: "https://xquik.com/api/v1/x/users/$X_HANDLE"
        headers:
          x-api-key: "$XQUIK_API_KEY"
          xquik-api-contract: "2026-04-29"
        label: "Xquik"
setup_time: 15 min
cost_estimate: "Varies by provider and usage"
---

# X-to-Brain: Twitter Monitoring That Updates Your Brain

Your timeline, mentions, and keyword searches flow into brain pages. The collector
tracks deletions, engagement velocity, and narrative patterns. You wake up knowing
what happened on X while you slept.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Follow these steps precisely.

**The core pattern: code for data, LLMs for judgment.**
The X collector is deterministic code. It pulls tweets, detects deletions, tracks
engagement. It NEVER interprets content. YOU (the agent) read the collected data
and make judgment calls: who is important, what entities are mentioned, what
narratives are forming.

**Why sequential execution matters:**
- Step 1 validates the API key. Without it, nothing connects to X.
- Step 2 sets up the collector. Without it, you have no data.
- Step 3 runs the first collection. Without data, you can't enrich.
- Step 4 is YOUR job: read the collected tweets, update brain pages.

**Do not skip steps. Do not reorder. Verify after each step.**

## Architecture

```
X API v2 or Xquik REST API
  ↓ Three collection streams:
  ├── Own timeline
  ├── Mentions
  └── Keyword searches
  ↓
X Collector (deterministic Node.js script)
  ↓ Outputs:
  ├── data/tweets/{own,mentions,searches}/{id}.json
  ├── data/deletions/{id}.json (detected via diff)
  ├── data/engagement/{id}.json (velocity snapshots)
  └── data/state.json (pagination, rate limits)
  ↓
Agent reads collected data
  ↓ Judgment calls:
  ├── Entity detection (people, companies mentioned)
  ├── Brain page updates (timeline entries)
  ├── Narrative pattern detection
  └── Engagement spike alerts
```

## Opinionated Defaults

**Three collection streams:**
1. **Own timeline** — your tweets, for your own archive and engagement tracking
2. **Mentions** — who is talking about you, for relationship tracking
3. **Keyword searches** — topics you care about, for signal detection

**Deletion detection:**
- Compare tweet IDs from previous run vs current
- If an ID is missing AND the tweet is < 7 days old, call GET /tweets/{id}
- 404 = confirmed deleted. Save the original tweet + deletion timestamp.
- Alert on deletions from accounts you track.

**Engagement velocity:**
- Snapshot likes/retweets/replies for tracked tweets
- Alert if likes doubled AND previous count >= 50
- Alert if likes gained > 100 absolute since last check
- Only write snapshot if metrics actually changed (idempotent)

**Rate limit awareness:**
- Track provider limits in state.json
- Back off automatically on 429 responses
- Preserve cursors and resume after the provider's reset window

## Prerequisites

1. **GBrain installed and configured** (`gbrain doctor` passes)
2. **Node.js 18+** (for the collector script)
3. Access through one provider:
   - X API v2 with a developer account
   - Xquik with an API key

## Setup Flow

### Step 1. Choose an X data provider

Ask the user to choose X API v2 or Xquik. Configure one option, not both.

#### Option A. X API v2

Tell the user:
"I need your X API Bearer token. Here's exactly where to get it:

1. Go to https://developer.x.com/en/portal/dashboard
2. If you don't have a developer account, click 'Sign up' (free tier available)
3. Create a new Project (name it anything, e.g., 'GBrain')
4. Inside the project, create a new App
5. Go to the app's 'Keys and tokens' tab
6. Under 'Bearer Token', click 'Generate' (or 'Regenerate')
7. Copy the Bearer Token and paste it to me, along with your X handle (without the @)

Note: Free tier gives read-only access with low limits. Basic tier ($200/mo)
gives search/recent endpoint and higher limits. Pro tier gets full archive search."

Set both `X_API_BEARER_TOKEN` and `X_HANDLE` in the environment. Validate immediately
(app-only bearer tokens cannot call `/users/me` — that endpoint requires
user-context OAuth — so validation uses the by-username lookup):
```bash
curl -sf -H "Authorization: Bearer $X_API_BEARER_TOKEN" \
  "https://api.x.com/2/users/by/username/$X_HANDLE" \
  && echo "PASS: X API connected" \
  || echo "FAIL: X API token invalid"
```

**If validation fails:** "That didn't work. Common issues: (1) make sure you copied
the Bearer Token, not the API Key or API Secret, (2) Bearer Tokens are long strings
starting with 'AAA...', (3) if you just created the app, the token is valid immediately."

**STOP until X API validates.**

#### Option B. Xquik

Tell the user:
"Create an API key at https://xquik.com/dashboard/api-keys and paste it here.
I also need your X handle without the @. This route reads public X data and does
not require an X developer account."

Set `XQUIK_API_KEY` and `X_HANDLE`. Validate them without printing the key:

```bash
curl -sf -H "x-api-key: $XQUIK_API_KEY" \
  -H "xquik-api-contract: 2026-04-29" \
  "https://xquik.com/api/v1/account" \
  && echo "PASS: Xquik connected" \
  || echo "FAIL: Xquik key invalid"
```

**STOP until Xquik validates.**

### Step 2. Resolve the collector identity

For Xquik, verify the handle, then keep it as the collector identity:

```bash
curl -sf -H "x-api-key: $XQUIK_API_KEY" \
  -H "xquik-api-contract: 2026-04-29" \
  "https://xquik.com/api/v1/x/users/$X_HANDLE"
```

For X API v2, resolve and save the numeric user ID:

```bash
# Look up the user's X user ID from their handle
curl -sf -H "Authorization: Bearer $X_API_BEARER_TOKEN" \
  "https://api.x.com/2/users/by/username/$X_HANDLE" | grep -o '"id":"[^"]*"'
```

The X API collector needs the numeric ID, not the handle.

### Step 3: Configure the Collector

Create the collector directory:
```bash
mkdir -p x-collector/data/{tweets/{own,mentions,searches},deletions,engagement}
cd x-collector
```

The collector script needs these capabilities:

1. **collect** — pull tweets from three streams:
   - X API own timeline: `GET /2/users/{id}/tweets?max_results=100`
   - X API mentions: `GET /2/users/{id}/mentions?max_results=100`
   - X API searches: `GET /2/tweets/search/recent?query={query}`
   - Xquik own timeline: `GET /api/v1/x/users/{id}/tweets?pageSize=100`
   - Xquik mentions: `GET /api/v1/x/users/{id}/mentions?pageSize=100`
   - Xquik searches: `GET /api/v1/x/tweets/search?q={query}&limit=100`
   Xquik accepts a username or user ID for `{id}`.
   Send `x-api-key` and `xquik-api-contract: 2026-04-29` on Xquik requests.
   Pass provider cursors unchanged on the next request.
2. **Deletion detection.** Compare previous run's tweet IDs vs current. Verify
   missing IDs through `/2/tweets/{id}` on X API or
   `/api/v1/x/tweets/{id}` on Xquik. A 404 confirms deletion.
3. **Engagement tracking** — snapshot metrics for tracked tweets. Only write if metrics changed.
4. **State management** — save pagination tokens, last run timestamp, rate limit state to `data/state.json`
5. **Atomic writes** — write to .tmp file, then rename (prevents corrupt data on crash)

Configure keyword searches based on what the user cares about:
```json
{
  "searches": [
    "\"your name\" -from:yourhandle",
    "\"your company\" OR \"your product\"",
    "topic you track"
  ]
}
```

### Step 4: Run First Collection

```bash
node x-collector.mjs collect
```

Verify: `ls data/tweets/own/` should contain tweet JSON files.
Show the user a sample: "Found N tweets from your timeline, M mentions, K search results."

### Step 5: Enrich Brain Pages

This is YOUR job (the agent). Read the collected tweets:

1. **Detect entities**: who tweeted? Who is mentioned? What companies/topics?
2. **Check the brain**: `gbrain search "person name"` — do we have a page?
3. **Update brain pages**: for each notable person or company mentioned:
   `- YYYY-MM-DD | Tweeted about {topic} [Source: X, @handle, {date}]`
4. **Track narratives**: if someone tweets about the same topic 3+ times in a week, note the pattern in their compiled truth
5. **Flag deletions**: if a tracked account deleted a tweet, note it:
   `- YYYY-MM-DD | Deleted tweet: "{content}" [Source: X deletion, detected {date}]`
6. **Sync**: `gbrain sync --no-pull --no-embed`

### Step 6: Set Up Cron

The collector should run every 30 minutes:
```bash
*/30 * * * * cd /path/to/x-collector && node x-collector.mjs collect >> /tmp/x-collector.log 2>&1
```

The agent should review collected data 2-3x daily and run enrichment.

### Step 7: Log Setup Completion

```bash
mkdir -p ~/.gbrain/integrations/x-to-brain
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.9.0","status":"ok","details":{"provider":"PROVIDER","identity":"X_ID_OR_HANDLE"}}' >> ~/.gbrain/integrations/x-to-brain/heartbeat.jsonl
```

## Production Patterns (v0.8.1)

These patterns come from a production deployment tracking 19+ accounts with
real-time monitoring.

### Image OCR (NEW)

**Problem:** Text-only collection misses visual context in tweet images --
screenshots, charts, memes with text overlay, quote screenshots.

**Fix:** Run OCR on tweet images via a vision model (Claude Sonnet or equivalent):
- For every tweet with images, extract full text content via vision API
- Store OCR output alongside the tweet data
- Include extracted text in entity detection and brain page updates
- Charts/data visualizations: extract data points, describe findings

This catches signal that text-only collectors miss entirely.

### Real-time monitoring through the X API filtered stream

**Problem:** 30-minute polling means you find out about things 30 minutes late.
For time-sensitive content (engagement spikes, deletions, breaking threads),
that's too slow.

**Fix:** Use Twitter's Filtered Stream API (`GET /2/tweets/search/stream`) for
near-real-time monitoring. Catches outbound tweets within seconds.

**Setup:**
1. Add filter rules: `POST /2/tweets/search/stream/rules` with your tracking terms
2. Open persistent connection: `GET /2/tweets/search/stream`
3. Process tweets as they arrive (no polling delay)

**Requirements:** Basic tier ($200/mo) minimum for Filtered Stream access.

**Use alongside polling:** Stream for real-time alerts, polling for completeness
(stream can drop tweets during disconnects).

Xquik collectors should keep the polling flow. Do not call the X filtered-stream
routes with an Xquik key.

### Tweet Rating Rubric (NEW)

**Problem:** Not all tweets deserve the same attention. Without scoring, every
tweet gets equal weight.

**Fix:** Rate tweets on a 6-dimension rubric:
1. **Reach** -- follower count, engagement rate
2. **Relevance** -- connection to your interests/work
3. **Sentiment** -- positive/negative/neutral toward you
4. **Novelty** -- new information vs rehash
5. **Actionability** -- does this require a response?
6. **Virality potential** -- engagement velocity, quote-tweet ratio

Re-rate after 60 minutes to track engagement trajectory. A tweet at 50 likes
that hits 500 in an hour is a different signal than one that stays at 50.

### Outbound Tweet Monitoring (NEW)

**Problem:** You tweet something and don't notice engagement patterns until
hours later.

**Fix:** 60-second monitoring window after every outbound tweet:
- Check engagement velocity (likes, replies, quotes)
- Flag unusual reply-to-like ratios (high reply ratios signal controversy)
- Flag if quote-tweet ratio > retweet ratio (commentary, not sharing)
- Cross-reference mentioned accounts against brain for context

### X-to-Brain Pipeline (NEW)

Every tweet interaction can automatically create/update brain pages:
- Mentioned person has a brain page? Append to their timeline
- New person mentioned? Check notability gate, create page if notable
- Article URL in tweet? Fetch and ingest via article workflow
- Video URL in tweet? Queue for transcription pipeline
- Images? OCR and extract text content

Follow `skills/_brain-filing-rules.md` for filing decisions.

### Cron Staggering (IMPORTANT)

**Problem:** Multiple cron jobs firing simultaneously causes resource contention
and timeouts.

**Fix:** Stagger all collection schedules so max 1 runs per minute:
```
# Good: staggered
*/30 * * * * x-collector       # :00, :30
5,35 * * * * x-bundle-ingest   # :05, :35
10 */3 * * * social-monitor     # :10 every 3h

# Bad: overlapping
*/30 * * * * x-collector
*/30 * * * * x-bundle-ingest   # fires at same time!
```

## Implementation Guide

These are production-tested patterns from a deployment tracking 19+ accounts.

### Deletion Detection Algorithm

```
detect_deletions(prevIds, currentIds):
  for id in prevIds:
    if id in currentIds: continue          // still exists

    stored = load_tweet(id)
    if not stored: continue                // never stored

    // HEURISTIC 1: Only check tweets < 7 days old
    age = now - stored.created_at
    if age > 7_DAYS: continue              // aged out of API window

    // HEURISTIC 2: Skip if last seen > 48h ago
    staleness = now - stored.last_updated
    if staleness > 48_HOURS: continue      // fell out of window, not deleted

    // HEURISTIC 3: Already logged?
    if deletion_file_exists(id): continue

    // VERIFY via direct API call
    res = GET /tweets/{id}
    if res.status == 404 OR (res.ok AND no data):
      save_deletion(id, original_tweet, detected_at)
      alert(f"DELETION: {author} deleted: {preview}")
```

**Why the heuristics matter:** Without #2 (48h staleness check), you get false
positives on old tweets that just aged out of the API search window. Without #1
(7-day cap), you'd investigate thousands of old tweets on every run.

### Engagement Velocity Tracking

```
track_engagement(id, metrics):
  snapshots = load_snapshots(id)
  last = snapshots[-1] if snapshots else null

  if last AND metrics_equal(last, metrics): return  // no change

  snapshots.append({timestamp: now, metrics})
  if len(snapshots) > 100: snapshots = snapshots[-100:]  // cap growth

  // Alert conditions (OR logic):
  if last:
    old_likes = last.like_count
    new_likes = metrics.like_count

    // Condition 1: 2x on established tweets (>= 50 likes)
    if old_likes >= 50 AND new_likes >= old_likes * 2:
      alert(f"VELOCITY: {id} likes {old_likes} -> {new_likes}")

    // Condition 2: Absolute jump > 100
    elif (new_likes - old_likes) > 100:
      alert(f"VELOCITY: {id} likes {old_likes} -> {new_likes}")
```

**Threshold design:** `50` minimum prevents noise from small tweets going 2→4.
The `100` absolute jump catches big spikes on tweets with any baseline.

### Atomic File Writes

```
atomic_write(path, obj):
  tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 2))
  renameSync(tmp, path)  // atomic on most filesystems
```

If the process dies mid-write, the `.tmp` file is left behind but the original
is untouched. Critical when you have thousands of per-tweet JSON files.

### Rate Limit Handling

```
rate_limits = {}  // per endpoint

after_each_request(endpoint, headers):
  rate_limits[endpoint] = {
    remaining: headers['x-rate-limit-remaining'],
    reset: headers['x-rate-limit-reset']
  }

is_rate_limited(endpoint, min_remaining=2):
  r = rate_limits[endpoint]
  return r AND r.remaining <= min_remaining
```

Reserve 2 requests per endpoint so other streams still work. If mentions
hits the limit, own timeline and searches can still run.

### Stdout Contract

The collector prints structured lines the cron agent can parse:
```
RUN_START:{timestamp}
OWN_TWEETS:{total} ({new} new)
MENTIONS:{total} ({new} new)
DELETION_DETECTED:{id}:{author}:{preview}
VELOCITY_ALERT:{id}:likes:{old}->{new}:{minutes}min
RUN_COMPLETE:{timestamp}:tweets_stored={N}:deletions={N}:velocity_alerts={N}
```

### What the Agent Should Test After Setup

1. **Deletion detection:** Post a tweet, collect, delete it, collect again.
   Verify deletion is detected on second run.
2. **Rate limit:** Run collect with very low remaining quota. Verify it stops
   gracefully and reports which streams were skipped.
3. **Engagement:** Find a tweet with 45 likes. Mock it jumping to 90 (no alert,
   < 50 threshold). Then 50→100 (alert: 2x). Then 30→150 (alert: >100 jump).
4. **Deduplication:** Collect, then like one of your own tweets, collect again.
   Verify `_collected_at` is preserved (not overwritten).
5. **Atomic writes:** Kill the process mid-collection. Verify no corrupted JSON.

## Cost Estimate

| Component | Cost basis |
|-----------|------------|
| X API | Check the current X developer pricing and access limits. |
| Xquik | Check current usage and credit terms before collection. |

Choose a provider whose current access and cost limits support all 3 streams.

## Troubleshooting

**Upgrading from recipe v0.8.2 or earlier (token shows [missing] after upgrade):**
- Older versions of this recipe named the token `X_BEARER_TOKEN`. The canonical
  name is `X_API_BEARER_TOKEN` — the name the built-in `x_handle_to_tweet`
  resolver reads. Rename the variable wherever you set it (shell profile, cron
  environment, `.env`) — same value, new name. A collector installed under the
  old name keeps running either way; the rename is what makes the integrations
  dashboard and the resolver see the token.

**X API returns 403.**
- Check your app has the right access level (Read or Read+Write)
- Free tier apps can only use basic endpoints
- Some endpoints require Basic or Pro tier

**Xquik returns 401 or 402.**
- Check `XQUIK_API_KEY` for 401 responses
- Check the account's available usage for 402 responses

**Rate limited (429):**
- The collector respects provider limits automatically
- If hitting limits frequently, increase the cron interval to 60 minutes
- Check `data/state.json` for rate limit tracking

**No tweets collected:**
- Verify the user ID is correct (numeric, not handle)
- Check the Bearer Token is valid (Step 1 validation)
- Some accounts may have protected tweets (requires OAuth 2.0 user context)
