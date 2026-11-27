**On a Rust brain, a page whose chunks are replaced now gets new chunk ids, as on Postgres and PGLite, so a chunk id from before the change no longer opens a window on the new text.**

### Fixed
- When a page's chunks were replaced in full (a seal, or the store's own re-chunk of a page), the Rust engine kept the old chunk ids. A `chunk_id` from an earlier search then still opened `get_page --around-chunk-id` on the new text, and the engine-swap shadow saw the copy's search rows as rows its primary never returned. Each chunk now gets a new id in chunk order, and an old id answers `revision_changed`.
