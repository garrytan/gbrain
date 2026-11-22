---
important: security
---
**`gbrain publish` refuses a page whose frontmatter sits below other text instead of putting the frontmatter into the shared file.**

<!-- behavior-change: publish_refuse_wrapped_frontmatter -->

### Fixed
- `gbrain publish` strips frontmatter only when it starts the file. A page saved from a thin client's paged `gbrain get` starts with a quote fence above the frontmatter, and a page with any other line above it was the same: publish did not see the frontmatter and put all of it, private values included, into the shared HTML or markdown. Publish now refuses with `invalid_frontmatter` when a frontmatter block starts in the first five non-blank lines without starting the file: an unindented `---yaml`, `---yml` or `---json` line, an unindented `---` line followed directly by a `key:` line or a `{` mapping (closed or not), or a pair of unindented `---` lines with a `key:` line between them. A page with an early horizontal rule and only prose after it still publishes. Save the page with plain `gbrain get <slug>` or delete the lines above the frontmatter, then publish again.
- The quote fence label for an outside guest note now escapes its saved date the way the `[outside guest · …]` warning line does, so a stored date can no longer add brackets, quotes or line breaks to the label.
