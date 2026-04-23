---
id: notion-to-brain
name: Notion-to-Brain
version: 0.1.0
description: Notion pages and databases sync into brain pages for offline semantic search. Complements the one-shot migrate skill with live ongoing sync.
category: sense
requires: []
secrets:
  - name: NOTION_API_KEY
    description: Notion internal integration token
    where: https://www.notion.so/my-integrations — "New integration", copy the "Internal Integration Token" (secret_...)
health_checks:
  - type: http
    url: "https://api.notion.com/v1/users/me"
    headers:
      Authorization: "Bearer $NOTION_API_KEY"
      Notion-Version: "2022-06-28"
    label: "Notion API"
setup_time: 20 min
cost_estimate: "$0 (Notion API is free)"
---

# Notion-to-Brain: Live Sync for Offline Semantic Search

Notion pages and database entries become searchable brain pages. Unlike the
one-shot `migrate` skill (which imports a Notion export), this recipe syncs
continuously — new pages appear in the brain automatically, and `gbrain query`
answers questions about your Notion content without an active Notion session or
network connection.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Follow these steps precisely.

**How this differs from the migrate skill:** `skills/migrate/SKILL.md` is a
one-time historical import from a Notion export ZIP. This recipe is a live sync
using the Notion API — it runs on a schedule, picks up new pages and edits, and
keeps the brain current. Use migrate for the initial bulk import of old content;
use this recipe for ongoing sync.

**Sharing is required.** The Notion API only returns pages that have been
explicitly shared with the integration. After creating the integration, the user
must share each top-level page or database they want synced. This is Notion's
security model — there is no way around it.

**The core pattern: code for data, LLMs for judgment.**
The collector script fetches pages and block children deterministically. You (the
agent) read the rendered markdown and make judgment calls: entity enrichment,
cross-links to people/company pages, relationship signals.

**Do not skip steps. Verify after each step.**

## Architecture

```
Notion (REST API, Bearer token + Notion-Version header)
  ↓ Three collection streams:
  ├── Search: POST /v1/search (all shared pages + databases)
  ├── Page content: GET /v1/blocks/{id}/children (recursive)
  └── Database rows: POST /v1/databases/{id}/query (paginated)
  ↓
Notion Collector (deterministic Node.js script)
  ↓ Outputs:
  ├── brain/notion/pages/{slug}.md     (standalone pages)
  ├── brain/notion/db/{db-name}/{slug}.md  (database rows)
  └── brain/notion/.raw/{id}.json      (raw API blocks)
  ↓
Agent reads brain pages
  ↓ Judgment calls:
  ├── Entity enrichment (people/companies mentioned)
  ├── Cross-links to existing brain pages
  └── Action item extraction from task databases
```

## Opinionated Defaults

**Page file format:**
```markdown
---
type: notion-page
notion_id: "abc123..."
title: "My Page Title"
last_edited: 2026-04-15T10:00:00Z
url: https://notion.so/abc123
parent_type: workspace | page | database
tags: []
---

# My Page Title

[View in Notion](https://notion.so/abc123)

{rendered markdown content}

---

## Timeline

- **2026-04-15** | Synced from Notion [Source: Notion API, 2026-04-15]
```

**Database row format** at `brain/notion/db/{database-name}/{row-title-slug}.md`:
Frontmatter includes all database properties as typed fields. Body is the row's
page content (if any) plus a properties table.

**Output paths:**
- Standalone pages: `brain/notion/pages/{title-slug}.md`
- Database rows: `brain/notion/db/{db-slug}/{row-slug}.md`
- Raw blocks: `brain/notion/.raw/{page-id}.json`

## Prerequisites

1. **GBrain installed and configured** (`gbrain doctor` passes)
2. **Node.js 18+**
3. **Notion internal integration token**
4. **Pages shared with the integration** (must be done in Notion UI)

## Setup Flow

### Step 1: Create Integration and Share Pages

Tell the user:
"I need a Notion integration token and you'll need to share your pages with it.

**Create the integration:**
1. Go to https://www.notion.so/my-integrations
2. Click **'+ New integration'**
3. Name it 'GBrain', select your workspace
4. Capabilities: check **Read content**, uncheck everything else (read-only is enough)
5. Click **'Save'** — copy the **'Internal Integration Token'** (`secret_...`)

