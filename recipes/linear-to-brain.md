---
id: linear-to-brain
name: Linear-to-Brain
version: 0.1.0
description: Linear issues, projects, and cycles become searchable brain pages. Offline semantic search across your entire task history.
category: sense
requires: []
secrets:
  - name: LINEAR_API_KEY
    description: Linear personal API key (read-only scope sufficient)
    where: https://linear.app/settings/api — "New API key", label it "gbrain"
health_checks:
  - type: http
    url: "https://api.linear.app/graphql"
    method: POST
    headers:
      Authorization: "$LINEAR_API_KEY"
      Content-Type: "application/json"
    body: '{"query":"{ viewer { id name } }"}'
    label: "Linear API"
setup_time: 15 min
cost_estimate: "$0 (Linear API is free)"
---

# Linear-to-Brain: Your Task History Becomes Searchable Memory

Every issue, project, and cycle in Linear becomes a brain page. Your agent can
answer "what did we decide about X?" or "which issues are blocking fundraising?"
without an active Linear session — the brain has the full history indexed and
vector-searchable.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Follow these steps precisely.

**Why this matters for offline search:** You already have Linear MCP for real-time
access in active Claude sessions. This recipe is the complement: it syncs Linear
content into the brain so `gbrain query` works without any MCP or network connection.
Historical issues, completed cycles, archived projects — all searchable offline.

**The core pattern: code for data, LLMs for judgment.**
The collector script pulls issues and projects deterministically via the Linear
GraphQL API. You (the agent) read the output and make judgment calls: entity
enrichment, relationship mapping, priority signals.

**Do not skip steps. Verify after each step.**

## Architecture

```
Linear (GraphQL API, Bearer token auth)
  ↓ Three collection streams:
  ├── Issues: GET /graphql (team + project + cycle filters)
  ├── Projects: GET /graphql (with milestones + members)
  └── Cycles: GET /graphql (with issue summaries)
  ↓
Linear Collector (deterministic Node.js script)
  ↓ Outputs:
  ├── brain/linear/issues/{YYYY-MM}/{issue-id}.md
  ├── brain/linear/projects/{slug}.md
  ├── brain/linear/cycles/{team}-{number}.md
  └── brain/linear/.raw/{id}.json  (raw API responses)
  ↓
Agent reads brain pages
  ↓ Judgment calls:
  ├── Entity enrichment (assignees → people pages)
  ├── Project cross-links (issues ↔ projects ↔ cycles)
  └── Priority signals (overdue, blocked, urgent labels)
```

## Opinionated Defaults

**Issue file format:**
```markdown
---
type: linear-issue
id: ENG-123
title: "Fix the thing"
state: In Progress
priority: 2
assignee: jane-doe
project: my-project
cycle: "Cycle 5"
labels: [urgent, customer-validation]
created: 2026-04-01
updated: 2026-04-15
url: https://linear.app/team/issue/ENG-123
---

# ENG-123: Fix the thing

**State:** In Progress | **Priority:** High | **Assignee:** Jane Doe

[View in Linear](https://linear.app/team/issue/ENG-123)

## Description

{issue description}

## Comments

- **Jane Doe** (2026-04-10): {comment text}

---

## Timeline

- **2026-04-15** | State changed: Todo → In Progress [Source: Linear API]
- **2026-04-01** | Created [Source: Linear API]
```

**Project file format** at `brain/linear/projects/{slug}.md`:
One file per project with issue count, status, members, and linked milestones.

**Output paths:**
- Issues: `brain/linear/issues/{YYYY-MM}/{id}.md` (month-partitioned for large teams)
- Projects: `brain/linear/projects/{slug}.md`
- Cycles: `brain/linear/cycles/{team-key}-{number}.md`
- Raw JSON: `brain/linear/.raw/{id}.json`

## Prerequisites

1. **GBrain installed and configured** (`gbrain doctor` passes)
2. **Node.js 18+**
3. **Linear API key** (read-only)

## Setup Flow

### Step 1: Get and Validate API Key

Tell the user:
"I need a Linear API key.
1. Go to https://linear.app/settings/api
2. Click **'New API key'**
3. Label it 'gbrain', any scope works (read-only is enough)
4. Copy the key and paste it to me"

Store the key:
```bash
# Add to ~/.gbrain/config.json under integrations (or use env var)
mkdir -p ~/.gbrain/integrations/linear-to-brain
echo "LINEAR_API_KEY=<key>" > ~/.gbrain/integrations/linear-to-brain/.env
chmod 600 ~/.gbrain/integrations/linear-to-brain/.env
```

Validate:
```bash
source ~/.gbrain/integrations/linear-to-brain/.env
curl -sf -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { id name } }"}' \
  | grep -q '"id"' && echo "PASS: Linear API reachable" || echo "FAIL: check API key"
```

**STOP until Linear API validates.**

### Step 2: Identify Teams and Scope

Ask the user: "Which Linear teams should I sync? For each team, how far back should
I go? (e.g., 'all teams, last 6 months' or 'just ENG + PRODUCT, all history')"

Also ask: "Should I sync completed/cancelled issues, or only active ones?"

Note the answers — pass as flags to the collector.

### Step 3: Set Up the Collector Script

```bash
mkdir -p linear-collector
cd linear-collector
npm init -y
npm install node-fetch dotenv
```

