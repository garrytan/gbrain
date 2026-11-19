//! Jobs: the Minion job queue, cycle locks, spend and rate leases, and wake subscriptions. Nothing
//! is built yet: TypeScript reaches these tables through `executeRaw`, which the Rust engine
//! refuses.
//!
//! Keys: every record of this family starts with `keys::JOBS` (`m`). The bytes after the tag are
//! this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md ("jobs (core)").
