---
name: perplexity-research
version: 0.1.0
description: Brain-augmented web research. Asks Perplexity about a topic, with a short summary of what the brain already knows, and returns what is NEW with citations. Sends page content only after the user agrees. Use for current-state checks and freshness deltas on topics. NOT for simple URL fetches (use web_fetch) or brain-only queries (use gbrain query).
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
> for the lookup chain. This skill reads the brain first and tells
> Perplexity what is already known, so the web search focuses on the delta
> between brain knowledge and current web state.

## What this does

Combines existing brain knowledge with Perplexity's web search. The
agent reads the brain on a topic, then asks Perplexity what's NEW relative
to a short summary of what the brain already knows; Perplexity searches,
reads and synthesizes multiple pages with citations.

**What leaves the machine.** Everything in the query goes to Perplexity. By
default send only the topic and a few lines of public facts the brain
already holds (names of public companies, dates, published events). Before
sending page content, private notes, or anything about a private person,
tell the user what would be sent and wait for their agreement.

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

# 2. Compose the Perplexity query (topic plus a short public summary;
#    page content only after the user agreed to send it):
#    """
#    Topic: <topic>
#    Already known: <a few lines of public facts>
#    Find: what's NEW since 2026-MM-DD.
#    Cite every claim.
#    """

# 3. Call Perplexity's Agent API (or the host's perplexity binary). The
#    Sonar chat-completions endpoint (/chat/completions with
#    "model": "sonar-pro") is being retired and refuses migrated accounts
#    with 403 agent_api_migration_required; use POST /v1/agent:
#    The key goes in on stdin so it stays out of the process list:
#    printf 'Authorization: Bearer %s\n' "$PERPLEXITY_API_KEY" | \
#    curl https://api.perplexity.ai/v1/agent -H @- \
#      -H "Content-Type: application/json" \
#      -d '{"preset": "low", "instructions": "Cite every claim.", "input": "..."}'
#    Read the answer from the output item with "type": "message" (SDKs
#    expose it as output_text) and the citations from the search results
#    in the output array; inline [n] markers refer to them.

# 4. Write the structured research page via put_page:
gbrain put research/<slug>      # via the put_page operation; if refused with slug_in_other_source, retry with the --source-id it names

# 5. Cross-link entities mentioned (people, companies) per Iron Law.
```

## Presets

| Agent API preset | Replaces | Use when |
|-------|-------------|----------|
| `"preset": "low"` | Sonar Pro | Deep analysis (multi-step search) |
| `"preset": "fast"` | Sonar | Quick lookups, bulk monitoring, briefing pipelines |

Default to `low`. Drop to `fast` for bulk contexts where cost
matters more than depth. Perplexity does not publish a fixed per-request
price for presets; check its pricing page before running bulk jobs.

## Integration patterns

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

- ❌ Skipping the brain read. Without it the result can't say what's new
  — use `web_fetch` instead.
- ❌ Sending page content, private notes or details about a private person
  without the user's agreement.
- ❌ Discarding citations. Every claim in the output must have a URL.
- ❌ Skipping the cross-link step when entities are mentioned. Iron Law.

## Environment

- `PERPLEXITY_API_KEY` set in the agent's environment (or in
  `~/.gbrain/.env`).
- Optional: install Perplexity's official CLI for richer streaming output.

## Related skills

- `skills/academic-verify/SKILL.md` — wraps perplexity-research for
  citation-verified academic claim checking
- `skills/data-research/SKILL.md` — structured-data trackers (different
  shape: parameterized YAML recipes, not free-form research)


## Contract

This skill guarantees:

- Routing matches the canonical triggers in the frontmatter.
- Output written under the directories listed in `writes_to:` (when applicable).
- Conventions referenced (`quality.md`, `brain-first.md`, `_brain-filing-rules.md`) are followed.
- Examples use placeholder names and paths.

The full behavior contract is documented in the body sections above.

## Output Format

The skill's output shape is documented inline in the body sections above (see "Output", "Brain page format", or equivalent).
