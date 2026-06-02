# Pillars

## Purpose

Content pillars are the **thematic clusters** that organize your entire content strategy. Each pillar represents a broad subject area that your brand owns expertise in. Topics discovered through research are mapped to pillars, and content ideas are generated from pillar clusters.

Pillars are **living documents** — they evolve as research matures and audience interests shift.

## What Data Lives Here

- One markdown file per content pillar
- Each file contains metadata (YAML frontmatter) and a narrative description
- Pillar files track which topics are mapped to them
- Pillar files contain high-level content strategy notes for their theme

## File Naming Convention

```
pillars/<pillar-slug>.md
```

- Use **kebab-case** for slugs
- Slugs should be short and descriptive
- Examples: `ai-in-marketing.md`, `seo-fundamentals.md`, `content-strategy.md`

## Pillar Lifecycle

1. **draft** — New pillar proposed but not yet validated with enough topics
2. **active** — Pillar has sufficient topics and content is being produced
3. **archived** — Pillar is no longer a strategic focus (topics retained for reference)
4. **merged** — Pillar was merged into another pillar (reference the target pillar in the body)

## How Agents Use This Directory

- **Research agents** propose new pillars when a cluster of topics doesn't fit existing pillars
- **Editorial agents** read pillar files to understand the strategic context before drafting content
- **Self-improvement agents** update `topics_count`, `total_search_volume`, and `avg_commercial_intent` as new topics are mapped

## Schema Reference

See `../SCHEMA.md` for the full pillar file frontmatter schema.
