**On the Rust engine, restoring a deleted page over 24 MiB works again, and a page read that races a re-chunk is refused as on Postgres.**

### Fixed
- On the Rust engine, the stored view of a page kept in segments (a body over 1 MiB) did not say which body generation it showed. Two answers an agent sees then differed from PGLite and Postgres:
  - `restore_page` of a deleted page over 24 MiB failed with `storage_error`, and the page stayed deleted.
  - A `get_page` or `fetch` window read returned text when `gbrain reindex --segmented` replaced the page's stored blocks between the read's check and its body read. PGLite and Postgres answer `revision_changed` there.
  The Rust page view now carries the generation, so both answers match the other engines. Pages that are not stored in segments are not affected.
