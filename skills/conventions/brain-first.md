# Brain-First Lookup Convention

Before using ANY external API (web search, enrichment services, social APIs) to
research a person, company, or topic, check the brain first.

## The 5-Step Lookup

1. `gbrain search "name"` — keyword search for existing pages
2. `gbrain query "natural question about name"` — hybrid search for related context
3. `gbrain get <slug>` — if you know the slug, read the full page
4. Check backlinks: `gbrain get_backlinks <slug>` — who references this entity?
5. Check timeline: `gbrain get_timeline <slug>` — recent events involving this entity

The brain almost always has something. External APIs fill gaps, not start from scratch.

## Why This Matters

- The brain has context that external APIs don't (user's direct observations, meeting notes, personal relationships)
- External API calls cost money and time
- Brain context makes external lookups more targeted (you know what's missing)
- The user's direct statements are highest-authority data. External sources are lowest.
