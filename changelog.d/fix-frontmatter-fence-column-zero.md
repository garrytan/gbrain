---
important: security
---
**`gbrain publish` no longer puts frontmatter lines after an indented `---` into the shared file.**

<!-- behavior-change: publish_frontmatter_fence_column_zero -->

### Fixed
- An indented `---` line inside a multi-line frontmatter value (for example under `notes: |`) was taken as the end of the frontmatter, so `gbrain publish` put every frontmatter line after it into the shared page. The end of the frontmatter is now found the way gbrain reads frontmatter everywhere else: a `---` line that starts at the beginning of the line. A page whose frontmatter opens with `---yaml`, `---yml` or `---json`, which gbrain also reads as frontmatter, is now stripped too instead of published whole. A page whose frontmatter is closed only by an indented `---` never closes, so publish refuses it with `invalid_frontmatter` instead of sharing it. The same fix keeps `gbrain check-backlinks fix` from writing inside such a frontmatter value, stops a Timeline heading quoted inside frontmatter from counting as the page's Timeline section on `put_page`, and lets a remote `put_page` remove a copied read's quote fence from a frontmatter value after such a line.
