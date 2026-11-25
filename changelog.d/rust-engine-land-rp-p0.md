**Fact and page purges and the writer checks now go through named engine members instead of raw SQL, and nothing you run changes.**

### Changed
- About 35 more `BrainEngine` members now carry the statements that fact and page purges, writer admin, write-gate holds, embedding budgets, trust proposals and the access and credential reads used to run inline. PGLite and Postgres run the same SQL as before, behind typed members that a Rust-backed brain can serve later.
- A held write (a quarantined fact or take) now keeps its page binding when the page is renamed, because the hold member writes the same bound and unbound statements as master.
- The Rust shadow evidence epoch restarts when this ships (adapter version 6 to 7). No migration.
