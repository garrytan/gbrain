**Decide replay receipts, the resolved-model list and the writer-version reports now list rows that tie in the same order on every engine, instead of an order the database happened to pick.**

### Fixed
- Bug fix in shared code (PGLite and Postgres): rows that tie on every sort key now come in one order. The Rust engine already sorted ties this way.
  - Replay receipts with the same decision id and rank: insertion order (the row id).
  - Resolved models with the same latest time: byte order of slot, provider and model.
  - Writer versions (the latest per host and principal, the recent counts and the segmented-storage gate's evidence) with the same last-seen time: role, then host with no host first, then principal and version in byte order. When several requests of one host and principal have the same latest time, the request with the lowest id names the version.
  - Before this fix, PGLite and Postgres could answer tied rows in another order than the Rust engine, and in a different order from one read to the next. Seen on a macOS run.
- The writer-version parity cases wait 20 ms before a zero-day window read. A zero-day window starts at the read's own `now()`, so `>= now() - 0` still counts a request published in that clock tick, on every engine. No caller reads a zero-day window, so the window's behavior stays the same.
