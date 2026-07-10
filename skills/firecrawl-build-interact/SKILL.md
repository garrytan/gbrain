---
name: firecrawl-build-interact
description: Integrate Firecrawl `/interact` into product code for dynamic pages and browser actions after scraping. Use when a feature needs clicks, form fills, pagination, authentication-aware flows, or other multi-step interactions that plain `/scrape` cannot complete.
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

# Firecrawl Build Interact

Use this when `/scrape` is not enough because the feature needs to act on the page.

## Use This When

- content appears only after clicks, typing, or navigation
- the feature needs forms, pagination, filters, or multi-step flows
- the product must stay in the same browser context after scraping

## Default Recommendations

- Start with `/scrape`, then escalate to `/interact`.
- Keep `/interact` scoped to the smallest browser workflow that unlocks the data.
- Use persistent profiles only when the feature truly needs authenticated state across sessions.

## Common Product Patterns

- search forms and faceted filters
- paginated result sets
- login-gated dashboards or tools
- flows where the page must be explored before extraction is complete

## Implementation Notes

- `/interact` is the right tool when the page must be manipulated, not just read.
- Keep prompts or action code specific to the product flow.
- If the use case is fully open-ended browser automation, evaluate whether a browser sandbox is a better product fit.

## Escalation Rules

- If the page can be read directly, stay on [firecrawl-build-scrape](../firecrawl-build-scrape/SKILL.md).

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
- [firecrawl-build-search](../firecrawl-build-search/SKILL.md)

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
