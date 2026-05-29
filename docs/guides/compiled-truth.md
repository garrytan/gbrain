# Compiled Truth + Timeline Pattern

## Goal

Every brain page has two zones: compiled truth (current synthesis, rewritten as
evidence changes) and timeline (append-only evidence trail, never edited).

## What the User Gets

Without this: brain pages are append-only logs. To understand a person, you read
200 timeline entries. The answer is buried in entry #147.

With this: the compiled truth gives you the state of play in 30 seconds. The
timeline is the proof. Six months of entries compress into a one-paragraph
assessment that's always current.

## Implementation

### Page Structure

```markdown
---
type: person
title: Sarah Chen
tags: [engineering, acme-corp]
---

## Executive Summary
One paragraph. How you know them, why they matter.

## State
VP Engineering at Acme Corp. Managing 45-person team. Reports to CEO.

## What They Believe
Strong opinions on test coverage. "Ship it when the tests pass, not before."

## What They're Building
Leading the API migration from REST to GraphQL. Target: Q3 completion.

## Assessment
Sharp technical leader. Under-appreciated internally. Watch for signs of burnout.

## Trajectory
Ascending. Likely CTO track if the migration succeeds.

## Relationship
Met through Pedro. Had coffee 3x. Last: discussed API architecture thesis.

## Contact
sarah@acmecorp.com | @sarahchen | linkedin.com/in/sarahchen

---

## Timeline

- **2026-04-07** | Met at team sync. Discussed API migration timeline.
  Seemed energized about GraphQL pivot.
  [Source: Meeting notes, 2026-04-07 2:00 PM PT]
- **2026-04-03** | Mentioned in email re Q2 planning. Taking lead on ops.
  [Source: Gmail, sarah@acmecorp.com, 2026-04-03 10:30 AM PT]
- **2026-03-15** | First meeting. Intro from Pedro. Strong technical background.
  [Source: User, direct conversation, 2026-03-15 3:00 PM PT]
```

### Updating a Page

```
update_brain_page(slug, new_info, source):
  page = cortex get {slug}

  // TIMELINE: always APPEND (never edit existing entries)
  cortex add_timeline_entry {slug} {
    date: today,
    summary: new_info.summary,
    detail: new_info.detail,
    source: format_source(source)  // [Source: who, channel, date time tz]
  }

  // COMPILED TRUTH: REWRITE (not append)
  // Read the existing compiled truth
  // Integrate new information
  // Write the updated synthesis
  updated_truth = rewrite_compiled_truth(page.compiled_truth, new_info)
  cortex put {slug} {
    compiled_truth: updated_truth,
    // timeline is NOT passed — it's managed by add_timeline_entry
  }
```

### The Rules

| Zone | Action | Explanation |
|------|--------|-------------|
| Compiled truth | **REWRITE** | Current synthesis. Changes when evidence changes. |
| Timeline | **APPEND** | Evidence trail. Never edited, only added to. |

**Every compiled truth claim must trace to timeline entries.** If the Assessment
says "under-appreciated internally," there should be timeline entries that
support that claim.

## Tricky Spots

1. **REWRITE means rewrite, not append.** Don't add a new paragraph to compiled
   truth. Rewrite the entire section with the new information integrated. Old
   assessments that are no longer accurate should be updated, not kept alongside
   contradictory new ones.

2. **Timeline entries are immutable.** Never edit a timeline entry. If information
   turns out to be wrong, add a NEW entry correcting it:
   `- 2026-04-10 | Correction: Sarah is VP Eng, not CTO. Previous entry was wrong.`

3. **Cortex search weights compiled truth higher.** `cortex query` returns compiled
   truth chunks with higher relevance than timeline chunks. This means the freshest
   synthesis surfaces first in search results.

4. **The --- separator matters.** Cortex uses the first standalone `---` after
   frontmatter to split compiled_truth from timeline. Everything above is compiled
   truth, everything below is timeline.

5. **Don't skip the Assessment section.** The assessment is the value. "Strong
   technical leader" is something no API can provide. It's YOUR read on this
   person. That's what makes the brain page better than LinkedIn.

## How to Verify

1. **Update a person page.** Add new meeting info. Check: compiled truth was
   REWRITTEN (not appended), timeline has new entry at the top.
2. **Search for the person.** `cortex query "Sarah Chen"`. The compiled truth
   (current synthesis) should appear first, not a random timeline entry.
3. **Check traceability.** Every claim in compiled truth should have a
   corresponding timeline entry. Read both sections and verify.
4. **Check immutability.** After update, old timeline entries should be unchanged.
   Dates, sources, and content should match the originals exactly.

---

*Part of the [Cortex Agent Runtime](../CORTEX_AGENT_RUNTIME.md). See also: [Source Attribution](source-attribution.md), [Entity Detection](entity-detection.md)*
