---
name: enrich
version: 1.1.0
description: |
  Enrich brain pages with tiered enrichment protocol. Creates and updates
  person/company pages with compiled truth, timeline, and cross-links.
  Also keeps projects/ and goals/ pages fresh by appending timeline entries
  and updating status when those pages are referenced in sessions, originals,
  or other in-flow signal — preventing active-work pages from going stale.
  Use when a new entity is mentioned or an existing page needs updating.
triggers:
  - "enrich"
  - "create person page"
  - "update company page"
  - "who is this person"
  - "look up this company"
  - "update project page"
  - "refresh this project status"
  - "this project moved forward"
tools:
  - get_page
  - put_page
  - search
  - query
  - add_link
  - add_timeline_entry
  - get_backlinks
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - projects/
  - goals/
---

# Enrich Skill

Enrich person and company pages from external sources. Scale effort to importance.

## Contract

This skill guarantees:
- Every enriched page has compiled truth (State section) with inline citations
- Every enriched page has a timeline with dated entries
- Back-links are created bidirectionally
- Tiered enrichment: Tier 1 (full), Tier 2 (medium), Tier 3 (minimal) based on notability — applies to **people / companies** only
- No stubs: every new entity page has meaningful content from web search or existing brain context
- **Project / goal pages** are kept fresh: when a session, original, or other in-flow source references `projects/<slug>` or `goals/<slug>`, the target page receives a timeline entry summarising the new signal and (when the signal warrants) a refreshed `status` / `updated` frontmatter field — without invoking notability gates or external APIs

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any new page.

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.

Every mention of a person or company with a brain page MUST create a back-link
FROM that entity's page TO the page mentioning them. An unlinked mention is a
broken brain. See `skills/_brain-filing-rules.md` for format.

## Philosophy

A brain page should read like an intelligence dossier, not a LinkedIn scrape.
Facts are table stakes. Texture is the value -- what do they believe, what are
they building, what makes them tick, where are they headed.

## Citation Requirements (MANDATORY)

> **Convention:** see `skills/conventions/quality.md` for citation formats and source precedence.

When sources conflict, note the contradiction with both citations.

## When To Enrich

### Primary triggers (people / companies — full pipeline)
- User mentions an entity in conversation
- Entity appears in a meeting transcript or email
- New contact appears with significant context
- Entity makes news or has a major event
- Any ingest pipeline encounters a notable entity

### Primary triggers (projects / goals — lightweight timeline + status push)
- A session page references `[[projects/<slug>]]` or `[[goals/<slug>]]`
- An original or writing page expresses a status delta on an active project
- A meeting transcript names the project and reports progress, blockers, or
  decisions
- The user asks to "refresh this project page" or says a project moved forward
- A retrospective sweep (cron-driven, future extension) discovers project
  references not yet propagated to the project page's timeline

### Do NOT enrich
- Random mentions with no relationship signal
- Bot/spam accounts
- People / companies with no substantive connection to the user's work
- Same page enriched within the past week (unless new signal warrants it)
- Project / goal pages where the only "new signal" is a duplicate of an
  existing timeline entry (deduplicate before appending)

## Enrichment Tiers

Scale enrichment to importance. Don't waste API calls on low-value entities.

| Tier | Who | Effort | Sources |
|------|-----|--------|---------|
| 1 (key) | Inner circle, close collaborators, key contacts | Full pipeline | All available APIs + deep web research |
| 2 (notable) | Occasional interactions, industry figures | Moderate | Web research + social + brain cross-ref |
| 3 (minor) | Worth tracking, not critical | Light | Brain cross-ref + social lookup if handle known |

## The Enrichment Protocol (7 Steps)

### Step 1: Identify entities

