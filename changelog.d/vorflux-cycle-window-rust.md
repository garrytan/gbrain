**On a Rust brain, the nightly cycle of a source with no sync now walks that source's changed pages, as on Postgres and PGLite.**

### Fixed
- A source that does not sync (a connector source, one with automatic sync off, or one with no checkout) gets its extract phases from a window of its changed pages. On a Rust brain the cycle refused to build that window, so those phases stopped for the source. The window's reads are now typed engine calls the Rust engine serves, so the cycle walks the source's pages a window at a time and resumes where the last cycle stopped.
