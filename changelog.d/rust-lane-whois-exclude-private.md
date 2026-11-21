**On a Rust brain, whois for a remote caller now hides private people instead of refusing.**

### Fixed
- On a Rust brain, the exact whois lookup for a remote caller that hides private pages refused with a capability error. It now returns only the pages the caller may read: a private page, or one whose readers name nobody the caller is, is left out before the limit, as on Postgres and PGLite. A reader the page names, or a caller with a private-read grant on the source, still finds it.
