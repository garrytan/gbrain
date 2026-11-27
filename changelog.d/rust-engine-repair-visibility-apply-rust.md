**On a Rust brain, `gbrain repair visibility --apply`, `gbrain repair --all --apply` and `gbrain doctor --remediate --include-repairs` now apply their visibility fixes instead of stopping.**

### Fixed
- `gbrain repair visibility --apply` refused on a Rust brain before writing a page label or a fenced fact. It now writes them, as PGLite and Postgres do.
- `gbrain repair --all --apply` and `gbrain doctor --remediate` ended on a Rust brain in the contextual-mode repair, whose embedding-input proof read and wrote chunks with raw SQL. Those reads and writes are typed engine members now, so the whole run finishes.
- PGLite and Postgres send the same statements as before, moved into the engine and pinned.
