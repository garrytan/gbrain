---
name: web-research
version: 0.1.0
description: Brain-augmented web research with Context Answers. Find new developments and current facts, compare them with existing brain knowledge, and save a sourced research summary.
triggers:
  - "what's new about"
  - "current state of"
  - "web research"
  - "what changed about"
  - "surface new developments"
mutating: true
writes_pages: true
writes_to:
  - research/
---

# Web Research with Context

> **Convention:** Follow [brain-first](../conventions/brain-first.md),
> [brain routing](../conventions/brain-routing.md), and
> [quality](../conventions/quality.md).

## Contract

Read relevant brain pages first. Research what is missing or has changed,
then verify material claims at their original URLs. Preserve the active
brain and source. Send only context authorized for external research.

## Invocation

Use the connected Context MCP server's `web-answers` tool, inspecting its
schema first, or the REST API with `CONTEXT_DEV_API_KEY` exported:

```bash
curl --fail-with-body --silent --show-error \
  https://api.context.dev/v1/web/answers \
  -H "Authorization: Bearer $CONTEXT_DEV_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "task": "Check https://docs.context.dev/answers/overview for the current Answers API modes. Known context: fast and ultra were available on 2026-09-01. Identify any changes and cite the supporting documentation.",
  "mode": "ultra",
  "json_format": {
    "summary": "What changed or remains confirmed",
    "developments": [{"claim": "A new finding", "source_url": "https://example.com/source"}],
    "confirmations": [{"claim": "A confirmed fact", "source_url": "https://example.com/source"}],
    "contradictions": [{"claim": "A conflicting finding", "source_url": "https://example.com/source"}],
    "unknowns": ["An unresolved question"]
  }
}
JSON
```

Replace `task` with the topic, a concise summary of permitted brain context,
and the requested date window. The limit is **2,000 characters**; split larger
questions instead of silently truncating. `json_format` is an example object,
not JSON Schema. Use `ultra` for deeper research and `fast` for narrow lookups.
See [Answers documentation](https://docs.context.dev/answers/overview).

## Output Format

Read `json_content` and `sources` (URLs). Unknown values may be `null`; surface
`partial: true` as incomplete research. Verify material claims by reading the
cited URLs with Context `web-scrape` Highlights, or Markdown if needed.

Write `research/<slug>` through `put_page`, with title, type `research`, date,
and `brain_context_slugs` in frontmatter. Include a summary, new developments,
confirming signals, contradictions, recommended brain updates, and citations.
Add entity backlinks per `quality.md`. When another skill calls this one,
return the verified findings so the caller owns the final format and destination.

## Anti-Patterns

- Treating source lists, empty answers, or partial output as verified facts.
- Uploading entire private brain pages or overwriting conflicting facts silently.
- Switching providers on an API error; report the blocker instead.
