---
name: correction-pipeline
version: 1.0.0
description: |
  When the user corrects a factual error, root-cause it immediately.
  Don't just note the correction — trace the error to its source,
  fix the source, and prevent recurrence. Every factual error is
  either a data error (bad brain page, bad memory file, bad rendered
  SOUL/USER identity, bad facts row) or a hallucination (LLM
  confabulated from partial signals).
triggers:
  - "that's wrong"
  - "that's not true"
  - "I never said that"
  - "where did you get that"
  - "you got that wrong"
  - "correct that fact"
  - "root-cause this error"
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - concepts/
upstream: correction-pipeline@fc834ee
---

# Correction Pipeline

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md)
> — Step 1 of the root-cause chain IS the brain-first lookup chain (`search`
> for exact tokens, `query` for concept-shaped questions) before anything else.
>
> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) —
> corrections edit pages in place; the page stays filed by primary subject.

## Trigger

ANY factual error the user identifies. No exceptions. No "I'll note that."

(Routing here is a harness convention, not a mechanical guarantee — but once
this skill is in play, the no-exceptions contract above is the discipline.)

## Immediate Response

1. **Acknowledge the error.** Don't defend. Don't explain. Just: "You're right. I got that wrong."
2. **Quote the specific wrong claim** so the user can see you know exactly what was wrong.
3. **State the correct fact** as the user gave it.

## Root Cause Analysis (do THIS, not just a memory note)

Run these steps IN ORDER. Report findings to the user.

### Step 1: Search the brain

```bash
gbrain search "<relevant terms>" --limit 10
```

For concept-shaped or synonym-phrased claims, escalate to `gbrain query
"<question>"` (LLM expansion recovers phrasings `search` misses). Also grep
the brain repo checkout directly — resolve it once from config:

```bash
BRAIN_DIR=$(gbrain config get sync.repo_path)
grep -ri "<wrong claim terms>" "$BRAIN_DIR/people/" "$BRAIN_DIR/companies/" "$BRAIN_DIR/concepts/" 2>/dev/null
```

**Question:** Is the wrong fact IN the brain? If yes → the brain is the
contamination source. Fix the brain page (Step 6).

### Step 2: Search memory files

Grep the harness's always-loaded memory files (e.g. the workspace `MEMORY.md`
and any `memory/*.md` companions — the exact location depends on your
harness):

```bash
grep -ri "<wrong claim terms>" <memory files> 2>/dev/null
```

**Question:** Is the wrong fact in memory? If yes → memory is the
contamination source. Fix the memory file.

### Step 3: Check SOUL.md and USER.md

```bash
grep -i "<relevant terms>" <workspace>/SOUL.md <workspace>/USER.md 2>/dev/null
```

**Question:** Is there a misleading passage that could have led to the wrong
inference? SOUL.md and USER.md are in every context window — a vague or
ambiguous line here propagates into every session.

**Important:** on gbrain installs these files are RENDERED from the bootstrap
answer bank (`state/interview.json`). Note the finding here; the fix goes
through the answer bank in Step 6, never through a direct edit.

### Step 4: Check the facts table

```bash
gbrain recall <entity-slug>            # facts about the subject, newest first
gbrain recall --grep "<claim terms>"   # substring filter when the entity is unclear
```

Is there a wrong fact with high confidence? Note its fact id.

### Step 5: Classify the error

| Classification | Description | Fix surface |
|----------------|-------------|-------------|
| **BRAIN_ERROR** | Wrong fact exists in a brain page | Edit the page in the brain repo, commit, re-sync |
| **MEMORY_ERROR** | Wrong fact exists in memory files | Fix the memory file |
| **SOUL_USER_ERROR** | Misleading passage in SOUL.md or USER.md | Fix the ANSWER BANK, re-render — never the rendered file |
| **FACTS_TABLE_ERROR** | Wrong fact in the gbrain facts table | `recall` → `forget <fact-id>` → `remember` the correction |
| **HALLUCINATION** | No source — LLM confabulated from partial signals | Name the contamination vector (what partial signals led to it), write a guard fact |
| **STALE_DATA** | Fact was once true but is no longer | Update the source with current truth; supersede the stale fact |
| **CROSS_CONTAMINATION** | Correct fact about person A attributed to person B | Fix attribution in the source — on BOTH entities |

