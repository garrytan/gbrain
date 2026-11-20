**On an experimental Rust brain, a `put` now commits through the background writer, as on PGLite. PGLite and Postgres brains behave as before.**

### Fixed
- On a Rust brain a `put` used to stop queued at its publication step, because the Rust store refused to keep the follow-up work (embedding, mention links, facts) a publication queues. The store now keeps that work as queued rows, so the write commits and its receipt names work that exists. The Rust brain does not run that work yet: it waits, queued, and nothing is lost.
- On a Rust brain `gbrain write-request <id> --json` now returns the receipt. The receipt read its writer grant and its effects with raw SQL, which the Rust brain refuses; it now reads them through typed engine calls on every engine.
