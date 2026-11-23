---
kind: fix
---
When 1000 or more pages in a search's scope are waiting for indexing, the search coverage counts (waiting pages, pages that could affect the query, and waiting images) are now exact up to 1000, so they no longer change with the order pages were written in and PGLite, Postgres and the Rust engine give the same numbers. A count that takes longer than 2 seconds is reported as unknown. Postgres builds a new index over the waiting pages' titles and slugs during the upgrade.
