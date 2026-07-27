# Retrieval Incident: a chosen-name page was missed, and the fix

**Status:** Resolved (retrieval-cathedral wave). Supersedes the docs-only RFC in
closed PR #1616 — the diagnosis there was directionally right about the disease
but wrong on several mechanics; this is the corrected record + what shipped.
**Original author:** Garry Tan's OpenClaw. **Severity at the time:** High.
**Related:** [`RETRIEVAL.md`](./RETRIEVAL.md), [`../eval/METRIC_GLOSSARY.md`](../eval/METRIC_GLOSSARY.md).

---

## 1. What happened

The agent was asked to log that Garry "wants to build a Greek amphitheater." It
ran a retrieval for the concept, the canonical concept page (titled "...Indoor
Greek Amphitheater...") did **not** surface with enough confidence to be
recognized as the existing page, and the agent wrote a **duplicate stub** on top
of a fully-developed concept doc. Garry caught it: "It's in the brain. It's the
Hall of Light. Why did you forget?"

The page is *about* a Greek amphitheater — the phrase is in its title and first
sentence. A healthy index returns it at the top. It didn't.

## 2. The disease (the RFC got this right)

The brain is stored by **meaning and chosen name** (Mingtang, Hall of Light) but
was retrieved by **literal embedding proximity to a body chunk**, and the agent's
"is this already here?" decision keyed off a single fuzzy blended score. Three
retrieval gaps plus one contract gap produced the miss.

## 3. Verified ground truth (corrections to the RFC)

These were checked in code during the fix; several change the remedy:

1. **`gbrain search` was keyword-only**, not hybrid — so the RFC's cosine scores
   (0.64/0.98) came from the hybrid `query`/MCP path the agent actually hit, not
   `gbrain search`. The repro command in the RFC was mislabeled.
2. **`--mode` was never a CLI param** — mode resolves server-side from the
   `search.mode` config key, which is why all three "modes" returned identical
   results (the flag was silently dropped; `thorough` isn't a real mode).
3. **`hybridSearch` already max-pooled per page at the dedup layer.** So the
   per-page max-pool fix's real win is *candidate-set page recall* (the vector
   side returned N chunks that could collapse to fewer pages), and it is
   necessary-but-not-sufficient: if a page's title chunk scores below a body
   chunk on a 2-word query, or falls outside the candidate pool, pooling alone
   doesn't rescue it.
4. **Frontmatter `aliases:` was dead to search** — stored in `pages.frontmatter`
   JSONB, never consulted. `slug_aliases` is a *slug→slug* wikilink redirect, a
   different concept.

## 4. The fix that shipped (four layers + a contract)

| Layer | Fixes | Where |
|---|---|---|
| **Per-page max-pool** (T1) | a page scored by its weakest chunk; vector page-recall | `searchVector` both engines, shared `buildBestPerPagePoolCte` |
| **Title-phrase boost** (T2) | query is a phrase in the title but matched a body chunk | `applyTitleBoost` (reads `page.title`), `title_boost` mode knob |
| **Alias hop** (T3) | true synonyms with zero surface overlap ("Hall of Light" → Mingtang) | `page_aliases` table, `applyAliasHop`, ingest projection + `reindex --aliases` backfill |
| **Evidence contract** (T4) | the agent keyed "don't duplicate" off a fuzzy score | `evidence` + `create_safety` on every result; the agent keys off `create_safety='exists'`, not a threshold |

Plus: `gbrain search "<text>"` is now cheap-hybrid (the obvious verb gives the
good path); `modes/stats/tune` stay subcommands; `--mode` works per-call for
local callers; rank-1 score drift telemetry; and **NamedThingBench**, a CI gate
that hard-gates the families that ARE this incident.

## 5. How to confirm / triage a recurrence

```
# Which layer surfaces (or misses) the target page?
gbrain search diagnose "Greek amphitheater" --target projects/new-greek-theater/concept_v0

# Backfill aliases for existing pages whose frontmatter predates the alias layer:
gbrain reindex --aliases

# Watch retrieval quality over time (a downward avg rank-1 score = regressing):
gbrain search stats --days 30

# The gate that prevents silent reintroduction:
gbrain eval retrieval-quality test/fixtures/retrieval-quality/namedthing.jsonl
```

For a page to be reliably found by its chosen name, give it `aliases:` frontmatter:

```yaml
---
title: The Mingtang — Indoor Greek Amphitheater
aliases:
  - Hall of Light
  - 明堂
---
```

## 6. The discipline this teaches

A benchmark that scores 97.9 R@5 while production returns a flagship page at 0.64
means the benchmark and the shipped path diverged. NamedThingBench runs the same
families through the real pipeline on every PR, and the evidence contract means
the agent's duplicate-or-not decision is grounded in *why* a page matched, not a
number that was never a calibrated probability.
