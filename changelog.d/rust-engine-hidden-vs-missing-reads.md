**A remote read now treats a page the caller may not see exactly like a page that does not exist.**

<!-- behavior-change: remote_hidden_reads_as_missing -->

### Fixed
- Privacy: a remote caller reading a page by a name that another page also answers to now gets the same answer whether a page it may not see holds that name or no page does. Local reads are unchanged. Applies on PGLite, Postgres and the Rust engine.
