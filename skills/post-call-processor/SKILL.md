---
name: post-call-processor
version: 1.0.0
description: |
  After a Granola transcript lands and matches a pre-call brief, link the two,
  extract structured facts into entity pages, create task pages for committed
  action items, and draft a follow-up email. Locked output schema. Drafts
  never auto-sent.
triggers:
  - "process call"
  - "debrief"
  - "post-call"
  - "what came out of the call"
  - "/debrief"
tools:
  - get_page
  - put_page
  - list_pages
  - search
  - query
  - add_link
  - add_timeline_entry
mutating: true
writes_pages: true
writes_to:
  - briefs/          # status update + post-call section
  - meetings/        # prep_brief link
  - tasks/           # new
  - emails/          # new draft
  - people/          # service_provider + intel updates
  - companies/       # service_provider + deal-status updates
---

# Post-Call Processor

Close the loop after a call. Brief + transcript become a debriefed brief +
N task pages + draft follow-up email + updated entity pages with structured
facts. Drafts are never auto-sent — the operator reviews and ships.

> **Filing rule:** All output follows `~/gbrain/recipes/brief-to-brain.md`
> schemas. See `skills/_brain-filing-rules.md` for cross-reference and
> back-link rules.

> **Convention:** see `skills/_output-rules.md` for "no slop" and
> "deterministic links" rules. Citation format per
> `skills/conventions/quality.md`.

## Contract

- **Trigger condition.** A new `~/brain/meetings/<YYYY-MM-DD>-<participant>.md`
  exists AND a matching `~/brain/briefs/<slug>.md` has `status: pre-call`
  (or `in-progress`) AND `participants:` overlap AND `date:` matches.
- **Idempotent.** Re-running on the same brief/transcript pair is a no-op
  (`status: post-call-debrief` short-circuits unless `--force`).
- **Drafts never auto-sent.** The follow-up email is `status: draft`
  always. Operator reviews, edits, sends from their real mail client. Per the
  standing rule that chat-written outbound copy fails brand voice, this skill
  produces operator-reviewable copy, not an outbound message.
- **Confidential facts get routed.** When the transcript contains markers
  ("don't share this," "between us," "sensitive"), the extracted fact lands in
  a separate `confidential:` frontmatter field on the brief, NEVER in the
  public body, and a task is created tagged `confidential` to remind the
  operator. The follow-up email's body never contains the confidential fact —
  only an acknowledgement P.S. if the operator made a commitment around it.
- **Deterministic extraction schema.** The LLM extraction pass produces YAML
  matching the schema in the Extraction Schema section below. The schema is
  the contract — outputs that don't validate get a manual-review task created
  instead of being silently written.
- **Deliverable only.** No "v1 vs v2" commentary in the artifacts. Per
  [[deliverable-only-no-scratch]].
- **Reciprocal links everywhere.** Brief ↔ transcript, both ↔ tasks, tasks ↔
  email, all four ↔ referenced deals/people/firms. Iron law per
  `skills/_brain-filing-rules.md`.

## Inputs

Required (or auto-detected):
- `brief_slug` — e.g., `dewald-cloete-2026-05-13`
- `meeting_slug` — e.g., `2026-05-13-dewald-cloete`

Auto-detect mode: scan `~/brain/meetings/*.md` mtime > last-run cursor; for
each, find matching brief by `(participants, date)` tuple. Cursor lives at
`~/.gbrain/integrations/post-call-processor/cursor.json`.

## Phases

### 1. Load context

```bash
# Read the artifacts and pull entity context
gbrain get briefs/<brief_slug>
gbrain get meetings/<meeting_slug>
# For each entity referenced in brief frontmatter:
gbrain get <entity_slug>
```

Build a context dict: brief body, transcript body, prior state of each entity.

### 2. Extract structured facts (LLM, locked schema)

Single LLM pass. Output must validate against this schema or the skill
short-circuits to a manual-review task.

