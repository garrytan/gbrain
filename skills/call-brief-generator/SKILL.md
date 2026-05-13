---
name: call-brief-generator
version: 1.0.0
description: |
  Generate a pre-call brief deterministically from the CRM dealbook, brain
  context, and conference history. Outputs canonical markdown to
  ~/brain/briefs/ AND rendered HTML to web/public/briefs/. Locked schema,
  locked design tokens, zero inferred facts.
triggers:
  - "brief me on"
  - "prep call with"
  - "call brief for"
  - "/brief"
tools:
  - search
  - query
  - get_page
  - list_pages
  - put_page
  - get_recent_salience
mutating: true
writes_pages: true
writes_to:
  - briefs/
  - people/        # reciprocal-link append only
  - companies/     # reciprocal-link append only
---

# Call Brief Generator

Produce a pre-call brief that is queryable in gbrain AND usable on a phone
during the call. Two outputs, every time: canonical markdown + rendered HTML.

> **Filing rule:** Briefs live at `briefs/<slug>.md` per the [[brief-to-brain]]
> recipe schema. See `~/gbrain/recipes/brief-to-brain.md` for the canonical
> frontmatter shape and the dual-storage pattern this skill executes. See
> `skills/_brain-filing-rules.md` for cross-reference and back-link rules.

> **Convention:** see `skills/_output-rules.md` for "no slop" and
> "deterministic links" rules that every output line must satisfy.

## Contract

This skill guarantees:

- **Every fact pulled deterministically.** The counterparty's deals come from
  `~/Projects/active/hash-lemma/data/index.sqlite` (`deals` table, `owner` LIKE
  participant). Conference context comes from
  `~/brain/sources/hash-lemma/conferences/<slug>.md`. Calendar attendance
  comes from `~/brain/daily/calendar/<YYYY>/<YYYY-MM-DD>.md`. **Zero inferred
  locations, dates, names, numbers.** If a source does not have it, the field
  stays blank — never guess.
- **Dual storage, every time.** Markdown source at `~/brain/briefs/<slug>.md`
  (canonical, queryable, indexed). Rendered HTML at
  `~/Projects/active/hash-lemma/web/public/briefs/<slug>.html` (daily-driver
  UI, mobile-responsive, light mode).
- **Light mode only.** HTML uses the operator's light-paper palette. Token
  values are defined inline in the HTML template below — there is no dark
  variant, no `prefers-color-scheme` toggle.
- **Deliverable only.** The brief contains the final content. Zero scratch,
  zero audit, zero "v1 vs v2" commentary in the brief itself.
- **Reciprocal links everywhere.** Every entity referenced (people, deals,
  firms, events) gets a back-link to the brief appended to its
  `briefs_referenced_in:` frontmatter list. Per the Iron Law in
  `skills/_brain-filing-rules.md`, an unlinked mention is a broken brain.
- **Source-cite in footer.** The rendered HTML footer lists every source path
  used. Operator can audit any claim mid-call by tapping the source line.
- **No `slug:` field in frontmatter.** gbrain derives slug from path; an
  explicit `slug:` triggers `SLUG_MISMATCH` sync failure.

## Inputs

Required:
- `participant_slug` — canonical slug, e.g., `dewald-cloete`
- `date` — call date in `YYYY-MM-DD`

Optional:
- `context_event_slug` — if the call is anchored to a recent conference (e.g.,
  `consensus-miami-2026`). The skill verifies operator's calendar to confirm
  they were there before referencing it.
- `duration_min` — default `45`
- `category` — `call-prep` (default) | `post-call` | `one-pager` |
  `weekly-review` | `strategy-memo`

## Phases

### 1. Pull deterministic facts

Run these reads before writing a single word of brief content.

```sql
-- Dealbook owned by participant
SELECT name, stage, entity_type, deal_value, referred_by,
       delivery_channel, deal_length, follow_up_date,
       won_lost_date, comments
FROM deals
WHERE owner LIKE '%<participant-name>%'
ORDER BY won_lost_date DESC, stage;

-- Contacts owned by participant
SELECT name, title, companies, importance, last_contact,
       contact_type, location
FROM contacts
WHERE hash_person LIKE '%<participant-name>%'
ORDER BY importance DESC, last_contact DESC;
```

Then read:
- `~/brain/people/<participant_slug>.md` — existing context (role, location,
  open threads, known clients)
- `~/brain/sources/hash-lemma/conferences/<context_event_slug>.md` — if a
  context event was provided
