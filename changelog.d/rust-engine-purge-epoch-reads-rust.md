### For contributors
- The persistence parity file ran the purge-epoch and reason-tombstone case twice: a typed copy and an older copy that seeded with raw SQL, which stopped on the Rust engine. The raw copy is gone; the typed copy, equal on PGLite, Postgres and Rust, covers the same reads.
