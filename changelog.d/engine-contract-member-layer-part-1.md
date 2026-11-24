**The engine contract gains the members the Rust store switch needs, with nothing calling them yet.**

### Added
- `BrainEngine` has new members for a set of reads and writes that were raw SQL at their call sites. They cover access and OAuth credentials, belief and mention bookkeeping, persistence journal and admission statements, open loops per sender email, pending core-page edit notices and the stale applied-capture purge. PGLite and Postgres answer them with the same SQL as before, kept in shared `engine-sql` modules. The opt-in Rust engine lists each one, and serves open loops per sender email from its store with no 1000-row cap.
- No caller uses the new members yet, so PGLite and Postgres brains behave exactly as before. Later parts move the callers over, one area at a time.
