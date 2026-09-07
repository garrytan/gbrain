# Why the hybrid + graph stack works

Vector search alone underdelivers on real personal-knowledge queries. This doc explains why gbrain layers four strategies together and how they compound.

## The four strategies in concert

1. **Vector (HNSW on pgvector)** — semantic similarity. Catches "who works on retrieval quality at acme-example?" → pages mentioning "alice-example + retrieval" even when the user never typed "acme".
2. **BM25 keyword** — lexical match. Catches names, exact phrases, code identifiers, anything where the user remembers the literal token. Survives the cases where vector search drifts into thematic neighbors.
3. **Reciprocal-rank fusion (RRF)** — merges vector + keyword rankings without weighting one over the other globally. Each strategy gets to vote.
4. **Knowledge graph traversal** — follows typed edges. Catches "what did Bob invest in this quarter?" by walking `bob ── invested_in ──> company ── dated ──> Q1`. Vector search can't see causal chains; the graph can.

## Why each one alone fails

**Vector only.** Returns chunks semantically close to the query. Misses any factual relationship not directly encoded in the embedding. "Companies in alice-example's portfolio" returns essays about portfolios, not company pages.

**Keyword only (ripgrep-style).** Brittle to phrasing. "Who works on retrieval?" misses pages that say "search ranking" instead of "retrieval." Garbage on synonyms, near-misses, or paraphrases.

**Graph only.** Excellent at "neighbors of Alice" but blind to anything not yet linked. Sparse on fresh pages until backlinks accumulate.

**Hybrid (vector + keyword + RRF), no graph.** Decent at "what is X?" type queries. Fails on "what is Y's relationship to X?" — those are graph queries and no amount of embedding tuning recovers them.

## The benchmark

