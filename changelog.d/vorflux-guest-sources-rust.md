**A Rust brain now keeps guest sources and enforces their write rules, so `gbrain guests init` and `gbrain guests grant-owner-clients` work there as on PGLite and Postgres.**

### Changed
- `gbrain guests init --yes` and `gbrain guests grant-owner-clients` give the same output on a Rust brain as on PGLite and Postgres. A source whose config alone says guest is still "not a guest source" for grant-owner-clients on every engine. Blast radius: guests grant-owner-clients now works on a Rust brain.
- A Rust brain stores each guest source's record (its writers and trust ceiling) and applies the same write rules as the SQL engines' trust trigger. Only a listed writer can save a page in a guest source, and only as a guest note. A guest page is never stored above the source's ceiling. A guest source holds no facts, takes or timeline entries and takes no local path. Each refusal has the same message as on PGLite and Postgres.
- Reads that ask whether a source is a guest source count the record as well as the config, as the SQL engines do. A seed of a Rust brain from PGLite or Postgres copies the guest-source records.
- Still refused on a Rust brain: saving a guest note itself (its admission reads the record through raw SQL).
- Tests: `test/engine-parity/guest-sources.test.ts` checks init, grant-owner-clients, the config-only case and each write rule on every engine arm.
