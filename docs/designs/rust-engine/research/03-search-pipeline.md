# 03. Search pipeline: retrieval and ranking, end to end

Line numbers refer to gbrain 36bd05806a.

Reference: gbrain TypeScript at `garrytan/gbrain`, commit `36bd05806a` (v0.60.733.0). Paths below are relative to `src/core/` unless they start with `docs/`. Line numbers are from reading the files at that commit.

Provenance labels: **[code]** = read in the source; **[doc]** = quoted from `docs/architecture/RETRIEVAL.md` or `docs/guides/search-modes.md` and not re-measured; **[inferred]** = my reading of how pieces combine, not run.

I did not execute the pipeline, the tests, or any benchmark. The eval repo (`gbrain-evals`, commit `9ecc5b20`) was only checked for layout. Benchmark figures below are doc quotes.

## 1. Entry points

| Op | File | Retrieval path | Expansion | Relational | Facts |
|---|---|---|---|---|---|
| `search` | `ops/search.ts:696` | `hybridSearchCached`, expansion pinned off (`:818`), `anyWordFill` | never | mode default | saved facts |
| `search` `match: keyword` | `ops/search.ts` | page-grain keyword enumeration, no RRF | n/a | n/a | n/a |
| `query` | `ops/search.ts:881` | `hybridSearchCached`; `expandFn` unless `expand:false` (`:1077`) | mode default (off) or `expand: true` | mode default or `relational` param | facts arm, facts block, temporal reserve, saved facts |
| `recall` | `ops/facts.ts:298` | `hybridSearchCached`, expansion off (~`:1455`) | off | mode | facts |
| `think` gather | `think/gather.ts:182-210` | bare `hybridSearch`, expansion off | off | mode | n/a |


`query`'s `autocut` param text used to say "Default on"; the resolved default is off in every bundle, and the param text now says so (see section 9).

## 2. Mode bundles (`search/mode.ts:488`, `MODE_BUNDLES`)

| Knob | conservative | balanced (default) | tokenmax |
|---|---|---|---|
| `searchLimit` (default rows) | 10 | 25 | 50 |
| `tokenBudget` | 4000 | 12000 | none |
| reranker | off | `voyage:rerank-3-lite`, topNIn 25 | `voyage:rerank-3-lite`, topNIn 50 |
| `expansion` | false | false | false |
| `expansion_variant_budget` | null | null | null |
| `intentWeighting` | true | true | true |
| `keywordOrFallback` | true | true | true |
| `relationalRetrieval` / `relational_planner` | false / false | true / true | true / true |
| `relational_rerank_pin` | 3 | 3 | 3 |
| `graph_signals` | false | true | true |
| `collapse` / `rank_priors` | true / true | true / true | true / true |
| `floor_ratio` | undefined (off) | undefined | undefined |
| `metadata_boost_gate` | lexical | lexical | lexical |
| `autocut` / `autocut_jump` / `autocut_min_top` / `autocut_min_keep` | false / 0.2 / 0.35 / 1 | same | same |
| `cache_enabled` / threshold / TTL | true / 0.92 / 3600 | same | same |

Resolution order is per-call `SearchOpts`, then per-key config, then `MODE_BUNDLES[search.mode]`, then `balanced` (`search/mode.ts`, header comment). The `cache_*` values (threshold 0.92, TTL 3600 s) are retained config only. The semantic cache is hard-disabled at `search/query-cache.ts:35` (`semanticResultCacheAvailable() { return false; }`), so every request runs retrieval fresh.

## 3. Ordered stage diagram

Default path for a text query with both embedding and keyword available (`hybridSearch`, `search/hybrid.ts:1086`). Pool sizes are for `balanced` and `conservative` with a default `limit`; `tokenmax` doubles them. The DB feature each stage uses is in the right-hand column.

