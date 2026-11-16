---
important: regression
---
**After an upgrade from before v0.51, `gbrain projections drain` rebuilds the pages that are out of search first, and on Postgres it rebuilds 4 pages at once by default, so every page answers search much sooner.**

### Fixed
- The search-index rebuild that an upgrade from before v0.51 starts used to work through pages in queue order, so pages with a facts fence could wait hours behind pages that were still answering from their old index. `gbrain projections drain` now rebuilds the pages that are out of search first, then seals images, then rebuilds the pages still answering from their pre-upgrade index. `--dry-run` lists rows in the same order. A follow-up to #9192.
- On Postgres the drain rebuilds several pages at once, each on its own pooled connection: 4 by default, or fewer when the pool is small, and `--concurrency N` goes up to the pool size less 2. On a 50,000-page test brain with 30,000 fenced pages behind an 18 ms round trip, every page was searchable after about 86 minutes at the default. PGLite, `gbrain serve` on PGLite and the drain inside `gbrain migrate --to` still rebuild one page at a time.
- A refused or dropped extra connection lowers the width by one and the drain carries on; stderr names the new width. It never fails the drain.
- The upgrade's `[153]` line gives the rebuild time at the default width, names the faster `--concurrency` command with its time, and counts only the Markdown and code pages the drain rebuilds, not images.