Create `linear-collector.mjs` with these capabilities:

1. **GraphQL pagination** — Linear's GraphQL API returns max 50 nodes per query.
   Paginate using `pageInfo.hasNextPage` + `endCursor`. Collect ALL issues in scope,
   not just the first page.

2. **Issue collection** — query by team, filter by `updatedAt` for incremental syncs:
   ```graphql
   query Issues($after: String, $updatedAfter: DateTime) {
     issues(first: 50, after: $after, filter: { updatedAt: { gte: $updatedAfter } }) {
       nodes { id identifier title state { name } priority assignee { name } ... }
       pageInfo { hasNextPage endCursor }
     }
   }
   ```

3. **Project collection** — pull all projects with members and milestones:
   ```graphql
   query Projects($after: String) {
     projects(first: 50, after: $after) {
       nodes { id name slugId status members { nodes { name } } ... }
       pageInfo { hasNextPage endCursor }
     }
   }
   ```

4. **Markdown generation** — render each issue/project as markdown following the
   opinionated format above. Include the Linear URL in every file.

5. **Incremental sync** — persist `state.json` with `lastSync` timestamp.
   On subsequent runs, only fetch issues updated after `lastSync`.

6. **Raw JSON preservation** — write `brain/linear/.raw/{id}.json` for provenance.

### Step 4: Run Historical Sync

```bash
source ~/.gbrain/integrations/linear-to-brain/.env
node linear-collector.mjs --all-history
```

Expected output: one `.md` file per issue, one per project, one per cycle.

Verify:
```bash
ls brain/linear/issues/ | head -10
ls brain/linear/projects/
```

### Step 5: Import to GBrain

```bash
gbrain import brain/linear/ --no-embed
gbrain embed --stale
```

Verify:
```bash
gbrain search "urgent" --limit 3
gbrain query "what is blocked right now?"
```

### Step 6: Assignee Enrichment

This is YOUR job (the agent). For each assignee appearing in Linear issues:

1. `gbrain search "assignee name"` — do they have a brain page?
2. If yes: add a back-link from their page to key issues they own
3. If no + they appear on 3+ issues: create a `people/{slug}.md` page

### Step 7: Set Up Daily Sync

Issues change frequently. Sync daily:

Create `~/.gbrain/linear-sync-run.sh`:
```bash
#!/bin/bash
source ~/.gbrain/integrations/linear-to-brain/.env
export PATH="$HOME/.bun/bin:$PATH"
cd ~/linear-collector
node linear-collector.mjs --incremental
gbrain sync --repo ~/IdeaProjects/knowledge-base && gbrain embed --stale
```

Add to the dream-cycle or as a separate launchd job (daily at 8 AM):
```xml
<!-- ~/Library/LaunchAgents/com.gbrain.linear-sync.plist -->
<!-- StartCalendarInterval: Hour=8, Minute=5 -->
```

### Step 8: Log Setup Completion

```bash
mkdir -p ~/.gbrain/integrations/linear-to-brain
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.1.0","status":"ok"}' \
  >> ~/.gbrain/integrations/linear-to-brain/heartbeat.jsonl
```

## Implementation Guide

### Priority Mapping

Linear priorities are numeric. Always map them in the markdown frontmatter:

```
0 = No priority
1 = Urgent
2 = High
3 = Medium
4 = Low
```

Include the human label (e.g., `priority: High`) not just the number, so
`gbrain search "urgent"` finds priority-1 issues.

### Incremental Sync Logic

```
sync(incremental):
  state = load_state()  // { lastSync: ISO timestamp }
  since = incremental ? state.lastSync : '2020-01-01T00:00:00Z'

  cursor = null
  while true:
    page = graphql(ISSUES_QUERY, { after: cursor, updatedAfter: since })
    for issue in page.nodes:
      write_issue_file(issue)
      write_raw_json(issue)
    if not page.pageInfo.hasNextPage: break
    cursor = page.pageInfo.endCursor

  state.lastSync = now()
  save_state(state)
```

### Slug Generation for Project Files

Linear project `slugId` is already URL-safe. Use it directly:
`projects/bpi-vol-1.md` from `slugId: bpi-vol-1`. No need to sanitize.

### What to Test After Setup

1. **Pagination:** Run against a team with 100+ issues. Verify all appear in output.
2. **Incremental:** Edit an issue in Linear. Run with `--incremental`. Verify only
   that issue is re-fetched (check API call count in state.json).
3. **Priority labels:** Create issues at each priority. Verify all four labels appear
   in frontmatter.
4. **Semantic search:** `gbrain query "blocked issues"` should return issues with
   "blocked" label or "Blocked" state.

## Cost Estimate

| Component | Monthly Cost |
|-----------|-------------|
| Linear API | $0 (free, no rate-limit concerns for personal use) |
| OpenAI (embeddings on new issues) | ~$0.01/100 issues |
| **Total** | **~$0** |

## Troubleshooting

**401 Unauthorized:**
- API key may be expired or revoked — regenerate at linear.app/settings/api

**Empty results:**
- Check team key is correct (`viewer { teams { nodes { key } } }`)
- Check `updatedAfter` filter isn't excluding everything

**Issues missing from search:**
- Run `gbrain embed --stale` — new files may not yet be embedded
