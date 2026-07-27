---
name: brain-ops
description: Read, enrich, and write brain pages with source attribution.
triggers:
  - any brain read or write
  - look something up in the brain
tools:
  - search
  - query
  - put_page
  - web_search
writes_pages: true
writes_to:
  - people/
  - companies/
mutating: true
sources:
  - /abs/path/should/be/dropped.ts
---

# brain-ops

Brain-first lookup, read-enrich-write loop, source attribution.

Phase 1: search the brain before reaching for any external tool.