- `~/brain/daily/calendar/<year>/<date>.md` — to confirm operator was at the
  context event. **If the calendar entry is missing, do not reference the
  event in the brief.** This is the anti-hallucination guard.

### 2. Synthesize the brief

Apply the five-block template. Each block has a time budget and a purpose:

| Block | Time | Purpose |
|-------|------|---------|
| 01 Opener | 2 min | Natural callback referencing verified shared context. If participants have ≥ 3 timeline entries together, drop the new-hire framing. |
| 02 Context debrief | 3-4 min | Free intel surface — if event provided, ask what they took from it. |
| 03 Dealbook | 12-15 min | Anchor to 3-5 specific deals. Mix wins (reference stories), losses (pattern interrogation), pricing-sent (unsticking). |
| 04 Referrer firms | 5-7 min | Firms where participant is `hash_person` for the firm relationship. Live vs cold map. |
| 05 Ask + next step | 5-8 min | Operator's BD plays + ONE concrete next step (a deliverable + deadline, NOT a "one-pager redline" framing). |

Defaults:
- **Lead with wins, not losses.** Reference stories outrank postmortems unless
  `category=post-call`.
- **Distinguish CRM-`owner` ambiguity.** A deal where `owner=<participant>`
  means either (a) they sit as director-of-record OR (b) they source/close
  but someone else sits. Frontmatter must clarify with a `dewald_role:` (or
  participant-specific) field.
- **Cap the deal walkthrough at 4 deals.** Anything more burns the slot.
- **No emoji in headers.** Operator's voice is unadorned.

### 3. Write outputs

1. Write markdown to `~/brain/briefs/<slug>.md` per `~/gbrain/recipes/brief-to-brain.md`.
2. Render HTML to `~/Projects/active/hash-lemma/web/public/briefs/<slug>.html` using the design tokens below.
3. Append `briefs:` list entry to `~/brain/people/<participant_slug>.md` frontmatter.
4. For each deal / firm / event referenced, append `briefs_referenced_in:` to the entity's frontmatter.
5. `git add` + commit the brain repo with message: `brief: <participant> <date> — pre-call (<N> deals, <M> firms)`.
6. Run `gbrain sync --no-pull --no-embed --repo ~/brain && gbrain embed --stale && gbrain extract links --dir ~/brain`.
7. Heartbeat to `~/.gbrain/integrations/brief-to-brain/heartbeat.jsonl`.

### 4. Verify before declaring done

- Open the HTML in browser (`open <path>`).
- Run `gbrain query "<participant first name> brief"` — confirm the new brief is rank 1.
- Confirm participant page now has the `briefs:` frontmatter entry.

If any verification fails, the skill has not completed.

## Output Format

Markdown frontmatter (canonical, locked):

```yaml
---
type: brief
category: call-prep
title: "<Participant first name> — Call Brief"
participants:
  - "[[people/<participant>]]"
  - "[[people/anoop-kansupada]]"
date: <YYYY-MM-DD>
duration_min: <int>
context_event: "[[sources/conferences/<slug>]]"  # only if calendar-confirmed
deals_referenced:
  - name: "..."
    monday_item_id: "..."
    stage: "..."
    deal_value: <int|null>
    referred_by: "..."
    closed: <date|null>
firms_referenced:
  - "[[companies/<slug>]]"
artifact_html: "web/public/briefs/<slug>.html"
status: pre-call
generated_by: claude
generated_at: <ISO>
sources:
  - "data/index.sqlite#deals where owner=<participant>"
  - "data/conferences/<event-slug>.json"
  - "daily/calendar/<YYYY>/<YYYY-MM-DD>.md"
related_granola: null
tags: [brief, call-prep, hash-directors, <participant-slug>]
---
```

Body shape (locked five-block structure):

```
# <Participant first name> — Call Brief

> **Context:** <one-line context sentence>

**Slot:** <N> min · Granola will record · <N> deals in his book
(<W> Won, <L> Lost, <P> Pricing Sent)

---

## Block 01 · Opener (2 min)

> *"<verbatim opening line>"*

## Block 02 · Context debrief (4 min)

- <question 1>
- <question 2>
- <question 3>

## Block 03 · The dealbook — wins, losses, stuck (14 min)

### → <Deal Name> — <one-line context>
- <probe 1>
- <probe 2>
- <probe 3>

...

## Block 04 · Referrer firms (7 min)
...

## Block 05 · Switching motion + the ask (8 min)
...

## Concrete next step

> *"<specific deliverable + deadline>"*

---

## Dealbook cheat sheet
<table: Stage | # | Names worth dropping>

## Open threads worth landing softly
<3 lines: things the brain doesn't know yet>

## Sources
<cited paths>
```