BrainBench (corpus + harness in the sibling [gbrain-evals](https://github.com/garrytan/gbrain-evals) repo) measures retrieval P@5, R@5, MRR, nDCG@5 on a 240-page Opus-generated rich-prose corpus. (This is the retrieval-ranking benchmark; the in-repo `gbrain eval brainbench` suite — [`docs/eval/BRAINBENCH.md`](../eval/BRAINBENCH.md) — gates the memory behaviors *above* retrieval: unprompted context push, write-back fidelity, cross-session continuity.)

| Strategy | P@5 | R@5 | Notes |
|---|---|---|---|
| ripgrep BM25 only | ~18 | ~75 | Lexical-only baseline |
| vector-only RAG | ~18 | ~80 | Standard RAG implementation |
| gbrain graph-disabled (hybrid + RRF, no graph traversal) | ~18 | ~85 | Hybrid alone |
| **gbrain default (full stack)** | **49.1** | **97.9** | Graph + extract-quality lift |

**+31 P@5 points** from the graph + extract quality work. The graph isn't a marginal feature; it's the load-bearing wall.

## Auto-link: why zero-LLM-call edge extraction works

Every `put_page` runs `extractEntityRefs` on the markdown body. It matches:

- Standard markdown links: `[Alice Example](wiki/people/alice-example)`
- Obsidian wikilinks: `[[wiki/people/alice-example|Alice Example]]`
- Typed-link blockquotes: `> **Convention:** see [path](path).`

Three regexes, zero LLM tokens, single SQL `addLinksBatch` call with `INSERT ... SELECT FROM jsonb_to_recordset(($1::jsonb)->'rows') JOIN pages ON CONFLICT DO NOTHING RETURNING 1` (free-text-safe). The graph grows on every write at near-zero cost. On a 17K-page brain, full graph extract completes in seconds.

Heuristic link-type inference (`attended`, `works_at`, `invested_in`, `founded`, `advises`) fires from surrounding sentence context — also LLM-free. Power users who want richer types add them via the typed-link blockquote convention.

## Cross-encoder reranker: 60% top-1 reshuffle

The reranker is on for the `balanced` and `tokenmax` mode bundles, off for `conservative`. The mode-bundle default is Voyage `rerank-2.5` (`DEFAULT_RERANKER_MODEL`, same `VOYAGE_API_KEY` as the embedding default); a brain with no `search.reranker.model` row reranks with it. Without the key, search fails open in RRF order: the gateway skips the HTTP call (`RerankError('no_key')`), writes ONE audit row per process, prints nothing, and stamps `reranker_skipped (no_key)` on the search meta — `gbrain search --explain` shows it, `gbrain search modes` prints a `Reranker:` readiness line, and `gbrain doctor`'s `reranker_health` names the fix (`export VOYAGE_API_KEY=…` or `gbrain config set search.reranker.enabled false`). Keyed installs without a Voyage key get reranking explicitly disabled at init. An explicit ZeroEntropy `zerank-*` config (`LEGACY_DEFAULT_RERANKER_MODEL`; hosted API ends 2026-09-04) short-circuits past that date before any HTTP: one audit row per process per model plus a single stderr line naming the switch command, and `gbrain doctor`'s `provider_sunset` check explains the state; a `base_urls` recipe override (self-hosted wire-compatible endpoint) suppresses the short-circuit. The retained query-cache key includes `reranker_model`; persisted result reuse is disabled until every response dependency can be verified. On a real-corpus benchmark across 20 queries, the cross-encoder reshuffled **60% of top-1 results** after the hybrid + RRF + graph stack (measured on zerank-2). The Voyage default's paired LongMemEval numbers live in [`docs/eval-bench.md`](../eval-bench.md#public-benchmarks-longmemeval).

The mechanical reason: hybrid ranking is locally optimal per strategy but globally suboptimal. A cross-encoder reranker reads the query + each candidate document jointly, with full attention. It catches the cases where the vector + keyword + graph signals all agreed on a document that's semantically related but topically wrong.

The cost: +150ms p50 latency, ~$0.025–0.05/M tokens depending on the reranker. Disabled with `gbrain config set search.reranker.enabled false`. For agent loops that do downstream LLM work after retrieval, the latency is invisible.

## Source-aware ranking

Hybrid search applies a source-factor CASE expression at the SQL layer (lives in `src/core/search/sql-ranking.ts`). Curated content like `originals/`, `concepts/`, `writing/` outranks bulk content like `your-openclaw/chat/`, `daily/`, `media/x/`. Hard-exclude prefixes (`test/`, `attachments/`, `.raw/`) filter at retrieval, not post-rank.

`archive/` is deliberately NOT hard-excluded: it holds high-signal historical content users expect to find, so it is demoted (`0.5x` in `DEFAULT_SOURCE_BOOSTS`), not hidden. The demote is a prior applied in the outer SQL re-rank; the cross-encoder reranker (balanced/tokenmax modes) can still PROMOTE an archive page that survives the demote into the rerank candidate window — it is not an unconditional suppression. `gbrain doctor`'s `hidden_by_search_policy` check reports how many chunked pages remain hidden by the surviving exclude prefixes.

The boost map is configurable via the `GBRAIN_SOURCE_BOOST` env var. Hard exclusions are separate: the exclusion set is defaults ∪ `GBRAIN_SEARCH_EXCLUDE` (env, comma-separated prefixes) ∪ per-call `SearchOpts.exclude_slug_prefixes`. Temporal queries (`detail: 'high'`) bypass the boost so chat pages re-surface for time-sensitive lookups.

## Named-thing retrieval (per-page pool + title + alias + evidence)

A brain organized around *chosen names* (project codenames, place nicknames —
say a project named "Helios" whose page is also known as "the Sun Room") needs
more than embedding proximity. Four layers (the failure mode they close is
written up in [`RETRIEVAL_MAXPOOL_INCIDENT.md`](../incidents/RETRIEVAL_MAXPOOL_INCIDENT.md)):

- **Per-page max-pool** — `searchVector` (both engines) collapses chunk-grain
  candidates to the best chunk per page (`DISTINCT ON (slug)`) over the full
  candidate set before the user `LIMIT`, via the shared `buildBestPerPagePoolCte`
  in `sql-ranking.ts`. The vector side returns N distinct pages by best chunk,
  not N chunks that collapse to fewer pages downstream. When one dense page's
  chunks fill the inner candidate pool, the engines escalate the pool in a
  bounded loop (×4 per step, at most 3 escalations; HNSW-backed columns
  additionally cap at the `ef_search` ceiling) until the page count is honest;
  a loop that ends still underfilled surfaces `vector_pool_underfilled` on the
  hybrid layer's `HybridSearchMeta` (the op-layer capture channel) instead of
  silently returning a short page.
- **Title-phrase boost** — when the normalized query is a contiguous token-run
  inside `page.title` (or an exact full-title match), a floor-ratio-gated,
  bounded multiplier fires (`applyTitleBoost`, `search.title_boost` knob). A
  query that is a phrase from the title can't lose to a body chunk by luck.
- **Alias hop** — free-text `aliases:` frontmatter is projected into a
  `page_aliases` table (separate from the `slug_aliases` wikilink redirect) and
  consulted at query time: a full normalized-query match injects/boosts the
  canonical page (`applyAliasHop`). The only layer that bridges true synonyms
  with zero surface overlap ("the Sun Room" → the Helios page). Backfill
  existing pages with `gbrain reindex --aliases`.
- **Evidence contract** — every result carries `evidence`
  (`alias_hit | exact_title_match | high_vector_match | keyword_exact |
  weak_semantic`) and `create_safety` (`exists | probable | unknown`). An agent
  deciding "is this page already here, safe to NOT write a duplicate?" keys off
  `create_safety`, not a raw blended score. `high_vector_match` is grounded in
  the result's real query↔chunk cosine (`SearchResult.cosine` at/above
  `search.evidence_cosine_floor`, default 0.80) — never the blended score, so a
  keyword+boost pile-up can't read as semantic support; keyless runs have no
  cosine and degrade to honest keyword-based labels. `gbrain search --explain`
  prints each result's raw cosine next to its blended score.

**Extraction quarantine lane:** pages carrying the unverified
auto-extracted markers (frontmatter `provenance: auto-extracted` +
`status: unverified`, see `src/core/extraction-review.ts`) rank as ordinary
content — they are skipped by the compiled-truth fusion boost and by the
`people/`/`companies/` namespace source-boost, and every search result from
such a page carries `unverified: true` so agents can label the provenance.
Promote or reject them via `gbrain extraction-pending` / `gbrain
extraction-review`.

The `search` MCP/CLI op is **cheap-hybrid** (vector + keyword + RRF + pool +
title + alias, expansion off); `query` is the full-control variant. Route
concept / landscape / "all-of-X" questions to `query` — expansion recovers
synonym-phrased matches `search` can miss, and a populated `search` result set
is not proof of coverage (both are top-K; exhaustive enumeration belongs to
`list_pages`). NamedThingBench
(`gbrain eval retrieval-quality`) gates these families on every PR. Diagnose a
specific miss with `gbrain search diagnose "<q>" --target <slug>`.

## Intent-aware query rewriting

`src/core/search/query-intent.ts` classifies queries into `entity`, `temporal`, `event`, `concept`, or `general`. Each routes through different ranking knobs:

- **Entity** queries ("who works at X?") apply a higher graph-traversal weight.
- **Temporal** queries ("what happened last week?") bypass source-boost so chat/daily pages surface.
- **Event** queries ("Acme AI Series A") engage the timeline index.
- **Concept** queries ("what is the ownership economy?", "find all the companies doing offshore wind" — definitional paraphrases and landscape/quantifier phrasings with no proper noun) rank vector-lean, so keyword-decoy pages stop outranking the page that actually explains the idea. Proper nouns, quoted phrases, and sub-3-word queries never classify as concept — they keep their existing routing.
- **General** queries hit the standard hybrid stack.

The classifier is deterministic (no LLM call). Wrong classification degrades gracefully — the hybrid stack still works without it.

## Multi-query expansion

For `detail: 'high'` searches, `src/core/search/expansion.ts` runs a Haiku-class LLM call to produce 2-3 query variants. Each variant's vector list enters RRF fusion alongside the original's. Expansion is NOT free on recall: on LongMemEval-S (470 scored questions, k=5, the 2026-09-02 receipt in `docs/eval-bench.md`) plain hybrid scores 93.19% strict `recall_all@5` while hybrid + equal-weight expansion scores 54.89% (paired +3 / -183 questions) — variant lists fusing at the same weight as the original outvote it on small-k recall, and the damage grows with the nondeterministic variant count.

The fix is budget-normalized weighted RRF, composed in `src/core/search/fusion-lists.ts`. Every vector list is a role-tagged arm (`original` | `variant` | `clause` | `image`) — tagged objects, never a positional convention, so a failed arm or a fell-open image branch can't mis-tag a list. The `original` arm always fuses at weight 1; the non-empty `variant`/`clause` arms share ONE total weight budget, `search.expansion_variant_budget` (`weight_i = b / n_voting_arms`, each row scored `weight / (k + rank)`), so total expansion influence is exactly `b` however many variants the LLM produced. `null` — the default in all three mode bundles — is the legacy equal-weight fusion (every list weight 1, byte-identical). A budget in (0, 4] is set with `gbrain config set search.expansion_variant_budget <b>`, per call via `HybridSearchOpts.expansionVariantBudget`, or pinned per eval arm with `gbrain eval longmemeval --expansion-variant-budget <b>` (sweep it against frozen `--expansion-replay` variants so cells differ only in `b`). Arithmetic: two variants agreeing on a distractor at rank 0 tie the original's rank-0 vote exactly at `b = 1.0`; legacy with two variants is ≈ `b = 2.0`; `b = 0.5` subordinates them. The knob is a no-op when expansion is off and folds into the query-cache key (`evb=`). Outcome (ranker wave, 2026-09-06, recorded Haiku variants replayed at every budget): the mechanism is real — strict `recall_all@5` rises from 255/470 at the legacy weighting to 394/470 at budget 0.25 — but its pre-registered rule (≥ plain hybrid − 2 on the 430-question decision set, no type losing > 1) failed at every budget (0.25: −43; plain hybrid 439/470), so every bundle keeps `expansion_variant_budget: null` and the knob is an operator lever. The receipts point at a trigger rather than a weight (expand only when the original query's evidence is weak), filed as the next pre-registered mechanism.

Expansion is opt-in per mode bundle (`tokenmax` on by default; `balanced` + `conservative` off). Default off in the cheap tiers because the LLM call adds ~$0.001/query and ~200ms — real money at scale. The `query` op is the exception: it defaults `expand: true` per call (pass `expand: false` to opt out) — expansion-by-default is what makes it the concept/landscape verb.

## Putting it together

The full pipeline for a trusted local `query` op follows. Remote retrieval
omits the optional code-graph augmentation stage; the policy-filtered typed-edge
relational recall arm remains available.

```
intent classify (query-intent.ts — deterministic, no LLM)
       │
       ▼
expansion (if enabled — tokenmax only by default)
       │
       ▼
hybrid recall + fusion:
   ├── vector  (HNSW on chunk embeddings, per-page max-pool)
   ├── keyword (BM25 via tsvector)
   ├── title-phrase arm
   ├── relational (typed-edge recall arm — relational queries only)
   ├── source-aware re-rank (CASE in SQL)
   ├── role-tagged arms; variant/clause lists weighted by search.expansion_variant_budget INSIDE the fusion (fusion-lists.ts)
   └── RRF fusion → cosine re-score → post-fusion boosts
       (backlink / salience / recency / graph signals / exact-match;
        the metadata boosts are skipped when the vector arm was the only
        voter — search.metadata_boost_gate=lexical, metadata-boost-gate.ts)
       │
       ▼
graph augment (optional two-pass structural expansion — walkDepth > 0)
       │
       ▼
deduplication (4-layer: per-page cap, same-page Jaccard, type diversity)
       │
       ▼
reranker (cross-encoder — balanced/tokenmax; fail-open)
       │
       ▼
relational re-pin (relational-arm rows back above the reranked text rows, in
   fused order, ≤ search.relational_rerank_pin; only when the reranker actually
   reordered — src/core/search/relational-rerank-pin.ts)
       │
       ▼
alias hop (exact alias match injects/boosts the canonical page)
       │
       ▼
exact-lookup tier (lookup-shaped queries only: slug + exact-title probes
   promote/inject the identity page at rank-1; supersession-filtered;
   fail-open — src/core/search/exact-lookup.ts)
       │
       ▼
evidence stamp → adaptive return (opt-in) → autocut (reranked modes)
       │
       ▼
limit slice → token-budget enforcement (per mode bundle)
       │
       ▼
results (+ retrieval-confidence grade in query-op meta — crag.ts)
```

Per-arm fail-open has one deliberate exception: when BOTH lexical arms
(`searchKeyword` + `searchTitles`) come back empty because of an ACCESS-class
failure (`isDbAccessFailure` in `src/core/pg-access-classify.ts` — the DB
itself is unreachable, not a schema gap), `hybridSearch` rethrows the arm
error instead of returning an empty result set. A dead database must surface
as the classified `database_error` envelope, never as a silent "no results".
Schema-class arm failures (pre-migration brains) keep the fail-open contract.

The stage order is pinned by `hybridSearch` in `src/core/search/hybrid.ts`:
dedup runs BEFORE the reranker (so the reranker sees a diverse candidate pool,
capped by its own `topNIn`; the reranker runs only on the full hybrid path — the
no-embedding and keyword-fallback paths are never reranked), the alias hop runs AFTER the reranker (so a query
that is a page's declared name reliably surfaces that page regardless of how
the reranker scored body chunks), and the token budget is enforced last, on
the final slice.

Two cross-cutting seams sit around the pipeline rather than inside it:

- **Private-page visibility.** For untrusted (remote/MCP) callers, every
  recall arm filters `visibility: private` pages via the shared predicate in
  `src/core/search/private-visibility.ts` (fail-closed default; operator
  opt-outs documented in `docs/operations/mcp-surface-runbook.md`). The
  same policy also authorizes contributing pages, link origins, dates and
  annotations before enrichment. Semantic result caching is temporarily
  disabled regardless of configuration; each request performs fresh retrieval.
  Query embeddings can still be reused within that request. Repeated searches
  may have higher latency and provider usage until caching can verify every
  response dependency.
- **CRAG-style confidence gate.** `src/core/search/crag.ts` grades every
  `query` op result (`strong`/`moderate`/`weak`) from the already-stamped
  honesty signals — zero LLM, zero added latency — and attaches the grade to
  response meta. Config-gated and default OFF: `search.crag_escalation=true`
  re-runs a weak retrieval once at a higher ceiling (expansion + relational
  on, autocut off, limit = the caller's explicit `limit` or the mode-derived
  default — never a hardcoded row count — floored at 50) and keeps the
  better-graded run; the re-run fires only when the first pass did not
  already run with the caller's expansion on (`shouldEscalateRetrieval` in
  `crag.ts`), so default-shape callers never pay a second expansion call for
  a near-identical candidate set. `search.crag_think=true` (local callers)
  escalates a still-weak result to `think`.

### Relational re-pin: edge answers bypass reranker demotion

The cross-encoder scores chunk TEXT against the query. The relational arm's
rows are typed-EDGE answers — "who invested in acme-co" resolves to investor
pages whose text need not mention acme-co at all — so a reranker ranks them
below any page that merely contains the query's words. Measured on
NamedThingBench's relational fixture (39 graph-relationship questions, the
shipped `balanced` default, `voyage:rerank-2.5`,
`scripts/r1-namedthing-rerank-ab.ts --relational`, paired per query): with
the reranker on and no pin, hit@1 fell from 21/39 to 3/39 (19 paired losses)
and hit@3 from 27/39 to 5/39 (22 paired losses), while the 11 non-relational
core questions showed 0 losses. With the pin at its default 3 — measured with
`--autocut on`, the shape that shipped before rule R2 turned autocut off — the
same paired comparison shows 0 hit@1 and
0 hit@3 losses (21/39 and 27/39, the reranker-off numbers) and the 11 core
questions unchanged, which is why the balanced reranker stays on.
`pinRelationalRows`
(`src/core/search/relational-rerank-pin.ts`) runs immediately after the
reranker and re-pins the arm's rows above the reranked text rows in their fused
order, bounded by `search.relational_rerank_pin` (3 in every bundle; `0`/`off`
restores the pre-pin ranking). It is a permutation of the pool (nothing added
or removed; one row per page; a relational row the reranker itself ranked
higher keeps that position; ties go to the fused order), fires only when the
reranker actually reordered (fail-open and reranker-off runs are untouched —
the fused order already carries the arm), and is a pure no-op for
non-relational queries. Pinned rows are stamped `relational_pinned` so autocut
keeps them and leaves them out of its cliff math (text-row autocut is
unchanged). The #3995 evidence slot still runs afterwards as the page-1
guarantee for pin 0 / fail-open runs. The pin trusts the arm: a false-positive
arm now puts up to `max` edge pages at the top instead of one at `limit` —
turn it off per brain with `gbrain config set search.relational_rerank_pin off`.
The knob folds into the query-cache key (`rrp=`).

