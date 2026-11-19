**The experimental Rust engine's store now serves facts, page operations, raw data and file records, the ontology, eval capture, dream verdicts and contradiction runs, and the code call graph the way PGLite does, but nothing selects it yet; PGLite and Postgres brains are unchanged.**

### Added
- The Rust engine serves all 15 fact members (insert, expire, list, supersede, trajectory, health, duplicate search by shared words and by cosine, the move to a canonical slug) and hides a fact whose origin page is private, renamed to a private page or aliased to one when the caller asks for `excludePrivate` (`rust/docs/store/facts.md`).
- The Rust engine serves 16 page operations (batch snapshots, duplicate lookup, batch and old-page purges, find, count, samplers, marker and date reads, revert), raw page data and file records, the ontology family, Life Chronicle event projections, eval capture, dream verdicts and contradiction runs, and the code call graph (`rust/docs/store/`).
- A second process can use a Rust brain through the process that owns it: the owner answers the members the store serves as it does in process, keeps its lock until running calls finish, and refuses a call that arrives after it stopped.

### Changed
- The salience and anomaly reads hide private pages on a Rust brain as they do on PGLite.
- A title search hit on a Rust brain no longer shows the text of a chunk that a deferred retire left on a segmented page; it shows the chunk PGLite shows, or none.
- On a Rust brain, `getChunkPage` and the chunk windows serve a page whose pre-upgrade index the v153 activation kept serving, as PGLite does.
- A keyword search on a Rust brain with a very long query (more than 1,024 query items) now starts one large-stack worker thread for its whole walk, not one for each page, title or fact it checks.
- The keyword-search golden scripts install PGLite 0.5.16 from npm's tarball checked against its published integrity hash, into a new directory for each run.
