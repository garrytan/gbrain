---
name: idea-ingest
version: 1.2.0
upstream: idea-ingest@fc834ee
description: |
  Ingest links, articles, tweets, and ideas into the brain. Fetch content, save
  to brain with analysis, credit the author (people page only when they pass the
  notability gate), and cross-link. Use when the user shares a link or says
  "read this", "save this", "think about this".
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
- The author is always credited: back-linked from an existing `people/` page (timeline update),
  or inline on the ingested page (`**Author:** {Author}, {role}`) when no page exists. A NEW
  `people/` page is created only when the author passes the notability gate AND you have at
  least two independent, durable facts about them beyond this one item — never a stub
  (`skills/_brain-filing-rules.md` §Notability Gate)
- Cross-links created bidirectionally (source ↔ author, source ↔ mentioned entities)
- Raw source preserved for provenance via `gbrain files upload-raw`
- Every fact has an inline `[Source: ...]` citation
- Filing follows primary subject rules (not format-based)

**Returns** (when invoked by another skill or sub-agent):
- `page_path`: brain page path of the ingested item (e.g., `concepts/flywheel-effects`)
- `author_path`: brain page path of the author (e.g., `people/alice-example`), or `null` when
  the notability gate was skipped and the author was credited inline instead
- `cross_links`: list of all cross-links created
- `status`: `ingested` | `updated` | `fetch_failed`

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.

Every mention of a person or company with a brain page MUST create a back-link.
Format: `- **YYYY-MM-DD** | Referenced in [page title](path) — brief context`

## Phases

1. **Fetch the content.** Use appropriate tools for the content type (web fetch for articles, API for tweets, PDF reader for documents).

2. **Upload raw source.** Save the fetched content for provenance: `gbrain files upload-raw <file> --page <slug>`

3. **Identify the author — notability-gated.** Search brain for an existing author page first.
   - If page exists → update timeline with this new publication, then cross-link both directions
   - If no page → create one ONLY if the author passes the notability gate
     (`skills/_brain-filing-rules.md` §Notability Gate, `skills/conventions/quality.md`) AND at
     least two independent, durable facts about them exist beyond this one item. Create a FULL
     page (not a stub) from enrichment — a single ingested item is not an entity worth a page.
   - Otherwise credit the author inline on the ingested page (`**Author:** {Author}, {role}`) and
     note the gap in the reply. When in doubt, DON'T create. A missing page can be created later.

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

## When it fails

Follow the [agent operator protocol](../../docs/protocol/AGENT_OPERATOR_v1.md) for any gbrain error `code`, exit code, `[AGENT]` block or notice block. Specific to this skill:

- The fetch fails (paywall, 404, timeout): save a stub with URL, metadata and the failure reason (`status: fetch_failed`) and ask the user to paste the content.
- `gbrain files upload-raw` / `file_upload` is refused (path outside the allowed root, payload too large): tell the user the limit and offer a link or an excerpt instead.
- `write_pending` (exit 10) on the page write: poll `gbrain write-request <request_id>` before reporting `ingested`.

## Anti-Patterns

- Just summarizing without connecting to brain knowledge
- Filing everything in `sources/` (sources is for raw data dumps only)
- Dropping the author credit entirely — neither a back-link on an existing author page nor an inline `**Author:**` line on the ingested page
- Creating a `people/` page that fails the notability gate in `skills/_brain-filing-rules.md` or is a stub built from this one item
- Not cross-linking to mentioned entities
- Ingesting without checking brain first for existing coverage
- Overwriting an existing brain page instead of merging new content into it
- Hallucinating connections to brain knowledge — only cite connections you verified via search/query
- Creating generic slugs like `concepts/strategy` — be specific: `concepts/flywheel-effects`
- Assuming the fetch succeeded without verifying content was actually retrieved

## Tools outside your MCP surface

This plugin serves the starter tool surface. When a step above names one of these tools and your tool list
does not have it, run its gbrain CLI equivalent instead:

- `add_link` → `gbrain link`
- `file_upload` → `gbrain call file_upload <params_json>`

Or widen this machine's plugin surface with GBRAIN_SURFACE=full (new sessions pick it up).
