**The duplicate finder lists same-name pages of one source for collapsing even when a page in another source matches them, and confirm no longer links two pages of one source.**

<!-- behavior-change: dedupe_same_source_split_gst3609 -->

### Fixed
- When a cross-source duplicate group holds two or more pages of one source, `gbrain dedupe --preview` and doctor `entity_duplicates` now also list those pages as their own same-source group, so they show up for collapsing. Before, they appeared only inside the cross-source group.
- `gbrain dedupe confirm <id>` refuses a cross-source group that holds two pages of one source (`dedupe_group_not_confirmable`, reason `same_source_members`), and the confirm list leaves it out. Before, confirming it linked the two same-source pages as one identity. Collapse those pages first, and the next preview shows the cross-source group with one page per source.
