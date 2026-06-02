# Content Ideas

## Purpose

This directory holds the **ranked content idea queue** — the output of the entire research pipeline. Ideas are scored, prioritized, and tracked through the production lifecycle.

## What Data Lives Here

- `queue.md` — The master idea queue, ranked by composite score
- One entry per content idea with full metadata
- Status tracking from `queued` through `published` or `killed`

## File Naming Convention

Currently the system uses a single queue file:

```
ideas/queue.md
```

As the system scales, individual idea files may be split out:

```
ideas/<idea-slug>.md
```

## Idea Lifecycle

```
queued → researching → drafting → review → scheduled → published
                                                        ↓
                                                     killed (at any stage)
```

## How Agents Use This Directory

- **Idea generation agents** add new entries to `queue.md` with calculated scores
- **Editorial agents** pull the highest-scored `queued` ideas for production
- **Project management agents** update status as ideas move through the pipeline
- **Self-improvement agents** analyze published vs. killed ideas to refine scoring

## Schema Reference

See `../SCHEMA.md` for the full idea queue frontmatter schema and score calculation formula.
