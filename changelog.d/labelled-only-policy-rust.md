**A member with the labelled-only grant can no longer rewrite an open page it is not named on, on a Rust brain.**

### Fixed
- On a Rust brain, the check that opens every remote page write did not look at the labelled-only grant, so a member holding it could rewrite an open page that does not name it. The check now reads the grant, and that write is refused with `engine_capability_missing` and nothing is written, because the Rust engine does not serve the labelled-only writer policy yet. PGLite and Postgres brains were not affected and still refuse it with `page_not_found`.
