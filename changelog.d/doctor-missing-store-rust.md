**`gbrain doctor` on a Rust-engine brain whose store folder is missing no longer creates an empty store and calls it healthy.**
<!-- behavior-change: doctor_missing_store_rust -->

### Fixed
- When a Rust brain's store directory is gone (an unmounted drive or a moved folder), `gbrain doctor` now stops before it connects with the same `brain_missing` error PGLite brains get, names the configured path, exits non-zero and creates nothing. An empty folder where the store was counts as missing too. Mount or move the store back, or point `database_path` at where it lives now. Other commands that open the brain still create a new empty store at the configured path on a Rust brain; that is a known gap.
