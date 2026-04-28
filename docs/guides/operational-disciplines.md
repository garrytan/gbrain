# Operational Disciplines

## Goal
Five non-negotiable rules that separate a production brain from a demo -- signal detection, brain-first lookup, sync after every write, daily heartbeat, and nightly dream cycle.

## What the User Gets
Without this: the agent misses signals in conversation, wastes money on external APIs when the brain already has the answer, leaves search results stale after writes, and lets the brain rot quietly. With this: every message is scanned for entities, the brain is always consulted first, search is always current, health is monitored daily, and the brain compounds overnight.

## Implementation

```
# DISCIPLINE 1: Signal Detection on Every Message (MANDATORY)
on every_inbound_message(message):
    # No exceptions. If the user thinks out loud and the brain doesn't
    # capture it, the system is broken. This is the #1 discipline.

    entities = detect_entities(message)
    #   people, companies, deals, original ideas

    for entity in entities:
        existing = gbrain search "{entity.name}"
        if existing:
            gbrain add_timeline_entry <entity_slug> \
                --entry "{what_was_said}" \
                --source "User, direct message, {timestamp}"
        # else: flag for enrichment if important enough

    originals = detect_original_thinking(message)
    for idea in originals:
        gbrain put originals/{slug} --content "{user's exact phrasing}"

# DISCIPLINE 2: Brain-First Lookup Before External APIs (MANDATORY)
on information_needed(topic):
    # ALWAYS check the brain before reaching for the web
    brain_result = gbrain search "{topic}"
    if brain_result:
        page = gbrain get <slug>
        # Use brain data first. External APIs FILL GAPS, not replace.
    else:
        # Brain has nothing -- now use external APIs
        external_result = brave_search("{topic}")

    # An agent that reaches for the web before checking its own brain
    # is wasting money and giving worse answers.

# DISCIPLINE 3: Sync After Every Write (MANDATORY)
on brain_write_complete():
    gbrain sync
    # Without this, search results are stale.
    # The page you just wrote won't appear in gbrain search or gbrain query
    # until sync runs. Skipping this means the next lookup misses the
    # most recent data.

# DISCIPLINE 4: Daily Heartbeat Check
on daily_schedule("09:00"):
    gbrain doctor
    # Checks: database connectivity, embedding health, sync status,
    # page count, stale pages, broken links
    # If doctor reports issues, fix them before doing anything else.

# DISCIPLINE 5: Nightly Dream Cycle
on nightly_schedule("02:00"):
    # The dream cycle is the most important discipline.
    # The brain COMPOUNDS overnight.

    # 5a: Entity sweep -- find unlinked mentions
    pages = gbrain list_pages
    for page in pages:
        mentions = extract_entity_mentions(page.content)
        existing_links = gbrain get_links <page.slug>
        for mention in mentions:
            if mention not in existing_links:
                gbrain link <page.slug> <mention_slug> --link-type mentions  # fix broken graph

    # 5b: Citation audit -- find facts without sources
    for page in pages:
        facts_without_sources = audit_citations(page.content)
        if facts_without_sources:
            flag_for_remediation(page, facts_without_sources)

    # 5c: Memory consolidation -- update compiled truth from timeline
    for page in stale_pages(older_than="7d"):
        timeline = gbrain get_timeline <page.slug>
        if timeline.has_new_entries_since_last_consolidation:
            # Re-synthesize compiled truth from accumulated timeline
            updated_truth = consolidate(page.compiled_truth, timeline.new_entries)
            gbrain put <page.slug> --content updated_truth

    # 5d: Sync everything
    gbrain sync

# BONUS: Durable Skills Over One-Off Work
# If you do something twice, make it a skill + cron.
#   1. Concept the process
#   2. Run it manually for 3-10 items
#   3. Revise -- iterate on quality
#   4. Codify into a skill
#   5. Add to cron -- automate it
# Each entity type and signal source has exactly one owner skill.
# Two skills creating the same page = coverage violation.
```

## Tricky Spots

1. **The dream cycle is the most important discipline.** Brains compound overnight. Entity sweeps fix broken graphs, citation audits catch sourceless facts, and memory consolidation keeps compiled truth current. Skip the dream cycle and the brain slowly rots.
2. **Skipping Discipline 3 (sync after write) means stale search results.** You write a page, then immediately search for it -- and get nothing back. The page exists but isn't indexed. Always sync after writes.
3. **Signal detection must fire on EVERY message.** Not just messages that look important. The user says "I talked to Pedro yesterday about the board seat" in passing -- that's a timeline entry on Pedro's page, a potential update to his State section, and a signal about the board. If the agent doesn't catch it, the system is broken.
4. **Brain-first saves money AND gives better answers.** The brain has context that external APIs don't: relationship history, meeting notes, the user's own assessment. An API lookup for "Pedro Franceschi" returns a LinkedIn profile. The brain returns the full picture including private context.
5. **`gbrain doctor` catches silent failures.** Embedding pipelines can stall, sync can fail silently, database connections can drop. The daily heartbeat catches these before they compound into data loss.

## How to Verify

1. Send a message mentioning a person with a brain page. Confirm the agent detects the entity and adds a timeline entry to their page (`gbrain get_timeline <slug>`).
2. Ask the agent about someone in the brain. Confirm it runs `gbrain search` or `gbrain get` BEFORE reaching for external APIs (check the tool call order).
3. Write a new page with `gbrain put`, then immediately run `gbrain search` for it. Confirm it appears in results (verifies sync ran).
4. Run `gbrain doctor`. Confirm it returns a health report with database status, page count, and any flagged issues.
5. After a dream cycle runs, check a page that had unlinked entity mentions. Confirm new links were added (`gbrain get_links <slug>`).

---
*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
