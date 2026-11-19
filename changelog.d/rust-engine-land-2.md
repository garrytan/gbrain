**The Rust engine's store now serves fact, ontology and eval-capture reads and writes instead of refusing them.**

Nothing selects the Rust engine yet. No default path (PGLite, Postgres) loads this code, and nothing outside the Rust engine's own files imports it. It is the second of several Rust-engine landings.

### Added
- The Rust store gains the facts, trust, ontology, eval-capture and persistence domains with their napi bindings. 24 `BrainEngine` members in `test/engine-parity/coverage.tsv` go from refusing to serving: 14 fact members, 4 ontology members, `migrateFactsToCanonical` and 5 eval-capture members, with their `store-members` TypeScript members.
- Private rows are filtered the way the PGLite and Postgres engines filter them. A read whose privacy policy the store cannot reproduce exactly still refuses with `engine_capability_missing` instead of returning private rows.
- The store also gains trust-tier stamping on page writes, calibration profiles, decide proposals and store, and fact relink. These have Rust tests but no TypeScript member yet, so nothing calls them.
- A new test proves a refused fact write leaves nothing behind: a batch that deletes a page's facts and then fails restores them, and neither the batch nor a refused expiry takes an id or changes a row.
- A fact written after its claim was withdrawn is saved expired, as the SQL engines' database trigger does; a bare entity name is read under the privacy of the page at its directory; an upper-case request id names the same publication effects as its lower-case spelling; and the capacity true-up listing counts queued effects as unfinished work. A page rename carries its withdrawals to the new slug, and an ontology confidence floor is compared as the stored REAL, so a 0.7 row meets a 0.7 floor.
