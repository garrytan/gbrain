# Brain-First Lookup Convention

**Read this before doing ANY entity/person/company/fact lookup.**

Sub-agents and fresh sessions inherit gbrain tools but not the knowledge of
when and how to use them. This file is that knowledge.

## Available GBrain Tools

Your tool inventory includes these (prefixed `gbrain__` in OpenClaw):

| Tool | Use for |
|------|---------|
| `gbrain__search` / `search` | Exact tokens / known names — cheap hybrid, no expansion |
| `gbrain__query` / `query` | Concept / landscape questions — hybrid + LLM expansion |
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

Route by the SHAPE of the question, then escalate:

1. **Exact known token / name / structured field** → **`search`** — cheap
   hybrid (vector + keyword, no expansion; embedding-only cost).
2. **Concept / landscape / synonym-phrased question** ("all the X that do Y",
   "the landscape of Z") → **`query`** FIRST — multi-query expansion recovers
   phrasings `search` misses. Costs one extra LLM expansion call; worth it
   for these.
3. **`get_page`** if you found a slug — read the full compiled truth.
4. **External APIs only after steps 1-2 return nothing useful.**

**A nonzero `search` count is NOT a completeness signal.** For "did I capture
everything about X?" run `query` even if `search` already returned hits —
synonym- and outcome-phrased matches drop silently otherwise. And `query` is
still top-K: for literal "list every page that…" enumeration, use `list_pages`
with pagination.

Never skip to external APIs without completing steps 1-2. The brain has
thousands of pages. The answer is almost always there.

## Rules

- **Score > 0.5 = use it.** Don't reach for external APIs when the brain answered.
- **User's direct statements are highest-authority data.** The brain captures
  what the user said in meetings, conversations, and notes. External sources
  are supplementary.
- **After any brain page write:** trigger a sync so new pages are searchable.
  In OpenClaw: `gbrain__sync_brain`. From CLI: `gbrain sync --no-pull`.
- **Bank every notable external API pull** via `gbrain capture` into the inbox
  before the conversation moves on — the cycle enriches it later. A lookup you
  paid for and didn't bank is a lookup you'll pay for again.
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

## Declarative opt-out (v0.36.x)

A skill can declare it does not need brain-first by adding this line to its
frontmatter:

    brain_first: exempt

Use this for pure-infra skills (cron schedulers, container managers,
ask-user prompters, browser drivers) whose entire job is to operate without
consulting the brain. The doctor `skill_brain_first` check honors this opt-
out; the `gbrain doctor --fix` auto-add of the canonical Convention callout
skips opted-out skills.

**Strict canonical form (the parser is loud about typos):**

| Form | Result |
|---|---|
| `brain_first: exempt` | ✅ matches |
| `brain-first: exempt` | ⚠ doctor hint — snake_case required |
| `BrainFirst: exempt`  | ⚠ doctor hint — snake_case required |
| `brain_first: "exempt"` | ⚠ doctor hint — drop the quotes |
| `brain_first: Exempt` | ⚠ doctor hint — value must be lowercase |
| `brain_first: required` | ⚠ doctor hint — only `exempt` is supported in v0.36 |

A near-miss prints a paste-ready fix line and the skill stays flagged
until the canonical form lands. Silent typos would be the worst outcome
("I declared exempt and it still flags!"), so the parser refuses to guess.

**You do NOT need to declare `brain_first: exempt` when:**

- The skill ALREADY includes the canonical Convention callout above
  (this file's path). The compliance check matches `> **Convention:**`
  blockquotes referencing `brain-first.md` and short-circuits to OK.
  `brain-ops`, `signal-detector`, `idea-ingest`, `enrich`,
  `perplexity-research`, and `academic-verify` all pass via this path.
- The skill has no external-lookup references at all (`web_search`,
  `exa`, `perplexity`, `happenstance`, `crustdata`, `captain-api`,
  `firecrawl`). Trivially exempt.

When in doubt: declare `brain_first: exempt` explicitly OR add the
canonical Convention callout near the top of the skill body. Both are
zero-friction one-line operations.