```yaml
covered_vs_planned:
  - block: "Block 01 — Opener"
    planned: "<the opener line from the brief>"
    covered: "<what actually happened>" | "skipped"
  # ...one entry per block in the brief

new_facts:
  - subject: "[[<type>/<slug>]]"        # person, company, deal
    fact_type: service_provider | relationship | deal_status | pricing | network | competitive_intel | personal_context
    fact: "<close paraphrase or verbatim>"
    confidence: high | medium | low
    quote: "<exact transcript line>"
    confidential: false

service_provider_updates:
  - subject_page: "[[companies/<slug>]]"
    role: directorship | legal_counsel_cayman | legal_counsel_us | accountant | auditor | custodian | bank | transfer_agent | token_issuer | compliance | tax_advisor | marketing | pr | treasury_manager | registered_office | vasp | kyc_aml
    firm: "[[companies/<slug>]]"
    individuals: ["[[people/<slug>]]"]
    notes: "<context from transcript>"

deal_status_updates:
  - deal_name: "..."
    new_stage: "..." | null
    new_blocker: "..." | null
    new_intel: "..." | null

action_items:
  - title: "..."
    owner: "<operator-slug>" | "<participant-slug>"
    deadline: <YYYY-MM-DD> | null
    priority: high | medium | low
    notes: "<full context including transcript quote>"
    confidential: false

confidential_flags:
  - context: "<what makes it confidential>"
    fact: "<the fact>"
    handling: do_not_spread | internal_only | operator_only

gap_feedback:
  - issue: "<what the brief got wrong or missed>"
    fix: "<concrete change to template/generator>"
```

### 3. Update the brief

1. Frontmatter: `status: post-call-debrief`, `related_granola: "[[meetings/<meeting_slug>]]"`.
2. Append a `## Post-call debrief — what we actually covered` section with:
   - `### Covered vs planned` table
   - `### New facts surfaced` bullets
   - `### What the brief got wrong (for future generations)` — operator-self-identified + LLM-identified gaps from `gap_feedback`
3. **Do NOT touch the pre-call body sections.** Preserve the audit trail of
   what was planned.

### 4. Update the transcript

1. Append to frontmatter: `prep_brief: "[[briefs/<brief_slug>]]"`,
   `participants: [...]` (canonicalize "Unknown" Granola attendees against
   brief participants).
2. Append `## Post-call links` section pointing to brief + tasks + draft email.

### 5. Write task pages

For each `action_items` entry, write `~/brain/tasks/<participant-slug>-<call-date>-<task-slug>.md`:

```yaml
---
type: task
title: "..."
status: open       # open | in-progress | blocked | done | cancelled
owner: "[[people/<owner>]]"
context_call: "[[briefs/<brief_slug>]]"
related_granola: "[[meetings/<meeting_slug>]]"
related_person: "[[people/<participant>]]"
deals_referenced: [...]
firms_referenced: [...]
deadline: <YYYY-MM-DD or null>
priority: high | medium | low
created: <ISO timestamp>
created_from: post-call-processor
confidential: false | true
tags: [task, <participant-slug>, <project-slug>, <priority>-priority]
---

# <title>

**Owner:** <name> · **Deadline:** <date> · **Priority:** <level>

## Context

From call with [[people/<participant>]] on <date>. See [[briefs/<brief_slug>]]
and [[meetings/<meeting_slug>]].

## Notes

<full context including transcript quote if relevant>
```

### 6. Update entity pages

For each `service_provider_updates` entry, append a `service_providers:`
list item to the subject page's frontmatter (schema defined in
`~/brain/CLAUDE.md`).

For each `new_facts` entry where `subject` is a person/firm/deal page,
append to a `## Recent intel` section: the fact + source quote + date.
Use the format `[Source: meetings/<meeting_slug>, 2026-05-13]` for citations
per `skills/conventions/quality.md`.

