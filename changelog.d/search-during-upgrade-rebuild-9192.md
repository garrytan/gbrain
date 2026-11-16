---
important: regression
---
**Search keeps answering while an upgrade from before v0.51 rebuilds a large brain's search index, and the upgrade says how long the rebuild will take.**

### Fixed
- Upgrading from a release before v0.51 no longer takes every page out of keyword and vector search until `gbrain projections drain` finishes. On a 50,000-page brain behind an 18 ms database round trip that meant about 9 hours with no results. A page whose index the rebuild would not change (no facts or takes fence, no private-key text, no quarantine marker, indexed at or after the safe-chunk fence) keeps answering from that index until its own rebuild; every other page waits, as before. Access checks are unchanged, and a page that changes after the upgrade leaves search until it is rebuilt. No embedding calls are made. Reported by @jonahberg (#9192).
- The upgrade's `[153]` line says how many pages keep answering, how many wait, and how long the rebuild takes at the round trip it measured to the database. `gbrain doctor` still counts every page waiting for the rebuild, and says results may be incomplete only while some page is out of search.
