**The engine contract gains the members the Rust store switch needs, with nothing calling them yet.**

### Added
- `BrainEngine` has three new members: open loops counted per sender email, pending core-page edit notices, and the stale applied-capture purge. PGLite and Postgres answer them with the same SQL their callers ran inline before. The SQL sits in shared `engine-sql` modules, beside held statement modules for access and OAuth credentials, belief and mention bookkeeping, and the persistence journal and admission checks that later parts wire in. The opt-in Rust engine lists each new member, and serves open loops per sender email from its store with no 1000-row cap.
- No caller uses the new members or modules yet, so PGLite and Postgres brains behave exactly as before. Later parts move the callers over, one area at a time.