Extract people, companies, concepts from the incoming signal. Additionally
scan for project and goal references — typically `[[projects/<slug>]]` and
`[[goals/<slug>]]` wikilinks in the source content, but also natural-language
mentions that resolve to existing project / goal pages. Project / goal
references go through a separate, lighter-weight protocol (see "Project &
Goal Enrichment" below) — the rest of this protocol is for people / companies.

### Step 2: Check brain state

For each entity:
- `gbrain search "name"` -- does a page already exist?
- **If yes:** UPDATE path (add new signal, update compiled truth if material)
- **If no:** CREATE path (check notability gate first, then create)

### Step 3: Extract signal from source

Don't just capture facts. Capture texture:

| Signal Type | What to Extract |
|-------------|----------------|
| Opinions, beliefs | What They Believe section |
| Current projects, features shipped | What They're Building section |
| Ambition, career arc, motivation | What Motivates Them section |
| Topics they return to obsessively | Hobby Horses section |
| Who they amplify, argue with, respect | Network / Relationships |
| Ascending, plateauing, pivoting? | Trajectory section |
| Role, company, funding, location | State section (hard facts) |

### Step 4: External data source lookups

Priority order -- stop when you have enough signal for the entity's tier.

**4a. Brain cross-reference (always, all tiers)**
- `gbrain search "name"` and `gbrain query "what do we know about name"`
- Check related pages: company pages for person enrichment and vice versa
- This is free and often the richest source

**4b. Web research (Tier 1 and 2)**
- Use Perplexity, Brave Search, Exa, or equivalent web research tool
- **Key pattern:** Send existing brain knowledge as context so the search
  returns DELTA (what's new vs what you already know), not a rehash
- Opus-class models for Tier 1 deep research, lighter models for Tier 2

**4c. Social media lookup (all tiers when handle known)**
- Pull recent posts/tweets for tone, interests, current focus
- Social media is the highest-texture signal for what someone actually thinks

**4d. People enrichment APIs (Tier 1)**
- LinkedIn data, career history, connections, education

**4e. Company enrichment APIs (Tier 1)**
- Company data, financials, headcount, key hires, recent news

| Data Need | Example Sources | Tier |
|-----------|----------------|------|
| Web research | Perplexity, Brave, Exa | 1-2 |
| LinkedIn / career | Crustdata, Proxycurl, People Data Labs | 1 |
| Career history | Happenstance, LinkedIn | 1 |
| Funding / company data | Crunchbase, PitchBook, Clearbit | 1 |
| Social media | Platform APIs, web scraping | 1-3 |
| Meeting history | Calendar/meeting transcript tools | 1-2 |

### Step 5: Save raw data (preserves provenance)

Store raw API responses via `put_raw_data` in gbrain:
```json
{
  "source": "crustdata",
  "fetched_at": "2026-04-11T...",
  "query": "jane doe",
  "data": { ... }
}
```

Raw data preserves provenance. If the compiled truth is ever questioned,
the raw data shows exactly what the API returned.

### Step 6: Write to brain

#### CREATE path

1. Check notability gate (see `skills/_brain-filing-rules.md`)
2. Check filing rules -- where does this entity go?
3. Create page with the appropriate template (below)
4. Fill compiled truth with citations
5. Add first timeline entry
6. Leave empty sections as `[No data yet]` (don't fill with boilerplate)

#### UPDATE path

1. Add new timeline entries (reverse-chronological, append-only)
2. Update compiled truth ONLY if the new signal materially changes the picture
3. Update State section with new facts
4. Flag contradictions between new signal and existing compiled truth
5. Don't overwrite user-written assessments with API boilerplate

#### Person page template

```markdown
---
title: Full Name
type: person
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: []
company: Current Company
relationship: How the user knows them
email:
linkedin:
twitter:
location:
---

# Full Name

> 1-paragraph executive summary: HOW do you know them, WHY do they matter,
> what's the current state of the relationship.

## State
Role, company, key context. Hard facts only.

## What They Believe
Ideology, first principles, worldview. What hills do they die on?

## What They're Building
Current projects, recent launches, what they're focused on.

## What Motivates Them
Ambition, career arc, what drives them.

## Hobby Horses
Topics they return to obsessively. Recurring themes in their work/posts.

## Assessment
Your read on this person. Strengths, gaps, trajectory.

## Trajectory
Ascending, plateauing, pivoting, declining? Where are they headed?

## Relationship
History of interactions, shared context, relationship quality.

## Contact
Email, social handles, preferred communication channel.

## Network
Key connections, mutual contacts, organizational relationships.

## Open Threads
Active conversations, pending items, things to follow up on.

---

## Timeline
Reverse chronological. Every entry has a date and [Source: ...] citation.
- **YYYY-MM-DD** | Event description [Source: ...]
```

#### Company page template

```markdown
---
title: Company Name
type: company
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: []
---

# Company Name

> 1-paragraph executive summary.

## State
What they do, stage, key people, key metrics, your connection.

## Open Threads
Active items, pending decisions, things to track.

---

## Timeline
- **YYYY-MM-DD** | Event description [Source: ...]
```

### Step 7: Cross-reference

- Update company pages from person enrichment (and vice versa)
- Run the **Project & Goal Enrichment** sub-protocol (below) for every
  project / goal slug discovered in Step 1
- Check index files if the brain uses them

**Note (v0.10.1):** Links between brain pages are auto-created on every
`put_page` call (auto-link post-hook). Step 7 focuses on content
cross-references (updating related pages' compiled truth with new signal
from this enrichment), not on creating links. Verify via the `auto_links`
field in the put_page response (`{ created, removed, errors }`).
Timeline entries still need explicit `gbrain timeline-add` calls.

## Project & Goal Enrichment (lighter-weight protocol)

Project (`projects/<slug>.md`) and goal (`goals/<slug>.md`) pages are
**user-authored work trackers** — the user defines the scope, owner, and
target. The skill must NEVER create new project / goal pages from inferred
signal; it only refreshes pages the user already deliberately created.
The job is to keep them honest with what's actually happening.

### What this sub-protocol prevents

Without this, project pages drift: the user runs sessions for a week, ships
three increments, and the project page still shows the status it had when it
was last opened. The brain becomes a stale dossier. Active-work pages must
read like the project's living state, not last week's snapshot.

### Trigger

Step 1 found one or more `[[projects/<slug>]]` or `[[goals/<slug>]]`
references in the source content. For each unique slug, run the steps below.

### Steps

**P1. Resolve target page.** `get_page projects/<slug>` (or `goals/<slug>`).
If the page does NOT exist, **stop** — projects / goals are deliberate
user-authored entities; do not auto-create them. Log the unresolved
reference so the user can decide whether to create the page later.

**P2. Extract the new signal.** From the source content (session, original,
meeting transcript, etc.), distill ONE or TWO sentences describing what
changed for this project: a decision, a status delta, a blocker, a milestone
hit, a scope change, a learning. Use the user's exact phrasing where the
phrasing carries meaning (verbatim is preferred for status quotes).

**P3. Deduplicate against existing timeline.** Read the target page's
existing `## Timeline` section. If the most recent entry already captures
this signal (same date + same essence), **skip** — do not duplicate. If the
new signal extends or contradicts the latest entry, append a new entry.

**P4. Append timeline entry.**

```
- **YYYY-MM-DD** | <one- to two-sentence summary> [Source: <session/original slug>]
```

Use `add_timeline_entry` with the project / goal slug as target, the source
slug as the citation, and the source's source-of-truth date.

**P5. Refresh status / updated frontmatter (conditional).** Update the
target page's frontmatter when the signal warrants it:
- `updated:` — always bump to the source's date (the page is no longer stale)
- `status:` — only when the signal explicitly indicates a transition
  (e.g., active → paused, active → archived, planning → active). Never
  flip status from a vague mention. Quote the exact transition signal in
  the timeline entry.

**P6. Cross-link both directions.** The source page should already wikilink
to the project / goal (that's how Step 1 found it). Ensure the project /
goal page's `## Open` or `## Activity` section references the source via
the auto-link post-hook (which runs on `put_page`). Verify by reading the
target page after writing.

### What this sub-protocol does NOT do

- ❌ Create new project / goal pages from inferred signal
- ❌ Run notability gates, web research, or external API enrichment
- ❌ Rewrite compiled-truth sections (the user owns scope and framing)
- ❌ Flip status without an explicit transition signal in the source
- ❌ Append duplicate timeline entries when the signal is already recorded

### Retrospective sweep (cron-driven, optional extension)

In addition to the in-flow trigger above, a cron-driven variant is allowed:
periodically scan recent session / original / meeting pages for project /
goal references that have NOT yet been propagated to the corresponding
target page's timeline, and apply steps P1–P6 retrospectively. This is
useful when in-flow enrichment was skipped (e.g. ingest pipeline restart,
host-agent crash). The cron variant must use the same dedupe rule (P3) so
it is idempotent on repeated runs.

## Bulk Enrichment Rules

- **Test on 3-5 entities first.** Read actual output. Check quality.
- Only proceed to bulk after test shots pass your quality bar.
- 3+ entities from one source -> batch process or spawn sub-agent
- Throttle API calls. Respect rate limits.
- Commit every 5-10 entities during bulk runs.
- Save a report after bulk enrichment (see Report Storage below).

## Validation Rules

- Connection count < 20 on LinkedIn = likely wrong person, skip
- Name mismatch between brain and API = skip, flag for review
- Joke profiles or obviously wrong data = save to raw, don't update page
- Don't overwrite user-written assessments with API boilerplate
- When in doubt: save raw data but don't update brain page

## Report Storage

After enrichment sweeps, save a report:
- Number of entities processed
- New pages created vs existing updated
- Data sources called and results quality
- Notable discoveries or contradictions
- Validation flags or API failures

This creates an audit trail for brain enrichment over time.

## Anti-Patterns

- Creating stub pages with no content
- Enriching without checking brain first
- Overwriting user's direct statements with API data
- Creating pages for non-notable entities
- **Auto-creating project or goal pages** from inferred signal — projects /
  goals are user-authored; if the target slug doesn't exist, log and stop
- **Running web research / API enrichment on project / goal pages** — those
  pages are private work trackers, not entities-in-the-world
- **Flipping a project's `status:` from a vague mention** — only act on
  explicit transition signal quoted from the source
- **Appending duplicate timeline entries** on retrospective sweep — always
  dedupe against the page's existing timeline before writing

## Output Format

An enriched person page contains:
- **Frontmatter** with type, tags, company, relationship, and contact fields
- **Executive summary** (1 paragraph: how you know them, why they matter, relationship state)
- **State** section with hard facts and inline `[Source: ...]` citations
- **Texture sections** (What They Believe, What They're Building, What Motivates Them, Hobby Horses)
- **Assessment** with trajectory read
- **Relationship** history and contact info
- **Network** connections and mutual contacts
- **Timeline** in reverse chronological order, every entry dated with source citation

An enriched company page contains:
- **Frontmatter** with type and tags
- **Executive summary** (1 paragraph)
- **State** section (what they do, stage, key people, metrics, your connection)
- **Open Threads** (active items, pending decisions)
- **Timeline** in reverse chronological order with dated, cited entries

A refreshed project / goal page (lightweight enrichment) shows:
- **Existing user-authored content untouched** (scope, framing, milestones)
- **`updated:` frontmatter bumped** to the source's date
- **`status:` frontmatter updated** only when an explicit transition signal
  was quoted from the source (otherwise unchanged)
- **One or two new timeline entries** appended in reverse chronological
  order, each citing the originating session / original / transcript slug
- **No new compiled-truth content invented** by the skill

All page types have bidirectional back-links to every entity they mention.

## Tools Used

- Read a page from gbrain (get_page)
- Store/update a page in gbrain (put_page)
- Add a timeline entry in gbrain (add_timeline_entry)
- List pages in gbrain by type (list_pages)
- Store raw API data in gbrain (put_raw_data)
- Retrieve raw data from gbrain (get_raw_data)
- Link entities in gbrain (add_link)
- Check backlinks in gbrain (get_backlinks)
