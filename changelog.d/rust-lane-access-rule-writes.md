**A Rust brain can now change its folder access rules.**

### Changed
- `gbrain access rule add` and `rule remove`, approvals and restamps now run on the Rust engine, so a Rust brain can make a folder private, approve the change and open the folder again, with the same access checks and revision history as Postgres and PGLite.
- on the Rust engine, two rule changes made at the same time cannot both apply against the same revision, and a rule change that fails part way leaves no partial rule.
- on the Rust engine, a rule can name one page as well as a folder, as on Postgres and PGLite.
- on the Rust engine, a page written under an existing folder rule is kept to that rule's readers at once, and a reader a rule names sees the folder's pages in title lookups and salience reads.
- `gbrain access` setup checks, policy-store moves and policy exports now run on the Rust engine.
- on the Rust engine, the member-key setup checks read and revoke the brain's own keys and OAuth clients, instead of answering as if it had none.

### Fixed
- on a Postgres server with a locale collation such as `en_US.UTF-8`, `gbrain access rule list`, `access member list`, group lists, pending prefixes, whoami's applied revisions, setup lists and the pages-naming list sorted ids by the locale, which skips punctuation (`ab` before `a-z`). They now sort by byte, as PGLite and Rust brains do. A stored rulebook digest never depended on this order, so nothing needs approving again.
- on the Rust engine, a page hidden only by a folder rule now counts as private everywhere Postgres counts it: the write visibility check, the private-fact checks that keep such a page's facts from a caller with a private-facts grant, fact consolidation, and the fact cache, which now refreshes when a rule or a pending folder changes.
- on a Postgres server with a locale collation, a member's groups in key bindings and identities, the labelled-only member list `gbrain doctor` prints, the lineage check's audience member list, the enabled members `gbrain serves` names and the open-pages report's sources also sorted by the locale. They now sort by byte, as PGLite and Rust brains do.
- the Rust engine docs and refusal messages no longer say the store keeps no OAuth clients or access tokens. It keeps them; the grant, fence, name and member-binding reads that still refuse now say that they do not read those records yet.
