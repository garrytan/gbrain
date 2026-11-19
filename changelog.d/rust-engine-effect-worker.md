**On an experimental Rust brain, the follow-up work a write queues (embedding, mention links, facts) now runs and finishes, as on PGLite, when no embedding model is configured. PGLite and Postgres brains behave as before.**

### Fixed
- On a Rust brain the work a `put` queues after it commits used to wait, queued, forever: the Rust store never handed it to the background worker. The store now hands it out in the same order as PostgreSQL, and the worker records each result, so the write's receipt shows the same finished work as on PGLite.
- A Rust brain's background worker now checks for waiting work through the store, so it wakes for queued writes and follow-up work instead of refusing that check.
- With an embedding model configured, a Rust brain does not embed pages yet. That embedding work stays queued and nothing is lost.
