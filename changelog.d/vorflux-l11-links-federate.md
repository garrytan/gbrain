**A Rust brain now saves a page that links to a page that does not exist yet, and runs `gbrain sources federate`, `unfederate`, `rename`, `webhook` and `tracked-branch`, with the same federation warning as Postgres and PGLite.**

### Fixed
- Saving a page on a Rust brain failed when one of its links named a page that does not exist yet, or a renamed page's old slug. The link step now reads slug aliases and the source's slug list through typed engine calls, so the page saves and links the same way on every engine.
- `gbrain sources federate` and `unfederate` refused on a Rust brain. They now work, and `sources rename`, `webhook set`, `webhook rotate`, `webhook clear` and `tracked-branch` work there too.
- When federating or restoring a source, a Rust brain now shows the same warning about remote-written pages that name no readers, and the same list of credentials that can read the source. Before, the warning was silently dropped there.
