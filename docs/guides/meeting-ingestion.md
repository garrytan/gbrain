# Meeting Ingestion

## Goal
Meeting transcripts become brain pages that update every mentioned entity -- attendees, companies, deals, and action items all propagated in one pass.

## What the User Gets
Without this: meetings vanish into memory, action items are forgotten, and the agent has no idea what was discussed last time you met someone. With this: every meeting is a permanent record that enriches every person and company page it touches, and the user walks into every follow-up already briefed.

## Implementation

```
on new_meeting_transcript(meeting):
    # Step 1: Pull the COMPLETE transcript -- NOT the AI summary
    #   AI summaries hallucinate framing ("it was agreed that...")
    #   The transcript is ground truth
    transcript = fetch_full_transcript(meeting.id)  # e.g., Circleback API
    # Must have speaker diarization: WHO said WHAT

    # Step 2: Create the meeting page
    slug = f"meetings/{meeting.date}-{short_description}"
    compiled_truth = agent_analysis(transcript):
        # Above the bar: agent's OWN analysis, not a generic recap
        #   - Reframe through the user's priorities
        #   - Flag surprises, contradictions, implications
        #   - Name real decisions (not performative ones)
        #   - Call out what was left unsaid or unresolved
    timeline = format_diarized_transcript(transcript)
        # Below the bar: full transcript, append-only
        #   Format: **Speaker** (HH:MM:SS): Words.

    gbrain put <slug> --content "<compiled_truth>\n---\n<timeline>"

    # Step 3: Propagate to ALL entity pages (MANDATORY -- most agents skip this)
    for person in meeting.attendees + meeting.mentioned_people:
        gbrain add_timeline_entry <person_slug> \
            --entry "Met in '{meeting.title}' on {date}. Key points: ..." \
            --source "Meeting notes '{meeting.title}', {date}"
        # Update their State section if new information surfaced
        # Update company pages for each person's company if relevant

    for company in meeting.mentioned_companies:
        gbrain add_timeline_entry <company_slug> \
            --entry "Discussed in '{meeting.title}': {what_was_said}" \
            --source "Meeting notes '{meeting.title}', {date}"

    # Step 4: Extract action items
    action_items = extract_action_items(transcript)
    # Add to task list with owner attribution

    # Step 5: Back-link everything (bidirectional graph)
    for entity in all_entities_mentioned:
        gbrain link <slug> <entity_slug> --link-type mentions
        gbrain link <entity_slug> <slug> --link-type mentions

    # Step 6: Sync so new pages are immediately searchable
    gbrain sync

# Schedule: cron 3x/day (10 AM, 4 PM, 9 PM) to catch new meetings
# Source: Circleback (https://circleback.ai) or any service with
#         speaker diarization + API/webhook access
```

## Tricky Spots

1. **Always pull the COMPLETE transcript, never the AI summary.** AI summaries hallucinate framing -- they editorialize what was "agreed" or "decided" when no such agreement happened. The diarized transcript is ground truth.
2. **Entity propagation is the step most agents skip.** A meeting is NOT fully ingested until every attendee's page, every mentioned person's page, and every company's page has a new timeline entry. The meeting page alone is useless without propagation.
3. **Mentioned people are not just attendees.** If the meeting discussed "Sarah's team at Brex," then Sarah's page AND Brex's page need updates -- even though Sarah wasn't in the room.
4. **The agent's analysis is the value, not a summary.** "They discussed Q2 targets" is worthless. "Pedro pushed back on the burn rate, Diana didn't commit to the timeline, and nobody addressed the pricing gap" is useful.
5. **Back-links must be bidirectional.** The meeting page links to attendee pages AND attendee pages link back to the meeting. The graph is bidirectional. Always.

## How to Verify

1. After ingesting a meeting, run `gbrain get meetings/{date}-{slug}`. Confirm the page has the agent's analysis above the bar and the full diarized transcript below it.
2. For each attendee, run `gbrain get <attendee_slug>`. Check that their timeline has a new entry referencing the meeting with specific insights (not just "attended meeting").
3. Pick a company mentioned in the meeting. Run `gbrain get <company_slug>`. Confirm a timeline entry exists referencing what was discussed about the company.
4. Run `gbrain get_links meetings/{date}-{slug}`. Verify back-links exist to all attendee and entity pages.
5. Run `gbrain search "{meeting_topic}"`. Confirm the meeting page appears in search results (verifies sync ran).

---
*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
