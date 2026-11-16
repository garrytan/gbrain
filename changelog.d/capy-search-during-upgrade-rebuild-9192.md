---
important: regression
---
**An upgrade from before v0.51 keeps a page in search while the index rebuilds, when its old index can't hold withdrawn, held or redacted text, and says how long the rebuild will take.**

### Fixed
- Upgrading from a release before v0.51 used to take every page out of keyword and vector search until `gbrain projections drain` finished: about 9 hours on a 50,000-page brain behind an 18 ms database round trip. Now a Markdown or code page indexed at or after the safe-chunk fence keeps answering from its old index until its own rebuild, as long as it has no facts or takes fence, no private-key text and no quarantine marker. Pages with a facts or takes fence, pages with private-key text, quarantined pages, images and pages indexed before the safe-chunk fence still wait for the rebuild, so a brain made mostly of entity pages with a Facts fence gets little from this change. Access checks are unchanged, a page that changes after the upgrade leaves search until it is rebuilt, and no embedding calls are made. Reported by @jonahberg (#9192).
- The upgrade's `[153]` line says how many pages keep answering, how many wait and why, and how long the rebuild takes at the round trip it measured to the database. `gbrain doctor` still counts every page waiting for the rebuild, and says results may be incomplete only while some page is out of search.
