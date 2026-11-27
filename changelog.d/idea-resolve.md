### Added

- `idea_resolve`: accept, reject, obsolete, withdraw or reopen an idea, recording who did it, when and why (frontmatter `resolution`, a `resolutions` history and a `## Resolution` section). New idea status `accepted`.
- A near-duplicate submitted over MCP is now recorded as support (a vote) on the existing idea, as Slack submissions already were. Replies (MCP and the Slack intake) state the resolution of the duplicate and of similar ideas, and an idea from Slack gets its resolution in its thread once.
- The `ideas` phase keeps manual resolutions: a cancelled initiative returns an accepted idea to `accepted`, not `open`.
