---
important: security
---
**`gbrain publish` no longer puts a guest page's frontmatter into the shared file when the page was saved from `gbrain get`.**

<!-- behavior-change: publish_guest_attribution_frontmatter -->

### Fixed
- `gbrain get` prints a guest page with its `[outside guest · …]` warning line above the frontmatter. Saved to a file and published, the page no longer started with `---`, so `gbrain publish` did not see the frontmatter and put all of it, private values included, into the shared HTML or markdown. Publish now drops that exact warning line when frontmatter opens right after it, then strips the frontmatter as usual. Frontmatter that opens after the warning line and never closes (a `---` line that starts at the beginning of the line) is refused with `invalid_frontmatter`, the same as any other unclosed frontmatter.
