# Retrieval Quality Incident: Vector Search Returns Pages by Their Weakest Chunk

**Status:** Proposal / RFC (no code in this PR — documentation + remediation plan + eval design)
**Author:** Wintermute (Garry Tan's agent)
**Date:** 2026-05-29
**gbrain version at time of incident:** 0.41.26.1
**Severity:** High — brain-wide retrieval quality defect affecting every multi-chunk page
**Related:** [`docs/architecture/RETRIEVAL.md`](./RETRIEVAL.md), [`docs/eval/METRIC_GLOSSARY.md`](../eval/METRIC_GLOSSARY.md), [`docs/eval/SEARCH_MODE_METHODOLOGY.md`](../eval/SEARCH_MODE_METHODOLOGY.md)

---

## 0. TL;DR

A real query missed a real page. Querying **"Greek amphitheater"** failed to surface the page literally titled *"The Mingtang (明堂) — Indoor **Greek amphitheater**…"* with enough confidence to be used, returning it at cosine **0.64** via a mediocre body chunk. The same page's **title chunk scores 0.9866** on a richer query — so the embedding is fine; the *retrieval aggregation* is broken.

**Root cause:** `searchVector` in both engines returns top-k **chunks** ranked chunk-grain, with **no per-page max-pooling**. A page is represented by whichever of its chunks happens to survive the candidate cut — not by its best-matching chunk. The keyword path (`searchKeyword`) already does the correct `DISTINCT ON (slug) ORDER BY score DESC` pooling. The vector path does not. For a weak short query against a ~100K-page brain, a page's strong title chunk can fall outside the candidate set while a weak body chunk makes it in, so the page inherits the weak chunk's score and ranks accordingly (or drops out entirely).

**Secondary finding:** Search mode knobs (`reranker_enabled`, `expansion`) produced **zero delta** on this query across `conservative` / `balanced` / `thorough`. Either they no-op on this path or the CLI default doesn't invoke the full hybrid stack that [`RETRIEVAL.md`](./RETRIEVAL.md) describes. There is a gap between the documented architecture (hybrid vector + BM25 + RRF + graph, 49.1 P@5 / 97.9 R@5 on BrainBench) and the path the production CLI actually exercises.

This document: (1) the full incident, (2) the code-level root cause with line references, (3) a boil-the-ocean menu of fixes from cheap to ambitious, (4) a serious eval design so we can prove the fix and prevent regressions.

---

## 1. What Happened (Incident Narrative)

1. Garry asked Wintermute to log that he "wants to build a Greek amphitheater."
2. Wintermute ran a retrieval for the concept. The query effectively reduced to the generic phrase **"Greek amphitheater."**
3. The canonical page — `projects/new-greek-theater/concept_v0`, a ~2,000-word concept doc created 2026-05-09, titled *"The Mingtang (明堂) — Indoor Socratic Amphitheater"* — did **not** surface with enough confidence to be recognized as the existing page.
4. Wintermute wrote a **duplicate stub** ("Garry wants to build a Greek amphitheater, no details yet") on top of a fully-developed concept page. Garry caught it: *"It's in the brain. It's the Hall of Light. The Mingtang. Why did you forget?"*
5. Investigation followed. First hypothesis (agent-side): "I searched the generic English label instead of the chosen name." True but shallow. Garry pushed: *"You should be able to query Greek amphitheater and find it. That should have been vector search."* Correct. That reframed it from an agent-discipline problem to a **gbrain retrieval defect**.

The page is *about* a Greek amphitheater. The phrase "Greek amphitheater" appears in its title and first sentence; "Greek theater," "theatron," "Epidaurus," "orchestra," "skene" pepper the body. A healthy semantic index returns this at the top with high confidence. It didn't.

---

## 2. Reproduction & Evidence

All runs against the production brain (~100K pages), gbrain 0.41.26.1.

### 2.1 The bare query underperforms

```
$ gbrain search "Greek amphitheater" --limit 8
[0.6401] projects/new-greek-theater/concept_v0 -- - **Ceiling treatment:** A domed or faceted ceiling can either focus sound…
[0.6249] projects/sanctum            -- venue, no permits needed…
[0.6173] conversations/wintermute/2026/2026-05-09 -- The thing that forced his hand had a name: Bambu Lab…
[0.3964] reports/content-ideas/2026-05-09-0536 …
[0.3660] personal/correspondence/2007-09-13-white-stripes-concert-canceled …
```

The Mingtang is technically rank 1 — but at **0.64**, represented by the **ceiling-treatment** body chunk, sitting in a cluster with two unrelated pages at 0.62/0.61. In a realistic agent flow with a confidence threshold (e.g. the dedup gate's 0.85), this reads as "no strong match — safe to write a new page." That is exactly the failure that produced the duplicate.

### 2.2 The title chunk embeds perfectly — it just isn't selected

```
$ gbrain search "indoor Greek amphitheater San Francisco" --limit 5
[0.9903] conversations/wintermute/2026/2026-05-09 …
[0.9866] projects/new-greek-theater/concept_v0 -- # The Mingtang (明堂)  > **The Hall of Light.** An indoor Greek amphitheater purpose-built for adversarial…
```

With a richer query the **title chunk** surfaces at **0.9866**. So:
- The page **is** chunked and embedded.
- Its title chunk **is** in the index and **is** highly relevant.
- The bare 2-word query simply fails to pull the title chunk into the candidate set; a weak body chunk represents the page instead.

### 2.3 Mode knobs are a no-op on this query

```
$ gbrain search "Greek amphitheater" --mode conservative   # reranker OFF, expansion OFF
[0.6401] projects/new-greek-theater/concept_v0 -- - **Ceiling treatment:** …
$ gbrain search "Greek amphitheater" --mode thorough       # reranker ON, expansion ON
[0.6401] projects/new-greek-theater/concept_v0 -- - **Ceiling treatment:** …
```

**Identical 0.6401, identical chunk, across all three modes.** The reranker and LLM query-expansion that `balanced`/`thorough` enable change nothing here. This means the failure is upstream of reranking, in candidate generation / page aggregation — and it raises a question about whether the CLI default path invokes the documented hybrid stack at all.

---

## 3. Root Cause (Code-Level)

### 3.1 The vector path has no per-page max-pool

`src/core/postgres-engine.ts` → `searchVector` (~line 1789):

```sql
WITH hnsw_candidates AS (
  SELECT p.slug, p.id as page_id, p.title, …,
         cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
         1 - (cc.<col> <=> <query_vec>) AS raw_score
  FROM content_chunks cc
  JOIN pages p ON p.id = cc.page_id
  …
  ORDER BY cc.<col> <=> <query_vec>
  LIMIT <innerLimit>          -- top-k CHUNKS, brain-wide
)
SELECT slug, …, raw_score * <source_factor> AS score, false AS stale
FROM hnsw_candidates
ORDER BY score DESC, page_id ASC, chunk_id ASC
LIMIT <limit> OFFSET <offset>;
```

There is **no `DISTINCT ON (slug)`**. The CTE selects the top `innerLimit` *chunks* across the entire corpus, then orders and truncates **chunk-grain**. A page is represented by whichever of its chunks survived `innerLimit`. If a page's best chunk ranks #150 in nearest-neighbor order and `innerLimit` is ~100, that chunk is gone; a weaker chunk at #95 represents the page, or the page disappears entirely.

### 3.2 The keyword path already does it right

`src/core/postgres-engine.ts` → `searchKeyword` (~line 1526):

```sql
ranked_chunks AS (
  SELECT …, ts_rank(cc.search_vector, websearch_to_tsquery('english', $1)) * <source_factor> AS score
  FROM content_chunks cc JOIN pages p … ORDER BY score DESC LIMIT <innerLimit>
),
best_per_page AS (
  SELECT DISTINCT ON (slug) *
  FROM ranked_chunks
  ORDER BY slug, score DESC          -- ← best chunk per page
)
SELECT … FROM best_per_page ORDER BY score DESC LIMIT <limit> OFFSET <offset>;
```

`best_per_page` collapses chunks to the **max-scoring chunk per slug**. The vector path is missing exactly this stage. This is an internal inconsistency: two retrieval paths in the same engine disagree on whether a page is scored by its best chunk.

### 3.3 Same defect in the pglite engine

`src/core/pglite-engine.ts` → `searchVector` (~line 1812) has the same shape: `hnsw_candidates` CTE → re-rank by `raw_score * source_factor` → `LIMIT`. No per-page pooling. The engines are at behavioral parity on the **bug**.

### 3.4 Candidate-pool asymmetry compounds it

- Keyword path `innerLimit` (postgres-engine ~line 1415): `Math.min(limit * 3, MAX_SEARCH_LIMIT * 3)`.
- Vector path `innerLimit` (postgres-engine ~line 1702): `offset + Math.max(limit * 5, 100)`.

For `--limit 8`, vector pulls ~100 candidate chunks brain-wide. Against ~100K pages, the nearest-neighbor cut for a weak short query is dominated by thematically-adjacent chunks from many pages. A target page's single strongest chunk competing for one of ~100 global slots can lose to noise — and because there's no pooling, losing that one slot means the page is misrepresented or absent.

### 3.5 Documented architecture vs. shipped path

[`RETRIEVAL.md`](./RETRIEVAL.md) describes a four-strategy hybrid (vector + BM25 + RRF + graph) and reports **49.1 P@5 / 97.9 R@5** on BrainBench, explicitly warning that **"vector search alone underdelivers."** The incident shows the production CLI default behaving like vector-only with no fusion and no pooling — i.e. the exact failure mode the doc says the stack exists to prevent. **Open question for maintainers:** does `gbrain search` (CLI default) route through the hybrid+RRF+graph stack, or does it call `searchVector` directly? The mode-knob no-op (§2.3) suggests the latter, at least for this path. If BrainBench exercises a different code path than the CLI, the benchmark is not protecting the surface users actually hit.

---

## 4. Boil-the-Ocean Fix Menu

Ordered cheapest → most ambitious. Recommendation: ship **Tier 1** first, **measure** (§5), and only build higher tiers if the evals don't clear the bar. Tiers are independent unless noted.

### Tier 1 — Per-page max-pool in `searchVector` (the actual bug)

- Mirror `searchKeyword`'s `best_per_page` into both engines' `searchVector`: `DISTINCT ON (slug) … ORDER BY slug, score DESC`, pooling over the **full candidate set before** the user-facing `LIMIT`. Keep the stable tiebreaker (`page_id ASC, chunk_id ASC`).
- Ensure pooling happens over a candidate set large enough that a page's best chunk isn't truncated pre-pool. Either (a) raise vector `innerLimit`, or (b) restructure so pooling precedes truncation, or (c) two-stage: pull top-N chunks, pool to pages, then re-expand each surviving page's best chunk.
- **Cost:** ~a day incl. tests + dual-engine parity. **Risk:** low — copies a proven in-repo pattern. **Expected:** "Greek amphitheater" → Mingtang at ~0.9 (its title chunk), because we know that chunk embeds at 0.9866.
- **This may fully resolve the symptom.** Everything below is conditional on evals showing residual gaps.

### Tier 2 — Title/summary as first-class retrieval signal

The deeper reason "Greek amphitheater" matched a body chunk and not the title: the **title is just another chunk** competing on equal footing. Names of things deserve weight.
- **2a. Dedicated title/summary embedding** per page (separate column or a synthetic high-priority chunk), fused into candidate generation so a query matching the title is strongly favored.
- **2b. Title/heading boost factor** at scoring time (analogous to the existing `source_factor` multiplier) when the matched chunk is `chunk_source = 'title'`/heading or the page title is a lexical superstring of the query.
- **Cost:** medium (schema touch + ingest + scoring). **Risk:** medium — needs eval to avoid over-boosting titles on thematic queries.

### Tier 3 — Make the CLI default a true hybrid (close the doc/reality gap)

- Route `gbrain search` through the documented **vector + BM25 + RRF** fusion so lexical signal (the literal phrase "Greek amphitheater" is in the title) can rescue vector misses. RRF means neither strategy needs a global weight.
- Confirm/repair that `reranker_enabled` and `expansion` actually fire on the default path (the §2.3 no-op suggests they don't).
- **Cost:** medium–high. **Risk:** medium — this is the path BrainBench supposedly already measures, so it may be largely wiring + ensuring the CLI uses it.

### Tier 4 — Alias / named-entity resolution layer

For true synonyms where neither vector nor lexical helps (e.g. "the Hall of Light" ↔ "Mingtang" ↔ "Greek amphitheater" ↔ "the buildings other people won't build"):
- **4a. Project `aliases:` frontmatter into a searchable structure at ingest** (many pages already declare `aliases:`; today it's dead metadata for the query path). Normalize (lowercase/trim/collapse-ws). Backfill existing pages.
- **4b. Deterministic alias hop in query:** if the normalized query (or an n-gram) matches a stored alias, hard-inject the canonical page into candidates at high score — no LLM call, works with expansion off. Source-aware like the existing `resolveSlugWithAlias`.
- Note: today's `slug_aliases` table is exact slug→slug redirect used only by `get <slug>`; it does **not** participate in search. Decide: extend it for free-text aliases or add a `page_aliases` table.
- **Cost:** medium. **Risk:** low. **Value:** catches the cases vector/lexical structurally cannot, and makes Garry's chosen names load-bearing in retrieval.

### Tier 5 — Query understanding & expansion that works

- Replace/augment the barely-measurable LLM expansion with: acronym/romanization expansion (明堂 ↔ Mingtang), entity-linking the query against page titles/aliases before search, and multi-vector query (embed the raw query AND an LLM-canonicalized form, fuse via RRF).
- **Cost:** high. **Risk:** medium (latency, cost per search). Gate behind a mode.

### Tier 6 — Graph-assisted recall for named things

- When a query lexically/aliases-matches a page title, pull that page **and its graph neighbors** so "the amphitheater" also surfaces related project/people/venue pages. Leverages the existing zero-LLM auto-link graph.
- **Cost:** medium (graph already exists). **Value:** turns a name hit into a contextual cluster.

### Cross-cutting hardening (do alongside whatever tier ships)

- **Score semantics:** document and standardize what `score` means per path (raw cosine vs. post-rerank vs. fused). The agent-side dedup gate keys off 0.85; if different paths emit differently-scaled scores, thresholds are meaningless. See [`docs/eval/METRIC_GLOSSARY.md`](../eval/METRIC_GLOSSARY.md).
- **Engine parity test** that fails CI if postgres and pglite `searchVector` diverge behaviorally on a fixture corpus.

---

## 5. Eval Design — "Super Good Evals"

The point: never let a page be misrepresented by a weak chunk again, and catch it in CI, not in chat. Build on the **existing harness** (`src/eval/code-retrieval/harness.ts` — `loadQuestions`, `runCodeRetrievalEval`, `evaluateGate`, `DEFAULT_GATE`, `EvalRunReport`) and the **baseline → compare → gate** pattern already used by `gbrain eval code-retrieval`. Metrics already implemented: `precisionAtK`, `recallAtK`, MRR, nDCG@k (see RETRIEVAL.md's BrainBench: P@5, R@5, MRR, nDCG@5).

### 5.1 New eval suite: `retrieval-quality` (a.k.a. NamedThingBench)

A gold-labeled query set targeting the failure class this incident exposed, run with **reranker AND expansion OFF** (so it measures core retrieval, not rescue layers).

**Query families (each query → gold set of expected slugs):**
1. **Title-substring queries.** Query is a literal phrase from a page title (e.g. "Greek amphitheater" → `projects/new-greek-theater/concept_v0`). The page MUST be rank 1. This is the direct regression for this bug.
2. **Generic-label → named-entity.** Tourist label for a named thing ("the photo app" → Baku; "Garry's civic platform" → Garry's List). Tests Tier 4.
3. **Synonym / alias.** "Hall of Light" / "明堂" → Mingtang. Tests Tier 4/5.
4. **Multi-chunk dilution.** Long pages where the relevant content is one strong chunk among many weak ones. Directly stresses max-pooling (Tier 1).
5. **Short vs. rich paraphrase pairs.** Same intent, 2-word vs. 8-word form; assert the short form doesn't collapse (the §2.1 vs §2.2 gap should shrink to near-zero after Tier 1).
6. **Relationship / graph queries** (from RETRIEVAL.md's strength) as a guardrail so retrieval changes don't regress graph wins.
7. **Hard negatives.** Queries that should NOT return a given page (precision guard against over-boosting titles in Tier 2).

**Metrics & gates (reuse `GateOpts`/`DEFAULT_GATE` shape):**
- **Hit@1 / Hit@3** per family (binary "did the gold page make rank 1/3").
- **MRR, nDCG@5, P@5, R@5** overall and per family.
- **Score-confidence calibration:** for true matches, median score should be ≥ the agent dedup threshold (0.85) OR we explicitly recalibrate the threshold. Track score distribution for true-positive rank-1 hits.
- **Short-vs-rich gap:** `score(rich) − score(short)` for matched pairs; target gap → ~0 after Tier 1.
- **Gate verdict:** PR must not regress any family's Hit@3 and must improve title-substring Hit@1 from the current baseline (this bug → near-0 usable) to ~1.0.

### 5.2 Baseline capture (do this in the FIX PR, not this doc PR)

```
gbrain eval retrieval-quality --baseline --save evals/retrieval-quality/baseline.json    # current broken state
# … apply Tier 1 …
gbrain eval retrieval-quality --save evals/retrieval-quality/maxpool.json
gbrain eval retrieval-quality --compare baseline.json maxpool.json                        # gate verdict
```

Run baseline 3× for a noise floor (the code-retrieval harness already documents this practice).

### 5.3 Corpus strategy

- **Real-corpus subset:** a curated, PII-safe gold set drawn from the actual brain (Mingtang, Baku, Garry's List, Argus, Sanctum, etc.) — these are the queries that matter. Store labels, not content, where possible.
- **Synthetic stress corpus:** extend BrainBench / the sibling `gbrain-evals` repo with multi-chunk dilution fixtures (a page with one strong title chunk + N weak body chunks) so the max-pool behavior is testable without the prod DB.
- **Engine parity:** every behavioral assertion runs against **both** postgres and pglite.

### 5.4 CI integration

- Wire `retrieval-quality` into the existing `eval-gate` flow. PRs touching `searchVector`, `searchKeyword`, chunking, embedding, or scoring **must** run it and pass the gate.
- Add the multi-chunk-dilution unit fixture to the fast test path so the specific "scored by weakest chunk" regression is caught in seconds, not only in the full eval.

### 5.5 Standing observability

- Log per-query, per-path score distributions to `search_telemetry` (already exists per `search stats`). Alert if rank-1 true-positive median score drifts down — an early warning that a scoring/chunking change degraded retrieval before a human hits it in chat.

---

## 6. Recommendation

1. **Ship Tier 1** (per-page max-pool, both engines) as a focused PR with the §5 baseline + regression eval. High confidence it resolves the incident symptom.
2. **Measure** against NamedThingBench. Publish the before/after numbers.
3. **Decide Tiers 2–6 by data.** Build title-boost / hybrid / alias / graph layers only where the evals show residual gaps. Cheap fix first, measure, then spend.
4. **Resolve the doc/reality question** in §3.5: confirm whether the CLI default exercises the documented hybrid stack; if not, that's its own correctness issue independent of this bug.

The discipline this incident teaches: a benchmark that scores 97.9 R@5 while the production default returns a flagship page at 0.64 means the benchmark and the shipped path have diverged. The eval work above exists to make that divergence impossible to reintroduce silently.

---

## Appendix A — Exact references

- `src/core/postgres-engine.ts` — `searchVector` ~1674–1832 (no `DISTINCT ON`), `searchKeyword` `best_per_page` ~1526, keyword innerLimit ~1415, vector innerLimit ~1702.
- `src/core/pglite-engine.ts` — `searchVector` ~1812 (same defect).
- `src/core/search/mode.ts` — mode bundles; `balanced` = expansion off / reranker on; `DEFAULT_SEARCH_MODE = 'balanced'`.
- `src/eval/code-retrieval/harness.ts` — `precisionAtK`/`recallAtK`/MRR/nDCG, `EvalRunReport`, `evaluateGate`, `DEFAULT_GATE`.
- `docs/architecture/RETRIEVAL.md` — documented hybrid stack + BrainBench 49.1 P@5 / 97.9 R@5.
- Incident page: `projects/new-greek-theater/concept_v0` (title chunk embeds at 0.9866; bare-query match 0.6401).
