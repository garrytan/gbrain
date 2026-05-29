# Source Attribution

## Goal
Every fact in the brain traces to where it came from -- who said it, in what context, and when.

## What the User Gets
Without this: six months from now, someone reads a brain page and has no idea if "Pedro co-founded Brex" came from Pedro himself, a LinkedIn scrape, or a hallucination. With this: every claim is auditable, conflicts are surfaced, and the brain is a court-admissible record of reality.

## Implementation

```
on brain_write(page, fact):
    # EVERY fact gets a citation -- compiled truth AND timeline
    citation = format_citation(source)
    #   format: [Source: {who}, {channel/context}, {date} {time} {tz}]

    # Category-specific formats:
    if source.type == "direct":
        # [Source: User, direct message, 2026-04-07 12:33 PM PT]
    elif source.type == "meeting":
        # [Source: Meeting notes "Team Sync" #12345, 2026-04-03 12:11 PM PT]
    elif source.type == "api_enrichment":
        # [Source: Crustdata LinkedIn enrichment, 2026-04-07 12:35 PM PT]
    elif source.type == "social_media":
        # MUST include full URL -- not just @handle
        # [Source: X/@pedroh96 tweet, product launch, 2026-04-07](https://x.com/pedroh96/status/...)
    elif source.type == "email":
        # [Source: email from Sarah Chen re Q2 board deck, 2026-04-05 2:30 PM PT]
    elif source.type == "workspace":
        # [Source: Slack #engineering, Keith re deploy schedule, 2026-04-06 11:45 AM PT]
    elif source.type == "web":
        # [Source: Happenstance research, 2026-04-07 12:35 PM PT]
    elif source.type == "published":
        # [Source: [Wall Street Journal, 2026-04-05](https://wsj.com/...)]
    elif source.type == "funding":
        # [Source: Captain API funding data, 2026-04-07 2:00 PM PT]

    # Attach citation inline with the fact
    cortex put <slug> --content "...fact [Source: ...]..."

    # When sources conflict, note BOTH -- never silently pick one
    if conflicts_exist(fact, existing_page):
        append_to_compiled_truth(
            "Conflict: Source A says X, Source B says Y. "
            "[Source: A] [Source: B]"
        )

# Source hierarchy for conflict resolution (highest authority first):
SOURCE_PRIORITY = [
    "User direct statements",      # 1 -- always wins
    "Primary sources",             # 2 -- meetings, emails, direct conversations
    "Enrichment APIs",             # 3 -- Crustdata, Happenstance, Captain
    "Web search results",          # 4
    "Social media posts",          # 5
]
```

## Tricky Spots

1. **Compiled truth is NOT exempt from citations.** "Pedro co-founded Brex" in the synthesis section needs `[Source: ...]` just as much as a timeline entry does. Most agents skip citations above the bar.
2. **Tweet URLs are mandatory.** `[Source: X/@handle tweet, topic, date]` without a URL is a broken citation. Hundreds of brain pages end up with unreachable tweet references when the URL is omitted. Always: `[Source: X/@handle tweet, topic, date](https://x.com/handle/status/ID)`.
3. **"User said it" isn't enough.** WHERE, ABOUT WHAT, WHEN. `[Source: User, direct message, 2026-04-07 12:33 PM PT]` -- not just `[Source: User]`.
4. **Don't silently resolve conflicts.** When the user says one thing and an API says another, note the contradiction in compiled truth with both citations. Let the reader decide.
5. **Timeline entries need sources too.** Every append to the timeline carries provenance. A timeline entry without a source is an orphan fact.

## How to Verify

1. Open any brain page with `cortex get <slug>`. Read the compiled truth section above the bar. Every factual claim should have an inline `[Source: ...]` citation.
2. Search for tweet references: `cortex search "X/@"`. Every result should have a full URL, not just an @handle.
3. Find a page with data from multiple sources (e.g., a person enriched via API + mentioned in a meeting). Confirm both sources are cited independently.
4. Check timeline entries on 3 random pages. Each entry should have a source citation with date and context.
5. Look for a page where the user stated something that contradicts an API result. Confirm the contradiction is noted, not silently resolved.

---
*Part of the [Cortex Agent Runtime](../CORTEX_AGENT_RUNTIME.md).*
