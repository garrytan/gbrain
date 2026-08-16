---
name: meeting-ingestion
version: 2.2.0
description: |
  Ingest meeting transcripts from ANY meeting recorder into brain pages with
  attendee enrichment, entity propagation, and timeline merge. One unified
  pipeline: normalize the source into a standard transcript record, split
  multi-meeting recordings, resolve speakers by evidence, create the page,
  pass every surprising claim through the consistency check (transcript +
  brain + plausibility), enrich every entity, then run the verification
  checklist — substance AND sequence. A meeting is NOT fully ingested until
  the enrich skill has processed every entity AND the verification checklist
  passes, including the sequence verify (PASS or explicit user waive).
triggers:
  - "meeting transcript"
  - "process this meeting"
  - "meeting notes"
  - "meeting recorder"
  - "ingest this recording"
  - "capture meetings"
  - "audit this meeting"
  - "check the sequence"
  - "did I get the order right"
  - meeting transcript received
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - get_timeline
  - chronicle_day
mutating: true
writes_pages: true
writes_to:
  - meetings/
  - people/
  - companies/
upstream:
  - meeting-ingestion@fc834ee
  - meeting-gold-standard@fc834ee
  - chronology-guard@fc834ee
---

# Meeting Ingestion Skill — Unified Pipeline

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any new page.

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking, and
> `skills/conventions/brain-first.md` for the lookup chain — resolve every name
> against the brain BEFORE reaching for external lookups.

## Contract

This skill guarantees:
- Works with ANY meeting recorder — AI notetaker export, webhook payload, share
  link, raw audio transcription, or manual paste. The normalized transcript
  record (below) is the contract; per-source fetch/parse is the host agent's job
- One brain page per REAL meeting — multi-meeting recordings are split first
- Meeting page created with attendees, summary, key decisions, action items,
  notable quotes
- Speakers resolved by evidence, never by guess
- Recorder auto-summaries treated as CLAIMS, not facts — every surprising claim
  passes the consistency check before it touches an entity page
- EVERY attendee gets a people page (created or updated)
- EVERY company discussed gets entity propagation
- Timeline entries on ALL mentioned entities (timeline merge)
- Back-links created bidirectionally
- Meeting is NOT fully ingested until enrich runs for every entity
- The meeting is never REPORTED as ingested until the verification checklist
  (below) passes — every quote grounded, every slug backed by a page and a
  timeline backlink, every speaker resolved or flagged
- The narrated SEQUENCE is verified independently of substance: a sequence
  contradiction BLOCKS ingestion until fixed or explicitly waived by the user

Every attendee and company mentioned MUST get a back-link from their page to
the meeting page. An unlinked mention is a broken brain.

## Any recorder, one pipeline

Meeting content arrives from many sources: an AI notetaker (Granola and
Circleback are common examples), a phone voice memo, a video-call transcript
export, or a transcript the user pastes directly. Do NOT build per-vendor
pipelines or paraphrase this skill in ad-hoc instructions — normalize whatever
the source provides into the transcript record below, then run the shared
phases. Source-specific logic ends at normalization.

## The normalized transcript record

Before running the pipeline, reduce the input to this shape (mentally or as a
scratch file — it does not get written to the brain as-is):

```yaml
source: "<recorder name, or 'manual'>"
source_id: "<unique recording id from the source, if any>"
title: "Meeting Title"
date: YYYY-MM-DD
time: "HH:MM TZ"               # null if unknown
duration: "45m"                # null if unknown
attendees:                     # the SOURCE'S notion of who was there —
  - name: "..."                # may need correction during speaker resolution
    email: "..."               # only if the source provides it
    role: "..."                # only if known
transcript_segments:           # structured form when the source diarizes
  - speaker: "..."             # resolved name OR "UNKNOWN_N" if unresolved
    speaker_raw: "..."         # the source's raw speaker label, for traceability
    text: "..."
raw_transcript_text: "..."     # the complete transcript. NEVER truncate.
source_summary: "..."          # the recorder's AI summary if present — a CLAIM, not a FACT
source_url: "..."              # link back to the source platform, if any
```

**Invariants:**
- `raw_transcript_text` is complete and untruncated. Always.
- `attendees` is a claim by the source. People invited ≠ people present.
- `source_summary` is TWO lossy layers deep (speech-to-text, then AI
  summarization). Both layers confabulate. Verify before writing anything
  from it into the brain.

