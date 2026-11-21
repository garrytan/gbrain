**On a Rust brain, page history for a remote caller now hides private versions instead of refusing.**

### Fixed
- On a Rust brain, `getVersions` with `excludePrivate` (the page history a remote caller reads) refused with a capability error. It now lists only the versions the caller may read: none for a page the caller cannot see, and no snapshot that names other readers, is private, or marks a pinned question. The filter runs before the limit, as on Postgres and PGLite.
