**Rust brains no longer keep a second word index that nothing read, so writing a page takes about 40% less time at 10,000 pages.**

### Changed
- Rust brains move to store format 14 (the trunk may renumber it at merge). Each chunk write used to keep one record per distinct word for an old search that production keyword search never called; those records are gone, and the upgrade deletes them in one write transaction. A brain upgrades on its first writable open (1.6 s for 10,000 pages); a build that stops at format 8 refuses the upgraded brain, and going back means a re-seed. Brains made by `gbrain engine shadow seed` upgrade the same way.
- The Rust addon's `searchKeyword` method now answers exactly as `searchKeywordArm` with the query as both the match and the rank query. Keyword search through gbrain answers as before.
- On a synthetic 10,000-page brain on Linux, a page write went from 149 ms to 86 ms (p50) and Rust import from 1,427 s to 922 s. Writes per second at 1, 4 and 16 clients went from 4, 6 and 6 to 7, 9.5 and 9.8; PGLite does about 50 to 57.
