**`gbrain trust review` now runs on a Rust brain, and reads that stopped quietly there (the allow check, the freshness notice, retrieval tracking, saved facts in search) now answer. The census counts the stops that remain hidden.**

### Changed
- The Rust engine answers the owner's allow-rule list (`trust allow --list`, the allow check on every gated write and on sync) with an empty list, since a Rust brain holds no allow rule. Before, the list stopped on a raw database read, and the write gate quietly skipped its allow check.
- `gbrain trust review --json` now runs on a Rust brain. Its read of pending contradiction pairs is a typed engine method, and a Rust brain, which keeps no decide proposal, lists none.
- On a Rust brain, `gbrain search` and `gbrain query` decide whether to show the source freshness notice without a raw database read. A Rust brain keeps no notifier state, so the notice shows only when `sync.on_commit` is on. Before, the read stopped and the search logged a hidden refusal.
- On a Rust brain, `gbrain search`, `query`, `get` and `fetch` record which pages they returned, and `gbrain lsd` prefers pages nobody read lately, as on Postgres. Before, the record write stopped on a raw database read and every page looked never read.
- On a Rust brain, `gbrain search` and `gbrain query` show the saved facts that match the query, with corrections ahead of the facts they correct, as on Postgres. Before, the saved-facts read stopped and the block was quietly empty.
- The Rust census report counts hidden refusals: commands that answer the same on Rust as on Postgres, but log a stop that a fail-soft path caught. A table ranks each stop by how many hot commands hit it.
