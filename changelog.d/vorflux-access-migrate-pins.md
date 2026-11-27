**`gbrain access rule migrate` now refuses before it writes anything when it runs in a second process, instead of leaving a half-finished migration behind.**

### Fixed
- On a Rust brain, or whenever another process owns the brain, running `gbrain access rule migrate` from a process that does not own it now stops at once with a clear refusal and writes nothing. Before, it recorded the start of the migration and could commit the policy files, then failed at the store switch, and the unfinished migration blocked a move in the other direction. With a PGLite owner this stuck state already happened on the previous release; it no longer can.

### Changed
- The Rust brain's migration journal has new unit tests (an id is unique across sources, a switch keeps its receipts and update time, the newest unfinished migration is by creation time), and the whole migrate flow now has a parity test that runs on PGLite, Postgres and the Rust engine. No behavior change.

<!-- behavior-change: access_migrate_refuses_non_owner_32h -->
