# Topics

## Purpose

Topics are **individual content opportunities** discovered through social listening, keyword research, or competitive analysis. Each topic file captures the raw signals — what people are saying, what they're struggling with, and what content angles could address their needs.

Topics are the **atoms** of the content research system. They get clustered into pillars and eventually become content ideas.

## What Data Lives Here

- One markdown file per discovered topic
- YAML frontmatter with structured metadata (sentiment, pain points, keywords, scores)
- Body content with summary, key quotes, and research notes
- Topics are **never deleted** — only updated with new findings or marked as merged

## File Naming Convention

```
topics/<topic-slug>.md
```

- Use **kebab-case** for slugs
- Slugs should be descriptive of the topic
- Examples: `best-ai-writing-tools.md`, `google-helpful-content-update.md`, `email-subject-line-tips.md`

## Topic Lifecycle

1. A topic is **created** when a research agent identifies a content opportunity
2. The topic is **enriched** over time with additional data (more keywords, updated sentiment)
3. The topic is **mapped** to a pillar (tracked via `pillar_fit_score`)
4. The topic either spawns a content idea or is **merged** with an existing topic

## How Agents Use This Directory

- **Research agents** create new topic files from social listening data and keyword research
- **Editorial agents** browse topics to find high-opportunity content angles
- **Clustering agents** read all topics periodically to identify new pillar candidates
- **Self-improvement agents** update topic metadata based on content performance

## Schema Reference

See `../SCHEMA.md` for the full topic file frontmatter schema.
