**The optional Rust engine now checks, before every lock it skips, that its transactions still run one at a time, and refuses instead of racing when they do not.**

### Changed
- PGLite and Postgres take row, advisory and page-key locks that the Rust engine skips, because a Rust transaction holds the whole store until it ends. Each of those skips now asserts a new engine capability, `serialized_transactions`, which the store reports when it opens. Without it the call refuses with `engine_capability_missing` and writes nothing. Today the capability is always on, so every call takes the same path as before and no answer changes.
- A guard test finds every engine member whose PGLite version takes a lock and fails when the Rust engine serves one without the check or a stated reason.
- The Rust engine's keyword search cache is now kept per open brain (64 MiB each) instead of once per process.