```
[0] resolve request              request.ts:109-250
    limit = opts.limit || searchLimit                          (25 balanced)
    pool  = min(max(2*limit, 50, offset+limit), max(100, depth))  -> 50
    intent = classifyQuery(regex, no LLM)                      query-intent.ts:513
    detail: entity->'low' (soft), temporal/event->'high', else undefined
    DB: none
        |
[1] embed query                  hybrid.ts:1058, timeout 6000ms (floor 2000ms)
    prefix from config (query-prefix.ts)
    DB: none (provider call)
        |
[2] expansion (off by default)   arms.ts:228-258, expansion.ts
    MIN_WORDS=3, MAX_QUERIES=3 (original + <=2 variants)
        |
[3] arms, run concurrently, Promise.allSettled-style fail-open
   [3a] vector  per query variant  vector-statement.ts, postgres-engine.ts:1450
        SQL candidate window innerLimit = offset + max(5*pool, 100) -> 250
        ANN LIMIT = innerLimit (x2 when index walk)
        HNSW cosine (<=>), hnsw.ef_search = clamp(window,40,1000)
        best chunk per page, LIMIT pool
        DB: pgvector HNSW vector_cosine_ops; hnsw.iterative_scan=relaxed_order;
            hnsw.max_scan_tuples 20000; statement_timeout from 8000ms deadline
   [3b] keyword  postgres-engine.ts:1066, keyword-chunk-match.ts
        websearch_to_tsquery('english') @@ chunk.search_vector
        score = ts_rank(...) * phrase(1|2) * sourceFactorCase
        ranked_chunks LIMIT min(3*pool, 300) -> 150; best per page; LIMIT pool
        KEYWORD_RANK_CANDIDATES = 50,000 bound; work_mem 32MB
        statement_timeout 8000ms (search.keyword_statement_timeout_ms)
        DB: GIN(search_vector), tsvector, ts_rank, websearch_to_tsquery
        fallback: if strict AND empty -> OR retry (keywordOrFallback), rarity-ranked
   [3c] title   title-statement.ts
        pages.search_vector @@ websearch_to_tsquery(gbrain_fts_input(q))
        exact_title DESC, ts_rank_cd * sourceFactor DESC; LIMIT pool
        DB: GIN(pages.search_vector), ts_rank_cd
   [3d] relational  relational-recall.ts:376 (only if relational query)
        typed-edge answers; bounded per-hop SQL; <= 50 frontier pages/hop
        DB: links table, indexed lookups; recursive CTE only in graph walks
        |
[4] drop relaxed (OR) keyword/title rows if a text vector list is non-empty   rank.ts:88-93
        |
[5] compose RRF lists (fusion-lists.ts composeFusionLists)
        vector: k=vectorK (intent), keyword/title: k=keywordK, relational: k=60
        expansion variant/clause: weight = budget/n (budget null -> 1)
        |
[6] RRF, page grain (rrf-page-fusion.ts, rrfFusionWeighted hybrid.ts:1467)
        page vote = weight/(k+rank) at its best rank per list; lead chunk carries it
        normalize by max; compiled-truth factor x2.0 (explicit low) or x1.2 (auto low)
        DB: none (in-process)
        |
[7] cosine re-score (cosine-rescore.ts:121)
        score = 0.7 * (rrf / maxRrf) + 0.3 * cosine; cosine = 1 - (embedding <=> q)
        DB: pgvector <=> in SQL (engine-sql/chunks.ts:1121), dims check
        |
[8] post-fusion boosts (runPostFusionStages hybrid.ts:543), metadata group gated
        backlink x(1+0.05*ln(1+n)); salience x(1+k*ln(1+s)), k=0.15|0.30
        recency x(1+m*c*h/(h+days)); chronicle event/diary x1.15|1.25
        graph adjacency x1.05 | cross-source x1.10 | session demote x0.95
        alias-resolved x1.05;  title-phrase x1.25 (not metadata-gated)
        supersede x0.5
        DB: GROUP BY counts on links, timeline/effective dates, page_aliases
        |
[9] identity boosts (request.ts:348)
        generated-page demotion x0.5 (GENERATED_FACTOR)
        exact-match x1.25 (entity intent) or title-mention x1.18 (general/temporal)
        alias-mention x exactMatchBoost (entity intent only)
        re-sort by score
        |
[10] dedup (dedup.ts:107): L1 top-3 chunks/page; L2 Jaccard>0.85 same page;
        L3 type share <=0.6; L4 cap 2 per page (6 if segmented);
        guarantee best compiled_truth chunk per page
     collapse (collapse.ts; search.collapse=true): twins/redirects take one slot
        DB: page reads
        |
[11] reranker (rerank.ts:127) top topNIn=25 rows, voyage, 5000ms, fail-open to RRF
        tail keeps fused order; no-key -> reranker_skipped
        |
[12] feedback (feedback-boost.ts): bounded per-page weight, only if rated
        relational re-pin (relational-rerank-pin.ts): <= 3 arm rows back on top,
        only when reranker reordered
        rank priors (rank-priors.ts): demote PERSON/OCR/UNDATED/... priors
        |
[13] alias hop (alias-hop.ts): exact alias match injects/boosts canonical page
     exact-lookup tier (exact-lookup.ts): slug/exact-title identity -> rank 1
     collapse again
        DB: page_aliases, pages slug/title lookups (pg_trgm used by find_pages, not here)
        |
[14] evidence stamp (evidence.ts): alias_hit | exact_title_match |
     high_vector_match (cosine >= 0.8) | keyword_exact | weak_semantic
     autocut (off in all bundles), adaptive return (off by default)
     relational evidence slot: pin one answer on page 1 (chain slots 10)
        |
[15] slice [offset, offset+limit) -> token budget (token-budget.ts; chars/4, CJK 1/char)
     content flags stamp; meta emit
        |
[16] ops layer (after cache/capture): facts arm + facts block + temporal reserve (query only),
     saved facts (search+query), evidence delivery (return_unit=auto, search/evidence-delivery.ts)
```

