# Content and Media Ingestion

## Goal
YouTube videos, social media, PDFs, and documents become searchable brain pages with the agent's own analysis and full cross-references to every entity mentioned.

## What the User Gets
Without this: media links are bookmarks that decay -- you remember watching a video but can't find what was said, who said it, or why it mattered. With this: every piece of media is a permanent brain page with the agent's analysis layered on top, every mentioned entity gets a back-link, and the full content is searchable forever.

## Implementation

```
on user_shares_media(url_or_file):

    # PATTERN 1: YouTube Video Ingestion
    if media.type == "youtube":
        # Step 1: Get FULL transcript with speaker diarization
        #   WHO said WHAT -- not just a wall of text
        #   Use Diarize.io or equivalent service
        transcript = diarize(video_url)  # speaker-attributed transcript
        # NEVER use YouTube's auto-generated summary or AI summary

        # Step 2: Agent writes OWN analysis (this is the value)
        #   NOT a summary. NOT regurgitation. The agent's TAKE:
        #   - What matters and why (given the user's worldview)
        #   - Key quotes attributed to specific speakers
        #   - Connections to existing brain pages
        #   - Implications and follow-up angles
        analysis = agent_analyze(transcript, user_context)

        # Step 3: Create brain page
        slug = f"media/youtube/{video_slug}"
        gbrain put <slug> --content """
            # {title}
            **Channel:** {channel} | **Date:** {date} | **Link:** {url}

            ## Analysis
            {agent_analysis}

            ## Key Quotes
            - **{Speaker}** ({timestamp}): "{quote}" -- {why_it_matters}

            ---
            ## Full Transcript
            {diarized_transcript}
        """

        # Step 4: Extract and cross-reference entities
        for person in transcript.mentioned_people:
            gbrain link <slug> <person_slug> --link-type mentions
            gbrain link <person_slug> <slug> --link-type mentions
            gbrain add_timeline_entry <person_slug> \
                --entry "Discussed in {video_title}: {what_was_said}" \
                --source "YouTube: {url}"

    # PATTERN 2: Social Media Bundles
    elif media.type == "tweet" or media.type == "social":
        # Don't just save a tweet -- reconstruct FULL context
        bundle = {
            "original": fetch_tweet(url),
            "thread": reconstruct_thread(url),        # quoted tweets, replies
            "linked_articles": fetch_linked_urls(),    # fetch and summarize
            "engagement": get_engagement_data(),       # what resonated
        }

        slug = f"media/social/{platform}-{author}-{date}"
        gbrain put <slug> --content """
            # {author}: {topic}
            {agent_analysis_of_full_bundle}

            ## Thread
            {reconstructed_thread}

            ## Linked Articles
            {article_summaries}

            ---
            ## Raw
            {original_tweet_text}
        """

        # Extract entities and cross-reference
        for entity in bundle.mentioned_entities:
            gbrain link <slug> <entity_slug> --link-type mentions
            gbrain link <entity_slug> <slug> --link-type mentions

    # PATTERN 3: PDFs and Documents
    elif media.type == "pdf" or media.type == "document":
        # OCR if needed (scanned PDFs)
        content = ocr_if_needed(file) or extract_text(file)

        # For books and long-form:
        slug = f"sources/{document_slug}"
        gbrain put <slug> --content """
            # {title}
            **Author:** {author} | **Date:** {date}

            ## Chapter Summaries
            {per_chapter_summary}

            ## Key Quotes
            - p.{page}: "{quote}" -- {why_it_matters}

            ## Cross-References
            {links_to_brain_pages_for_people_and_concepts}

            ---
            ## Source
            {full_text_or_key_sections}
        """

        for entity in document.mentioned_entities:
            gbrain link <slug> <entity_slug> --link-type mentions
            gbrain link <entity_slug> <slug> --link-type mentions

    # Always sync after ingestion
    gbrain sync
```

## Tricky Spots

1. **Always FULL transcript, never AI summary.** YouTube's auto-summary and AI-generated summaries lose the texture: who said what, exact phrasing, tone, what was left unsaid. The full diarized transcript is the evidence base. The agent's analysis goes above it.
2. **The agent's OWN analysis is the value, not regurgitation.** "The video discussed AI safety" is worthless. "Dario made a specific claim about compute scaling that contradicts what Ilya said in the NeurIPS talk -- see media/youtube/ilya-neurips-2025" is useful. The analysis connects the new media to the existing brain.
3. **Social media is a bundle, not a single tweet.** A tweet without its thread, quoted tweets, linked articles, and engagement context is a fragment. Reconstruct the full context before creating the brain page.
4. **Cross-references make media pages alive.** A YouTube page without back-links to the people and companies mentioned is a dead archive. Every mentioned entity gets a link and a timeline entry.
5. **Over time, `media/` becomes a searchable archive.** Every video, podcast, talk, interview, article, and tweet the user has consumed, with the agent's commentary layered on top. This is the memex at full power.

## How to Verify

1. Ingest a YouTube video. Run `gbrain get media/youtube/{slug}`. Confirm the page has: the agent's analysis (not just a summary), key quotes with speaker attribution, and the full diarized transcript.
2. Run `gbrain get_links media/youtube/{slug}`. Confirm back-links exist to brain pages for every person and company mentioned in the video.
3. Pick a person mentioned in the video. Run `gbrain get <person_slug>`. Confirm their timeline has a new entry referencing the video with specific context.
4. Ingest a tweet. Confirm the brain page includes the thread context, linked article summaries, and entity cross-references -- not just the tweet text.
5. Run `gbrain search "{topic_from_video}"`. Confirm the media page appears in search results (verifies the content is indexed and searchable).

---
*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
