**Adding GBrain to Claude is now one click: `gbrain mcp expose --funnel` and the Claude Desktop guide give a link that opens Claude's add-connector form with GBrain's name and MCP URL already filled in.**

### Itemized changes

- `gbrain mcp expose --funnel` prints a `Claude.ai` line in its `Next` block. It holds a `https://claude.ai/customize/connectors?modal=add-custom-connector&…` link prefilled with the published MCP URL. The tailnet-only default does not print it, because claude.ai cannot reach a tailnet-only URL. JSON output is unchanged.
- docs/mcp/CLAUDE_DESKTOP.md gains the same link for hosted gbrain.io and says how to build it for any HTTPS endpoint. The manual steps stay as the fallback, since the link relies on claude.ai page parameters that Anthropic does not document.
