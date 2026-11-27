**The Rust engine now keeps folder access rules and keeps a private folder hidden from members its rule does not name.**

### Changed
- the Rust engine now stores folder access rules, pending folder coverage and policy revisions, so `access serves`, `whoami` and the folder checks give the same answers as Postgres and PGLite.
- on the Rust engine, a page under a private folder stays hidden from every member the folder's rule does not name.
