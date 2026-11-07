---
name: perplexity-research
version: 0.1.0
description: Brain-augmented web research. Sends brain context about a topic to Perplexity, which searches the web with citations and returns what is NEW vs what the brain already knows. Use for entity enrichment, current-state checks, deal monitoring, and freshness deltas. NOT for simple URL fetches (use web_fetch) or brain-only queries (use gbrain query).
triggers:
  - "perplexity research"
  - "perplexity-research"
  - "what's new about"
  - "current state of"
  - "web research"
  - "what changed about"
  - "surface new developments"
mutating: true
writes_pages: true
writes_to:
  - research/
when_to_use: "Use when the user asks: \"perplexity research\", \"perplexity-research\", \"what's new about\", \"current state of\", \"web research\"."
---

# perplexity-research — Brain-Augmented Web Research

> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> citation rules; every claim from web research lands with a verifiable
> citation, not a paraphrase.
>
> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md)
> for the lookup chain. This skill ENFORCES brain-first by sending brain
> context as part of the Perplexity prompt — the web search focuses on
> the delta between brain knowledge and current web state.

## What this does

Combines existing brain knowledge with Perplexity's web search. The
agent sends brain context about a topic into a Perplexity query;
Perplexity searches + reads + synthesizes multiple pages with citations,
focused on what's NEW relative to the supplied context.

**The key insight:** Perplexity doesn't just search — it reads and
synthesizes with citations. By sending brain context in the
instructions, it knows what you already know, so it surfaces the delta
instead of repeating settled fact.

## When to use this vs other tools

| Need | Use |
|------|-----|
| Deep research with citations | **This skill** — Perplexity + Opus |
| Quick URL content | `web_fetch` |
| Brain-only lookup | `gbrain query` / `gbrain search` |
| Real-time social monitoring | external X / social-media collectors |
| Structured data lookup against a tracker | `skills/data-research/SKILL.md` |

## Output structure

The research output lands as a brain page under `research/<slug>.md` with
this structure:

```markdown
---
title: "[Topic] — Research [YYYY-MM-DD]"
type: research
date: YYYY-MM-DD
brain_context_slugs: ["pages whose context was sent to Perplexity"]
recency_filter: "[hour|day|week|month|none]"
---

# [Topic] — Research [YYYY-MM-DD]

> Executive summary: 2-3 sentences on the delta between brain knowledge
> and current web state.

## Key New Developments
What's changed since the brain was last updated on this topic.

## Confirming Signals
Web evidence validating existing brain knowledge.

## Contradictions or Updates
Things that conflict with the brain — these need a closer look.

## Recommended Brain Updates
Specific page updates the user might want to make based on this research.
Each item: which page, what to add or change, source URL.

## Citations
- [Source title](URL) — accessed YYYY-MM-DD
- [Source title](URL) — accessed YYYY-MM-DD
- ...
```

## Invocation

The skill is markdown agent instructions; the agent uses Perplexity's
API directly (or a host-provided `perplexity` CLI if installed):

```bash
# 1. Pull brain context
gbrain get <slug>                    # or
gbrain query "<topic keywords>"

# 2. Compose the Perplexity query with brain context inline:
#    """
#    Topic: <topic>
#    Brain context (what we already know): <embedded gbrain content>
#    Find: what's NEW since 2026-MM-DD that the brain doesn't reflect.
#    Cite every claim.
#    """

# 3. Call Perplexity's Agent API (or the host's perplexity binary). The
#    Sonar chat-completions endpoint (/chat/completions with
#    "model": "sonar-pro") is being retired and refuses migrated accounts
#    with 403 agent_api_migration_required; use POST /v1/agent:
#    curl https://api.perplexity.ai/v1/agent \
#      -H "Authorization: Bearer $PERPLEXITY_API_KEY" \
#      -H "Content-Type: application/json" \
#      -d '{"preset": "low", "instructions": "Cite every claim.", "input": "..."}'
#    Read the answer from the output item with "type": "message" (SDKs
#    expose it as output_text) and the citations from the search results
#    in the output array; inline [n] markers refer to them.

# 4. Write the structured research page via put_page:
gbrain put research/<slug>      # via the put_page operation

# 5. Cross-link entities mentioned (people, companies) per Iron Law.
```

## Presets

| Agent API preset | Replaces | Use when |
|-------|-------------|----------|
| `"preset": "low"` | Sonar Pro | Deep analysis, entity enrichment, deal research (multi-step search) |
| `"preset": "fast"` | Sonar | Quick lookups, bulk monitoring, briefing pipelines |

Default to `low`. Drop to `fast` for bulk / cron contexts where cost
matters more than depth. Perplexity does not publish a fixed per-request
price for presets; check its pricing page before running bulk jobs.

## Integration patterns

### Entity enrichment

Called by `skills/enrich/SKILL.md` when an entity page (person, company)
needs current web context:

```bash
BRAIN=$(gbrain get people/<slug> 2>/dev/null)
# Send <slug>'s page content as brain_context to Perplexity, get current
# news / role / context, then update the brain page with what's new.
```

### Deal / company monitoring (cron)

For each active item under `deals/` or `companies/`:

```bash
# Weekly: pull recent news per company; flag changes for review.
```

### Morning briefing

Replace raw `web_fetch` calls in briefing pipelines with this skill so
the agent doesn't re-narrate already-known facts.

## Recency filter

Pass the recency filter on the web search tool:
`"tools": [{"type": "web_search", "filters": {"search_recency_filter": "week"}}]`
with `hour | day | week | month | year`. Useful for news-cycle topics; omit
for evergreen research. Record the value as `recency_filter` in the page
frontmatter.

## When it fails

Follow the [agent operator protocol](../conventions/agent-operator-protocol.md) for any gbrain error `code`, exit code, `[AGENT]` block or notice block. Specific to this skill:

- `PERPLEXITY_API_KEY` missing or rejected: tell the user the web arm cannot run; answer from the brain only and say so.
- `rate_limited`: retry after the stated delay; for bulk work drop to the cheaper model rather than looping.
- The brain-context search is empty with a degraded notice: the "what's new vs what the brain knows" diff is unreliable; say the brain side was keyword-only.

## Anti-Patterns

- ❌ Sending NO brain context. Then it's just a search — use `web_fetch`
  instead.
- ❌ Truncating the brain context. The whole point is "knows what you
  know." Send dense context.
- ❌ Discarding citations. Every claim in the output must have a URL.
- ❌ Skipping the cross-link step when entities are mentioned. Iron Law.

## Environment

- `PERPLEXITY_API_KEY` set in the agent's environment (or in
  `~/.gbrain/.env`).
- Optional: install Perplexity's official CLI for richer streaming output.

## Related skills

- `skills/academic-verify/SKILL.md` — wraps perplexity-research for
  citation-verified academic claim checking
- `skills/enrich/SKILL.md` — calls perplexity-research as part of the
  entity-enrichment loop
- `skills/data-research/SKILL.md` — structured-data trackers (different
  shape: parameterized YAML recipes, not free-form research)


## Contract

This skill guarantees:

- Routing matches the canonical triggers in the frontmatter.
- Output written under the directories listed in `writes_to:` (when applicable).
- Conventions referenced (`quality.md`, `brain-first.md`, `_brain-filing-rules.md`) are followed.
- Privacy contract preserved: no real names, no fork-specific filesystem path literals, no upstream-fork references.

The full behavior contract is documented in the body sections above; this section exists for the conformance test.

## Output Format

The skill's output shape is documented inline in the body sections above (see "Output", "Brain page format", or equivalent). The literal section header here exists for the conformance test (`test/skills-conformance.test.ts`).
