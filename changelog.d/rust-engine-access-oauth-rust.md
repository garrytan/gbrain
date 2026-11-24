**On the Rust engine, a key with the read-shared switch on reads every shared source when it signs in over HTTP.**

### Fixed
- On a brain with the Rust engine, a legacy token or an OAuth client with the read-shared switch on (`--read-shared on`) read only its own sources when it signed in to `gbrain serve --http` or the legacy MCP transport, and the response carried the `read_shared_unresolved` notice. It now reads the same shared sources as on PGLite and Postgres. Nothing to do on upgrade.
