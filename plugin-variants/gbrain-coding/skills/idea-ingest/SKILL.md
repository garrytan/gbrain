---
name: idea-ingest
version: 1.1.0
upstream: idea-ingest@fc834ee
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
writes_pages: true
writes_to:
  - people/
  - concepts/
  - sources/
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

**Returns** (when invoked by another skill or sub-agent):
- `page_path`: brain page path of the ingested item (e.g., `concepts/flywheel-effects`)
- `author_path`: brain page path of the author (e.g., `people/alice-example`)
- `cross_links`: list of all cross-links created
- `status`: `ingested` | `updated` | `fetch_failed`

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.

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

## Edge Cases

- **Fetch fails (paywall, 404, timeout):** Save a stub page with URL + metadata + reason for failure. Tell the user content couldn't be fetched and ask if they can paste it.
- **Duplicate URL:** Before ingesting, search brain for the URL. If found, update the existing page rather than creating a new one. Tell the user it was already ingested.
- **No identifiable author:** Use `sources/` filing. Skip the people page but note the gap.
- **Tweet thread vs single tweet:** Fetch the entire thread. Treat the thread as one unit.
- **Video/podcast link:** Note that only metadata can be ingested unless a transcript is available. Ask the user for a transcript.
- **Raw upload:** Use the `file_upload` tool (not CLI `gbrain files upload-raw`) when operating as an agent.

## Anti-Patterns

- Just summarizing without connecting to brain knowledge
- Filing everything in `sources/` (sources is for raw data dumps only)
- Skipping the author people page
- Not cross-linking to mentioned entities
- Ingesting without checking brain first for existing coverage
- Overwriting an existing brain page instead of merging new content into it
- Hallucinating connections to brain knowledge — only cite connections you verified via search/query
- Creating generic slugs like `concepts/strategy` — be specific: `concepts/flywheel-effects`
- Assuming the fetch succeeded without verifying content was actually retrieved
