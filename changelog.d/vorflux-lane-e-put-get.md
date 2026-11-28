**`gbrain put` and `gbrain get` now work on a brain that uses the Rust engine, and they store and print the same bytes as PGLite and Postgres.**

### Added
- On a Rust-engine brain that is not a managed brain, `gbrain put` writes a page and `gbrain get` reads it back. Before, both commands stopped with `engine_capability_missing`. The page text, the JSON output and the stored rows match what PGLite and Postgres give for the same command.
- The Rust engine now serves the store reads and writes a markdown import reaches, including derived links, wanted pages, timeline rows and the page's write admission. A request it still cannot serve, such as a guest source or a managed brain, stops with `engine_capability_missing` and names what is missing. It never writes part of the page.
- The engine swap report and guide name six limits of writing to a Rust brain: a put from a second process refuses while another process holds the brain open; after a writer crashes mid-write, later writes wait for its lease (365 s by default) and then all land; old put receipts are not compacted; embeddings install only as plain float vectors at the width the store keeps; preparing a page's links reads every source; and a page read checks sync holds across every source.

### Fixed
- On the Rust engine, a page read shows a fact you withdrew as forgotten and leaves out a purged one, as PGLite does. Before, the Rust read showed the withdrawn fact as active.
- On the Rust engine, a derived-link update that fails part of the way through now keeps the page's old links, also inside a caller's transaction. Before, the new links could be saved while the rest of the update was not.
- On the Rust engine, `gbrain delete` refuses before it deletes anything, because `gbrain restore` cannot run there yet. A put by the exact capitalised name of a page that a seed stored refuses instead of writing a second, lowercase page.
- On the Rust engine, a put of a reserved `skills/` page in a source with a shared skill pack is refused, as on PGLite; `gbrain history` keeps the reason a version was replaced; a write the database would have to store with no owner refuses before it is admitted; and an effect bound to a worktree runs on its owner.
- When several writes are prepared together, one that runs out of time no longer fails another write's shared skill-pack check.
- On the Rust engine, a page that is stored in parts (a large page) reads again when it has a withdrawn or purged fact. Before, the read failed.
- On the Rust engine, asking for a page by a name with capitals opens only the page stored under that exact name, never its lowercase look-alike, and the check reads one key instead of every page.
- On the Rust engine, receipt cleanup and an embedding at a width the store does not keep refuse before they touch anything, instead of failing halfway or saving a short vector as complete.
- `gbrain doctor`'s fence-hold, access-member and link checks on Postgres stop at the doctor's deadline again, so a locked table cannot hold a connection past it.
- On Postgres, the two checks that ask whether a page's facts are waiting for or done with extraction now stop at the write's preparation time limit, like the other reads a write makes before it commits.

### For contributors
- Many reads and statements that used raw SQL now go through named engine members, so a test that watched the SQL text now watches the member call.
- New parity cases compare `put`, `get`, `delete` and page reads with withdrawn facts on PGLite, Postgres and Rust (`test/rust-cli-put.test.ts`, `test/engine-parity/`; the Rust cases run when the Rust addon is built).
- Follow-ups (owner: lane E, after landing): the Rust addon CI step that does not run `test/rust-cli-put.test.ts` and `test/rust-engine-admission-and-derived-links.test.ts`; and, due Wed Dec 9, the per-page hold read that lists every source on Rust and `fetchSource`, which reads every source to find one (both named in the swap report).
