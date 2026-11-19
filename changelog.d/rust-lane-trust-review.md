**`gbrain trust review` now runs on a Rust brain, and the write gate there no longer skips its allow check after a raw read stops.**

### Changed
- The Rust engine answers the owner's allow-rule list (`trust allow --list`, the allow check on every gated write and on sync) with an empty list, since a Rust brain holds no allow rule. Before, the list stopped on a raw database read, and the write gate quietly skipped its allow check.
- `gbrain trust review --json` now runs on a Rust brain. Its read of pending contradiction pairs is a typed engine method, and a Rust brain, which keeps no decide proposal, lists none.
