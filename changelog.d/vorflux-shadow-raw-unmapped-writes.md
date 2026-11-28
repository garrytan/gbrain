**A Postgres serve start no longer marks shadow coverage invalid, and the swap report names each uncompared raw or unlisted write by the table it writes.**

<!-- behavior-change: shadow_raw_writes_named_by_table -->

### Fixed
- Shadow mode no longer sets the follower's coverage watermark invalid when a Postgres `gbrain serve` starts. The start adds a pool checkout listener (`onCheckout`), which runs no statement; it is now listed as a member that writes nothing. A member nobody listed still invalidates.

### Changed
- The shadow counts each raw SQL statement and each typed member outside the write map under the first table it writes, instead of the single keys `raw_sql` and `unmapped`: `timeline_entries`, `takes` and `sources` land on their own lines, and criterion 5 of `gbrain engine swap --plan` adds `side tables`, `process bookkeeping` and `no row written` lines. A member that only sets transaction settings or locks rows is `no_row:<member>`; a statement the parser cannot read stays `raw_sql`, and a member with no known statements is `unmapped:<member>`.
- These writes are named, not verified: they stay `capability_missing`, are never compared and never count toward the comparable count or the write bar. A new report line says so, and a second named loss lists the tables. `pages:sealImportedPage` joins the page-writes named loss.
