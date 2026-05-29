# Executive Assistant Pattern

## Goal
Email triage, meeting prep, and scheduling powered by brain context -- so every interaction is informed by the full history of the relationship.

## What the User Gets
Without this: the agent triages email mechanically ("you have 12 unread"), preps for meetings with generic LinkedIn bios, and schedules without relationship context. With this: the agent knows who every sender is before reading their email, surfaces shared history before every meeting, and nudges scheduling based on relationship temperature and open threads.

## Implementation

```
# WORKFLOW 1: Email Triage
on email_batch(emails):
    for email in emails:
        # Step 1: Search sender BEFORE reading the email body
        #   Brain context makes triage 10x better
        sender_page = cortex search "{email.sender_name}"
        if sender_page:
            context = cortex get <sender_slug>
            #   Now you know: who they are, relationship history,
            #   what they care about, open threads

        # Step 2: Read the email WITH brain context loaded
        #   Classification is now informed, not mechanical

        # Step 3: Classify with context
        if context.relationship == "inner_circle" or context.has_open_threads:
            priority = "urgent"
        elif context.is_known_entity:
            priority = "normal"
        else:
            priority = "noise"  # unknown sender, no brain page

        # Step 4: Draft reply with relationship context
        if needs_reply(email):
            draft = compose_reply(
                email,
                context=context,           # their brain page
                open_threads=context.open_threads,  # what you're working on together
                relationship=context.relationship   # tone calibration
            )

# WORKFLOW 2: Meeting Prep
on upcoming_meeting(meeting):
    briefing = {}
    for attendee in meeting.attendees:
        # Search brain for each attendee
        results = cortex search "{attendee.name}"
        if results:
            page = cortex get <attendee_slug>
            briefing[attendee] = {
                "compiled_truth": page.compiled_truth,
                "last_interaction": page.timeline[0],     # most recent
                "open_threads": page.open_threads,
                "relationship_temperature": page.relationship,
                "relevant_deals": cortex get_links <attendee_slug>,
            }
        else:
            briefing[attendee] = "No brain page -- consider enriching"

    # Surface: shared history, what to follow up on, what to watch for
    # "Last time you discussed the Series B timeline. Pedro was concerned
    #  about burn rate. Here's the latest from his company page."

# WORKFLOW 3: Post-Inbox Brain Updates
on inbox_cleared():
    for email in processed_emails:
        if email.contained_new_information:
            # Update the sender's brain page with new signal
            cortex add_timeline_entry <sender_slug> \
                --entry "Email re: {subject}. Key info: {extracted_signal}" \
                --source "email from {sender} re {subject}, {date}"

            # Update any mentioned entity pages too
            for entity in email.mentioned_entities:
                cortex add_timeline_entry <entity_slug> \
                    --entry "{what_was_said_about_them}" \
                    --source "email from {sender}, {date}"

# WORKFLOW 4: Scheduling Nudges
on schedule_request(meeting):
    for attendee in meeting.attendees:
        page = cortex get <attendee_slug>
        if page.last_interaction > 6_weeks_ago:
            nudge("You haven't met with {attendee} in {weeks} weeks")
        if page.has_open_threads:
            nudge("{attendee} has an open thread about {topic}")
        if page.relationship_temperature == "cooling":
            nudge("Relationship with {attendee} may need attention")
```

## Tricky Spots

1. **Search sender BEFORE reading the email.** This is counterintuitive but critical. Loading brain context first means you know who they are, what you're working on together, and what they care about -- before you even see the subject line. The triage is informed, not mechanical.
2. **Unknown senders with no brain page are almost always noise.** If `cortex search` returns nothing for a sender, they're probably not important. Classify as low priority unless the email content signals otherwise.
3. **Meeting prep is the highest-leverage EA workflow.** The user walks into every meeting already briefed on each attendee: last interaction, open threads, relationship history. This is the difference between "you have a meeting at 3" and "you have a meeting at 3 with Pedro -- last time you discussed the Series B, he was concerned about burn rate."
4. **Post-inbox brain updates are where the brain compounds.** Every email is signal. If you clear the inbox without updating brain pages, the information is lost. This is the step most agents skip.
5. **Scheduling nudges require timeline data.** "You haven't met with Diana in 6 weeks" only works if meeting pages have been ingested with proper entity propagation (see meeting-ingestion guide).

## How to Verify

1. Run meeting prep for tomorrow's calendar. For each attendee, confirm the agent ran `cortex search` and loaded their brain page before generating the briefing.
2. Triage 5 emails. Confirm the agent searched for each sender in the brain before classifying the email.
3. After clearing an inbox, check 2 sender brain pages with `cortex get <slug>`. Confirm new timeline entries were added with information from the emails.
4. Check a scheduling suggestion. Confirm the agent referenced the attendee's brain page (last interaction date, open threads) in the nudge.
5. Send a test email from someone with a brain page. Confirm the triage response references their relationship context, not just the email content.

---
*Part of the [Cortex Agent Runtime](../CORTEX_AGENT_RUNTIME.md).*
