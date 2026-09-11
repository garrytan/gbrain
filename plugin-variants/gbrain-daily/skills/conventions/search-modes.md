---
name: search-modes
description: Three named search modes (conservative / balanced / tokenmax). Pick one at install; everything else inherits.
type: convention
---

# Convention: Search Modes (v0.32.3)

> **Convention:** every brain has one active search mode. The mode bundles the
> search-lite knobs (semantic result-cache settings, token budget, intent
> weighting, LLM expansion, result limit) into a single config key:
> `search.mode = conservative | balanced | tokenmax`.

## When this fires

Any agent doing search-adjacent work in a gbrain brain consults this convention:

- `brain-ops` / `query` / `signal-detector` skills: respect the active mode at
  search time. Per-call `SearchOpts` overrides win when set; mode is the default.
- Skills that recommend tuning ("which search mode fits this brain?"):
  route operators to `gbrain search tune` rather than rolling their own logic.
- New skills that add per-call retrieval overrides: name them explicitly so
  the resolved-knob attribution dashboard (`gbrain search modes`) reads cleanly.

## Mode bundle (read-only constants)

The 3 bundles live in `src/core/search/mode.ts` as `MODE_BUNDLES` (frozen).
Don't redefine them per-install; that breaks the public methodology numbers.
The canonical knob table (with cost anchors) lives in
`docs/guides/search-modes.md` — update that first if the bundles change.

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

**Effective semantic result caching is disabled in every mode.** The table
retains the stored bundle values, but result lookup and writes are bypassed
regardless of config or `use_cache`. Cache statistics and the mode dashboard
report disabled; repeated queries perform fresh retrieval. Intent weighting
and the retained cache knobs remain constant across modes. Modes scale
`tokenBudget`, `expansion`, and `searchLimit`.

## Resolution chain (matches v0.31.12 model-tier shape)

    per-call SearchOpts.tokenBudget / expansion / etc.
      ↓ (when undefined)
    per-key config: search.cache.enabled, search.tokenBudget, …
      ↓ (when unset)
    MODE_BUNDLES[search.mode]
      ↓ (when search.mode is unset)
    MODE_BUNDLES.balanced (safety fallback)

## Tools for agents

Agents tuning a brain's retrieval should call these directly:

    gbrain search modes              # dashboard + per-knob source attribution
    gbrain search modes --reset      # clear search.* overrides (mode is canonical)
    gbrain search stats [--days N]   # hit rate, intent mix, budget drops
    gbrain search tune [--apply]     # data-driven recommendations

`gbrain search tune` reads the `search_telemetry` rollup (sums + counts of
last 7 days) + brain size + configured `models.tier.subagent` to suggest
mode + per-key changes. With `--apply`, it mutates config via `setConfig`
and prints a paste-ready revert command.

## Cache contamination guard

The retained `query_cache.knobs_hash` machinery separates mode settings:
tokenmax (expansion=on, limit=50) has a different hash from conservative
(no expansion, limit=10). Its stored lookup filter is:

    WHERE source_id = $ AND knobs_hash = $ AND embedding similarity < $

Legacy NULL-knobs_hash rows remain excluded. No semantic result rows are read
or repopulated while caching is disabled; changing the stored knobs cannot
restore result reuse.

## Trigger phrases

If an operator or agent asks any of these, route to `gbrain search …`:

- "what search mode is active?" → `gbrain search modes`
- "is my cache hot?" → `gbrain search stats`
- "tune my retrieval" → `gbrain search tune`
- "clear search overrides" → `gbrain search modes --reset`
- "compare modes" → `gbrain eval compare`

## Don't

- Don't redefine `MODE_BUNDLES` per-install. The methodology numbers in
  `docs/eval/SEARCH_MODE_METHODOLOGY.md` cite these as canonical.
- Don't mutate `search.mode` config from inside a subagent loop without
  operator approval. Mutation is a trust-boundary crossing
  (`tune --apply` stays CLI-only in v0.32.3 per `[CDX-21]`).
- Don't add per-call `tokenBudget` overrides on the production `query` op
  without naming them in `gbrain search modes` output.

## See also

- `docs/eval/SEARCH_MODE_METHODOLOGY.md` — full eval methodology
- `docs/eval/METRIC_GLOSSARY.md` — plain-English definitions
- `src/core/search/mode.ts` — module source
