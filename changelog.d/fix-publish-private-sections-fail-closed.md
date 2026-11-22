---
important: security
---
**`gbrain publish` no longer puts a page's private Timeline, fact rows or hidden comments into the shared file.**

<!-- behavior-change: publish_strips_private_sections_10020 -->

### Fixed
- `gbrain publish` removed the Timeline only when a `---` rule and one blank line came right before its `## Timeline` heading, so most pages published their whole private evidence log. It now cuts the page at the first Timeline or History heading or timeline marker, with or without a rule above it, and also drops gbrain's Facts and Takes blocks and HTML comments. Anything it cannot bound is dropped, and a page whose frontmatter never closes is refused instead of published (#10020). Reported by @ocscdsa and first fixed by @Masashi-Ono0611.
