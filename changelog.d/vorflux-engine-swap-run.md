**New: `gbrain engine swap --to rust --yes --expect <hash>` moves a PGLite brain to the opt-in Rust engine, with `--status` and `--resume`.**

### Added
- The swap runs the plan you approved by its hash. It first writes a verified recovery checkpoint, then fences the old brain against writes, copies anything the shadow missed, checks that every table matches on both engines, switches the config, and has a fresh `gbrain` process confirm the brain opens on the Rust engine. It reports success only after that check; if the check fails, the old engine is put back at once. The old brain stays fenced as the way back.
- A run that stops keeps its last step: `gbrain engine swap --status` shows it, and `--resume` continues it.
- The plan now prints the readiness policy (including any dated override and whether it applies to your brain), which Rust engine capabilities your brain would lose, and how long writes would pause.

### Changed
- A swap is refused, before anything changes, while the brain has remote callers (access tokens, OAuth clients, remote MCP), or folder rules in a build whose Rust engine cannot edit them, because the Rust engine cannot serve them yet; while another process holds the brain; or while a variable or service still selects the old engine. Running the swap without `--yes` now answers `confirmation_required` with the plan hash.

<!-- behavior-change: engine_swap_run_s5b -->
