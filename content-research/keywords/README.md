# Keywords

## Purpose

This directory holds **SEO keyword research** data. Keywords bridge the gap between what people search for and the content we create. Each keyword file captures search volume, difficulty, intent, and mapping to topics and pillars.

## What Data Lives Here

- Keyword research files organized by theme or campaign
- Each file contains a structured list of keywords with metadata:
  - Search volume (monthly)
  - Keyword difficulty (KD) score
  - Cost-per-click (CPC) if available
  - Search intent (informational, commercial, transactional, navigational)
  - Mapped topic and pillar
- Seed keyword lists from tools (Ahrefs, SEMrush, Google Keyword Planner exports)

## File Naming Convention

```
keywords/<theme-or-campaign>.md
```

- Use **kebab-case** for theme names
- Examples: `ai-writing-tools.md`, `content-marketing-basics.md`, `email-seo-2026.md`

## File Format

```markdown
# Keyword Research: <Theme>

## Seed Keywords

| Keyword | Volume | KD | CPC | Intent | Topic |
|---|---|---|---|---|---|
| AI writing tool | 18,100 | 45 | $3.20 | commercial | best-ai-writing-tools |
| AI content generator | 12,100 | 38 | $2.80 | commercial | best-ai-writing-tools |
| best AI copywriter | 8,100 | 52 | $4.10 | commercial | best-ai-writing-tools |

## Long-Tail Opportunities

| Keyword | Volume | KD | Intent |
|---|---|---|---|
| AI writing tool for blog posts | 1,300 | 22 | informational |
| how to use AI for content marketing | 2,400 | 28 | informational |

## Notes

- High commercial intent cluster around "best" and "review" modifiers
- Long-tail KD scores are low — good opportunity for quick wins
```

## How Agents Use This Directory

- **Research agents** populate keyword files from SEO tool exports and search data
- **Topic agents** reference keyword files when scoring topic opportunities
- **Editorial agents** read keyword files to optimize content for target keywords
- **Self-improvement agents** update keyword performance data after content publishes