Retain the raw transcript when the source provides one: file it as a sidecar
page (e.g. `meetings/YYYY-MM-DD-{slug}-transcript`) or keep the source file
reachable, and link it from the meeting page. The transcript is the canonical
evidence for every quote and claim check downstream.

**Redact before you retain.** A raw transcript routinely captures pasted
secrets and PII (a read-aloud API key, a screen-shared token, a private phone
number). Before writing the sidecar, scan for secret-shaped strings (`sk-…`,
`ghp_…`, `AKIA…`, bearer tokens, long hex/base64 blobs) and PII, and redact
matches to labeled placeholders — same deterministic deny-list /
`runPrivacyLint` model as `conversation-archive`. "Untruncated" means the
transcript's substance, never a live credential.

## Phases

### Phase 1: Normalize the input

Build the transcript record from whatever arrived. If the input is malformed
(empty transcript, summary-only payload with no transcript, in-progress
recording), STOP — do not create a meeting page from a summary alone. Surface
the problem to the user.

For raw transcript files with no structure at all, `gbrain capture` is the
preferred entry (it handles dedup and frontmatter routing); this pipeline is
for building structured meeting pages.

### Phase 2: Split detection — one recording is not always one meeting

A single recording is often several distinct meetings stitched together (a
recorder left running across back-to-back sessions). Detect this BEFORE page
creation, so each real meeting becomes its own page and dedupes/enriches
correctly.

**Split signals** (one is enough to investigate; two or more = split almost
certainly):
- **Roster shift** — a new person arrives mid-transcript (a greeting deep into
  the file), or the speaker set in the back half differs from the front
- **Topic hard-cut** with no continuity between the halves
- **Context reset** — "ok, next one", a fresh intro round, a restart phrase
- **The source's own title/agenda names multiple sessions**

**When a split is detected:**
1. Find the boundary segments — the exact points where roster/topic flips.
2. Partition the segments into N contiguous chunks, one per real meeting.
   Never drop or duplicate a segment; the union must equal the original, in order.
3. Run the remaining phases once per chunk → N separate meeting pages, each
   with its own corrected attendees, title, and time.
4. Cross-link the sibling pages ("same recording, session k of N") and note
   the shared `source_id` so dedup never re-merges them.

**Borderline judgment:** same people + one flowing conversation that wanders
topics = ONE meeting; don't over-split. The test is roster + hard context
break, not "the topic changed." If you genuinely cannot tell, surface the
boundary to the user rather than guessing.

### Phase 3: Dedup across recorders

Users increasingly run two recorders at once as a backup. Before creating a
page, check whether the same meeting already exists:
`gbrain search "{title or attendee names}"`, then match by date ± 1 day +
attendee overlap ≥ 50% + similar title.

- If a page exists, MERGE into it instead of creating a duplicate: build from
  the RICHER transcript, record both source ids in frontmatter.
- Source *priority* (which diarization to trust) is not source *completeness*
  (which transcript is fuller). One recorder may capture 20% of a session the
  other captured fully. Compare lengths; keep the fuller transcript as the
  grounding evidence.

### Phase 4: Speaker resolution — before writing the page

Recorders ship anonymous labels (`UNKNOWN_N`, `Participant 2`, `microphone`)
and sometimes confidently WRONG names. Resolve by evidence:

