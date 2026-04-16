---
id: slack-to-brain
name: Slack-to-Brain
version: 0.10.1
description: Slack channels, threads, and shared links sync into searchable brain pages.
category: sense
requires: [credential-gateway]
secrets:
  - name: CLAWVISOR_URL
    description: ClawVisor gateway URL (preferred auth path)
    where: https://clawvisor.com — create an agent and activate the Slack service
  - name: CLAWVISOR_AGENT_TOKEN
    description: ClawVisor agent token (preferred auth path)
    where: https://clawvisor.com — agent settings, copy the token
  - name: SLACK_BOT_TOKEN
    description: Direct Slack bot token fallback for the collector runtime
    where: https://api.slack.com/apps — create an app, install to workspace, copy the bot token
health_checks:
  - type: any_of
    label: "Slack auth"
    checks:
      - type: http
        url: "$CLAWVISOR_URL/health"
        label: "ClawVisor"
      - type: env_exists
        name: SLACK_BOT_TOKEN
        label: "Slack bot token"
setup_time: 20 min
cost_estimate: "$0 (internal workspace app)"
---

# Slack-to-Brain: Workspace Threads That Update Your Brain

Slack contains the decisions, follow-ups, and links that never make it into formal
docs. This collector turns those channel histories into deterministic markdown pages
the brain can search and cross-link.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Follow the collector pattern:

1. **Deterministic layer:** `scripts/slack-sync.mjs` fetches channels, messages, threads,
   links, and state. It writes markdown pages with Slack links already baked in.
2. **Latent layer:** YOU read the synced pages, classify importance, propagate to
   people/company pages, and extract follow-up context into the rest of the brain.

Do not ask the LLM to paginate Slack, generate thread links, or remember cursors.
That work belongs in code.

## Architecture

```
Slack workspace
  ↓
scripts/slack-sync.mjs
  ├── auth.test / users.list / conversations.list
  ├── conversations.history
  ├── conversations.replies
  └── ~/.gbrain/integrations/slack-to-brain/state.json
  ↓
brain/sources/slack/<workspace>/<channel>/*.md
  ├── thread pages
  └── channel/day digests
  ↓
Agent reads synced pages
  ├── updates people pages
  ├── updates company/project pages
  ├── carries forward action items
  └── runs gbrain sync
```

## Auth

Preferred path: use `credential-gateway` and let the gateway inject Slack access
into the collector runtime. If you do not have that route configured yet, the
collector also accepts a direct `SLACK_BOT_TOKEN`.

Required Slack scopes:
- `channels:read`
- `groups:read`
- `channels:history`
- `groups:history`
- `users:read`

## First Run

1. Validate auth:

```bash
node -e 'fetch("https://slack.com/api/auth.test",{method:"POST",headers:{Authorization:`Bearer ${process.env.SLACK_BOT_TOKEN}`}}).then(r=>r.json()).then(console.log)'
```

2. List candidate channels:

```bash
node scripts/slack-sync.mjs --list-channels
```

3. Run a backfill:

```bash
node scripts/slack-sync.mjs --days 14
```

4. Narrow to high-signal channels if needed:

```bash
node scripts/slack-sync.mjs --channel eng --channel client-acme
```

5. After pages are written, run:

```bash
gbrain sync --no-pull --no-embed
```

## Output Rules

- Threads with replies, links, decisions, or action items become dedicated pages.
- Important standalone messages roll into daily digest pages per channel.
- Slack user mentions are rendered as links to `people/<slug>.md`.
- State lives in `~/.gbrain/integrations/slack-to-brain/state.json`.
- Runs append heartbeat events to `~/.gbrain/integrations/slack-to-brain/heartbeat.jsonl`.

## Backfill and Incremental Modes

- `--days N` backfills a rolling window.
- `--since YYYY-MM-DD` backfills from a fixed date.
- No backfill flag = incremental sync from stored timestamps with a thread lookback
  window so active threads get re-resolved.

## Cron

Run every 30 minutes:

```bash
*/30 * * * * cd /path/to/repo && node scripts/slack-sync.mjs >> /tmp/slack-sync.log 2>&1
```

## Completion Log

```bash
mkdir -p ~/.gbrain/integrations/slack-to-brain
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.10.1","status":"ok"}' >> ~/.gbrain/integrations/slack-to-brain/heartbeat.jsonl
```
