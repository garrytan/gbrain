---
name: idea-ingest
version: 1.0.0
description: |
  Ingest links, articles, tweets, and ideas into the brain. Fetch content, save
  to brain with analysis, create author people page, and cross-link. Use when the
  user shares a link or says "read this", "save this", "think about this".
triggers:
  - shares a link or URL
  - "read this"
  - "save this"
  - "think about this"
  - "put this in brain"
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - file_upload
mutating: true
---

# Idea Ingest Skill

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any new page.

## Contract

This skill guarantees:
- Every ingested item has a brain page with genuine analysis (not just a summary)
- The author gets a people page (MANDATORY for anyone whose thinking is worth ingesting)
- Cross-links created bidirectionally (source ↔ author, source ↔ mentioned entities)
- Raw source preserved for provenance via `gbrain files upload-raw`
- Every fact has an inline `[Source: ...]` citation
- Filing follows primary subject rules (not format-based)

## Iron Law: Back-Linking (MANDATORY)

Every mention of a person or company with a brain page MUST create a back-link.
Format: `- **YYYY-MM-DD** | Referenced in [page title](path) — brief context`

## Phases

1. **Fetch the content.** Use appropriate tools for the content type (web fetch for articles, API for tweets, PDF reader for documents).

2. **Upload raw source.** Save the fetched content for provenance: `gbrain files upload-raw <file> --page <slug>`

3. **Identify the author — MANDATORY people page.** Anyone whose thinking is worth ingesting is worth tracking.
   - Search brain for existing author page
   - If no page → CREATE ONE with compiled truth + timeline format
   - If page exists → update timeline with this new publication
   - Cross-link both directions

4. **Save to brain.** File by PRIMARY SUBJECT (read `skills/_brain-filing-rules.md`):
   - About a person → `people/`
   - About a company → `companies/`
   - A reusable framework → `concepts/`
   - Raw data dump → `sources/`

5. **Analyze for the user.** Reply with analysis that connects the content to what the brain knows. Think about:
   - Active projects — is this relevant?
   - Contradictions — does this challenge existing brain knowledge?
   - Connections — does this involve known people/companies?
   - Don't just summarize. Tell the user things they wouldn't have noticed.

6. **Sync.** `gbrain sync` to update the index.

## Output Format

```markdown
# {Title} — {Author}

**Source:** {URL}
**Author:** {Author}, {role}
**Published:** {date}
**Ingested:** {date}

## Context
{Why this matters now, connected to brain knowledge}

## Summary
{3-5 bullet core arguments}

## Key Data / Claims
{Specific facts, numbers, quotes}

## Analysis
{How this connects to existing brain knowledge. What's new. What contradicts.}
```

## Anti-Patterns

- Just summarizing without connecting to brain knowledge
- Filing everything in `sources/` (sources is for raw data dumps only)
- Skipping the author people page
- Not cross-linking to mentioned entities
- Ingesting without checking brain first for existing coverage
