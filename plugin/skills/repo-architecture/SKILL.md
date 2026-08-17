---
name: repo-architecture
version: 1.0.0
description: |
  Where new brain files go. Decision protocol for filing brain pages by primary
  subject, not by format or source. Reference for all brain-writing skills.
triggers:
  - "where does this go"
  - "filing rules"
  - "create new page"
  - "which directory"
tools:
  - search
  - get_page
  - list_pages
mutating: false
---

# Repo Architecture — Filing Rules

> **Full filing rules:** See `skills/_brain-filing-rules.md`

## Contract

This skill guarantees:
- Every new page is filed by primary subject (not format, not source)
- The decision protocol is followed for ambiguous cases
- Common misfiling patterns are caught

## Phases

1. **Identify the primary subject.** What would you search for to find this page?
2. **Walk the decision tree:**
   - About a person → `people/{name-slug}.md`
   - About a company → `companies/{name-slug}.md`
   - A reusable concept/framework → `concepts/{slug}.md`
   - An original idea → `originals/{slug}.md`
   - A meeting → `meetings/{slug}.md`
   - Media content → `media/{type}/{slug}.md`
   - Raw data import → `sources/{slug}.md`
3. **Cross-link.** Link from related directories.
4. **Check notability.** See `skills/conventions/quality.md` notability gate.

## Output Format

Advisory: "File this at `{type}/{slug}.md` because the primary subject is {reason}."

## Anti-Patterns

- Filing by format ("it's a PDF so it goes in sources/")
- Filing by source ("it came from email so it goes in sources/")
- Creating pages without checking if one already exists
- Using `sources/` for anything except raw data dumps
