---
name: linkedin-enrichment
version: 1.1.0
description: |
  Finds a person's LinkedIn profile via web search, extracts full profile data 
  (roles, education, location, summaries), creates a raw extraction record,
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

This skill isolates the execution of finding and appending LinkedIn data to a person's brain page, while also retaining the raw extracted data.

## Contract
- Modifies a person's markdown file to include their LinkedIn URL.
- Appends `https://www.linkedin.com/in/<handle>` to the `aliases:` block in YAML frontmatter.
- Updates the `State` section with the URL, current roles, location, and education.
- Creates a dedicated raw extraction markdown file at `people/linkedin-profiles/<slug>-linkedin.md`.
- Links the raw profile back to the main person page, and links the main page to the raw profile.

## Phases

### Phase 1: Search
- Use `web_search` with the query `"<Name>" LinkedIn` or `"<Name>" "<Company>" LinkedIn`.
- Extract ALL available structured data from the search snippets (current role, headline, past roles, location, education, summary, connection count, etc.).

### Phase 2: Package Data
- Structure the extracted data into a JSON payload. The script accepts a single JSON string.
- Recommended keys: `currentRole`, `location`, `education`, `headline`, `summary`, `experience`.

### Phase 3: Patch Brain Page & Create Raw Profile
- Execute the patching script:
  `bun run scripts/enrich-linkedin.ts <path-to-person.md> <linkedin-url> '<json-string>'`
- The script automatically writes the main page updates and creates the `linkedin-profiles/` file.

## See Also
- [Enrich Skill](../enrich/SKILL.md) - This skill is typically chained from the master enrich skill.
- [Filing Rules](../_brain-filing-rules.md) - Contains standard directory layout.
