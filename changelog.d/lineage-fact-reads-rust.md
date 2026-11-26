**On a Rust brain, a labelled-only member and an ordinary member read facts the same as on PGLite and Postgres with `access.members_read_lineage` on, including `recall` and `search`.**

### Fixed
- On a Rust brain, every fact read by a member was refused with `engine_capability_missing` while `access.members_read_lineage` was on, which also made `search` fail for every member because it matches saved facts. Fact lists, recall, the saved-facts match behind `search`, the relevance pool, similar facts, contested pairs, ontology reads, row attribution, counts, brief facts and single-fact checks now answer the same facts as PGLite and Postgres. A fact is read through its provenance page by the member's lineage (a derived page when its origins allow it, never another member's page), a labelled-only member also reads a fact on a page that names it or whose every origin does, and a fact on a page the member may not read, or under a pending folder prefix, is not returned.

### Known gap
- On a Rust brain, three reads for a labelled-only member are still refused with `engine_capability_missing` (PGLite and Postgres answer them): the remote fact floors (`forget` and the single-fact lookups), an audience of several identities, and `as_of` editions. Nothing wrong is shown. Tracked as row 32e-b-5 in the Rust engine design doc.
