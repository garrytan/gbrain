**On a Rust brain, `gbrain forget <id> --purge` now finishes on a source with no belief ledger and gives the same receipt as Postgres and PGLite.**

### Fixed
- On the Rust engine, a fact purge on a source that records no belief history now commits, and its receipt (every store's count, the residuals and the completion) matches Postgres and PGLite, segmented pages and take and decision proposals included.
- On the Rust engine, a fact purge on a source that does record belief history now refuses before it writes anything, and the refusal names the step that is missing and when it is due. Before, it recorded the purge request and then stopped part way.
