---
name: perplexity-research
version: 0.2.0
description: Optional brain-augmented web research through the Perplexity Agent API. Use when Perplexity is explicitly selected; general research uses web-research.
triggers:
  - "perplexity research"
  - "perplexity-research"
mutating: true
writes_pages: true
writes_to:
  - research/
---

# perplexity-research — Optional Web Research

> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> citation rules; every claim from web research lands with a verifiable
> citation, not a paraphrase.
>
> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md)
> for the lookup chain. This skill ENFORCES brain-first by sending brain
> context as part of the Perplexity prompt — the web search focuses on
> the delta between brain knowledge and current web state.

Use this skill only when the user or their workflow explicitly selects
Perplexity. For a general research request from an existing caller, use
[web-research](../web-research/SKILL.md) instead.

The previous Sonar integration is outdated: [support ended September 27,
2026](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview).
Synchronous and streaming calls are being translated automatically; this
skill uses the Agent API directly.

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
| Deep research with citations | **This skill** — Perplexity Agent API |
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
Agent API directly:

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

# 3. Call the Agent API, replacing input with the prepared research prompt:
curl --fail-with-body --silent --show-error https://api.perplexity.ai/v1/agent \
  -H "Authorization: Bearer $PERPLEXITY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"preset":"fast","input":"<topic, permitted brain context, and research questions>"}'

# 4. Write the structured research page via put_page:
gbrain put research/<slug>      # via the put_page operation

# 5. Cross-link entities mentioned (people, companies) per Iron Law.
```

Read the typed `output` array: answer text is in `message.content[]` items
of type `output_text`; sources are in `search_results.results[]`. Match
citation markers to result `id` values, not array positions. `fast` uses
`[1]`; deeper presets use markers such as `[web:1]`. Verify material claims
at the cited URLs and surface incomplete output or missing citations.

## Presets

Default to `fast`, which includes web search and is the recommended
replacement for `sonar` / `sonar-pro`. Use `high` for deeper research when
needed. See the [migration guide](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/how-to)
for current presets and request/response examples.

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

Add `"tools": [{"type": "web_search", "filters":
{"search_recency_filter": "month"}}]` to the request for a recency window.
Supported values: `hour`, `day`, `week`, `month`. Omit for evergreen research;
this is a tool filter, not a top-level request field.

## Anti-Patterns

- ❌ Sending NO brain context. Then it's just a search — use `web_fetch`
  instead.
- ❌ Truncating the brain context. The whole point is "knows what you
  know." Send dense context.
- ❌ Discarding citations. Every claim in the output must have a URL.
- ❌ Skipping the cross-link step when entities are mentioned. Iron Law.

## Environment

- Export `PERPLEXITY_API_KEY` in the agent's environment. If stored in
  `~/.gbrain/.env`, load it before calling the API.
- On missing credentials or API errors, report the blocker; do not silently
  switch providers.

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
