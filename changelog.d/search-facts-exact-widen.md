**A plain question about a person now finds their saved facts, and a thin search is widened with the literal scan.**

<!-- behavior-change: facts_arm_displace_exact_widen_7743 -->

### Fixed
- The facts keyword pool orders by how many distinct query terms a fact holds before ts_rank_cd, so a fact that names the thing asked about no longer sits below dozens of facts that only repeat a name. Partly fixes #7743.
- A saved fact that holds every query term may take the place of the lowest page rows of a `query` result when page rows fill the row count (`search.facts_arm_displace`, default on). Weaker matches still fill only free rows.

### Added
- `search` runs the facts arm too, under the same read policy and skip rules as `query` (`search.search_facts_arm`, default on). Fact rows render as they do in `query`.
- A degraded or thin `search` or `query` result of a short query also runs the `search_exact` literal scan for its terms as a phrase and merges up to three pages it finds (`search.exact_widen`, default on). Merged rows carry `widened: "exact"` and `_meta.retrieval.exact_widened` is `true` when the scan ran.
