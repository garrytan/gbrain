**Adding GBrain to Claude or Cursor is now one click: `gbrain mcp expose` and the MCP docs give links that open each client's add-server step with GBrain's name and MCP URL already filled in.**

### Itemized changes

- `gbrain mcp expose` prints one-click client links in its `Next` block. A `Cursor` line holds Cursor's documented install deeplink (`cursor://anysphere.cursor-deeplink/mcp/install?…`), printed for tailnet-only and Funnel publishes. With `--funnel`, a `Claude.ai` line holds a `https://claude.ai/customize/connectors?modal=add-custom-connector&…` link; the tailnet-only default omits it, because claude.ai cannot reach a tailnet-only URL. `--json` adds the links as `install_links`, and `--status` repeats them.
- docs/mcp/README.md gains a "One-click client links" section with both links for hosted gbrain.io, and docs/mcp/CLAUDE_DESKTOP.md gains the Claude link. The manual steps stay as the fallback, since the Claude link relies on claude.ai page parameters that Anthropic does not document. ChatGPT, Perplexity and Claude Cowork have no such link.
