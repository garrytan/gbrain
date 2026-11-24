**A keyword search on the Rust engine now splits a query on the same spaces PGLite does.**

### Fixed
- On the Rust engine, keyword search split a query into words only at ASCII whitespace. PGLite also splits at U+0085, U+2000 to U+200A (except U+2007), U+2028, U+2029, U+205F and U+3000. So a query such as `cats` and `dogs` joined by an ideographic space (U+3000) was read as one odd word on Rust and as two words on PGLite, and the two engines returned different pages. Rust now splits where PGLite splits.

### Added
- Tests: a parity test runs a keyword search whose query is split by each of 21 space-like characters and requires Rust to give PGLite's answer for every one. A second parity test pins what deleting a page does to the facts about it. A hard delete leaves them live, and a soft delete followed by a purge expires the facts the page owns and keeps another page's.
- Docs: `rust/docs/store/keyword.md` says which characters separate words in a keyword query.