### Step 6: Fix the source

- **BRAIN_ERROR:** Edit the page file in the brain repo. Include
  `[Source: user correction, YYYY-MM-DD]` on the corrected line. Commit, then
  `gbrain sync` so the DB reflects the fix. (Editing the DB row without the
  repo file — or vice versa — leaves the two out of agreement until the next
  sync overwrites one of them.)
- **MEMORY_ERROR:** Edit the memory file. Add a correction note with date.
- **SOUL_USER_ERROR:** NEVER edit SOUL.md / USER.md directly — they are
  rendered files, and a hand edit is silently lost on the next render. Fix the
  underlying answer in the shared bootstrap answer bank, then re-render:
  ```bash
  gbrain bootstrap interview --set KEY "corrected value"   # verbatim, user's words
  gbrain bootstrap interview --show                        # read back
  gbrain bootstrap interview --status                      # get the confirm hash
  gbrain bootstrap interview --confirm <hash>
  gbrain bootstrap render --only SOUL.md --force           # repeat per affected file
  ```
  The full interview discipline (read-back ritual, verbatim answers, backup
  behavior) lives in `skills/soul-audit/SKILL.md` — route through it for
  anything beyond a single-key fix.
- **FACTS_TABLE_ERROR:** Expire the wrong row and write the correction with
  provenance:
  ```bash
  gbrain recall <entity-slug>                                  # find the fact id
  gbrain forget <fact-id>                                      # expire the wrong fact
  gbrain remember "<correct fact>" \
    --provenance "user correction, YYYY-MM-DD" --entity <entity-slug>
  ```
- **HALLUCINATION:** There is no source to fix. Identify the partial signal
  that seeded the confabulation, then write a guard so it can't reseed:
  ```bash
  gbrain remember "WRONG: <what was said>. RIGHT: <what is true>. Guard: <instruction to prevent recurrence>" \
    --provenance "user correction, YYYY-MM-DD (hallucination guard)" --entity <entity-slug>
  ```
- **STALE_DATA:** Update the source page with current truth (BRAIN_ERROR
  flow), and supersede any stale facts rows (`forget` + `remember` with the
  current truth and fresh provenance).
- **CROSS_CONTAMINATION:** Fix the attribution at the source, then check BOTH
  entities: person A's page and facts (does the fact now live where it
  belongs?) and person B's page and facts (is every trace of the
  misattribution gone?).

### Step 7: Check for propagation

The wrong fact may have propagated into OTHER brain pages, synthesis output,
or memory files.

```bash
grep -ri "<wrong claim terms>" "$BRAIN_DIR" 2>/dev/null | grep -v ".git"
gbrain search "<wrong claim terms>" --limit 20
```

Fix ALL instances, not just the first one found. Re-sync after repo edits.

### Step 8: Report to the user

Short report:

```
**Error:** [what was wrong]
**Root cause:** [BRAIN_ERROR | HALLUCINATION | etc.]
**Source:** [specific file/line or fact id, or "no source — confabulated from X"]
**Fixed:** [what was changed, where]
**Propagation:** [other files fixed, or "no propagation found"]
```

## Severity Tiers

| Tier | Description | Action |
|------|-------------|--------|
| **S1 — Identity error** | Wrong facts about the user's family, heritage, history, core identity | Fix immediately. These contaminate EVERYTHING — every synthesis, every book mirror, every conversation. |
| **S2 — Entity error** | Wrong facts about a person, company, deal in the brain | Fix brain page, check propagation |
| **S3 — Context error** | Wrong inference about the user's current state, feelings, situation | Guard fact via `remember`. Usually hallucination. |
| **S4 — Minor factual** | Wrong date, wrong number, wrong detail | Fix source, no propagation check needed |

## Recurring Error Patterns to Watch

