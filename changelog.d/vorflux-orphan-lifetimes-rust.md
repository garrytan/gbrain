**On a Rust brain, the belief ledger health check now reports orphaned page lifetimes, as on Postgres and PGLite.**

### Fixed
- The check that finds page lifetimes left open after a page was removed outside the ledger (and, in a deep check, ledger events that name a lifetime that does not exist) was refused on a Rust brain, so the ledger report could not say whether any were orphaned. It is now a typed engine call the Rust engine serves.
