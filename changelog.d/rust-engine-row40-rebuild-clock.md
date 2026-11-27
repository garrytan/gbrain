**On an experimental Rust brain, search reports an upgrade's index rebuild as running only while a text page in the search scope waits for it, as on PGLite and Postgres.**

### Fixed
- Image pages, pages of an archived source and pages outside the search scope no longer start the rebuild clock on a Rust brain.
