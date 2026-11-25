---
kind: action
---
Re-running `gbrain setup codex` on an entry it wrote with `surface_origin: default` moves that entry to the current Codex default (now `serve --surface full`) and prints the move with the exact command that keeps the old entry, including its `--source`. An entry whose receipt predates `surface_origin` keeps its surface; setup prints the command that would move it to the Codex default, so run that line if you want the full tool list in Codex. A surface you chose with `--surface` (origin `explicit`), an entry another tool owns and a hand-written entry stay as they are. `gbrain setup openclaw` prints an `openclaw mcp set` line when your OpenClaw config holds a starter gbrain entry and never edits OpenClaw's config; the OpenClaw docs now register `--surface full`.
