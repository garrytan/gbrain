# Skill Development Cycle

## Goal

Turn every repeating task into a durable, automated skill so that if you ask twice, it should already be running on a cron.

## What the User Gets

Without this: ad-hoc work that the agent forgets how to do. You ask "enrich
this person" and the agent invents a new process each time. Quality varies.

With this: every capability is codified, tested, and scheduled. Enrichment
runs the same way every time. New patterns get skill-ified within a day.

## Implementation

**The Rule:** If you have to ask your agent for something twice, it should
already be a skill running on a cron. First time is discovery. Second time
is system failure.

### The 5-Step Cycle

**Step 1: Concept the Process.**
Describe what needs to happen in plain language:
- What's the input? What's the output? What triggers it?
- What data sources does it touch?
- How often should it run?

**Step 2: Run Manually for 3-10 Items.**
Actually do the work by hand on a small batch. This is the prototype phase.
Do NOT write a SKILL.md yet. Just do the work and observe:
- What does the output actually look like?
- What edge cases appear?
- What quality bar is right?

**Step 3: Evaluate Output.**
Show the user the results. Get feedback.
- Does output look good? Is quality right?
- Did you miss anything? Over-engineer?
- Revise the process based on what you learned.

**Step 4: Codify into a Skill.**
Write the SKILL.md. Either:
- **New skill** -- genuinely new capability
- **Add to existing skill** -- variation of something that exists (parameterize it)

The skill must be:
- **Durable** -- works tomorrow, next week, next month without manual intervention
- **MECE** -- doesn't overlap with other skills (see below)
- **Parameterized** -- handles variations through parameters, not separate skills

**Step 5: Add to Cron (if recurring).**
If the process should run automatically:
- Add to existing cron job if it fits naturally
- Create new cron job if it has a distinct scheduling concern
- Monitor the first 2-3 automated runs for quality
- Fix issues that emerge at scale

### MECE Discipline

Skills should be **Mutually Exclusive, Collectively Exhaustive**:
- Each entity type has exactly ONE owner skill
- Each signal source has exactly ONE owner skill
- Two skills creating the same brain page = MECE violation

**Example ownership (no overlap):**

| Signal Source | Owner Skill | Creates |
|--------------|-------------|---------|
| Meeting transcripts | meeting-ingestion | brain/meetings/ pages |
| Email messages | executive-assistant | brain/people/ timeline entries |
| X/Twitter posts | x-collector | brain/media/ pages |
| Person enrichment | enrich | brain/people/ compiled truth |
| Calendar events | calendar-sync | brain/daily/calendar/ pages |
| Video/podcast content | media-ingest | brain/media/ pages |

### Quality Bar Checklist

A skill is ready when:

- [ ] Ran successfully on 3-10 real items with good output
- [ ] User reviewed output and approved
- [ ] SKILL.md is under 500 lines (use references for overflow)
- [ ] Checks notability before creating brain pages (don't create pages for nobodies)
- [ ] Has citation enforcement (every fact has a source)
- [ ] Doesn't overlap with existing skills (MECE)
- [ ] If recurring: on a cron with appropriate schedule
- [ ] If it creates brain pages: checks notability first

### What This Means in Practice

- Don't do ad-hoc brain enrichment, use the enrich skill
- Don't manually check social media, use an automated cron
- Don't manually ingest meeting notes, use the meeting-sync recipe
- Don't manually create entity pages, use the entity detector
- If a new pattern emerges, prototype it, skill-ify it, cron-ify it

## Tricky Spots

1. **MECE violations compound silently.** Two skills that both create
   `brain/people/` pages will produce duplicates and conflicting data.
   Before creating a new skill, check the ownership table. If an existing
   skill already owns that entity type, extend it with parameters instead
   of creating a new skill.

2. **The quality bar is real.** Don't ship a skill that hasn't been tested
   on 3-10 real items with user approval. A skill that produces bad output
   is worse than no skill -- it creates bad brain pages at scale on a cron.

3. **Don't create stubs.** A SKILL.md with "TODO: implement" is not a skill.
   Every skill must be complete enough to run end-to-end on real data. If
   you can't finish it, don't create the file. Keep it as manual work until
   you can do it right.

## How to Verify

1. **Run the skill on 3 real items.** Execute the skill against live data
   (not test data). Check that the output matches the quality bar: citations
   present, notability checked, no stubs created.

2. **Check MECE against existing skills.** Review the ownership table. Does
   this new skill create pages in a directory already owned by another skill?
   If yes, it's a MECE violation. Merge or parameterize instead.

3. **Verify the quality bar checklist.** Walk through every item in the
   Quality Bar Checklist above. If any item is unchecked, the skill isn't
   ready for cron deployment.

---

*Part of the [Cortex Agent Runtime](../CORTEX_AGENT_RUNTIME.md).*