### Metadata boost gate: vector-only voters keep the vector order

The post-fusion metadata boosts (backlink, salience, recency + chronicle,
graph signals, alias resolution) reward well-connected pages. That is right
when a lexical arm agreed the page is about the query; it is wrong on
paraphrase-style concept questions where nothing but the vector arm voted —
there the boosts promoted hub pages (1.03–1.12x) over the gold concept page,
which carried none. `decideMetadataBoosts`
(`src/core/search/metadata-boost-gate.ts`) runs before `runPostFusionStages`
and, under `search.metadata_boost_gate=lexical` (every bundle), skips those
boosts when no strict keyword, title-phrase or relational row fused (relaxed
OR-fallback rows do not count). Supersede downrank, exact-match boost,
title-phrase boost, compiled-truth boost, cosine re-score, dedup, reranker
and autocut are untouched either way. Receipt (Cat 13 conceptual recall,
gbrain-evals): held-out nDCG@5 53.0 → 57.8 (bare vector 60.5 remains the
stretch), NamedThingBench, BrainBench, the retrieval canary and the
LongMemEval dev slice byte-identical. `always` restores the pre-wave
pipeline; the decision is on `HybridSearchMeta.metadata_boost_gate`; the
knob folds into the query-cache key (`mbg=`). The companion
`search.keyword_arm_confidence_floor` (`src/core/search/arm-confidence.ts`,
off in every bundle) down-weights a weak keyword arm in the fusion; its
pre-registered receipt did not move the held-out score, so it ships as an
operator knob only.

