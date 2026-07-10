---
name: firecrawl-build-search
description: Integrate Firecrawl `/search` into product code and agent workflows. Use when an app needs discovery before extraction, when the feature starts with a query instead of a URL, or when the system should search the web and optionally hydrate result content.
license: ISC
metadata:
  author: firecrawl
  version: "0.1.0"
  homepage: https://www.firecrawl.dev
  source: https://github.com/firecrawl/skills
inputs:
  - name: FIRECRAWL_API_KEY
    description: Firecrawl API key for hosted Firecrawl requests.
    required: true
  - name: FIRECRAWL_API_URL
    description: Optional base URL for self-hosted Firecrawl deployments.
    required: false
triggers:
  - firecrawl
  - scrape
  - web data
---

# Firecrawl Build Search

Use this when the application starts with a query, not a URL.

## Use This When

- the user asks a question and the product must discover sources first
- the feature needs current web results
- you want to turn a search query into a shortlist of pages for later scraping

## Default Recommendations

- Use `/search` first when URL discovery is part of the product behavior.
- Keep search and extraction conceptually separate unless scraping search results is clearly required.
- Prefer selective follow-up extraction over broad hydration when cost or latency matters.

## Common Product Patterns

- answer generation with cited sources
- company, competitor, or topic discovery
- research workflows that produce a shortlist before deeper extraction
- query-to-URL pipelines for later `/scrape` or `/interact`

## Escalation Rules

- If you already have the URL, use [firecrawl-build-scrape](../firecrawl-build-scrape/SKILL.md).
- If the result page then requires clicks or form interaction, escalate to [firecrawl-build-interact](../firecrawl-build-interact/SKILL.md).

## Implementation Notes

- Treat `/search` as discovery, ranking, and source selection.
- Be explicit about whether the product needs snippets, URLs, or full result content.
- Keep the query contract stable so downstream scraping logic stays predictable.

## Docs (Source of Truth)

Read the source-of-truth page for your project language before writing integration code:

- **Node / TypeScript**: [docs.firecrawl.dev/agent-source-of-truth/node](https://docs.firecrawl.dev/agent-source-of-truth/node)
- **Python**: [docs.firecrawl.dev/agent-source-of-truth/python](https://docs.firecrawl.dev/agent-source-of-truth/python)
- **Rust**: [docs.firecrawl.dev/agent-source-of-truth/rust](https://docs.firecrawl.dev/agent-source-of-truth/rust)
- **Java**: [docs.firecrawl.dev/agent-source-of-truth/java](https://docs.firecrawl.dev/agent-source-of-truth/java)
- **Elixir**: [docs.firecrawl.dev/agent-source-of-truth/elixir](https://docs.firecrawl.dev/agent-source-of-truth/elixir)
- **cURL / REST**: [docs.firecrawl.dev/agent-source-of-truth/curl](https://docs.firecrawl.dev/agent-source-of-truth/curl)

## See Also

- [firecrawl-build](../firecrawl-build/SKILL.md)
- [firecrawl-build-scrape](../firecrawl-build-scrape/SKILL.md)
- [firecrawl-build-interact](../firecrawl-build-interact/SKILL.md)

## Contract
- Inputs: skill request + project context (and Firecrawl API key when calling live endpoints).
- Outputs: concrete integration guidance, code snippets, and endpoint choices that match Firecrawl docs.
- Failure modes: missing API key, wrong endpoint for the task, or out-of-scope one-off terminal scrapes (use firecrawl CLI skill instead when applicable).

## Output Format
1. Confirm the target endpoint(s) and why they fit.
2. Provide the minimal working code/config changes.
3. Call out auth/env requirements and common pitfalls.

## Anti-Patterns
- Do not invent Firecrawl endpoints or response fields.
- Do not hardcode live API keys into source.
- Do not recommend crawl when a single `/scrape` or `/search` call is enough.
- Do not use these product-integration skills for disposable terminal-only lookups when a CLI path is intended.
