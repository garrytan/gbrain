**On the Rust engine, page history never shows a change reason that a damaged next version would have hidden.**

### Fixed
- On a brain with the Rust engine, `get_versions` for a caller held to what it may read (a remote or member-bound key) skipped a stored version it could not parse and took the next readable version as the successor. The version before the damaged one then showed its change reason, which can describe a write that made the page private. It now treats the damaged version as hidden. The damaged version is not listed, and the version before it shows no reason, as on PGLite and Postgres. Nothing to do on upgrade.
