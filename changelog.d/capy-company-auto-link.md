**Companies that are plainly the same company in two sources are now linked by sync, and a reject keeps them apart for good.**

<!-- behavior-change: company_auto_link_gst3127 -->

### Added
- Each sync links the cross-source company pages it changed with their copies in other sources when the pages carry exactly the same name, share a LinkedIn company page or their own site's domain, share an id no other page has, and name no different countries. Rankings and enrichment count the linked group once. `gbrain import` and `gbrain dedupe reconcile` link every company that qualifies, and a page written on its own (`put_page`, `capture`) links at the next sync, import or reconcile. People are never linked automatically, and nothing merges, renames or deletes a page.
- `gbrain dedupe reject <identity>` removes such a link at once. The decision keeps a fingerprint of each page (a hash of its name and ids, never the values), so the pair stays apart after one page is renamed or moved to another source, and after a database is rebuilt from git. Rejects recorded before this release get their fingerprints at the next sync.

### Changed
- When no page of a confirmed group is in the default source, the oldest page becomes the group's main page instead of the longest one.
