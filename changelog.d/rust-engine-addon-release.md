**Every gbrain release now carries the Rust engine addon, and gbrain can fetch and check it. Nothing uses it yet.**

### Added
- Each release now attaches `gbrain-engine-rust-linux-x64.node`, `gbrain-engine-rust-darwin-arm64.node` and `gbrain-engine-rust.sha256.json`, all with a build attestation. A release is not published unless all three are there.
- A brain whose config says `engine: rust` now fetches the addon for its own release on first open, checks its attestation, SHA-256 and size, saves it under `engines/rust/` and loads it. Later opens load the saved file with no network. If the addon is missing or does not match, gbrain stops with `rust_engine_addon_missing` or `rust_engine_addon_mismatch` and never falls back to another engine. The engine itself is a shell for now, so even a good addon ends in `engine_capability_missing` and nothing is written to the brain. `gbrain engine status --probe` on a Rust brain reports that refusal code instead of an unclassified database error.
- `GBRAIN_RUST_ENGINE_ADDON` can still point at a local build. It now skips only the SHA-256 check.
- After a release publishes, a check downloads the published executable on Linux and macOS and confirms the attached addon loads.

### Changed
- The "builds and runs with no Rust installed" CI job now also installs gbrain from source, runs a PGLite put and get, and checks that no `engines/` folder appears.
