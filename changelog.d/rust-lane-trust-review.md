**On a Rust brain, `gbrain trust review` and the write gate's allow check no longer stop on a raw read.**

### Changed
- The Rust engine answers the owner's allow-rule list (`trust allow --list`, the allow check on every gated write and on sync) with an empty list, since a Rust brain holds no allow rule. Before, the list stopped on a raw database read, and the write gate quietly skipped its allow check.
