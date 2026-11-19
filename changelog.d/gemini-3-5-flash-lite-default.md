**The `gemini` alias and the Google defaults now use gemini-3.5-flash-lite, because Google retires gemini-2.5-flash on 2026-12-01.**

<!-- behavior-change: gemini_default_3_5_flash_lite_9776 -->

### Changed
- The `gemini` model alias, the Google provider's default chat and query-expansion model, and the Google judge on the `eval takes-quality` default panel now name `gemini-3.5-flash-lite`, Google's named replacement for `gemini-2.5-flash`. Google bills both at $0.30 input and $2.50 output per million tokens, and from 2026-12-01 it serves 3.5-flash-lite to every 2.5-flash request anyway, so receipts and usage logs now name the model that actually runs.
- `gemini-3.5-flash-lite` has a price row. `gemini-2.5-flash` keeps its row, so old usage still prices, but it is no longer offered in the Google recipe's model lists. `gemini-2.5-flash-lite`, which Google has not deprecated, is still offered.
- gemini-3.5-flash-lite cannot switch its reasoning fully off, so its takes-quality judge call is capped and priced at the 32,000-token reasoning headroom; a `--budget-usd` that passed before can refuse earlier.

Reported by @Masashi-Ono0611 (#9776).
