---
name: briefing
description: Compile daily briefing with meeting context, active deals, and citation tracking
triggers:
  - "daily briefing"
  - "morning briefing"
  - "what's happening today"
tools:
  - search
  - query
  - get_page
  - list_pages
  - get_timeline
mutating: false
---

# Briefing Skill

Compile a daily briefing from brain context.

> **Filing rule:** When the briefing creates or updates brain pages,
> follow `skills/_brain-filing-rules.md`.

## Contract

- Every fact in the briefing includes an inline `[Source: slug, updated DATE]` citation.
- Meeting participants are resolved against the brain; gaps are explicitly flagged.
- Active deals and action items include deadlines and recency context.
- The briefing is read-only: no brain pages are created or modified unless the user explicitly requests it.
- Stale alerts surface pages relevant to today's context, not just all stale pages.

## Phases

1. **Today's meetings.** For each meeting on the calendar:
   - Search gbrain for each participant by name
   - Read their pages from gbrain for compiled_truth context
   - Summarize: who they are, recent timeline, relationship to you
2. **Active deals.** List deal pages in gbrain filtered to active status:
   - Deadlines approaching in the next 7 days
   - Recent timeline entries (last 7 days)
3. **Time-sensitive threads.** Open items from timeline entries:
   - Items with deadlines in the next 48 hours
   - Follow-ups that are overdue
4. **Recent changes.** Pages updated in the last 24 hours:
   - What changed and why (read timeline entries from gbrain)
5. **People in play.** List person pages in gbrain sorted by recency:
   - Updated in last 7 days
   - Have high activity (many recent timeline entries)
6. **Stale alerts.** From gbrain health check:
   - Pages flagged as stale that are relevant to today's meetings

## GBrain-Native Context Loading

Before generating any briefing, load context from gbrain systematically.

### Before a meeting

For every attendee on the calendar invite:
- `gbrain search "<attendee name>"` -- find their brain page
- `gbrain get <slug>` -- load compiled truth, recent timeline, relationship context
- If no page exists, note the gap ("No brain page for Sarah Chen -- consider enrichment")

### Before an email reply

Before drafting or triaging any email:
- `gbrain search "<sender name>"` -- load sender context
- Read their compiled truth to understand who they are, what they care about, and
  your relationship history. This turns a cold reply into an informed one.

### Daily briefing queries

Run these queries to populate the briefing sections:
- `gbrain query "active deals status"` -- deal pipeline snapshot
- `gbrain query "meetings this week"` -- recent meeting pages with insights
- `gbrain query "pending commitments follow-ups"` -- open threads and action items
- `gbrain search --type person --sort updated --limit 10` -- people in play

## Output Format

```
DAILY BRIEFING -- [date]
========================

MEETINGS TODAY
- [time] [meeting name]
  Participants: [name] (slug: people/name, [key context])

ACTIVE DEALS
- [deal name] -- [status], deadline: [date]
  Recent: [latest timeline entry]

ACTION ITEMS
- [item] -- due [date], related to [slug]

RECENT CHANGES (24h)
- [slug] -- [what changed]

PEOPLE IN PLAY
- [name] -- [why they're active]
```

## Back-Linking During Briefing

If the briefing creates or updates any brain pages (e.g., new meeting prep
pages, updated entity pages), the back-linking iron law applies: every entity
mentioned must have a back-link from their page. See `skills/_brain-filing-rules.md`.

## Citation in Briefings

When presenting facts from brain pages, include inline citations:
- "Jane is CTO of Acme [Source: people/jane-doe, updated 2026-04-01]"
- This lets the user trace any claim back to the brain page and assess freshness

## Anti-Patterns

- **Briefing without brain queries.** Never generate a briefing from memory alone; always query gbrain for current data.
- **Uncited facts.** Every claim must include `[Source: slug, updated DATE]`. A fact without a citation is unverifiable.
- **Stale context presented as current.** If a page hasn't been updated in 30+ days, flag the staleness explicitly rather than presenting it as fresh.
- **Modifying brain pages unprompted.** The briefing is read-only by default. Do not create or update pages unless the user explicitly requests it.
- **Ignoring coverage gaps.** When a meeting participant has no brain page, say so. Silence about gaps hides ignorance.

## Tools Used

- Search gbrain by name (query)
- Read a page from gbrain (get_page)
- List pages in gbrain by type (list_pages)
- Check gbrain health (get_health)
- View timeline entries in gbrain (get_timeline)
