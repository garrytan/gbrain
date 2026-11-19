**When a later conversation records that someone changed jobs, city or role, every fact reader now shows the old value as ended, and four smaller fact fixes ride along.**

<!-- behavior-change: conversation_slot_closes_stored_gst3170 -->
<!-- behavior-change: far_future_fact_rank_gst3170 -->
<!-- behavior-change: extracted_deal_label_fundraise_gst3170 -->
<!-- behavior-change: remember_item_params_on_surface_gst3170 -->

### Fixed
- Conversation facts with a slot (employer, location, role) now store the end the facts block already worked out at read time: when a later page records a new value, the old row gets `valid_until` and `superseded_by` (never `expired_at`), in the same transaction as the publish or clear. Entity facts, recall, fact lists and remember's duplicate check now see the old value end. The facts block, slot history, contested claims, capture dedup and relink read such a stored end as open, so their output is unchanged. An end another writer set is never changed or cleared, and a private row never ends a world row.
- Newest-first fact reads (entity facts, fact lists, the relevance pool's entity reads and question refresh) rank a fact dated far in the future by when it was written, so one mistyped year no longer holds the top of the list. A past-dated or current fact ranks by its date as before.
- The conversation fact extractor's round and deal-amount labels (`seed_round`, `series_a`, `round_size`, `deal_amount_usd` and similar) fold into `fundraise`, so one deal's amounts share one tag. A valuation, share price, cap, ownership or count label never folds, and a label written in a page's Facts fence is kept as written.
- A client on a narrower tool surface can no longer pass a hidden `remember` parameter inside an `items` entry; it is refused with `param_not_on_surface` the same way a top-level hidden parameter is.

### Tests
- A remote write's private-rows notice counts only active rows.
- Known limits: a stored end whose successor is later purged or forgotten stays until the next publish of that slot (query results re-derive ends and are unaffected); stored ends ignore the trust floor and quarantine, and group rows by exact entity slug only.
