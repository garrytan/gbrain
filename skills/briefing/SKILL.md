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

0. **Hot memory pulse (v0.32).** Before composing anything else, run:

   ```bash
   cortex recall --since-last-run --supersessions --pending --rollup --json
   ```

   Fold the result into the briefing under a "Brain pulse" section at the top:
   1. **Contradictions resolved overnight** — the `--supersessions` output. Lead
      with these because they're new corrections to your model of the world.
   2. **Top mentions** — `top_entities` from `--rollup` (top 5 entity slugs by
      fact count in the window).
   3. **New facts since last briefing** — group the `facts` array under each
      entity from the rollup; include `kind`, `notability`, and `confidence`.
   4. **Pending consolidation footer** — when `pending_consolidation_count > 0`,
      note `N facts await dream-cycle consolidation` so the operator can decide
      whether to run `cortex dream` before reading further.

   The `--since-last-run` flag advances `~/.cortex/recall-cursors/<source>.json`
   so the next briefing picks up exactly where this one left off. If you're
   running this as a cron job, pass `--source <slug>` or set `CORTEX_SOURCE`
   explicitly — cron doesn't start in your repo-root cwd, so dotfile resolution
   may miss the right source. Thin-client installs (`cortex init --mcp-only`)
   route through the remote brain transparently.

1. **Today's meetings.** For each meeting on the calendar:
   - Search cortex for each participant by name
   - Read their pages from cortex for compiled_truth context
   - Summarize: who they are, recent timeline, relationship to you
2. **Active deals.** List deal pages in cortex filtered to active status:
   - Deadlines approaching in the next 7 days
   - Recent timeline entries (last 7 days)
3. **Time-sensitive threads.** Open items from timeline entries:
   - Items with deadlines in the next 48 hours
   - Follow-ups that are overdue
4. **Recent changes.** Pages updated in the last 24 hours:
   - What changed and why (read timeline entries from cortex)
5. **People in play.** List person pages in cortex sorted by recency:
   - Updated in last 7 days
   - Have high activity (many recent timeline entries)
6. **Stale alerts.** From cortex health check:
   - Pages flagged as stale that are relevant to today's meetings

## Cortex-Native Context Loading

Before generating any briefing, load context from cortex systematically.

### Before a meeting

For every attendee on the calendar invite:
- `cortex search "<attendee name>"` -- find their Cortex workspace page
- `cortex get <slug>` -- load compiled truth, recent timeline, relationship context
- If no page exists, note the gap ("No brain page for Sarah Chen -- consider enrichment")

### Before an email reply

Before drafting or triaging any email:
- `cortex search "<sender name>"` -- load sender context
- Read their compiled truth to understand who they are, what they care about, and
  your relationship history. This turns a cold reply into an informed one.

### Daily briefing queries

Run these queries to populate the briefing sections:
- `cortex query "active deals status"` -- deal pipeline snapshot
- `cortex query "meetings this week"` -- recent meeting pages with insights
- `cortex query "pending commitments follow-ups"` -- open threads and action items
- `cortex search --type person --sort updated --limit 10` -- people in play

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

- **Briefing without brain queries.** Never generate a briefing from memory alone; always query cortex for current data.
- **Uncited facts.** Every claim must include `[Source: slug, updated DATE]`. A fact without a citation is unverifiable.
- **Stale context presented as current.** If a page hasn't been updated in 30+ days, flag the staleness explicitly rather than presenting it as fresh.
- **Modifying brain pages unprompted.** The briefing is read-only by default. Do not create or update pages unless the user explicitly requests it.
- **Ignoring coverage gaps.** When a meeting participant has no brain page, say so. Silence about gaps hides ignorance.

## Tools Used

- Search cortex by name (query)
- Read a page from cortex (get_page)
- List pages in cortex by type (list_pages)
- Check cortex health (get_health)
- View timeline entries in cortex (get_timeline)
