**On a Rust brain, listing pages by update time no longer reads every page, so the default page list is about 25 times faster at 10,000 pages.**

### Changed
- Rust brains move to store format 12 (the trunk may renumber it at merge). A new keyed lookup keeps pages in update order, so `listPages` sorted by update time, with no type, tag or slug filter, reads only the pages it returns. Rows and their order are unchanged. A brain upgrades on its first writable open (285 ms for 10,000 pages); a build that stops at format 9 refuses the upgraded brain, and going back means a re-seed.
- A failed store upgrade from format 8 or 9 leaves the brain readable at its old format with no half-written lookups, and the next open upgrades it. Tests prove this by failing the upgrade at its last write and at its commit.
