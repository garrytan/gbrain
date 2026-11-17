**A new research page shows how proven databases let many users and agents write at once without locks, and what the Rust engine should copy.**

### Documentation
- New `docs/research/rust-engine/multi-user-prior-art.md` compares about 40 databases, storage engines, search indexes and access-control systems on concurrency, crash safety, replication, access control, backup, multi-process use and proof of correctness.
- It recommends optimistic, serializable transactions checked at commit (the FoundationDB design) over a small proven store, with redb leading the bake-off, and deterministic simulation testing from the start.
- It maps each Postgres lock and queue pattern gbrain uses today (job claims with `SKIP LOCKED`, advisory locks, row locks, TTL leases, `LISTEN/NOTIFY`, RLS) to a lock-free replacement in the Rust engine.
- It finds that the Rust rewrite of Postgres is not a fit as a dependency: it keeps the Postgres lock model, is AGPL-licensed and is not yet production-ready.
