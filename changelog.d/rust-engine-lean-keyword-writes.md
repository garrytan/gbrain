**Rust brains write pages about 3 times faster at 10,000 pages, because a page write no longer rewrites hundreds of keyword-index records.**

### Changed
- Rust brains move to store format 13 (the trunk may renumber it at merge). A page write used to put or delete a few hundred keyword-index records spread over the whole record file. It now keeps one pending record for each changed document, and every 64th pending record makes that write merge all of them into the index. Keyword search answers exactly as before, because every read applies the pending records.
- A deleted or emptied page drops its keyword records at once, so a purge leaves none of its text behind.
- A brain upgrades on its first writable open, and the upgrade writes only the new format number. A build that stops at an earlier format refuses the upgraded brain and changes nothing; going back means a re-seed.
- On a synthetic 10,000-page brain on Linux, a page write went from 149 ms to 48 ms (p50), and Rust import from 1,428 s to 754 s. Writes per second at 1, 4 and 16 clients went from 4, 6 and 6 to 8, 12 and 12; PGLite does about 50 to 57. The store on disk grew from 570 MB to 642 MB.
