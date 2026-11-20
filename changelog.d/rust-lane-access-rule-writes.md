**A Rust brain can now change its folder access rules.**

### Changed
- `gbrain access rule add` and `rule remove`, approvals and restamps now run on the Rust engine, so a Rust brain can make a folder private, approve the change and open the folder again, with the same access checks and revision history as Postgres and PGLite.
- on the Rust engine, two rule changes made at the same time cannot both apply against the same revision, and a rule change that fails part way leaves no partial rule.
- on the Rust engine, a rule can name one page as well as a folder, as on Postgres and PGLite.
- on the Rust engine, a page written under an existing folder rule is kept to that rule's readers at once, and a reader a rule names sees the folder's pages in title lookups and salience reads.
- `gbrain access` setup checks, policy-store moves and policy exports now run on the Rust engine.
