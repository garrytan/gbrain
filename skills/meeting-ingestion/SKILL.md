---
name: meeting-ingestion
version: 1.0.0
description: |
  Ingest meeting transcripts into brain pages with attendee enrichment, entity
  propagation, and timeline merge. A meeting is NOT fully ingested until the
  enrich skill has processed every entity.
triggers:
  - "meeting transcript"
  - "process this meeting"
  - "meeting notes"
  - meeting transcript received
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
mutating: true
---

# Meeting Ingestion Skill

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any new page.

## Contract

This skill guarantees:
- Meeting page created with attendees, summary, key decisions, action items
- EVERY attendee gets a people page (created or updated)
- EVERY company discussed gets entity propagation
- Timeline entries on ALL mentioned entities (timeline merge)
- Meeting is NOT fully ingested until enrich runs for every entity
- Back-links created bidirectionally

## Iron Law: Back-Linking (MANDATORY)

Every attendee and company mentioned MUST get a back-link from their page to
the meeting page. An unlinked mention is a broken brain.

## Phases

### Phase 1: Parse the transcript

Extract from the transcript:
- Attendees (names, roles if available)
- Date, time, duration
- Key topics discussed
- Decisions made
- Action items with owners
- Companies and projects mentioned

### Phase 2: Create meeting page

```markdown
# {Meeting Title} — {Date}

**Attendees:** {list with links to people pages}
**Date:** {YYYY-MM-DD}
**Duration:** {if available}

## Summary
{3-5 bullet key outcomes}

## Key Decisions
{Decisions with context}

## Action Items
{Tasks with owners and deadlines}

## Discussion Notes
{Structured notes by topic}
```

### Phase 3: Attendee enrichment (MANDATORY)

For EACH attendee:
1. `gbrain search "{name}"` — does a people page exist?
2. If NO → create via enrich skill (this is mandatory, not optional)
3. If YES → update compiled truth with meeting context
4. Add timeline entry: `- **{date}** | Attended [{meeting title}](path) — {context}`

### Phase 4: Entity propagation (MANDATORY)

For each company, project, or concept discussed:
1. Check brain for existing page
2. Create/update as needed
3. Add timeline entry referencing the meeting
4. Back-link from entity page to meeting page

### Phase 5: Timeline merge

The same event appears on ALL mentioned entities' timelines. If Alice met Bob at
Acme Corp, the event goes on Alice's page, Bob's page, AND Acme Corp's page.

### Phase 6: Sync

`gbrain sync` to update the index.

## Output Format

Meeting page created. Report: "Meeting ingested: {N} attendees enriched, {N} entities
updated, {N} action items captured."

## Anti-Patterns

- Creating the meeting page without enriching attendees
- Skipping entity propagation ("I'll do that later")
- Not merging timelines across all mentioned entities
- Creating attendee stubs without meaningful content
- Filing meeting pages without cross-linking to all participants
