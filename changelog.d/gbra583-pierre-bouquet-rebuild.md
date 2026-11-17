**Code blocks on pages made with `gbrain publish` get a Copy button, and `gbrain mcp expose` prints one-click links that add the brain to Cursor and, for a public brain, to Claude.**

### Added
- Every code block on a published page, including a password-protected page once it is unlocked, shows a Copy button in its top-right corner. It copies the block's exact text, works from the keyboard, and reads "Copied" for a moment. Pages opened from a file or a plain-http host fall back to the browser's older copy command. Code blocks also get a bordered panel that scrolls sideways, so long lines no longer stretch the page. Contributed by @Pierre-Bouquet (#9453).
- `gbrain mcp expose` ends its `Next` block with a `Cursor` line: Cursor's install link, which opens Cursor's MCP install prompt with the brain's URL filled in. With `--funnel` a `Claude` line comes first: Anthropic's custom connector install link, which opens claude.ai's add-connector form the same way. A tailnet-only publish gets no Claude line, because claude.ai connects from Anthropic's servers and can't reach the tailnet. `--status` repeats the links when everything verifies, and `--json` adds them as `install_links` (only when there is at least one). The links carry no credential, and a URL that isn't plain https gets none.
- docs/mcp/README.md has a "One-click client links" section with ready links for hosted gbrain.io, docs/mcp/CLAUDE_DESKTOP.md puts the Claude shortcut above its manual steps, and docs/guides/remote-mcp.md shows the new line in its example output.

### Fixed
- A published page whose markdown contains a closing `</script>` tag, such as a code block that shows HTML, now renders that text instead of breaking the page. Before, the tag ended the page's script early, so the rest of the page was lost and any HTML after it skipped the sanitizer.
- The password-protected page now renders unlocked content through the same sanitizing function as an open page, instead of patching its unlock script by string replacement.

Contributed by @Pierre-Bouquet
