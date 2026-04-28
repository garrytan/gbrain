# Enrichment Pipeline

## Goal
Enrich brain pages from external APIs with tiered spend -- full pipeline for key people, light touch for passing mentions, raw data preserved for auditability.

## What the User Gets
Without this: brain pages are thin shells with only what the user manually typed, API calls are wasted on nobodies, and enrichment data vanishes after the agent session ends. With this: key people have rich, multi-source portraits; spend scales to importance; raw API responses are preserved for re-processing; and cross-references connect the entire graph.

## Implementation

```
on enrich(entity, trigger):
    # trigger: meeting mention, email thread, social interaction, user request

    # Step 1: Identify entities from the incoming signal
    entities = extract_entities(signal)
    #   people names, company names, associations

    # Step 2: Check brain state -- UPDATE or CREATE path?
    for entity in entities:
        existing = gbrain search "{entity.name}"
        if existing:
            page = gbrain get <entity_slug>
            path = "UPDATE"
        else:
            path = "CREATE"

    # Step 3: Determine tier -- scale spend to importance
    tier = classify_tier(entity):
        # Tier 1 (10-15 API calls): key people, inner circle, business partners,
        #         portfolio companies. Full pipeline, ALL data sources.
        # Tier 2 (3-5 API calls): notable people, occasional interactions.
        #         Web search + social + brain cross-reference.
        # Tier 3 (1-2 API calls): minor mentions, everyone else worth tracking.
        #         Brain cross-reference + social lookup if handle known.

    # Step 4: Run external lookups (priority order, stop when enough signal)
    data = {}
    data["brain"] = gbrain search "{entity.name}"          # Always first (free)
    if tier <= 2:
        data["web"] = brave_search("{entity.name}")        # Background, press, talks
    if tier <= 2:
        data["twitter"] = twitter_lookup(entity.handle)    # Beliefs, building, network
    if tier == 1:
        data["linkedin"] = crustdata_enrich(entity.name)   # Career, connections
        data["research"] = happenstance_research(entity)   # Career arcs, web presence
        data["funding"] = captain_api(entity.company)      # Funding, valuation, team
        data["meetings"] = circleback_search(entity.name)  # Transcript search
        data["contacts"] = google_contacts(entity.email)   # Contact data

    # Step 5: Store raw data (auditable, re-processable)
    gbrain put_raw_data <entity_slug> \
        --data '{"sources": {"crustdata": {"fetched_at": "...", "data": {...}}, ...}}'
    # Overwrite on re-enrichment, don't append

    # Step 6: Write to brain page
    if path == "CREATE":
        gbrain put <entity_slug> --content "<compiled_truth_from_all_sources>"
        gbrain add_timeline_entry <entity_slug> --entry "Page created via enrichment"
    elif path == "UPDATE":
        # Append timeline, update compiled truth ONLY if materially new
        gbrain add_timeline_entry <entity_slug> --entry "Enriched: {new_signal}"
        # Flag contradictions -- don't silently resolve them

    # Step 7: Cross-reference the graph (link_type = RELATIONSHIP label, required)
    gbrain link <person_slug> <company_slug> --link-type works_at
    gbrain link <company_slug> <person_slug> --link-type works_at
    gbrain link <person_slug> <deal_slug> --link-type involved_in
    # Every entity page links to every other entity page that references it

# People page sections (not a LinkedIn profile -- a living portrait):
#   Executive Summary, State, What They Believe, What They're Building,
#   What Motivates Them, Assessment, Trajectory, Relationship, Contact, Timeline
# Facts are table stakes. TEXTURE is the value.

# Extract texture, not just facts:
#   Opinion expressed?        -> What They Believe
#   Building or shipping?     -> What They're Building
#   Emotion expressed?        -> What Makes Them Tick
#   Who did they engage with? -> Network / Relationship
#   Recurring topic?          -> Hobby Horses
#   Committed to something?   -> Open Threads
#   Energy level?             -> Trajectory
```

## Tricky Spots

1. **Don't overwrite human-written assessments.** If the user wrote an Assessment section with their own read on someone, API enrichment NEVER overwrites it. API data goes into State, Contact, Timeline. The user's assessment is sacrosanct.
2. **Don't re-enrich the same page more than once per week.** Check `put_raw_data` timestamps before running the pipeline again. Enrichment is expensive and data doesn't change that fast.
3. **LinkedIn connection count < 20 means wrong person.** Crustdata sometimes returns a different person with the same name. If the LinkedIn profile has fewer than 20 connections, it's almost certainly a false match. Discard it.
4. **X/Twitter is the most underrated data source.** When you have someone's handle, their tweets reveal beliefs, what they're building, hobby horses, network (reply patterns), and trajectory (posting frequency, tone shifts). This is richer than LinkedIn for "What They Believe" and "What Makes Them Tick."
5. **Cross-references are not optional.** After enriching a person, update their company page. After enriching a company, update founder pages. An enriched page without cross-links is a dead end in the graph.

## How to Verify

1. Enrich a Tier 1 person. Run `gbrain get <slug>` and confirm the page has Executive Summary, State, What They Believe, Contact, and Timeline sections populated from multiple sources.
2. Run `gbrain get_raw_data <slug>`. Confirm raw API responses are stored with `sources.{provider}.fetched_at` timestamps.
3. Run `gbrain get_links <slug>`. Confirm cross-reference links exist to the person's company page, deal pages, and related entities.
4. Check a page that was enriched AND has a user-written Assessment. Confirm the Assessment section was preserved, not overwritten by API data.
5. Try to re-enrich the same person. Confirm the system checks the `fetched_at` timestamp and skips if less than a week old.

---
*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
