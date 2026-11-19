---
important: security
---
**A secret store restore ties an original only to the page at its backed-up slug, and only when that page still holds its marker.**

### Fixed
- `gbrain secrets backup --restore` no longer ties an original to a page that merely took its old slug and does not hold its marker (`<REDACTED:<rule>:<id>>`), so that page's readers never pass the `reveal_secret` read check for it. A page that holds a full copy of the marker, in its text or in a timeline entry or fact filed on it, still counts as holding it.
- A backup that names a page by a slug it had before a rename (one taken before 0.60.744.0) skips that entry (`skipped_no_page`) instead of tying it to another page, and a restore never brings back what a purge removed. This replaces the 0.60.744.0 note saying such an entry would be restored without a place.
- A restore that loses the race with a purge of the same page no longer leaves the sealed original behind.
