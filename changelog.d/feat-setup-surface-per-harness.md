**`gbrain setup codex` registers the full tool surface, so Codex sees every gbrain tool.**

### Changed
- `gbrain setup codex` registers `serve --surface full` instead of `serve --surface starter --advertise verbs`. Codex never reloads its tool list, so tools that `request_tools` unlocked on starter never reached it. The receipt records `surface_origin` (`explicit` or `default`); a re-run moves a default entry and prints the command that keeps the old one, keeps an older entry with no origin and prints the command that would move it, and leaves a chosen surface alone.
- New `--advertise` flag for `gbrain setup codex` and `gbrain setup claude-code`: `--surface starter --advertise verbs` pins exactly that registration, fresh and on every re-run.
- New config keys `mcp.default_surface_codex`, `mcp.default_surface_claude_code` and `mcp.default_surface_hermes` (`full` or `starter`) turn one harness's default; `gbrain config unset` restores the shipped one. Claude Code, Hermes and opencode keep starter.
- `gbrain setup openclaw` prints the `openclaw mcp set` command that moves a starter gbrain entry in your OpenClaw config to `--surface full`, without editing the file, and the OpenClaw docs register `--surface full`.

<!-- behavior-change: setup_codex_registers_full_i1 -->
<!-- behavior-change: setup_codex_rerun_moves_default_i1 -->
