# Key files: Core Search (2/2, continued)

[Subsystem index](../KEY_FILES.md) · [Previous entries](core-search-2.md). Read only the entries relevant to your change.
Current behavior and load-bearing invariants; history belongs in Git and CHANGELOG.

- `src/core/search/rank-priors.ts` — `applyRankPriors`: multiplicative priors after rerank and pinning (person rows on an organization question, low-coverage image rows stamped `image_page`, undated rows on a when-question, redirect stubs, and archive rows (GST-2768: ARCHIVE_PRIOR under a close non-archive row, ARCHIVE_HITS_PER_DAY per day, off for a conversation or date query)); each changed row carries `rank_prior` and `rank_score`. Knob `search.rank_priors`.
- `src/core/search/score-contract.ts` — `scoresFollowRank`: at the search/query op boundary the returned `score` follows the returned order (the rerank score, times any rank prior, in a reranked list; a running minimum otherwise) and the replaced value stays as `fused_score` (#7156).
- `scripts/bench/ranking-shapes/` + `test/fixtures/ranking-shapes/` — synthetic two-source ranking bench (208 pages, 70 questions): `run.ts` builds a PGLite brain, runs search/query/query --expand through a checkout's CLI behind a caching provider proxy and scores hit@k, MRR and per-shape checks (twins, stubs, families, priors, score order, chunk size).
