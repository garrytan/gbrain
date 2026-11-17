**A brain set to `engine: rust` now finds, checks and loads the Rust engine addon before it opens, and refuses with a typed error that names the reason when it cannot; PGLite and Postgres brains never load the addon or reach the network for it.**

### Added
- `loadRustEngineAddon()` (`src/core/rust-engine/addon-loader.ts`) loads the addon for the Rust engine shell. It uses `GBRAIN_RUST_ENGINE_ADDON` when you point it at your own build, then an addon already cached in `<gbrain home>/engines/rust/` whose checksum matches this release, and otherwise fetches the release asset once, checks its checksum and build provenance, and caches it.
- Two error codes: `rust_engine_addon_missing` (no addon for this platform, the release or download is unreachable, or another gbrain process holds the cache for too long, reason `cache_busy`) and `rust_engine_addon_mismatch` (checksum, provenance, `engine_abi`, `engine_build` or target differ, or the file does not load). Both refuse before the brain is touched and write nothing. `gbrain errors <code>` explains each one.

### Fixed
- A newly fetched addon that fails to load no longer deletes the addon that was cached before it. The old file is put back.
- Two gbrain processes that start the Rust engine at the same time on one gbrain home take turns replacing the cached addon, so one cannot remove the other's file or restore a rejected one.
- The addon refuses typed arrays backed by shared memory by asking the runtime, so hiding `SharedArrayBuffer` or swapping a prototype no longer gets shared memory past the check.
- `bun run rust:build` ignores `CARGO_TARGET_DIR`, so it never packages an older library from another build directory.
