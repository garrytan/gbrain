---
name: search-modes
description: Three named search modes (conservative / balanced / tokenmax). Pick one at install; everything else inherits.
type: convention
---

# Convention: Search Modes (v0.32.3)

> **Convention:** every brain has one active search mode. The mode bundles the
> search-lite knobs from PR #897 (semantic cache, token budget, intent
> weighting, LLM expansion, result limit) into a single config key:
> `search.mode = conservative | balanced | tokenmax`.

## When this fires

Any agent doing search-adjacent work in a gbrain brain consults this convention:

- `brain-ops` / `query` / `signal-detector` skills: respect the active mode at
  search time. Per-call `SearchOpts` overrides win when set; mode is the default.
- Skills that recommend tuning ("the cache hit rate is high — raise threshold?"):
  route operators to `gbrain search tune` rather than rolling their own logic.
- New skills that add per-call retrieval overrides: name them explicitly so
  the resolved-knob attribution dashboard (`gbrain search modes`) reads cleanly.

## Mode bundle (read-only constants)

The 3 bundles live in `src/core/search/mode.ts` as `MODE_BUNDLES` (frozen).
Don't redefine them per-install; that breaks the public methodology numbers.

| Knob                          | `conservative` | `balanced` | `tokenmax`     |
|-------------------------------|----------------|------------|----------------|
| `cache.enabled`               | true           | true       | true           |
| `cache.similarity_threshold`  | 0.92           | 0.92       | 0.92           |
| `cache.ttl_seconds`           | 3600           | 3600       | 3600           |
| `intentWeighting`             | true           | true       | true           |
| `tokenBudget`                 | **4000**       | **12000**  | **off**        |
| `expansion` (LLM multi-query) | false          | false      | **true**       |
| `searchLimit` default         | 10             | 25         | 50             |

**Cache, intent weighting, and similarity threshold are constant across modes**
— they're free wins (no API cost). Modes scale the three cost levers:
`tokenBudget`, `expansion`, `searchLimit`.

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

Migration v56 added `query_cache.knobs_hash`. A tokenmax write
(expansion=on, limit=50) is keyed by a different hash than a conservative
read (no expansion, limit=10), so cross-mode contamination is structurally
impossible. The cache lookup filter is:

    WHERE source_id = $ AND knobs_hash = $ AND embedding similarity < $

Legacy NULL-knobs_hash rows from pre-v0.32.3 are silently excluded
(treated as misses, re-populated with the right hash on first hit).

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
