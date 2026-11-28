**`gbrain put` and `gbrain get` now work on a brain that uses the Rust engine, and they store and print the same bytes as PGLite and Postgres.**

### Added
- On a Rust-engine brain that is not a managed brain, `gbrain put` writes a page and `gbrain get` reads it back. Before, both commands stopped with `engine_capability_missing`. The page text, the JSON output and the stored rows match what PGLite and Postgres give for the same command.
- The Rust engine now serves the store reads and writes a markdown import reaches, including derived links, wanted pages, timeline rows and the page's write admission. A request it still cannot serve, such as a guest source or a managed brain, stops with `engine_capability_missing` and names what is missing. It never writes part of the page.

### Fixed
- On the Rust engine, a derived-link update that fails part of the way through now keeps the page's old links. Before, the new links could be saved while the rest of the update was not.
- On Postgres, the two checks that ask whether a page's facts are waiting for or done with extraction now stop at the write's preparation time limit, like the other reads a write makes before it commits.

### For contributors
- Many reads and statements that used raw SQL now go through named engine members, so a test that watched the SQL text now watches the member call.
- New parity cases compare `put` and `get` on PGLite, Postgres and Rust (`test/rust-cli-put.test.ts`; the Rust case runs when the Rust addon is built).
