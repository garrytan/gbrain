**Every gbrain release now carries the Rust engine addon, with a build attestation and a SHA-256 manifest. gbrain does not download it yet, and nothing uses it.**

### Added
- Each release now attaches `gbrain-engine-rust-linux-x64.node`, `gbrain-engine-rust-darwin-arm64.node` and `gbrain-engine-rust.sha256.json`, all with a build attestation. A release is not published unless all three are there.
- A brain whose config says `engine: rust` loads the addon only from `engines/rust/` in the gbrain home, after checking its SHA-256 against this release's manifest saved there. gbrain does not download the addon; an install command comes later. If the addon is missing or does not match, gbrain stops with `rust_engine_addon_missing` or `rust_engine_addon_mismatch` and never falls back to another engine. The engine itself is a shell for now, so even a good addon ends in `engine_capability_missing` and no store data is written: the brain directory holds at most the owner lock files that opening a Rust brain creates. `gbrain engine status --probe` on a Rust brain reports that refusal code instead of an unclassified database error.
- `GBRAIN_RUST_ENGINE_ADDON` can still point at a local build. It skips only the SHA-256 check.
- After a release publishes, a check on Linux and macOS downloads the published executable, manifest and addon, checks both attestations, puts the addon where gbrain looks, and confirms the executable loads it and writes no store data.

### Changed
- The "builds and runs with no Rust installed" CI job now also installs gbrain from source, runs a PGLite put and get, and checks that no `engines/` folder appears.
