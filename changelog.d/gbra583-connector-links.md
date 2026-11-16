**`gbrain mcp expose` now prints one-click links that add the brain to Cursor and, for a public brain, to Claude.**

### Added
- `gbrain mcp expose` ends its `Next` block with a `Cursor` line: Cursor's install link, which opens Cursor's MCP install prompt with the brain's URL filled in. With `--funnel` a `Claude` line comes first: Anthropic's custom connector install link, which opens claude.ai's add-connector form the same way. A tailnet-only publish gets no Claude line, because claude.ai connects from Anthropic's servers and can't reach the tailnet. `--status` repeats the links when everything verifies, and `--json` adds them as `install_links` (only when there is at least one). The links carry no credential, and a URL that isn't plain https gets none.
- docs/mcp/README.md has a "One-click client links" section with ready links for hosted gbrain.io, docs/mcp/CLAUDE_DESKTOP.md puts the Claude shortcut above its manual steps, and docs/guides/remote-mcp.md shows the new line in its example output.

Contributed by @Pierre-Bouquet
