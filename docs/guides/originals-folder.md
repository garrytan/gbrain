# The Originals Folder

## Goal
Capture the user's original thinking with their exact phrasing, deep cross-links, and full provenance -- so intellectual capital compounds instead of evaporating.

## What the User Gets
Without this: the user generates a brilliant framework in conversation and it vanishes when the session ends. Six months later, they vaguely remember the idea but can't find it, can't recall the exact phrasing, and can't trace what influenced it. With this: every original observation, thesis, framework, and hot take is captured verbatim in `brain/originals/`, cross-linked to the people, companies, and media that shaped it, and searchable forever.

## Implementation

```
on user_message(message):
    # Detect original thinking in every message
    if contains_original_thinking(message):
        # The authorship test:
        #   User generated the idea?                   -> originals/{slug}.md
        #   User's unique synthesis of someone else's?  -> originals/ (synthesis IS original)
        #   World concept someone else coined?          -> concepts/{slug}.md
        #   Product or business idea?                   -> ideas/{slug}.md

        # Step 1: Use the user's EXACT phrasing for the slug
        #   "meatsuit-maintenance-tax"
        #   NOT "biological-needs-maintenance-overhead"
        #   The vividness IS the concept.
        slug = slugify(user_exact_phrase)

        # Step 2: Create the originals page
        gbrain put originals/{slug} --content """
            # {User's Exact Phrase}

            ## The Idea
            {User's original thinking, captured in their own words.
             Do NOT paraphrase. Do NOT clean up the language.
             The raw phrasing is the intellectual artifact.}

            ## Context
            {What triggered this thinking. Meeting? Article? Conversation?
             Include the source that sparked it.}
            [Source: User, {context}, {date} {time} {tz}]

            ## Connections
            - Related to: [[{person_slug}]] -- {how they connect}
            - Emerged from: [[{meeting_slug}]] -- {what was discussed}
            - Influenced by: [[{book_or_media_slug}]] -- {what resonated}
            - Builds on: [[{other_original_slug}]] -- {how ideas cluster}
        """

        # Step 3: Cross-link to everything that shaped the thinking
        for entity in idea.influences:
            gbrain link originals/{slug} <entity_slug> --link-type mentions
            gbrain link <entity_slug> originals/{slug} --link-type mentions

        # Step 4: Sync
        gbrain sync

# What counts as original thinking:
#   - Novel frameworks ("the meatsuit maintenance tax")
#   - Hot takes on someone else's work (synthesis IS original)
#   - Pattern recognition across multiple entities
#   - Predictions or bets about the future
#   - Contrarian positions with reasoning

# What does NOT go in originals/:
#   - Facts about the world (-> entity pages)
#   - Concepts someone else coined (-> concepts/)
#   - Product ideas (-> ideas/)
#   - Preferences (-> agent memory)
```

## Tricky Spots

1. **Naming: the vividness IS the concept.** `meatsuit-maintenance-tax` not `biological-needs-maintenance-overhead`. `ambition-debt` not `deferred-career-risk-accumulation`. The user's colorful phrasing is the intellectual artifact. Never sanitize it into corporate-speak.
2. **Synthesis IS original.** The user's take on Peter Thiel's zero-to-one framework goes in `originals/`, not `concepts/`. The original part is the user's synthesis, interpretation, or disagreement -- even though the underlying ideas came from someone else.
3. **An original without cross-links is a dead original.** The connections ARE the intelligence. An idea about "ambition debt" that doesn't link to the people who exemplify it, the meeting where it was discussed, and the book that influenced it is just a note in a graveyard. Cross-link aggressively.
4. **Originals form clusters.** Over time, the user's ideas connect to each other. "Meatsuit maintenance tax" connects to "ambition debt" connects to "founder energy budget." Link originals to other originals. The cluster IS the user's worldview.
5. **Capture the trigger context.** What conversation, meeting, article, or moment sparked this idea? The context often matters as much as the idea itself for future retrieval. Include it in the page.

## How to Verify

1. Generate an original idea in conversation (e.g., "I call this the 'ambition debt' problem -- every year you delay going big, the compound interest works against you"). Confirm a new page appears at `brain/originals/ambition-debt` with `gbrain get originals/ambition-debt`.
2. Check that the page uses the user's exact phrasing for the title and slug -- not a sanitized version.
3. Run `gbrain get_links originals/ambition-debt`. Confirm cross-links exist to related people, meetings, or other originals.
4. Express a take on someone else's idea (e.g., "I think Thiel's contrarian question is wrong because..."). Confirm it goes to `originals/` (synthesis is original), not `concepts/`.
5. Run `gbrain search "ambition debt"`. Confirm the originals page appears in search results and is discoverable.

---
*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
