**`gbrain search` on the command line now shows the facts you saved with `gbrain remember`, and the OpenClaw install steps add the brain-first rule.**

### Fixed
- `gbrain search` and `gbrain query` on the command line print the saved facts (`remember`) that match, under "Saved facts (remember)", as MCP search already did. A fact saved with `gbrain remember` and looked up later with `gbrain search` used to print "No results." With `--json`, stdout stays the row array and the saved facts go to stderr.
- `gbrain setup --help` names `openclaw`, `hermes`, `opencode` and `cursor` in its usage lines, not only `claude-code` and `codex`.

### Changed
- The OpenClaw install steps (`INSTALL_FOR_AGENTS.md`, `docs/mcp/OPENCLAW.md`) run `gbrain setup openclaw` right after registering the MCP server. Without that step a new session answers from OpenClaw's own memory instead of gbrain.