For each `deal_status_updates` entry, append a timeline entry to the deal
page using `add_timeline_entry`.

### 7. Draft the follow-up email

Write `~/brain/emails/<brief_slug>-followup.md` with frontmatter:

```yaml
---
type: email
category: follow-up
status: draft       # ALWAYS draft. Never sent by the processor.
to: ["<participant email from CRM>"]
cc: []
from: "<operator email>"
subject: "Following up — <participant first> x <operator>, <D Mon>"
context_call: "[[briefs/<brief_slug>]]"
related_granola: "[[meetings/<meeting_slug>]]"
tasks_referenced: [...]
generated_by: post-call-processor
generated_at: <ISO>
tags: [email, draft, follow-up, <participant-slug>]
---
```

Body writing rules:
- **Natural prose, not bullets-only.** Operator can lift verbatim.
- **First name only** unless prior correspondence indicates a different
  convention.
- **No "as discussed during our call" filler.** Get to the actions.
- **Three-part structure:** (1) actions operator owns with deadlines, (2)
  things operator needs from participant with deadlines, (3) logistics
  (standing cadence proposal).
- **Confidential P.S. only when needed** to acknowledge a commitment — never
  the confidential fact itself.
- **No subject-line emoji.** Operator's existing voice is unadorned.

### 8. Commit + sync + verify

```bash
cd ~/brain
git add briefs/<brief_slug>.md meetings/<meeting_slug>.md \
        tasks/ emails/ companies/ people/ deals/
git commit -m "post-call: <participant> <date> — brief→debrief, transcript linked, N tasks + draft follow-up"

source ~/.zprofile
gbrain sync --no-pull --skip-failed --repo ~/brain
gbrain embed --stale
gbrain extract links --dir ~/brain
```

Heartbeat to `~/.gbrain/integrations/post-call-processor/heartbeat.jsonl`:

```json
{
  "ts": "<ISO>",
  "event": "processed",
  "status": "ok",
  "details": {
    "brief": "<slug>",
    "meeting": "<slug>",
    "tasks_created": <N>,
    "emails_drafted": 1,
    "facts_extracted": <N>,
    "confidential_flags": <N>,
    "service_provider_updates": <N>
  }
}
```

### 9. Render web/ HTML versions

- `~/Projects/active/hash-lemma/web/public/briefs/<brief_slug>.html` —
  regenerate with the post-call section appended (same light-mode design
  tokens from [[call-brief-generator]] Output Format section).
- `~/Projects/active/hash-lemma/web/public/emails/<brief_slug>-followup.html`
  — render the draft email with the same light-mode tokens, plus a `mailto:`
  link to the operator's mail client.
- Task pages do NOT get per-file HTML; they surface via the `/tasks` route in
  `web/`.

### 10. Verify before declaring done

- Brief frontmatter has `status: post-call-debrief` and `related_granola:` set.
- Transcript frontmatter has `prep_brief:` set.
- Task count > 0 (an empty post-call processing implies extraction failure).
- Email draft exists with `status: draft`.
- `gbrain query "<participant> follow-up tasks"` returns the new tasks ranked
  in the top 5.

If any check fails, the skill has not completed.

## Output Format

Every invocation produces exactly:

```
~/brain/briefs/<brief_slug>.md                                  (updated, status: post-call-debrief)
~/brain/meetings/<meeting_slug>.md                              (updated, prep_brief link)
~/brain/tasks/<participant>-<date>-*.md                         (N new task pages)
~/brain/emails/<brief_slug>-followup.md                         (1 draft email)
~/Projects/active/hash-lemma/web/public/briefs/<brief_slug>.html       (regenerated)
~/Projects/active/hash-lemma/web/public/emails/<brief_slug>-followup.html  (new)
```

Plus inline frontmatter updates on referenced deals, firms, persons.

## Auto-Run (LaunchAgent)

