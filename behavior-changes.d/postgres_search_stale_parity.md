---
kind: fix
---
On Postgres brains, search results now mark a page stale when the page has a timeline entry added after the page was last updated, as PGLite brains already did. Before, Postgres always returned stale false. The stale field of a search result, for example in gbrain search --json, can now be true on Postgres where it was false. Result order does not change. A restricted Postgres read role needs SELECT on timeline_entries to search, as the read-role recipe in docs/ENGINES.md now shows. A role without that grant gets a permission error from search.
