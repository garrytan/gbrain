**The Rust store's key tags have a registry, and new storage families get room to grow.**

### Changed
- For contributors to the Rust engine: `docs/designs/RUST_ENGINE_INTERFACES.md` now has a "Tag registry" of every storage tag claimed on any branch. The digits `4` to `9` can be claimed only through an approved row, and `~` is reserved as an escape that starts a two-byte tag for every new storage family. A test fails on a duplicate tag, an unapproved digit tag, or a two-byte tag with no row. Nothing changes on disk, and existing brains need no upgrade step.