### Autocut: score-discontinuity result-sizing

Off by default in every bundle. It shipped on for `balanced` and `tokenmax`
until the ranker wave's pre-registered rule R2 measured it on LongMemEval from
the shipped default's captured post-rerank pool: with the reranker on, the
score cliff after the top session is the normal shape on multi-part questions,
and the cut removed the second gold session — strict `recall_all@5` 449/470 →
379/470 (−68 paired on the 430-question decision set), with no floor in the
sweep {0.10 … 0.80} within two questions of "off" on either seeded half
(0.80 still lost 9, all knowledge-update). Any-hit stayed ≥ 99.4% throughout:
autocut keeps the best session and drops the rest, which is a token saving
(mean returned window 3256 → 1633 estimated tokens at 0.35) paid for with the
questions that need more than one session. `gbrain config set search.autocut
true` re-enables it with the knobs below; a session-aware cut (never below k
distinct sessions) is the filed follow-up. `applyAutocut`
(`src/core/search/autocut.ts`) cuts the ranked set at the largest
cross-encoder rerank-score cliff, before the limit slice, first page only.
Never-empty failsafe (`minKeep`), no-op when fewer than 2 results carry a
finite rerank score (covers the fail-open reranker path), and alias-hop exact
matches are preserved through the cut. Weak-top floor: when the top rerank
score is below `minTopScore` (default 0.35, config `search.autocut_min_top`),
cliff trimming is skipped entirely — a low-confidence list returns the full
cluster for the caller to judge instead of collapsing to one result. Knobs:
per-call `SearchOpts.autocut` → `search.autocut` / `search.autocut_jump` /
`search.autocut_min_top` config → mode bundle. The pre-autocut pool can be
captured for offline floor replay: `hybridSearch` exposes an eval-only
`onRerankPool` hook that fires with the exact pool `applyAutocut` is about to
cut (post-rerank, post alias-hop / exact-lookup, unscored injections included),
`gbrain eval longmemeval --capture-pool` records it per row as `rerank_pool`,
and `scripts/replay-autocut-floor.ts` replays every floor — including `off` —
from that single capture, validating byte-for-byte against the live decisions
before any other cell is read.

