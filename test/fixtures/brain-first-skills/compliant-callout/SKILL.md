---
name: compliant-callout
description: External-lookup skill with canonical Convention callout
triggers:
  - "research a person"
mutating: true
---

# compliant-callout

A skill that researches people via Perplexity but properly delegates to
the brain-first convention.

> **Convention:** see conventions/brain-first.md for the lookup chain (search → query → get_page → external).

## Phase 1: Research

Use Perplexity to find recent news about the person; cross-reference web_search
for primary sources.
