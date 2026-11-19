**The experimental Rust engine now answers timeline and chunk reads that quote a page by its id, so `get_timeline`, `chronicle_day`, `chronicle_since` and `get_chunks` no longer stop on it with a typed refusal.**

### Changed
- Both engines gain one storage read, `listPageRefsByIds`, that names the source, slug and type of each listed page by id, deleted pages included. Timeline quoting and `get_chunks` use it in place of their own SQL, so PGLite and Postgres answer exactly as before.
