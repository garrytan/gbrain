**Codex sessions keep gbrain's tools when gbrain takes more than a second to start.**

### Fixed
- Codex 0.147 and newer wait only one second for MCP servers to start, then run the whole `codex exec` session without any server that is still starting, and print no warning. `gbrain serve` takes about a second to start, so on a slower machine a Codex session sometimes had no gbrain tools at all. `gbrain setup codex` now sets `mcp_optional_startup_grace_ms = 0` at the top of `$CODEX_HOME/config.toml`, so Codex waits for each server up to its `startup_timeout_sec` and still starts without a broken one. Setup writes the key only when it isn't set, keeps any value you set yourself (and says so when yours is above 0), and `--remove` deletes it only while it is still setup's `0`. Re-run `gbrain setup codex` to add it to an existing install.

<!-- behavior-change: setup_codex_waits_for_startup_gst3901 -->