The hybrid flow is pinned in `hybridSearch` (`hybrid.ts:1086-1210`). Dedup runs before the reranker, so the reranker sees a diverse pool. The alias hop, exact-lookup tier and evidence stamp run after it.

## 4. The SQL

### 4.1 Vector arm (`search/vector-statement.ts`, `postgres-engine.ts:1450`)

Chunk embeddings live in `content_chunks.embedding vector(1536)` with `CREATE INDEX idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)` (`schema.sql:360`, `:408`). No `WITH (m, ef_construction)` is set, so pgvector defaults apply [code]. Multimodal columns are `embedding_image` and `embedding_multimodal`, both `vector(1024)` (`schema.sql:400-415`).

Key constants and shape:

- `innerLimit = offset + max(limit*5, 100)` (`vector-statement.ts:315`). With pool 50 that is 250.
- The ANN ordering is pure distance: `ORDER BY cc.embedding <=> $q LIMIT innerLimit` (`:404-412`). The source factor is a select-list expression, not in the ORDER BY, so the index stays usable (comment `:477-480`).
- Score: `raw_score = 1 - (cc.embedding <=> $q)`, then `score = raw_score * sourceFactorCase` (`:408`, `:481`).
- Freshness: `embedded_text_hash = md5(cc.chunk_text) OR embedded_text_hash IS NULL` (`:364`). On an indexed column the freshness predicate moves to a `scored` filter so the planner keeps the HNSW index (`:7-13`).
- Per-page pool: `DISTINCT ON (COALESCE(source_id,'default'), slug) ORDER BY score DESC, page_id, chunk_id` (`sql-ranking.ts:263`), then `ORDER BY score DESC, page_id ASC, chunk_id ASC LIMIT pool OFFSET offset`.
- Index walk (`:415-445`) and scope scan (`:447-475`): used only without type/date filters and for source shares of at least 0.04 (`:146`, `:354-361`). Scope scan covers small scopes (share < 0.3, chunks <= 120k; `:159-161`).

Session settings (`vector-settings.ts:29-32`, `vector-pool.ts`):

- `hnsw.ef_search = min(max(window, 40), 1000)` (`vector-index.ts:124-138`). The window is `innerLimit`, or `innerLimit * overfetch` for the walk.
- `hnsw.iterative_scan`: default `relaxed_order` on pgvector 0.8+ (`search/hnsw-iterative-scan.ts:18`); `off` otherwise.
- `hnsw.max_scan_tuples = 20000` (`POOL_MAX_SCAN_TUPLES`, `vector-pool.ts:85`).
- Walk attempts: 2000 ms budget, `enable_sort=off`, up to 2 escalations of x4 (`INDEX_WALK_ESCALATIONS`, `vector-pool.ts:32`).
- Pool loop: total deadline 8000 ms (`vector-pool.ts:103`), up to 3 escalations of x4 capped at `max(initialLimit, 20000)` (`:121-122`). On Postgres with an index and time left, one exact fallback with `+ 0` (`:125-127`). Shortfalls surface as `vector_candidates_incomplete`.

### 4.2 Keyword arm (`postgres-engine.ts:1066`, `search/keyword-chunk-match.ts`, `search/keyword-statement.ts`)

Non-CJK query:

```
candidates: content_chunks cc JOIN pages p JOIN sources s
  WHERE cc.search_vector @@ websearch_to_tsquery('english', $1)
    AND cc.modality = 'text' AND <type/date/source/hard-exclude/visibility filters>
score  = ts_rank(cc.search_vector, websearch_to_tsquery('english',$1))
         * (CASE WHEN ... phraseto_tsquery ... THEN 2 ELSE 1 END)   -- only if search.keyword_phrase
         * sourceFactorCase(p.slug)
ranked_chunks: row_number() OVER (PARTITION BY page_id ORDER BY score DESC, chunk_id) = 1,
               LIMIT min(3*pool, 300)  (innerLimit)
best_per_page: DISTINCT ON (source_id, slug) ... LIMIT pool OFFSET offset
```

Facts from the code:

