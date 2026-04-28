---
name: linkedin-enrichment
version: 1.0.0
description: |
  Finds a person's LinkedIn profile via web search, extracts current roles,
  and safely updates their brain page frontmatter (aliases) and State section.
triggers:
  - "find their linkedin"
  - "enrich linkedin for"
  - "get linkedin profile"
tools:
  - web_search
  - read
  - exec
mutating: true
---

# LinkedIn Enrichment

This skill isolates the execution of finding and appending LinkedIn data to a person's brain page.

## Contract
- Modifies a person's markdown file to include their LinkedIn URL.
- Appends `https://www.linkedin.com/in/<handle>` to the `aliases:` block in YAML frontmatter.
- Updates the `State` section with the URL and current roles found via search.

## Phases

### Phase 1: Search
- Use `web_search` with the query `"<Name>" LinkedIn` or `"<Name>" "<Company>" LinkedIn`.

### Phase 2: Extraction
- Extract the LinkedIn URL and current title/company from the search results.

### Phase 3: Patch Brain Page
- Execute `bun run scripts/enrich-linkedin.ts <name-slug> <linkedin-url> "<roles-summary>"` to safely patch the markdown file.

## See Also
- [Enrich Skill](../enrich/SKILL.md) - This skill is typically chained from the master enrich skill.