Optional: `~/Library/LaunchAgents/com.gbrain.post-call-processor.plist` with
`StartInterval=900` (15 min). Wrapper at
`~/.gbrain/integrations/post-call-processor/run.sh` scans for new transcripts
and runs this skill on each match.

Tighter feedback: chain into `~/.gbrain/integrations/granola-sync/run.sh` —
after each Granola sync, immediately run the post-call processor on any new
transcripts. Eliminates the polling lag.

## Anti-Patterns

- **Auto-sending the follow-up email.** Never. Drafts only. The operator
  ships.
- **Including confidential facts in the email body.** Confidential goes in
  the brief's `confidential:` frontmatter only, plus a task tagged
  `confidential`. The email body never references the fact directly — only an
  acknowledgement P.S. if the operator made a commitment around it.
- **Inferring action items.** If the transcript doesn't surface a clear
  commitment from the operator, do not invent one. Default to "no action
  items extracted" + a manual-review task asking the operator to confirm.
- **Touching the pre-call body of the brief.** The pre-call sections are the
  audit trail of what was planned. Post-call goes in an appended section
  only.
- **Skipping the gap_feedback section.** Operator self-criticism during the
  call (e.g., "this brief pulled losses not wins") is gold for improving the
  call-brief-generator. Always capture.
- **Writing tasks with no `deadline`.** Tasks without deadlines are wishes.
  When the transcript doesn't surface one, set a 14-day default and tag the
  task `deadline-defaulted` so the operator can adjust.
- **Touching CRM source data.** Read-only against `~/Projects/active/hash-lemma/data/`.

## Idempotency + retry

- Idempotent on `(brief_slug, meeting_slug)`. Re-running short-circuits if
  brief is already `post-call-debrief` AND `related_granola` is set, unless
  `--force` flag.
- If extraction schema validation fails twice in a row, the skill writes a
  manual-review task at `tasks/<brief>-<date>-manual-review.md` and emits a
  failure heartbeat with `details.error_class: schema_validation`.

## Failure modes + recovery

| Symptom | Cause | Fix |
|---------|-------|-----|
| No brief matches transcript | Transcript participants are "Unknown" (Granola anonymization) | Operator manually edits transcript frontmatter to canonicalize names; skill matches on `date` alone as fallback |
| LLM extraction returns malformed schema | Prompt drift or model behavior change | Re-run with `--strict-schema`; after 2 retries, emit manual-review task and stop |
| Email draft references a task that doesn't exist | Race condition between task write and email write | Phase 5 (tasks) always completes before Phase 7 (email); ordering is the fix |
| Brief gets re-processed unintentionally | Operator manually reverted `status: post-call-debrief` | Skill checks `related_granola`; if set, no-op unless `--force` |
| Confidential fact leaks into email body | LLM marked `confidential: false` incorrectly | Inline `[REVIEW: confidential?]` marker — operator must remove before send. Verify the email draft has a visible review marker for any flagged-confidential adjacent context. |

## What this skill does NOT do

- Does NOT send the email. Drafts only.
- Does NOT modify the pre-call body of the brief. Post-call section only.
- Does NOT modify CRM source data.
- Does NOT call external services. All inputs are local: brain pages + CRM
  SQLite.

## See also

- [[call-brief-generator]] — produces the pre-call brief this skill closes
  the loop on
- [[meeting-ingestion]] — Granola → transcript pipeline feeding this skill
- [[brain-ops]] — general brain query patterns
- [[enrich]] — for the entity-update phase semantics
- `~/gbrain/recipes/brief-to-brain.md` — schema authority

## Tools Used

- Read entity pages (`get_page`)
- Write task pages, email drafts, updated brief (`put_page`)
- List meetings/briefs (`list_pages`)
- Resolve participant slugs (`search`, `query`)
- Update timeline entries on deal pages (`add_timeline_entry`)
- Append back-links (`add_link`)