HTML design tokens (light mode, locked):

```css
--bg:         #f7f2e8;   /* warm paper */
--bg-card:    #ffffff;   /* clean card */
--ink:        #1a1612;   /* warm near-black */
--ink-dim:    #6b5e4d;   /* warm grey */
--rule:       #d9cdb7;
--rule-strong:#b9a886;
--accent:     #c0451f;   /* terracotta */
--accent-soft:#d97045;
--green:      #2e7d51;
--red:        #b8392e;
--serif:      'Instrument Serif', Georgia, serif;
--sans:       'Inter Tight', system-ui, sans-serif;
--mono:       'JetBrains Mono', ui-monospace, monospace;
```

Typography hierarchy: H1 = Instrument Serif clamp(40px,7vw,68px) weight-400.
H2 = Instrument Serif 30-34px. Body = Inter Tight 15-16px. Data tables and
metadata = JetBrains Mono 11-12px. Never use Inter, Roboto, or Arial.

## Anti-Patterns

- **Inferring an event location.** If the calendar entry is not on disk, do
  not write "we met at X" — write nothing or a blank field. See
  [[deterministic-data-only]] memory; the canonical failure was "Consensus
  Toronto" when 2026 was Miami.
- **Showing audit reasoning in the brief.** No "v1 vs v2" framing, no "CoS
  audit of pre-call draft," no scratch. The brief is the final deliverable
  the operator opens during the call. See [[deliverable-only-no-scratch]].
- **Walking through every CRM deal owned by the participant.** Caps the call
  before it starts. Four deals max, chosen for strategic mix.
- **Dark backgrounds in the HTML.** Never. See [[no-dark-mode]] — light only.
- **Asking "who are your clients."** The brief already lists them. The brief
  is your prep; questions are anchored to specific deal names.
- **Including a `slug:` field in frontmatter.** Triggers `SLUG_MISMATCH` —
  gbrain derives slug from path.
- **Generic "send you a one-pager redline" close.** Replace with a real,
  specific deliverable + deadline + medium ("Friday I'll send the NXT-loss
  postmortem via email").

## Idempotency

Re-running on the same `(participant, date)` overwrites the brief markdown +
HTML in place. Reciprocal-link appends are de-duplicated (skill checks
existing `briefs:` list before appending). Safe to re-run.

## Failure modes + recovery

| Symptom | Cause | Fix |
|---------|-------|-----|
| Sync fails with `SLUG_MISMATCH` | Frontmatter has `slug:` field | Remove the `slug:` line; gbrain derives slug from path |
| HTML has dark backgrounds | Wrong design tokens loaded | Use the light palette in this skill's Output Format section |
| Brief references location/date that's wrong | Inferred fact (forbidden) | Per [[deterministic-data-only]] memory, fall back to blank field; never guess |
| Participant has 50+ CRM contacts | Walked through every contact, brief is unusable | Cap at 4 deals + top 5 contacts by importance; rest stays in cheat-sheet table |
| No prior history with participant | Default Block 01 is "new hire" framing | If `~/brain/people/<slug>.md` has fewer than 3 timeline entries with operator, use new-hire opener; otherwise reference verified shared context |

## What this skill does NOT do

- Does NOT call external scrapers (LinkedIn / web). All inputs are local:
  gbrain + CRM SQLite + calendar.
- Does NOT send the brief anywhere. The HTML is opened locally; the operator
  decides distribution.
- Does NOT generate slides or PDFs. Output is markdown + HTML only.
- Does NOT modify CRM source data. Read-only against
  `~/Projects/active/hash-lemma/data/`.

## See also

- [[post-call-processor]] — runs AFTER Granola transcript lands; closes the loop
- [[brain-ops]] — general brain query patterns
- [[meeting-ingestion]] — Granola pipeline producing the transcripts the
  post-call counterpart consumes
- `~/gbrain/recipes/brief-to-brain.md` — schema authority

## Tools Used

- Search gbrain by name (`search`)
- Read a page (`get_page`)
- List pages by type (`list_pages`)
- Write a new page (`put_page`)
- Query the dealbook DB via Bash + sqlite3 (deterministic, no API)
- Render the HTML via the inline design tokens
