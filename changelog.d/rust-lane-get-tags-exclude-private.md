**On a Rust brain, `get_tags` for a remote caller now answers instead of refusing.**

### Fixed
- On a Rust brain, `get_tags` refused for a remote caller: it asks the tag read to hide private pages, and the Rust tag read refused that option. The Rust engine now applies the caller's page policy, so a page the caller may not see has no tags, live or soft-deleted, and a page the caller may read shows its tags as on Postgres and PGLite.
