**gbrain has a loader that checks and loads the experimental Rust engine addon from the gbrain home, refusing with a typed error that names the reason when it cannot; nothing starts it yet, and PGLite and Postgres brains never load the addon.**

### Added
- `loadRustEngineAddon()` (`src/core/rust-engine/addon-loader.ts`) loads the addon for the Rust engine shell. No config value selects the Rust engine yet, so no command calls it. It uses `GBRAIN_RUST_ENGINE_ADDON` when you point it at your own build, and otherwise an addon already in `<gbrain home>/engines/rust/` whose checksum matches this release's manifest. It downloads nothing and writes nothing.
- Two error codes: `rust_engine_addon_missing` (no addon for this release is installed, the `GBRAIN_RUST_ENGINE_ADDON` file does not exist, or no addon is published for this platform) and `rust_engine_addon_mismatch` (checksum, `engine_abi`, `engine_build` or target differ, or the file does not load). Both refuse before the brain is touched and write nothing. `gbrain errors <code>` explains each one.

### Fixed
- The addon refuses typed arrays backed by shared memory by asking the runtime, so hiding `SharedArrayBuffer` or swapping a prototype no longer gets shared memory past the check.
- `bun run rust:build` ignores `CARGO_TARGET_DIR`, so it never packages an older library from another build directory.
