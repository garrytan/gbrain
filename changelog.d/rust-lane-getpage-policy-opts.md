**On a Rust brain, write attribution for a remote caller now reads the page instead of refusing.**

### Fixed
- On a Rust brain, `get_write_attribution` refused before it read anything: its page read passes the safe-chunk and take-holder options, which the Rust page read refused. Postgres and PGLite do not read either option for a page row, so the Rust engine now ignores them too, and the read still hides every page the caller may not see.
