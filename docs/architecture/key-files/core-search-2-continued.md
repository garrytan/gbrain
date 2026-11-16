# Key files: Core Search (2/2, continued)

[Subsystem index](../KEY_FILES.md) · [Previous entries](core-search-2.md). Read only the entries relevant to your change.
Current behavior and load-bearing invariants; history belongs in Git and CHANGELOG.

- `src/core/search/score-contract.ts` — `scoresFollowRank`: at the search/query op boundary the returned `score` follows the returned order (the rerank score, times any rank prior, in a reranked list; a running minimum otherwise) and the replaced value stays as `fused_score` (#7156).
- `scripts/bench/ranking-shapes/` + `test/fixtures/ranking-shapes/` — synthetic two-source ranking bench (208 pages, 70 questions): `run.ts` builds a PGLite brain, runs search/query/query --expand through a checkout's CLI behind a caching provider proxy and scores hit@k, MRR and per-shape checks (twins, stubs, families, priors, score order, chunk size).
