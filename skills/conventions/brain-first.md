# Brain-First Lookup Convention

**Read this before doing ANY entity/person/company/fact lookup.**

Sub-agents and fresh sessions inherit gbrain tools but not the knowledge of
when and how to use them. This file is that knowledge.

## Available GBrain Tools

Your tool inventory includes these (prefixed `gbrain__` in OpenClaw):

| Tool | Use for |
|------|---------|
| `gbrain__search` / `search` | Keyword search — fast, always works |
| `gbrain__query` / `query` | Hybrid search (keyword + semantic) — best quality |
| `gbrain__get_page` / `get_page` | Direct page read when you know the slug |
| `gbrain__get_links` / `get_links` | Outgoing links from a page |
| `gbrain__get_backlinks` / `get_backlinks` | Who references this entity |
| `gbrain__get_timeline` / `get_timeline` | Dated events for an entity |
| `gbrain__resolve_slugs` / `resolve_slugs` | Fuzzy slug resolution |
| `gbrain__traverse_graph` / `traverse_graph` | Walk the relationship graph |
| `gbrain__put_page` / `put_page` | Create or update a brain page |
| `gbrain__add_timeline_entry` | Add a dated event |
| `gbrain__add_link` | Add a relationship edge |

Tool names vary by transport (MCP uses short names, OpenClaw plugin uses
`gbrain__` prefix). Both work. Use whichever your environment provides.

## The Lookup Chain (MANDATORY ORDER)

1. **`search`** first — keyword search, fast, zero API cost
2. **`query`** if search is thin — hybrid semantic search, uses embedding API
3. **`get_page`** if you found a slug — read the full compiled truth
4. **External APIs only after steps 1-2 return nothing useful**

Never skip to external APIs without completing steps 1-2. The brain has
thousands of pages. The answer is almost always there.

## Rules

- **Score > 0.5 = use it.** Don't reach for external APIs when the brain answered.
- **User's direct statements are highest-authority data.** The brain captures
  what the user said in meetings, conversations, and notes. External sources
  are supplementary.
- **After any brain page write:** trigger a sync so new pages are searchable.
  In OpenClaw: `gbrain__sync_brain`. From CLI: `gbrain sync --no-pull`.
- **Every brain page reference in output** should use a clickable link format
  appropriate to the deployment (GitHub URL, local path, or slug).
- **Never use `memory_search` for entity lookups.** Memory tools search
  session notes (MEMORY.md), not the brain knowledge graph. Use
  `search` or `query` for entity lookups.

## Entity Page Conventions

Standard directory structure:

| Directory | Type | Example |
|-----------|------|---------|
| `people/` | person | `people/paul-graham.md` |
| `companies/` | company | `companies/stripe.md` |
| `deals/` | deal | `deals/stripe-series-c.md` |
| `meetings/` | meeting | `meetings/2026-04-23-weekly-sync.md` |
| `projects/` | project | `projects/gbrain.md` |
| `yc/` | yc | `yc/batch-w26.md` |

When creating new pages, include proper frontmatter with `type`, `title`,
and `tags` fields.

## When Spawning Further Sub-agents

If you spawn your own sub-agents, include this line in their task prompt:

> Read `skills/conventions/brain-first.md` before starting work.

This ensures the convention propagates through any depth of sub-agent chain.
