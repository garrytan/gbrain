**The Rust engine now treats whitespace the way PGLite does in two more places, and its fact fingerprints are checked against PGLite on every Unicode character.**

### Fixed
- On the Rust engine, the OAuth `agent` scope check and the `message_id` blank check in keyword search treated only ASCII whitespace as a separator. PGLite also counts characters such as U+0085, U+2003 and U+3000, so a scope written as `read<U+3000>agent` was accepted on Rust and refused on PGLite, and a `message_id` made only of those characters was returned instead of read as empty. Both now follow PGLite.

### Added
- Tests: the Rust fact fingerprints are compared with PGLite on a fixture of 1,019 claims (419 hand-written, 600 seeded) and on `lower()` and the whitespace class for every code point. A script regenerates the fixture from PGLite, and a test fails when the checked-in file is stale. On Postgres the same test reports where the host differs from PGLite, including ICU and C-locale databases.
- Tests: property tests cover redb round trips in the store and hostile input at the addon boundary (30 `Brain` methods must return a typed error, never panic), plus a seeded fuzz case in the smoke run against the built addon.
- Docs: `rust/README.md` explains the fixture and the property tests.
