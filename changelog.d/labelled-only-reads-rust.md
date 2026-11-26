**On a Rust brain, a labelled-only member and an ordinary member read pages, versions and page lists the same as on PGLite and Postgres, also with `access.members_read_lineage` on.**

### Fixed
- On a Rust brain, every remote read by a labelled-only member was refused with `engine_capability_missing`, and so was every read by any member while `access.members_read_lineage` was on. Page, list, backlink and version reads (and search with lineage off) now answer the same bytes as PGLite and Postgres: a labelled-only member reads a page that names it (or a group it is in, or a folder rule it satisfies), and with lineage on also a derived page whose every origin names it. A page the member may not read comes back `page_not_found` and is missing from every list. A derived page whose `derived_from` list holds a null entry is not read by a labelled-only member, as on PGLite and Postgres.
- A labelled-only member reads its own member page's facts on a Rust brain, as on PGLite and Postgres.
- `gbrain access who-can-read` now says that, with lineage on, a labelled-only member reads a derived page when every origin names it, instead of saying none of them reads it (same text on every engine).

### Known gap
- On a Rust brain, a fact read with `access.members_read_lineage` on is still refused with `engine_capability_missing` for every member (PGLite and Postgres answer it); with lineage on that includes `recall` and `search`, because search also reads saved facts. Nothing wrong is shown. Tracked as row 32e-b-4 in the Rust engine design doc.
- With lineage on, `gbrain access who-can-read` does not list a labelled-only member for a derived page whose origin names it, on every engine; the member can still read the page.
