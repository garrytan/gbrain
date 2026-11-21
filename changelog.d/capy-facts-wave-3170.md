**Newest-first fact reads no longer let a fact dated years ahead hold the top of the list, extracted fundraising amounts share one tag per deal, and a narrower tool surface can no longer pass a hidden remember parameter inside an item.**

<!-- behavior-change: far_future_fact_rank_gst3170 -->
<!-- behavior-change: extracted_deal_label_fundraise_gst3170 -->
<!-- behavior-change: remember_item_params_on_surface_gst3170 -->

### Fixed
- Newest-first fact reads (entity facts, fact lists, the relevance pool's entity reads and question refresh) rank a fact dated far in the future by when it was written, so one mistyped year no longer holds the top of the list. A past-dated or current fact ranks by its date as before.
- The conversation fact extractor's round and deal-amount labels (`seed_round`, `series_a`, `round_size`, `deal_amount_usd` and similar) fold into `fundraise`, so one deal's amounts share one tag. A valuation, share price, cap, ownership, count, runway, loan, interest or target label never folds, and a label written in a page's Facts fence is kept as written.
- A client on a narrower tool surface can no longer pass a hidden `remember` parameter inside an `items` entry; it is refused with `param_not_on_surface` the same way a top-level hidden parameter is.

### Tests
- A remote write's private-rows notice counts only active rows.
