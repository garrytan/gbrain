# Search Modes

## Goal
Know which search command to use and when -- keyword, hybrid, or direct -- so every lookup is fast and returns the right result.

## What the User Gets
Without this: the agent fumbles between search commands, returns chunks when full pages are needed, runs expensive semantic searches when a direct get would do, or misses results entirely. With this: every lookup uses the optimal mode, token budgets are respected, and the user gets the right information in the fewest calls.

## Implementation

```
on user_asks_about(topic):
    # Decision tree: pick the right search mode

    if know_exact_slug(topic):
        # MODE 3: Direct get -- instant, no search overhead
        result = gbrain get <slug>
        # e.g., "Tell me about Alice" -> gbrain get alice-example
        # Returns the FULL page -- compiled truth + timeline

    elif topic.is_exact_name or topic.is_keyword:
        # MODE 1: Cheap-hybrid search -- vector + keyword + RRF, NO LLM
        # expansion. Embeds the query when embeddings are configured; the
        # keyword arm still works day-one without them (keyword-only is
        # also available via the search.mcp_keyword_only opt-out).
        results = gbrain search "{name_or_keyword}"
        # e.g., "Find anything about Series A" -> gbrain search "Series A"
        # Returns CHUNKS, not full pages

        # IMPORTANT: search returns chunks
        # If the chunk confirms relevance, THEN load the full page:
        if chunk.confirms_relevance:
            full_page = gbrain get <slug_from_chunk>

    elif topic.is_semantic_question or topic.is_concept_or_landscape:
        # MODE 2: Full hybrid -- adds multi-query LLM expansion on top of
        # vector + keyword + RRF. Owns concept / landscape / "all-of-X"
        # questions: expansion recovers synonym- and outcome-phrased
        # matches a single embedding misses. Costs one LLM expansion call
        # per query -- worth it for these question shapes.
        results = gbrain query "{natural language question}"
        # e.g., "Who do I know at fintech companies?" -> gbrain query "fintech contacts"
        # e.g., "all the companies doing offshore wind" -> gbrain query "..."
        # Returns ranked chunks via vector + keyword + expansion + RRF

        # Same rule: chunks first, then get full page if needed
        if chunk.confirms_relevance:
            full_page = gbrain get <slug_from_chunk>

# Quick reference:
# | Mode        | Command              | Needs Embeddings | Speed   | Best For                                  |
# |-------------|----------------------|------------------|---------|-------------------------------------------|
# | Cheap-hybrid| gbrain search "term" | Uses if present  | Fastest | Known names, exact tokens                 |
# | Full hybrid | gbrain query "..."   | Yes              | Fast    | Concept / landscape / "all-of-X", synonyms |
# | Direct      | gbrain get <slug>    | No               | Instant | When you know the slug                    |

# Progression over time:
#   Day 1:  search (keyword arm works without embeddings)
#   After first embed: vector arm + full hybrid (query) unlocked
#   Once you know slugs: direct get for speed

# Precedence for conflicting information within a page:
#   1. User's direct statements (always wins)
#   2. Compiled truth sections (synthesized from evidence)
#   3. Timeline entries (raw signal, reverse chronological)
#   4. External sources (web search, APIs)
```

## Tricky Spots

1. **Search returns chunks, not full pages.** After `gbrain search` or `gbrain query`, you get excerpts. Always run `gbrain get <slug>` to load the full page when the chunk confirms relevance. Don't answer questions from chunks alone when the full context matters.
2. **Search works without embeddings.** On day one before any embedding run, `gbrain search` still works (the keyword arm carries it; the vector arm joins once embeddings exist). Don't tell the user "search isn't available yet" -- search is always available.
3. **Don't use full hybrid for known names.** `gbrain query "Alice Example"` wastes an LLM expansion call. Use `gbrain search "Alice Example"` or better yet `gbrain get alice-example` if you know the slug.
4. **Token budget awareness.** A full page via `gbrain get` can be large. Read the search chunks first to confirm relevance before pulling the full page. "Did anyone mention the Series A?" -- search results (chunks) are probably enough. "Tell me everything about Alice" -- get the full page.
5. **Full hybrid needs embeddings to have been run.** If `gbrain query` returns nothing but `gbrain search` finds results, the embeddings haven't been generated yet. Run the embedding pipeline first.
6. **A populated `gbrain search` result set is not proof you found everything.** Search runs without query expansion, so synonym- and outcome-phrased matches can be missed even when it returns plenty of hits. For "find every / all / the landscape of" questions, use `gbrain query`; for literal exhaustive enumeration ("list every page of type X"), use `list_pages` pagination. A nonzero count is not a completeness signal.

## How to Verify

1. Run `gbrain search "Alice"` -- confirm it returns chunks with matching text and slug references.
2. Run `gbrain query "who works at fintech companies"` -- confirm it returns semantically relevant results (not just keyword matches on "fintech").
3. Run `gbrain get alice-example` -- confirm it returns the full page with compiled truth and timeline.
4. Compare: search for the same entity using all three modes. Keyword should be fastest, hybrid should surface conceptual matches, direct should return the complete page.
5. After a search returns a chunk, run `gbrain get` on the slug from that chunk. Confirm the full page contains more context than the chunk alone.

---
*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
