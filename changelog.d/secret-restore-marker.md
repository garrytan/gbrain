---
important: security
---
**A secret store restore ties an original only to a page that still holds its marker.**

### Fixed
- `gbrain secrets backup --restore` no longer ties an original to a page that merely took its old slug, so that page's readers never pass the `reveal_secret` read check for it. A place comes back only on a page whose text holds the entry's marker.
- A backup that names a page by a slug it had before a rename now ties the entry to the pages that hold its marker (counted as `reattached`), or skips it when none does (`skipped_no_page`), so a restore never brings back what a purge removed. This replaces the 0.60.744.0 note saying such an entry would be restored without a place.
- A rename no longer moves a leftover place with no page onto the renamed page unless that page holds its marker.
