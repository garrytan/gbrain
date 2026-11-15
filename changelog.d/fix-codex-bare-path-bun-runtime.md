---
important: blocker
---
**Codex starts the gbrain MCP server and hooks even when bun is not on its PATH.**

<!-- behavior-change: launcher_records_bun_gst2784 -->

### Fixed
- After `gbrain setup codex`, a Codex session started without bun on its PATH (the desktop app, a launcher, a terminal opened before the shell profile changed) failed with `/usr/bin/env: 'bun': No such file or directory` and showed no gbrain tools, with nothing telling you why. gbrain's hook launcher, which every MCP server entry and hook setup writes runs through, now records the Bun that installed gbrain, so those entries start from any PATH. The same gap closes for Claude Code, Hermes and OpenClaw entries that run through the launcher. The compiled binary needs no Bun and is unchanged. (GST-2784)
- `gbrain doctor` reports a launcher that records no Bun, or one whose Bun is gone, instead of calling the wiring healthy.

### To take this fix
- `gbrain upgrade` (its post-upgrade step rewrites the launcher), or rerun `gbrain setup codex`. Neither changes config.toml, hooks.json or Codex's trust entries.
