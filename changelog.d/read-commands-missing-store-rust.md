**Commands that read a Rust-engine brain no longer create an empty store when the store folder is missing.**
<!-- behavior-change: read_commands_missing_store_rust -->

### Fixed
- When a Rust brain's store directory is gone (an unmounted drive or a moved folder), `gbrain status`, `get`, `search`, `query`, `stats`, `list`, `sources list` and every other read now stop before they open the brain with the same `brain_missing` error `gbrain doctor` gives, exit 1 and create nothing. A write (`import`, `put`, `sync`) still creates the store of a brand-new Rust brain, but refuses the same way when the brain had a store there before (its owner lock file is still next to the folder) or the folder above the store is gone. Mount or move the store back, or point `database_path` at where it lives now.