1. Start from the source's attendee list, corrected by any roster evidence the
   user can provide (an invite list, an event page, "it was just me and
   charlie-example").
2. **Never guess.** When uncertain, write `[Room]` or `UNKNOWN` and flag it.
   A wrong attribution is worse than no attribution.
3. Cross-reference the brain: `gbrain search "{name}"` for each candidate;
   read their page before accepting an identification.
4. Assign each named speaker a confidence: `high` (roster-confirmed), `medium`
   (named unambiguously in the transcript), `low` (inferred from content —
   flag explicitly).
5. **Content-identity check:** for every named speaker who claims a
   role/company/product in their own words ("I founded X", "at my company Y
   we…"), verify the claim against that person's brain page. If the named
   person's established identity CONTRADICTS what the speaker says about
   themselves, the recorder substituted the wrong person — resolve by
   identity, not by name, and reattribute the whole track.
6. **Phantom-speaker check:** if the recorder reports MORE distinct speakers
   than the known attendee count, suspect over-splitting — one real voice
   diarized into two labels. Tells: two labels never address each other, or
   hand off mid-thought. Collapse phantoms into the real attendee.
7. **User ground truth overrides everything.** If the user states who was in
   the room, that beats the recorder's diarization AND the roster. Reattribute,
   fix the page, and never re-litigate a room the user has confirmed.
8. Speech-to-text garbles names constantly. Before creating a NEW person page
   from a transcript-only name, search the brain for plausible spelling
   variants of the surname; default assumption is that a near-miss IS the
   existing person with a mangled name. Update the existing page and record
   the variant as an alias rather than creating a duplicate.

### Phase 5: Create meeting page

```markdown
# {Meeting Title} — {Date}

**Attendees:** {list with links to people pages}
**Date:** {YYYY-MM-DD}
**Duration:** {if available}

## Summary
{3-5 bullet key outcomes}

## Key Decisions
{Decisions with context. If none: _No decisions — discussion only._}

## Action Items
{Tasks with owners and deadlines. If none: _None — exploratory conversation._}

## Notable Quotes
{Verbatim from the transcript, attributed, `>` blockquotes.
If none: _No notable quotes — operational/logistics meeting._}

## Discussion Notes
{Structured notes by topic}
```

The four required sections are Summary, Key Decisions, Action Items, and
Notable Quotes — additional sections (Discussion Notes, a link to the
transcript sidecar) are additive, never replacements. An empty section always
carries an explicit reason; a bare `- None.` is a dodge, not an answer.

Quotes are VERBATIM. Write what was said the way it was said — a paraphrase in
a blockquote is a fabricated quote.

### Phase 6: Claim verification + consistency check (gate for every entity write)

Recorder summaries inject false facts: speech-to-text garbles proper nouns,
and AI summaries turn banter into commitments. Before writing ANY of the
following claim types to a person/company page (compiled truth, frontmatter,
or timeline), verify:

| Claim type | Verification bar |
|---|---|
| Relationship/role change ("joined as cofounder", "became CTO", "left widget-co") | Find the verbatim transcript lines. The claim must be EXPLICIT in what was said, not an inference from enthusiasm. |
| Ownership/attribution ("her project", "his company") | A speaker saying a word ≠ owning the thing. Require explicit ownership language or brain corroboration. |
| New proper nouns (project/company/product names not already in the brain) | Search the brain and the web for the canonical spelling first. If unresolvable, annotate `(unverified spelling)` — never write it bare. |
| Major life/deal events (raised, acquired, hired, shut down) | Verbatim transcript support required. These propagate the furthest and are the most expensive to be wrong about. |

**Consistency check — transcript support alone is NOT sufficient.** A claim
can be faithfully transcribed and still wrong. Every claim that passes the
transcript bar ALSO gets:

1. **Brain contradiction check.** `gbrain query "{entity}"` and read the
   relevant pages. Does the new claim CONTRADICT established brain truth?
   When it does, the ESTABLISHED truth wins by default — flag the conflict to
   the user, don't silently overwrite. New claims override old truth only with
   explicit, verbatim, unambiguous transcript support, and even then the
   change is flagged in the ingest report.
2. **Logic/plausibility check.** Is the claim POSSIBLE given what else is
   known? Two people can't both independently "start" the same project; a
   company founded last year can't have been acquired five years ago. A
   logical impossibility means a probable garble — investigate before writing.
3. **Surprise = signal.** If a claim would make the user say "wait, what?",
   that surprise is exactly when these checks are mandatory. Boring claims
   ("discussed metrics", "attended") pass on transcript verification alone;
   surprising claims need every layer. Don't rationalize surprise into a story
   that fits — surface it as a question.

**Downgrade protocol:** if the transcript supports only an inference, record
it as an explicitly-uncertain note on the meeting page — never in an entity
page's compiled truth or frontmatter.

**Propagation rule:** a claim that fails verification must not fan out. Do not
copy it to other entity pages or timeline entries. A false claim written to
five pages costs five corrections.

### Phase 7: Attendee enrichment (MANDATORY)

For EACH attendee:
1. `gbrain search "{name}"` — does a people page exist?
2. If NO → create via the enrich skill (`skills/enrich/SKILL.md`). Every
   person who was actually IN the meeting gets a page, even a thin one. Skip
   only ephemeral third-party mentions (a name invoked about someone not
   present, with no standalone context) and non-participants (a server taking
   orders).
3. If YES → update compiled truth with meeting context (subject to Phase 6).
4. Add a timeline entry on the person's page:
   `gbrain timeline-add {person-slug} {date} "Attended {meeting-title}"`

Back-link known people who are MENTIONED or SPEAK in the transcript too, not
just attendees — but high-confidence identifications only. Never backlink a
garbled name or a low-confidence guess; a wrong backlink pollutes the graph
worse than a missing one.

**Note:** Once the meeting page is written via `gbrain put`, the auto-link
post-hook automatically creates `attended` links from the meeting to each
attendee whose page is referenced as `[Name](people/slug)`. You don't need to
call `gbrain link` for attendees. You DO still need `gbrain timeline-add` for
dated events (auto-link only handles links, not timeline entries).

### Phase 8: Entity propagation + timeline merge (MANDATORY)

For each company, project, or concept discussed:
1. Check the brain for an existing page (`gbrain search`, then `gbrain get`).
2. Create/update as needed (claims subject to Phase 6).
3. Add a timeline entry referencing the meeting.
4. Back-link from entity page to meeting page.

**Timeline merge:** the same event appears on ALL mentioned entities'
timelines. If alice-example met charlie-example at acme-example, the event
goes on alice-example's page, charlie-example's page, AND acme-example's page.
For a multi-company session (e.g. group office hours), disaggregate the
feedback per company — each company's timeline entry carries its own content,
not a blob about the whole session.

If the meeting contains original thinking worth extracting beyond the page
itself, chain into `skills/signal-detector/SKILL.md` after ingestion.

### Phase 9: Sync

`gbrain sync` to update the index.

## Verify before declaring done (HARD GATE)

The write phases do the work; this phase verifies the work was actually done.
Run the checklist on the finished page — every item, every meeting, including
"quick" logistics meetings. **Never report a meeting as ingested until every
item passes.** Saying "ingested" first and fixing later is a contract
violation; a false completion report is worse than an honest partial one.

**V1 — Required sections have substance.**
- `## Summary` carries real outcomes (2+ bullets or a few substantive
  sentences), not one vague line.
- `## Key Decisions`, `## Action Items`, and `## Notable Quotes` each have
  real content OR an explicit reason (`_None — exploratory conversation._`).
- A bare `- None.` or `_n/a_` written to silence the checklist is a violation.
  Before writing "none", confirm against the transcript that there truly were
  no decisions/commitments/quotes worth keeping.

**V2 — Every people/companies slug has a page AND a timeline backlink.**
For each person/company slug referenced by the meeting page:
```bash
gbrain get people/{slug}          # page exists?
gbrain timeline people/{slug}     # has an entry pointing back at this meeting?
```
A slug with no page means Phase 7/8 was skipped — go do it. A page with no
timeline entry for this meeting means the merge was incomplete — add it.

**V3 — Speaker map resolved.**
No `Participant N` / `UNKNOWN_N` / raw recorder labels remain in the page
without either a resolution or an explicit uncertainty flag (`[Room]`,
`⚠️ attribution uncertain`). Every named speaker carries a confidence from
Phase 4. An unflagged anonymous label means speaker resolution was skipped.

**V4 — Every quote grounded VERBATIM in the transcript.**
- **Deterministic check (transcript retained):** for each `>` blockquote,
  verify its contiguous span appears in the transcript sidecar. Filler words
  (`like`, `you know`, `I mean`) may be stripped from both sides; a genuine
  quote still shares a long contiguous run of content words, a fabricated one
  does not.
  ```bash
  gbrain get meetings/{date}-{slug}-transcript   # then locate each quote span
  ```
- **Prompt checklist (no transcript retained):** re-read the source notes and
  attest that each quote traces to them word-for-word.
- When a quote fails grounding, the fix is almost always to restore the spoken
  phrasing (or pick a cleaner contiguous span) — NOT to delete the quote, and
  never to keep the paraphrase inside the blockquote.

**V5 — Fabricated-attendee sanity checks.**
Recorders confidently invent names and emails for unlabeled speakers.
- An attendee name that appears NOWHERE in the transcript or roster evidence
  did not survive the evidence — treat it as a guess. Identify the real person
  from in-call tells (companies, shared history) or remove the name.
- An attendee email whose domain doesn't match the person's claimed org is a
  fabrication suspect (recorders commonly grab the host's domain). Verify the
  real address or clear the field.
- When either fires: do NOT auto-rename or auto-fill. Read the transcript,
  resolve by evidence, correct the page + frontmatter + backlinks, then re-run
  this checklist.

**V6 — Sequence verify (order, not substance).**
A meeting page can be right on depth and wrong on order — they are independent
failure axes, and V1–V5 never look at order. Verify the narrated sequence:

1. **Extract event atoms.** Walk the page body in document order and list each
   narrated sub-event as `{phase, place, people}` — where `phase` is its
   position relative to the meeting's central event (before / during / after)
   as the PROSE claims it.
2. **Deterministic checks** (agent-executed, mechanical — no judgment needed):
   - **PHASE_INVERSION (hard):** an atom narrated as "before" appears after
     the central event in the document's sequence (or vice versa). Example: the
     page narrates the debrief of alice-example's pitch, then narrates the
     pitch itself as if still upcoming.
   - **TELEPORT (hard):** the same person is placed in two non-adjacent
     locations with no transit or movement narrated between them. Example:
     alice-example is in the car en route in one paragraph and already inside
     the acme-example office in the next, with nothing connecting the two.
3. **Day-timeline corroboration (soft):**
   ```bash
   gbrain day {date}
   ```
   assembles that day's events and timeline entries across the whole brain.
   - **DAY_TIMELINE_GAP:** a narrated participant who never appears in the
     day's assembled timeline is a SIGNAL, not a hard fail — most often it
     means their timeline entry was never written (go fix Phase 7/8), and
     occasionally it means the narration names someone who wasn't there.
     Investigate; don't auto-block.
4. **Verdict — PASS or BLOCK.**
   - No hard contradiction → **PASS**. Proceed to report.
   - Any PHASE_INVERSION or TELEPORT → **BLOCK**. The meeting is NOT ingested.
     Fix the narration (re-read the transcript for the true order) and re-run
     V6 — or, if the user explicitly says the order is fine as written, record
     a **waive**. A waive is logged in the report as acknowledged, NOT
     resolved: `sequence: WAIVED by user — {contradiction} stands`.
   - Genuinely ambiguous order (flashbacks, prose that implies but doesn't
     state a sequence) is a judgment call, not a deterministic class — flag it
     in the report, don't block on it.

**The loop:** fix → re-check → fix, until every item passes (or V6 is
explicitly waived). Only then report.

## Sensitive meetings

If the title or transcript signals legal or deeply personal content
(deposition, attorney, counsel, privileged, health): keep the page minimal and
factual, do not extract biographical color into other pages, and prefer
restraint on back-links. When in doubt about whether content should propagate,
ask the user.

## Output Format

Meeting page created AND the verification checklist passed. Report: "Meeting
ingested: {N} attendees enriched, {N} entities updated, {N} action items
captured. Verification: passed. Sequence: PASS." If the sequence check was
waived, say so explicitly: "Sequence: WAIVED by user — {contradiction} stands
(acknowledged, not resolved)." If the recording was split, report one line per
resulting meeting page. If a claim was withheld or a contradiction flagged by
Phase 6, list each flag — the user resolves them, not silence. If any
checklist item cannot be made to pass, report the meeting as NOT ingested and
name the failing item.

## Anti-Patterns

- Creating the meeting page without enriching attendees
- Skipping entity propagation ("I'll do that later")
- Not merging timelines across all mentioned entities
- Creating attendee stubs without meaningful content
- Filing meeting pages without cross-linking to all participants
- Building a per-vendor pipeline or paraphrasing this skill in ad-hoc
  instructions instead of normalizing to the transcript record
- Treating a recorder auto-summary name or claim as fact without transcript
  verification
- Writing a summary's relationship/role/ownership claim into an entity page
  without finding the verbatim transcript line
- Writing a garbled proper noun bare instead of resolving canonical spelling
- Fanning an unverified claim out to multiple entity pages
- Silently overwriting established brain truth with a new meeting claim
  instead of flagging the contradiction
- Guessing a speaker identity instead of writing `[Room]`/`UNKNOWN` and flagging
- Truncating a transcript, or paraphrasing inside a quote blockquote
- Ingesting one page for a recording that contains two meetings
- Reporting "ingested" before the verification checklist passes
- Writing `- None.` under a required section to silence the checklist without
  confirming against the transcript
- Skipping the checklist because "it's just a quick logistics meeting"
- Declaring a page ingested while a sequence contradiction stands unresolved
  and unwaived
- Treating a user waive as a resolution — a waive is an acknowledgment; the
  contradiction is still in the page
- Passing a page that puts a person in two non-adjacent places with no
  transit between them
- Re-checking substance in the sequence pass (or order in V1–V5) — the axes
  are orthogonal by design
