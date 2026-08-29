# Search Modes

Two decisions shape every gbrain lookup, and this guide covers both:

1. **Which mode bundle** your brain runs — `conservative` / `balanced` /
   `tokenmax`, the named cost-knob presets that control cache, token budget,
   query expansion, and result count. This is the config-level decision you
   make once (at `gbrain init` or via `gbrain config set search.mode`).
2. **Which lookup verb** to use per call — `gbrain search` (keyword),
   `gbrain query` (hybrid), or `gbrain get` (direct). This is the
   per-lookup decision an agent makes on every question.

## The three mode bundles

A search mode is a named preset that sets every search-cost knob at once.
The bundles are frozen in `src/core/search/mode.ts` (`MODE_BUNDLES`):

| Knob                          | `conservative` | `balanced` | `tokenmax`     |
|-------------------------------|----------------|------------|----------------|
| `cache.enabled`               | true           | true       | true           |
| `cache.similarity_threshold`  | 0.92           | 0.92       | 0.92           |
| `cache.ttl_seconds`           | 3600           | 3600       | 3600           |
| `intentWeighting`             | true           | true       | true           |
| `tokenBudget`                 | **4000**       | **12000**  | **off**        |
| `expansion` (LLM multi-query) | false          | false      | **true**       |
| `relationalRetrieval`         | false          | **true**   | **true**       |
| `searchLimit` default         | 10             | 25         | 50             |

- **`conservative`** — smallest payloads. Pairs naturally with a cheap
  downstream model (Haiku-class) or a high query volume.
- **`balanced`** — the default and the fallback when no mode is set.
- **`tokenmax`** — no token budget, LLM query expansion on, 50 results.
  Pairs with an expensive downstream model you want fully fed.

Three of the knobs deserve a sentence:

- **`expansion`** rewrites your query into multiple variants via a cheap
  LLM call per search (adds roughly $1.50 per 1K queries) — better recall,
  small extra cost.
- **`relationalRetrieval`** adds a graph-walk recall arm for relational
  questions ("who invested in X", "what connects A and B"); it's a pure
  no-op for non-relational queries. The `query` op's `relational` flag
  forces it on/off per call.
- **`keywordOrFallback`** (on in every mode; config key
  `search.keywordOrFallback`) relaxes the keyword and title arms from AND
  to OR when strict AND matching finds nothing, so a multi-word query still
  gets keyword recall instead of leaning on vectors alone. Set the config
  key to `false` to keep strict AND matching.

### Setting and resolving the mode

```bash
gbrain config set search.mode tokenmax
```

Per-knob resolution (highest first):

    per-call SearchOpts → per-key config override (search.cache.enabled, …) →
      MODE_BUNDLES[search.mode] → MODE_BUNDLES.balanced (fallback)

Mode resolution lives in bare `hybridSearch`, not just the cached wrapper,
so eval replays test the same mode-affected behavior as the production
`query` op. The query cache folds the active knobs into its key
(`knobs_hash`), so switching modes never serves you a stale result set
from a different configuration. Cache hits honor the same result-count
resolution as misses (per-call `limit`, else the mode's `searchLimit`) —
a cached page is sliced to what you asked for, never a fixed count.

### Cost intuition

gbrain's own cost is rounding error; what the mode really controls is how
many tokens your *downstream agent* pays to read per query. The
corner-to-corner spread is ~25x once you pair mode with downstream model.
Rough anchors at 10K queries/month, full payload, no cache savings:

| Mode \ Downstream | Haiku-class (\$1/M in) | Sonnet-class (\$3/M in) | Opus-class (\$5/M in) |
|---|---|---|---|
| conservative (~4K tok) | **\$40/mo** | \$120/mo | \$200/mo |
| balanced (~10K tok) | \$100/mo | \$300/mo | \$500/mo |
| tokenmax (~20K tok) | \$200/mo | \$600/mo | **\$1,000/mo** |

Scales linearly with volume. Cache hits cut all numbers ~50%; disciplined
prompt caching in the agent loop cuts further. Mismatched pairings waste
capacity in both directions — a tokenmax payload overwhelms a cheap model,
a conservative payload starves an expensive one. The full methodology and
realistic-scale walkthrough live in
[`docs/eval/SEARCH_MODE_METHODOLOGY.md`](../eval/SEARCH_MODE_METHODOLOGY.md).

### CLI surfaces

```bash
gbrain search modes              # what is running, with per-knob attribution
gbrain search modes --reset      # clear search.* overrides (mode bundle wins)
gbrain search stats [--days N]   # cache hit rate, intent mix, budget drops
gbrain search tune [--apply]     # data-driven recommendations
gbrain search diagnose "<query>" --target <slug>
                                 # trace where a page surfaces (or fails to)
                                 # across the keyword/vector/alias/hybrid layers
```

The mode picker runs inside `gbrain init` (non-TTY auto-selects `balanced`).

## Choosing a lookup verb (search vs query vs get)

Independent of which bundle is active, every individual lookup should use
the cheapest verb that answers the question.

```
on user_asks_about(topic):
    # Decision tree: pick the right lookup verb

    if know_exact_slug(topic):
        # Direct get -- instant, no search overhead
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

### Tricky Spots

1. **Search returns chunks, not full pages.** After `gbrain search` or `gbrain query`, you get excerpts. Always run `gbrain get <slug>` to load the full page when the chunk confirms relevance. Don't answer questions from chunks alone when the full context matters.
2. **Search works without embeddings.** On day one before any embedding run, `gbrain search` still works (the keyword arm carries it; the vector arm joins once embeddings exist). Don't tell the user "search isn't available yet" -- search is always available.
3. **Don't use full hybrid for known names.** `gbrain query "Alice Example"` wastes an LLM expansion call. Use `gbrain search "Alice Example"` or better yet `gbrain get alice-example` if you know the slug.
4. **Token budget awareness.** A full page via `gbrain get` can be large. Read the search chunks first to confirm relevance before pulling the full page. "Did anyone mention the Series A?" -- search results (chunks) are probably enough. "Tell me everything about Alice" -- get the full page.
5. **Full hybrid needs embeddings to have been run.** If `gbrain query` returns nothing but `gbrain search` finds results, the embeddings haven't been generated yet. Run the embedding pipeline first.
6. **A populated `gbrain search` result set is not proof you found everything.** Search runs without query expansion, so synonym- and outcome-phrased matches can be missed even when it returns plenty of hits. For "find every / all / the landscape of" questions, use `gbrain query`; for literal exhaustive enumeration ("list every page of type X"), use `list_pages` pagination. A nonzero count is not a completeness signal.

### How to Verify

1. Run `gbrain search "Alice"` -- confirm it returns chunks with matching text and slug references.
2. Run `gbrain query "who works at fintech companies"` -- confirm it returns semantically relevant results (not just keyword matches on "fintech").
3. Run `gbrain get alice-example` -- confirm it returns the full page with compiled truth and timeline.
4. Compare: search for the same entity using all three modes. Keyword should be fastest, hybrid should surface conceptual matches, direct should return the complete page.
5. After a search returns a chunk, run `gbrain get` on the slug from that chunk. Confirm the full page contains more context than the chunk alone.
6. Run `gbrain search modes` -- confirm the active mode bundle and any per-key overrides are what you expect.

---
*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
