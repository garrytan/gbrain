**The CLI can open a brain whose config opts in to the experimental Rust engine, and `gbrain init` leaves such a brain unchanged.**

### Added
- A brain whose `config.json` says `"engine": "rust"` now opens the Rust engine from the CLI. The engine stays opt-in. Nothing changes for a PGLite or Postgres brain, and only a verified addon loads.
- On a Rust brain, `gbrain init` reports the brain and leaves its config unchanged. `gbrain engine status --probe` checks the store with a typed read; a missing path, an empty directory or an empty record file is reported (`data_dir_missing`, `store_incomplete`) and nothing is created.
- On a Rust brain, a command that needs the raw SQL the Rust store does not serve yet stops with `engine_capability_missing`. This includes any command whose source lookup cannot run while a source is chosen or registered, so a read never falls back to every source. Remote MCP and HTTP calls are refused before any work.
- The Rust store directory is made private (0700) when the brain opens.

<!-- behavior-change: init_keeps_existing_rust_brain -->
