**Operators can require a fact selector for recall page searches.**

### Added
- Set `recall.require_fact_selector_with_query` to `on` to refuse query-only recall with a retry that ranks saved facts using `question`. (#10225)

<!-- behavior-change: recall_fact_selector_10225 -->