Each stage is testable in isolation. Each stage is replaceable. The whole pipeline is < 1ms of orchestration cost; the latency budget goes to the upstream HTTP calls (embedding, rerank) and the index scans.

## How to verify on your own brain

```bash
# Reproduce the public LongMemEval receipt (cleaned S split, k=5) like-for-like:
# --by-type prints strict recall_all@5 (headline) and recall_any@5 (diagnostic);
# the like-for-like row pins the reranker and autocut off.
gbrain eval longmemeval ~/datasets/longmemeval/longmemeval_s_cleaned.json \
  --retrieval-only --top-k 5 --by-type --no-trajectory --mode balanced --reranker off --autocut off
# The shipped default path (what balanced/tokenmax run): --reranker on --autocut off

# Capture your own queries and replay against retrieval changes
export GBRAIN_CONTRIBUTOR_MODE=1
# ... use gbrain normally ...
gbrain eval export > before.ndjson
# ... change something ...
gbrain eval replay --against before.ndjson

# A/B retrieval strategies on a labeled fixture
gbrain eval --qrels labels.tsv --config balanced.json
```

The current measured LongMemEval result (95.53% session-level `recall_all@5` on the release default path, 449/470, and 93.40% with the reranker off, 439/470; cleaned S split, 470 scored questions, k=5, measured 2026-09-06 by the in-repo harness), its per-type table, every arm of the ranker wave and the judged answer-accuracy row live in [`docs/eval-bench.md`](../eval-bench.md#public-benchmarks-longmemeval).

Methodology + metric glossary in [`docs/eval/SEARCH_MODE_METHODOLOGY.md`](../eval/SEARCH_MODE_METHODOLOGY.md).

## Restricted salience

Remote reads default to the `world` take holder when no grant is supplied; an
explicit empty grant permits no takes. Counts and average weights use only
permitted active takes. Stored emotional weight contributes zero because it
combines all holders. Recent-salience inclusion uses `updated_at`, while the
existing recency formula is retained; unrestricted local reads keep their
existing formulas. Deleted, quarantined and archived contributors are excluded
before ranking, limits and anomaly-baseline aggregation. Default remote page
privacy also excludes private pages; its documented opt-outs do not widen
take-holder permissions.


## Chunk rebuilds after upgrading

Markdown chunk creation applies the strict protected-body sanitizer before
splitting text. For remote reads, all existing chunks are withheld until a
successful rebuild records the current chunker version. Public pages require
this rebuild too; trusted local chunk reads remain available. Body or chunk changes
invalidate that record until the next successful rebuild. Direct page reads
continue to use current source and visibility policy plus body sanitization.

Run rebuild commands from a local installation on the brain host; thin clients
cannot rebuild the host's indexes.
`gbrain reindex --markdown --dry-run --no-embed` previews the existing rebuild.
`gbrain reindex --markdown --no-embed` rebuilds without embedding calls, replacing
previous vectors; use `gbrain embed --stale` later to restore semantic retrieval
when provider usage is authorized. The regular reindex path rebuilds and embeds.
Code pages use `gbrain reindex-code --force --no-embed`. Existing image indexes
require reimporting the source files; images whose OCR contains protected
sections remain unavailable to remote chunk retrieval. No schema migration is
required.


Optional code-graph expansion is omitted from remote search. The six dedicated
code-inspection operations are also temporarily local-only; see the
[MCP surface runbook](../operations/mcp-surface-runbook.md#temporary-code-inspection-availability).
These restrictions are separate from the chunk rebuild requirement.
