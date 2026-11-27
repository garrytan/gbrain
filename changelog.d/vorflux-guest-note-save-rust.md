**A Rust brain now saves guest notes, so a listed guest writer's note over remote MCP is stored and read back as on PGLite and Postgres.**

### Changed
- A credential listed on a guest source's writers saves a guest note on a Rust brain. The page, its trust tier (capped at the source's ceiling) and its guest stamp (sender, group, audience, saved time) read back the same as on PGLite and Postgres. A credential not on the writers is still refused with `source_writer_restricted`.
- A Rust brain stores each guest note's mark. A page deleted for good takes its mark with it. A seed of a Rust brain from PGLite or Postgres copies the marks.
- Still refused on a Rust brain: promoting a guest note, a remote writer's delete of its own guest note, and a remote reader's guest stamp. Each still reads through raw SQL and refuses with `engine_capability_missing` before it writes anything.
- Tests: `test/engine-parity/guest-note-save.test.ts` checks a listed writer's save and an unlisted writer's refusal on every engine arm.