**Share pages with the integration** (REQUIRED — Notion won't return unshared pages):
For each top-level page or database you want synced:
1. Open the page in Notion
2. Click **'...'** (top right) → **'Connections'** → find 'GBrain' → click **'Connect'**
3. Repeat for each page/database you want in the brain

Paste the token to me."

Store the key:
```bash
mkdir -p ~/.gbrain/integrations/notion-to-brain
echo "NOTION_API_KEY=<token>" > ~/.gbrain/integrations/notion-to-brain/.env
chmod 600 ~/.gbrain/integrations/notion-to-brain/.env
```

Validate:
```bash
source ~/.gbrain/integrations/notion-to-brain/.env
curl -sf -H "Authorization: Bearer $NOTION_API_KEY" \
     -H "Notion-Version: 2022-06-28" \
     https://api.notion.com/v1/users/me \
  | grep -q '"type"' && echo "PASS: Notion API reachable" || echo "FAIL: check token"
```

**STOP until Notion API validates.**

### Step 2: Discover Shared Pages

Ask the user: "Which Notion workspaces/pages do you want synced? I'll search for
all pages shared with the integration so you can confirm the scope."

Run discovery:
```bash
source ~/.gbrain/integrations/notion-to-brain/.env
curl -sf -X POST https://api.notion.com/v1/search \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"filter":{"value":"page","property":"object"},"page_size":10}' \
  | python3 -c "import sys,json; [print(p['properties'].get('title',{}).get('title',[{}])[0].get('plain_text','?')) for p in json.load(sys.stdin).get('results',[])]"
```

Show the user the discovered pages. Confirm they want all of them (or filter by title prefix).

### Step 3: Set Up the Collector Script

```bash
mkdir -p notion-collector
cd notion-collector
npm init -y
npm install node-fetch dotenv
```

Create `notion-collector.mjs` with these capabilities:

1. **Search-based discovery** — use `POST /v1/search` to find all shared pages
   and database entries. Paginate using `has_more` + `start_cursor`. This is the
   entry point — never hardcode page IDs.

2. **Block rendering** — fetch `GET /v1/blocks/{id}/children` recursively for
   each page. Render Notion blocks to markdown:
   ```
   paragraph → plain text
   heading_1/2/3 → #/##/###
   bulleted_list_item → - item
   numbered_list_item → 1. item
   to_do → - [ ] / - [x]
   code → ```lang\ncode\n```
   quote → > text
   divider → ---
   child_page → link to brain page
   ```

3. **Database query** — for database pages, fetch properties and render as
   frontmatter. Use `POST /v1/databases/{id}/query` with `filter` and `sorts`.

4. **Incremental sync** — persist `state.json` with `lastSync` timestamp. Use
   Notion's `last_edited_time` filter to only fetch pages changed since last sync.

5. **Slug generation** — derive file slugs from page titles: lowercase, replace
   spaces with hyphens, strip special chars. Append first 8 chars of Notion ID
   to guarantee uniqueness: `my-page-abc12345.md`.

6. **Raw preservation** — write raw block JSON to `.raw/{page-id}.json`.

### Step 4: Run Initial Sync

```bash
source ~/.gbrain/integrations/notion-to-brain/.env
node notion-collector.mjs --all
```

Verify:
```bash
ls brain/notion/pages/ | head -10
ls brain/notion/db/ 2>/dev/null | head -5
```

### Step 5: Import to GBrain

```bash
gbrain import brain/notion/ --no-embed
gbrain embed --stale
gbrain query "what are my notes on fundraising?"
```

### Step 6: Entity Enrichment

This is YOUR job (the agent). For each person or company mentioned across Notion pages:

1. `gbrain search "person name"` — do they have a brain page?
2. If yes: add a back-link from their page to the Notion page mentioning them
3. If no + mentioned 3+ times: create a stub `people/{slug}.md`

### Step 7: Set Up Daily Sync

```bash
# Add to ~/.gbrain/dream-cycle.sh or create a dedicated launchd job
source ~/.gbrain/integrations/notion-to-brain/.env
node ~/notion-collector/notion-collector.mjs --incremental
gbrain sync --repo ~/IdeaProjects/knowledge-base && gbrain embed --stale
```

### Step 8: Log Setup Completion

```bash
mkdir -p ~/.gbrain/integrations/notion-to-brain
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.1.0","status":"ok"}' \
  >> ~/.gbrain/integrations/notion-to-brain/heartbeat.jsonl
```

## Implementation Guide

### Block-to-Markdown Rendering

Notion's block model is nested. Handle recursion:

```
render_block(block, depth=0):
  indent = "  " * depth
  type = block.type
  content = block[type]

  if type == "paragraph":
    return render_rich_text(content.rich_text)
  elif type in ["heading_1","heading_2","heading_3"]:
    level = int(type[-1])
    return "#" * level + " " + render_rich_text(content.rich_text)
  elif type == "bulleted_list_item":
    return indent + "- " + render_rich_text(content.rich_text)
  elif type == "to_do":
    check = "[x]" if content.checked else "[ ]"
    return indent + "- " + check + " " + render_rich_text(content.rich_text)
  elif type == "code":
    lang = content.language or ""
    return f"```{lang}\n{render_rich_text(content.rich_text)}\n```"
  elif type == "child_page":
    return f"[{content.title}](../pages/{slugify(content.title)}.md)"
  elif type == "divider":
    return "---"
  else:
    return ""  // unsupported block type — skip silently
```

Handle `has_children: true` by fetching children recursively, up to depth 3.
Beyond depth 3, emit a "... (truncated, see Notion)" note with the URL.

### Property Rendering for Database Rows

```
render_property(name, prop):
  type = prop.type
  if type == "title":   return render_rich_text(prop.title)
  if type == "rich_text": return render_rich_text(prop.rich_text)
  if type == "select":  return prop.select?.name or ""
  if type == "multi_select": return ", ".join(o.name for o in prop.multi_select)
  if type == "date":    return prop.date?.start or ""
  if type == "checkbox": return "true" if prop.checkbox else "false"
  if type == "number":  return str(prop.number or "")
  if type == "url":     return prop.url or ""
  if type == "email":   return prop.email or ""
  if type == "people":  return ", ".join(p.name for p in prop.people)
  if type == "relation": return f"[{len(prop.relation)} linked]"
  return ""  // formula, rollup, etc. — skip
```

### Incremental Sync Using last_edited_time

```
sync(incremental):
  state = load_state()
  since = state.lastSync if incremental else "2020-01-01T00:00:00.000Z"

  cursor = None
  while True:
    resp = post("/v1/search", {
      "filter": {"value": "page", "property": "object"},
      "sort": {"direction": "descending", "timestamp": "last_edited_time"},
      "start_cursor": cursor,
      "page_size": 100
    })
    for page in resp.results:
      if page.last_edited_time < since: break  // sorted descending, safe to stop
      sync_page(page)
    if not resp.has_more: break
    cursor = resp.next_cursor

  state.lastSync = now()
  save_state(state)
```

### What to Test After Setup

1. **Shared pages only:** Create a page NOT shared with the integration. Run sync.
   Verify it does not appear in output.
2. **Incremental:** Edit a shared page. Run with `--incremental`. Verify only that
   page is re-fetched.
3. **Nested blocks:** Create a page with a nested bulleted list (3 levels). Verify
   markdown output preserves indentation.
4. **Database rows:** Create a database with a title + select + date property. Verify
   all three appear in frontmatter.
5. **Semantic search:** `gbrain query "meeting notes from last week"` should return
   relevant Notion pages (if any exist).

## Cost Estimate

| Component | Monthly Cost |
|-----------|-------------|
| Notion API | $0 (free, generous rate limits) |
| OpenAI (embeddings on new pages) | ~$0.01/100 pages |
| **Total** | **~$0** |

## Troubleshooting

**Empty results from /v1/search:**
- Pages are not shared with the integration — go to Notion, open each top-level
  page, click '...' → Connections → connect 'GBrain'

**403 on block fetch:**
- The integration may have been shared with a child page but not its parent —
  share the top-level parent to grant access to the whole tree

**Garbled content:**
- Rich text in Notion can have annotations (bold, italic, code). `render_rich_text`
  must handle the `annotations` object. Bold: `**text**`, italic: `_text_`, code: `` `text` ``

**Rate limits (429):**
- Notion allows 3 requests/second. Add 350ms delay between requests in the
  collector loop.