| Pattern | Example | Guard |
|---------|---------|-------|
| Projecting therapeutic narratives | "You've been avoiding the hard conversation with your cofounder" (no evidence) | Check calendar/behavior data before making claims about the user's actions or state |
| Autocorrecting names to famous people | A contact named alice-example Cho silently becomes the similarly-named celebrity | The user's people outrank world-famous people — resolve against `people/` first |
| Confusing takes with facts | Dumping takes-table beliefs into facts | Takes = other people's beliefs. Facts = the user's personal knowledge. |
| Enumerative claims from session context only | "You've worked at two companies" — missing the one only recorded in the brain | NEVER make enumerative claims ("all your X," "every Y," "the three times you Z") without searching the brain first. Session context is always incomplete. |
| Missing data in always-loaded files | A core fact lives only in a brain page, not in USER.md/MEMORY.md, so every session re-derives it wrong | When a correction reveals a gap in an always-loaded file, ADD the missing data through the proper surface (answer bank for rendered files, direct edit for memory files) so it's in every future context window |

## Complement: the contradictions probe

This skill is REACTIVE — it fires when the user catches an error. The shipped
contradictions probe is the PROACTIVE side of the same discipline: it finds
intra-brain conflicts before the user does.

```bash
gbrain eval suspected-contradictions   # run the probe
gbrain find-contradictions             # read the latest run's findings
```

If a correction reveals a class of conflict (e.g. two pages disagreeing about
a date), run the probe afterward — the same contamination pattern may exist
elsewhere in the brain.

## Contract

This skill guarantees:

- Every factual error gets root-caused, not just noted
- Source fixes land at the REAL fix surface for the error class (page edit +
  commit + re-sync; `forget`/`remember` for facts rows; answer bank + re-render
  for SOUL/USER — never a direct edit to a rendered file)
- Propagation is checked (whole-brain grep + `gbrain search`)
- The user gets a clear report of what was wrong, why, and what was fixed
- Routing matches the canonical triggers in the frontmatter
- Privacy contract preserved: no real names, no fork-specific filesystem path
  literals, no upstream-fork references

## Output Format

The skill's output is the Step 8 root-cause report delivered inline during the
conversation, plus all source fixes applied (brain-repo edits committed and
re-synced; facts rows expired/superseded; identity files re-rendered from the
answer bank).

## Dedup (sharp boundaries)

- `skills/maintain/SKILL.md` — PROACTIVE brain health (stale pages, orphans,
  citations, doctor). This skill is REACTIVE: a specific user correction gets
  traced to its contamination source. If nobody said "that's wrong," it's
  maintain's territory.
- The contradictions probe (`gbrain eval suspected-contradictions` /
  `gbrain find-contradictions`) — PROACTIVE intra-brain conflict detection.
  Complementary, not overlapping: the probe finds conflicts between two brain
  sources; this skill starts from a correction supplied by the user.
- `skills/soul-audit/SKILL.md` — the full identity re-interview surface. This
  skill DELEGATES to it for SOUL_USER_ERROR fixes; it never re-implements the
  interview or render flow.
- `skills/citation-fixer/SKILL.md` — citation FORMAT compliance. Correcting a
  claim's truth is this skill; fixing how a true claim is cited is
  citation-fixer.
- frontmatter-guard (host-side) — structural page validation (YAML shape),
  not claim truth.

## Anti-Patterns

- **"Noted, I'll remember that."** NO. Trace the source. Fix the source.
- **Fixing only memory without checking the brain.** The brain is the
  persistent store. Memory gets flushed.
- **Editing SOUL.md / USER.md directly.** They're rendered from the answer
  bank; the hand edit dies on the next render and the error comes back. Fix
  the answer, re-render.
- **Editing the brain-repo file without re-syncing (or the DB row without
  committing).** The two stores drift and the next sync resurrects the error.
- **Fixing one instance without checking propagation.** Wrong facts spread.
- **Blaming the hallucination without identifying the partial signal.** Every
  hallucination has a seed — find it.
- **Defensive response.** Never explain why you got it wrong before
  acknowledging it's wrong.
