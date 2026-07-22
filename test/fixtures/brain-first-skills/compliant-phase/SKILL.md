---
name: compliant-phase
description: External-lookup skill with explicit Phase 1 brain heading
triggers:
  - "enrich entity"
mutating: true
---

# compliant-phase

A skill that enriches entities via web_search but starts with an explicit
Phase 1 brain-first lookup section.

## Phase 1: Brain-First Lookup

Before reaching for external sources, check what the brain already knows.

## Phase 2: External Enrichment

If the brain answer is thin, run web_search for missing context, then
cross-reference with exa.api for citations.
