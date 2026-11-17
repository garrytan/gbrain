**Local searches on a very common word no longer spend the keyword time limit in the title step.**

### Fixed
- The title step of hybrid search now ranks at most 5,000 matching pages for local callers, the ones with the lowest page ids, so the cut keeps the same pages on every call. A word that sits in many page timelines used to make it rank every matching page and run into the 8 s keyword statement limit on a large brain, a second time after the keyword step (#7082). When the cut applies, pages whose title holds the words come first and hybrid search reports `keyword_candidates_incomplete`. A query that matches 5,000 pages or fewer keeps its exact result, including a page found only through a timeline row that no chunk holds. Remote callers' results do not change.

<!-- behavior-change: title_arm_candidate_cap_7082 -->