- `KEYWORD_RANK_CANDIDATES = 50,000` (`keyword-chunk-match.ts:30`) bounds the rows ranked; over the bound the arm reports `keyword_candidates_incomplete`.
- `KEYWORD_STATEMENT_SETTINGS = { work_mem: '32MB' }` (`:40`). Statement timeout comes from `search.keyword_statement_timeout_ms` (default 8000, `postgres-engine/keyword-statement-timeout.ts:28`). A cancelled statement fails open to the vector arm with `keyword_arm_failed`.
- `ts_rank` is called with **default weights**, which are D=0.1, C=0.2, B=0.4, A=1.0, and default normalization 0. The code passes no weight array. Chunk `search_vector` weights are A = `doc_comment` and `symbol_name_qualified`, B = `chunk_text` (`schema.sql:444-458`). So a markdown chunk's text has weight 0.4 [code]. This is ts_rank, not BM25, despite the RETRIEVAL doc wording.
- The query text is passed to `websearch_to_tsquery` raw, after `collapseWebsearchDashRuns` only (`postgres-engine.ts:1111`, `keyword-statement.ts:71`). It is **not** wrapped in `gbrain_fts_input`. Only the title arm wraps it (`title-statement.ts:64`). See section 9.
- Relaxed OR retry (`keywordOrFallback`): if strict AND returns nothing, retry with `buildOrFallbackWebsearchQuery` (`sql-ranking.ts:363`). Narrowing caps at `OR_FALLBACK_MATCH_CAP = 20,000` (`keyword-or-narrow.ts:24`); rarity uses `RARE_TERM_CHUNK_CAP = 400` (`keyword-or-rarity.ts:36`).
- Relaxed rows are dropped from RRF when a text vector list is non-empty (`hybrid/rank.ts:88-93`).

### 4.3 Title arm (`search/title-statement.ts`)

