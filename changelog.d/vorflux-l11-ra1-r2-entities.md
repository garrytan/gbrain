**An entity card on a Rust brain now shows when its page was last retrieved, as Postgres and PGLite do.**

### Fixed
- The entity read on a Rust brain always reported a page's last retrieval time as empty. It now reports the time a search, query or page read last surfaced the page, so stale-page ranking sees the same value on every engine.
