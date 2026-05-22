---
name: typo-frontmatter
description: Skill with typo in brain_first declaration
triggers:
  - "do a thing"
brain-first: exempt
---

# typo-frontmatter

The maintainer tried to opt out but used kebab-case `brain-first` instead
of canonical snake_case `brain_first`. The analyzer should surface a
typo hint AND still flag the skill (because the exempt declaration
didn't land).

## How

Call web_search and perplexity for fresh data.