- Match: `p.search_vector @@ (websearch_to_tsquery('english', gbrain_fts_input($1)) || name-variant queries)` (`:64`). Name variants are given-name spellings (`titleNameVariants`, #7471).
- Rank: `ts_rank_cd(p.search_vector, tsq) * sourceFactorCase` (`:68`). Page `search_vector` weights are A = title, C = timeline text (`schema.sql:1222-1224`).
- Order: `exact_title DESC, score DESC, p.id ASC`, `LIMIT pool OFFSET offset` (`:125-126`). `exact_title = lower(btrim(title, ' "' || chr(160))) = normalizeAlias(query)`.
- One row per page. A chunkless page gets a synthetic row (`chunk_id 0`, empty text), which the compiled-truth boost skips (`hybrid.ts:125-135`, #3695).

### 4.4 CJK path (`search/cjk-keyword-sql.ts`, `search/cjk.ts`)

- Trigger: `hasCJK(query)` (`cjk.ts:74`). `websearch_to_tsquery` cannot tokenize CJK under an ASCII config, so the tsvector path is skipped.
- Terms: whitespace split, Korean particles stripped (`cjk.ts:207-250`). Match: AND of `LIKE/ILIKE '%term%'` per term.
- Score: occurrence counts summed over terms, plus raw-phrase bonus and `1/POSITION` tiebreak; OR variant adds `MATCHED_TERM_WEIGHT = 1000` per matched term (`cjk-keyword-sql.ts:61`). Source factor multiplies.
- Budget: `search.cjk_keyword_deadline_ms` default 3000, range 500-30000 (`cjk-keyword-deadline.ts:11-13`).
- No tsvector, no GIN: an unindexed `LIKE` scan [code].

### 4.5 Relational arm (`search/relational-recall.ts:376`, `relational-chain.ts`)

- Built once before any return path (`hybrid/arms.ts:170-198`). Off unless `relationalRetrieval` is true (balanced and tokenmax).
- Single hop: `parseRelationalQuery` (`relational-intent.ts:341`, fixed vocabulary regex). Planner (`relational_planner`): `parseRelationalPlan` (`relational-plan.ts:176`), at most `MAX_CHAIN_HOPS = 3` (`relational-chain.ts:363`). Per hop: 50 frontier pages, 100 edges per page, 10 paths per page [doc]. `CHAIN_HUB_HALF_DEGREE = 32` (`:126`), `UNCERTAIN_EDGE_WEIGHT = 0.5` (`:129`).
- Fused at `k = baseRrfK = 60` only if the query is not image-modal and the list is non-empty (`fusion-lists.ts`).

### 4.6 Facts arm and saved facts (query only, after retrieval)

- Facts arm (`search/facts-arm.ts`): `MAX_FACT_ROWS = 3` (`:35`). Fact cosine floor `FACTS_ARM_COSINE_MIN = 0.6` (`fact-relevance.ts:75`), ordering by `facts.embedding <=> q` (vector or halfvec, `fact-relevance.ts:212-241`), lexical side `ts_rank_cd` over the facts FTS document (`idx_facts_fts`), term share `TERM_SHARE_MIN = 0.5` (`facts-arm.ts:39`). Facts take only spare row slots.
- Facts block (default on, needs `token_budget`): up to 22% of the budget (`QUERY_FACTS_BLOCK_SHARE = 0.22`, `:52`), 40 rows (`:53`).
- Temporal reserve (default off): 15% of budget (`:44`), 30% of rows (`:47`), up to 20 rows (`:45`).
- Saved facts on `search` and `query`: up to 5 facts, three-quarters term share, capped at four required words [doc].

## 4.7 Cosine SQL

`engine-sql/chunks.ts:1121` returns `1 - (col <=> q)` with dims and zero-norm guards, only for chunks visible under the page visibility predicate. Unhydrated rows get cosine 0 (`cosine-rescore.ts:117`).

## 5. Fusion

### 5.1 RRF (`hybrid.ts:1467` `rrfFusionWeighted`, `search/rrf-page-fusion.ts`)

- Vote identity is the page `(source_id, slug)`, not the chunk. Each list votes once per page at its best rank. The votes sum per page, and the page's lead chunk (largest own vote) carries the total. Other chunks keep their own votes (`rrf-page-fusion.ts:23-35`).
- Vote = `weight / (k + rank)`, rank 0-based (`rrf-page-fusion.ts:80`).
- Normalize by the maximum raw score so the top is 1.0 (`hybrid.ts:1480-1495`), then multiply by the compiled-truth factor (below).
- Sort by `score DESC, own DESC`. Ties then follow the fusion's list order.
- `RRF_K = 60` (`hybrid.ts:58`). Keyword-only and no-embedding paths use the same constant (`hybrid/keyword-only.ts:60,270`).

### 5.2 Intent-based k (`search/intent-weights.ts:60-123`, `hybrid/rank.ts:55-65`)

`effectiveRrfK(60, w) = 60 / w` (`:123`). Weights per intent (`:67-105`):

| Intent | keyword weight -> keyword k | vector weight -> vector k | Notes |
|---|---|---|---|
| general | 1.0 -> 60 | 1.0 -> 60 | default |
| entity | 1.15 -> 52.2 | 1.0 -> 60 | exact-match boost 1.25 |
| temporal | 1.0 -> 60 | 1.0 -> 60 | recency suggested "on" |
| event | 1.20 -> 50.0 | 0.95 -> 63.2 | recency "on", exact 1.10 |
| concept | 0.9 -> 66.7 | 1.2 -> 50.0 | exact 1.0; title-mention boost off |

Cross-modal "both" mode only: text k = 60/0.6 = 100, image k = 60/0.4 = 150 (`mode.ts` weights). Image-query refinement uses 60/0.4 and 60/0.6 (`by-image.ts:118-120`).

Intent comes from `classifyQuery` (`query-intent.ts:513`), which is regex only and calls no LLM. Auto `detail` comes from `intentToDetail` (`query-intent.ts:607`): entity -> `low`, temporal/event -> `high`, concept/general -> undefined.

### 5.3 Compiled-truth factor (`hybrid.ts:92-135`)

- Applies only when `detail === 'low'`. Explicit `low` gives x2.0 (`COMPILED_TRUTH_BOOST`). Auto-`low` from entity intent gives x1.2 (`AUTO_LOW_COMPILED_TRUTH_TILT`, `:102`). Other details give 1.0.
- Skipped for unverified auto-extracted stubs and synthetic chunkless title rows (#160, #3695).
- The header comment at `hybrid.ts:1-10` still says "2.0x for compiled_truth chunks" with no mention of detail gating. That comment is stale.

### 5.4 Cosine blend (`cosine-rescore.ts:121`)

`blended = 0.7 * (score / maxScore_after_boost) + 0.3 * cosine`. The max is taken after the compiled-truth factor over the same nonnegative scores, so the normalized value is in [0,1]. Cosine is not clamped, so the blended score is in [-0.3, 1], not [0, 1]. Rows are re-sorted by blended score. This runs before post-fusion boosts (`rank.ts:156-165`).

### 5.5 Source-aware factor (inside each arm's SQL)

`buildSourceFactorCase` (`sql-ranking.ts:67`) is a longest-prefix `CASE`. Defaults (`search/source-boost.ts:18-45`): `originals/` 1.5, `writing/` 1.4, `concepts/` 1.3, `people/` `companies/` `deals/` 1.2, `meetings/` `media/articles/` `media/repos/` 1.1, `yc/` `civic/` 1.0, `daily/` 0.8, `media/x/` 0.7, `openclaw/chat/` `archive/` 0.5. Hard excludes (`:67`): `test/`, `attachments/`, `.raw/`. `detail: high` returns 1.0 (`sql-ranking.ts:73`). Because RRF uses ranks, this only changes order within an arm and which chunk represents a page.

## 6. Post-fusion boosts (`runPostFusionStages`, `hybrid.ts:543`)

All multiplicative on the score. `floor_ratio` is undefined in every bundle, so the floor gate is off (`computeFloorThreshold` returns -Infinity, `hybrid.ts:300`). Each stage stamps an explain field.

| Stage | Constant | Gated by | Source |
|---|---|---|---|
| Backlink | `1 + 0.05 * ln(1 + inbound)` | metadata gate | `hybrid.ts:257` |
| Salience | `1 + k * ln(1 + s)`, k = 0.15 (on) / 0.30 (strong) | metadata gate; `salience` opt | `hybrid.ts:327` |
| Recency | `1 + m * c * h / (h + days)`; m = 1.0 / 1.5; per-prefix `(h, c)` | metadata gate; `recency != off` (intent-driven) | `hybrid.ts:359`, `recency-decay.ts:43-76` |
| Chronicle type | event/diary x1.15 (on) / x1.25 (strong) | recency on | `hybrid.ts:448` |
| Graph adjacency | x1.05 (>=2 hits in top-20), cross-source x1.10, session demote x0.95 | metadata gate + `graph_signals` | `graph-signals.ts:54-68` |
| Alias-resolved | x1.05 | metadata gate | `hybrid/alias-resolved.ts:16` |
| Title phrase | x1.25 (`title_boost`) | **not** gated | `hybrid.ts:416` |
| Supersede | x0.5 | always (probe, 5-min TTL) | `hybrid.ts:779` |
| Generated-page demotion | x0.5 | identity stage | `provenance-demotion.ts:28` |
| Exact match | x1.25 (entity intent) | intent | `intent-weights.ts:141` |
| Title mention | x1.18 (general/temporal, not concept, not relational) | intent | `intent-weights.ts:172` |

Recency per prefix (`recency-decay.ts:43-76`): `daily/` 14 d / 1.5, `media/x/` and `chat/` 7 d / 1.5 and 1.0, `meetings/` 60 d / 1.0, `originals/` 180 d / 0.5, `writing/` 365 d / 0.4, `people/` and `companies/` 365 d / 0.3, `deals/` 180 d / 0.5, `concepts/` evergreen, fallback 90 d / 0.3.

The metadata gate (`search/metadata-boost-gate.ts`, `lexical` in every bundle) skips the backlink, salience, recency, graph and alias stages when no strict keyword, title or relational row fused (relaxed OR rows do not count). Supersede, exact-match, title-phrase and compiled-truth stages still run. Doc receipt: conceptual nDCG@5 53.0 -> 57.8 [doc].

## 7. Dedup, rerank, and the return tail

### 7.1 Dedup (`search/dedup.ts`)

Order (`dedupResults`, `:107-146`): L1 keep top 3 chunks per page (`dedupBySource`, `:151`); L2 drop same-page chunks with word-set Jaccard > 0.85 (`COSINE_DEDUP_THRESHOLD`, `:32`; whitespace-split, lowercased); L3 no type above `ceil(n * 0.6)` (`MAX_TYPE_RATIO`, `:33`); L4 cap 2 per page (`MAX_PER_PAGE`, `:34`; `MAX_PER_SEGMENTED_PAGE = 6`, `:36`); final pass adds the best pre-dedup compiled-truth chunk for any page lacking one, appended, not swapped (`guaranteeCompiledTruth`).

### 7.2 Reranker (`search/rerank.ts:127`, `ai/defaults.ts:19`)

- Reads `deduped.slice(0, topNIn)`; tail keeps fused order (`rerank.ts:137-138`). `topNIn` = 25 balanced, 50 tokenmax; conservative has it off.
- Model `voyage:rerank-3-lite` unless `search.reranker.model` is set. Timeout 5000 ms. Fail-open: no key -> `reranker_skipped (no_key)`, timeout -> `rerank_failed`, pass-through -> `rerank_passthrough`, all stamped in degraded (`hybrid/rank.ts:286-347`).

### 7.3 After rerank

1. `applyFeedbackStage` (`feedback-boost.ts`): bounded multiplier from use-attributed ratings; no-op when nothing is rated.
2. `pinRelationalRows` (`relational-rerank-pin.ts`): up to 3 arm rows back on top (max 10, `:73-75`). Only if the reranker reordered; not for image queries.
3. `applyRankPriors` (`rank-priors.ts:127`): multiplicative priors (`PERSON 0.85`, `OCR 0.6`, `UNDATED 0.85`, `REDIRECT_STUB 0.5`, `ARCHIVE 0.8`; `:28-33`).
4. Alias hop, exact-lookup tier (rank 1, supersession-filtered), then collapse again (`rank.ts:383-391`).

### 7.4 Evidence, autocut, slot, budget (`rank.ts:370-545`)

- Evidence labels (`evidence.ts`): `high_vector_match` needs real cosine >= 0.8 (`:64`); `keyword_exact` needs a strict keyword hit with base score >= 0.6 (`:53`). `HIGH_MATCH_FLOOR` 0.85 (`:51`) is legacy.
- Adaptive return: opt-in, off. Autocut: off in every bundle. When on: cut at the largest rerank-score drop of at least 20%, keep at least 1, skip when top score < 0.35 (`autocut.ts:45-49`), page 1 only.
- Relational evidence slot (`relational-recall.ts:280`): one arm answer guaranteed on page 1 (`relational_chain_slots = 10`).
- Slice, then token budget: `balanced` 12000, `conservative` 4000, `tokenmax` none (`token-budget.ts:47`; CJK chars count 1 each).

### 7.5 Evidence delivery

`return_unit` defaults to `auto` (`search/evidence-delivery.ts:51`). `auto` expands only conversation hits to the whole page. Budgets: 6000 default, 24000 conversation, 32000 remote max (`:61-65`). Runs after cache and capture; neighbour chunks come from one batched, `page_id`-keyed, re-authorized read.

## 8. Query cache and expansion

- Query cache: disabled by `semanticResultCacheAvailable() = false` (`query-cache.ts:35`). Retained constants: threshold 0.92 (`:42`), TTL 3600 s (`:44`), text guard Dice 0.5 (`:102`). Degraded results use a 60 s TTL (`hybrid.ts:1382`). Cache keys include `evb=`, `mbg=`, `rrp=`, `rp=` in the knob hash [doc].
- Expansion (`search/expansion.ts`): original + up to 2 LLM variants, skipped under 3 words (`MIN_WORDS`, `:17`) or 500 chars (`:18`). Variant weight is `budget / n` when `search.expansion_variant_budget` is set; default null = weight 1 (`fusion-lists.ts`). Doc: equal-weight expansion halved LongMemEval-S recall_all@5 (93.19% to 54.89%) [doc].

## 9. Discrepancies between docs and code

1. `query` param text said autocut is "Default on" (`ops/search.ts:943`). Resolved default is off in all three bundles (`mode.ts`), and `pagePlanHits` only forces off (`page-plan-hits.ts:10-14`). Code wins; the param text has since been corrected to say off.
2. RETRIEVAL.md calls the keyword arm "BM25". The code uses `ts_rank` with default weights and no normalization (`keyword-statement.ts:74`). Not BM25.
3. The `hybrid.ts:1-10` header says the compiled-truth boost is always 2.0x. Code applies it only to explicit `detail: 'low'` (1.2x for auto), `hybrid.ts:92-108`.
4. The keyword arm does not wrap the query in `gbrain_fts_input`; indexing and the title arm do. [inferred] An ASCII token that index-time splitting breaks (the doc's `Redis7` example) may miss on the keyword arm. Not run.

## Rust engine implications

**Must preserve exactly (contract, covered by tests or user-visible):**

- Page-grain RRF: vote per page per list at its best rank, lead chunk carries the total, k = 60 base, intent k table (section 5.2), weights per list, max normalization before boosts.
- Compiled-truth factor as explicit `low` 2.0x vs auto `low` 1.2x, skipped for unverified stubs and chunkless title rows.
- Cosine blend 0.7 / 0.3 using the post-boost max, computed after RRF and before post-fusion boosts.
- Stage order: dedup before rerank; alias hop, exact-lookup and evidence stamp after rerank; token budget last on the final slice.
- Dedup layers L1-L4 with the constants above, plus the compiled-truth guarantee that appends rather than replaces.
- Deterministic tie-breaks everywhere: `score DESC, page_id ASC, chunk_id ASC`.
- Freshness: an embedding counts only if its `embedded_text_hash` matches the current text (or is NULL).
- Visibility, private-page and hard-exclude filters must sit inside each candidate set, never be applied after ranking. Remote callers must not see private pages through any arm. Fail-closed on DB access errors: if both lexical arms fail with an access-class error, return an error, not an empty result (`hybrid/arms.ts:109-111`).
- Relaxed OR keyword rows drop out of fusion whenever a text vector list is non-empty.
- Source factor as a per-arm multiplier, longest prefix, `detail: high` bypass.

**Can simplify:**

- The index-walk, scope-scan, escalation and iterative-scan machinery (`vector-statement.ts`, `vector-pool.ts`) exists to work around pgvector filtered-HNSW planner behaviour. A Rust index that filters during search, or an exact scan on small scopes, can drop most of it. Keep only the contract: distinct pages, filters applied, bounded time.
- The keyword OR fallback rarity machinery and CJK `LIKE` scan exist because Postgres ts_rank cannot tokenize CJK and cannot rank rare terms. An inverted index with real term statistics can replace them, but this changes scores. Decide whether to keep ts_rank-like scoring or move to BM25, and validate.
- Semantic result cache: already disabled. Drop it; keep the knob names reserved.
- `KEYWORD_RANK_CANDIDATES` (50k) and statement timeouts are Postgres guards. Keep the degraded-stage names (`keyword_candidates_incomplete`, `vector_candidates_incomplete`); they are user-visible.

**Postgres features each stage depends on:**

| Stage | Postgres feature | Rust replacement needed |
|---|---|---|
| Vector arm | pgvector `vector` type, HNSW `vector_cosine_ops`, `<=>`, `hnsw.ef_search`, `hnsw.iterative_scan`, `hnsw.max_scan_tuples`, `+0` index bypass | HNSW or flat vector index with filter-aware search; cosine |
| Cosine rescore | `<=>` in SQL, `vector_dims`, `vector_norm` | in-process cosine on stored vectors |
| Keyword arm | `tsvector`, GIN on `search_vector`, `websearch_to_tsquery('english')`, `ts_rank`, `phraseto_tsquery`, `setweight`, `ts_filter` | inverted index, query parser with websearch semantics, term stats |
| Title arm | GIN on `pages.search_vector`, `ts_rank_cd`, `gbrain_fts_input()` (a SQL function) | title FTS index; port the CJK boundary split |
| CJK path | `LIKE`/`ILIKE` with `ESCAPE` over `chunk_text` (unindexed) | substring or n-gram index |
| Per-page pool | `DISTINCT ON`, window `row_number() OVER`, `count(*) OVER` | group-by with max, in process |
| Index walk / scope scan | `MATERIALIZED` CTEs, `OFFSET 0` fences, `LATERAL` probes, `ANY(ARRAY(...))`, `hashint4` sampling | not needed if filters are applied in the index scan |
| Filters and visibility | correlated `EXISTS` subplans, `NOT EXISTS`, `RLS` scope binding (`app.scopes`), `SET LOCAL` GUCs | row-level predicate in the engine, no RLS |
| Freshness | `md5(chunk_text)` column compare | content hash in Rust |
| Timeouts | `statement_timeout`, transaction-local `SET LOCAL` | time budget per arm in the engine |
| Relational arm | indexed `links` reads, per-hop bounded SQL, recursive CTE for BFS | adjacency list in memory or a graph index |
| Facts arm | `facts.embedding` halfvec, `ts_rank_cd` over `idx_facts_fts` | same as vector + keyword, over facts table |
| Find-by-name (not ranked search) | `pg_trgm` GIN (`idx_pages_trgm`, `idx_pages_slug_trgm`) | trigram index if find_pages is kept |

`LISTEN/NOTIFY`, advisory locks and `SKIP LOCKED` do not appear on the read path I traced.

**Risks:**

- Score parity: cosine should match; ts_rank will not. The gbrain-evals gates (BrainBench, NamedThingBench, LongMemEval) are the only parity check. Decide early between bit-compatible scores and ranking-level parity.
- The keyword arm not normalizing query text (section 9.4) may be a live bug that a rewrite should not copy by accident.
- The metadata gate, relational pin, feedback and rank priors all depend on the `lexical` decision. A reordering bug in one of them changes top-1 results more than a score change does.

## Open questions

1. Should the rewrite keep `ts_rank` default weights (D 0.1, C 0.2, B 0.4, A 1.0) and no normalization, or move to BM25 as the doc describes? This changes every keyword score and every boost that multiplies one.
2. Is the keyword arm's missing `gbrain_fts_input` on the query side intentional? Confirm with a test on a CJK-adjacent ASCII token before porting.
3. Which `query` default is authoritative for autocut: the param text ("Default on") or the bundles (off)? Answered: the bundles (off); the param text now matches.
4. The facts arm, facts block and temporal reserve run only in `query` (RETRIEVAL.md). Confirm before porting the op surface.
5. The HNSW walk/escalation machinery targets a 25k-chunk planner cliff. What is the target brain size for the Rust engine? That decides whether a flat scan is acceptable.
6. Do the title-arm and CJK path need separate CJK title matching? The title arm uses `websearch_to_tsquery` and unlikely matches unspaced CJK titles [inferred, not run].
7. Benchmark numbers are doc quotes. The Rust port needs the gbrain-evals harness re-run as its gate; I did not inspect those harness commands.
