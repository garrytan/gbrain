# Content Research System

## Overview

This directory is the central hub for all content research operations. It is designed to be **agent-readable and agent-writable** — every file follows a predictable schema so that automated agents can ingest, update, and act on the data without ambiguity.

The system flows in one direction:

```
Social Listening → Topics → Keywords → Pillars → Ideas → Published Content
                         ↑                                    ↓
                         └── Self-Improvement Feedback ←──────┘
```

Agents crawl social platforms, extract topics, cluster them into pillars, and generate ranked content ideas. A self-improvement loop captures learnings so the system gets smarter over time.

## Directory Map

| Directory | Purpose |
|---|---|
| `pillars/` | Content pillars — the thematic pillars that organize all content strategy |
| `topics/` | Individual topic research sourced from social listening and keyword data |
| `keywords/` | SEO keyword research with volume, difficulty, and intent data |
| `social-listening/` | Raw crawl data from Reddit, Twitter/X, and YouTube |
| `ideas/` | Ranked content ideas ready for production |
| `self-improvement/` | Agent self-improvement notes and calibration logs |

## How Agents Interact With This System

### Research Agents
1. **Ingest** raw data into `social-listening/<platform>/`
2. **Extract** topics from raw data and write to `topics/`
3. **Cluster** topics into pillars and write to `pillars/`
4. **Enrich** with keyword data from `keywords/`
5. **Generate** content ideas and push to `ideas/queue.md`

### Editorial Agents
1. **Read** `ideas/queue.md` for the highest-scored ideas
2. **Draft** content based on topic files and keyword data
3. **Update** idea status in `ideas/queue.md` (e.g., `drafting → review → published`)

### Self-Improvement Agents
1. **Analyze** published content performance
2. **Compare** predicted scores vs. actual outcomes
3. **Write** learnings to `self-improvement/log.md`
4. **Adjust** scoring heuristics in `SCHEMA.md` if needed

## File Conventions

- All files are **Markdown** with **YAML frontmatter**.
- Dates use **ISO 8601** format: `YYYY-MM-DD`.
- Slugs use **kebab-case**: `my-topic-name.md`.
- See `SCHEMA.md` for the full data schema.

## Maintenance

- Raw social listening data is **rotated monthly** — archive anything older than 90 days.
- Topic files are **never deleted**, only updated with new findings.
- Pillar files are **living documents** — they evolve as research matures.
- The idea queue is **continuously re-scored** as new data arrives.
