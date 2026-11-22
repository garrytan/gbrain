//! Deterministic simulation harness for the gbrain Rust engine. Standard library only.
//!
//! The pieces, small on purpose:
//! - [`SimRng`], [`SimClock`], [`Trace`]: a seeded random stream, a fake clock, and a hash of
//!   everything a run did. The same seed must give the same trace hash.
//! - [`Scheduler`]: runs simulated tasks one step at a time, choosing the next task from the seed.
//! - [`SimDisk`]: an in-memory disk with crash points, torn writes, fsync errors and fsync lies.
//! - [`check`]: checkers for lost commits, torn reads, serializability and recovery.
//! - [`seed`]: run a test over many seeds; a failing seed prints a one-line repro
//!   (`GBRAIN_SIM_SEED=<n> cargo test ...`).
//!
//! The harness knows nothing about any particular store. A store is simulated by writing a driver
//! that feeds it through these pieces; see the `gbrain-bakeoff` crate in `rust/bench`.

pub mod check;
pub mod clock;
pub mod disk;
pub mod rng;
pub mod sched;
pub mod seed;
pub mod trace;

pub use clock::SimClock;
pub use disk::{CrashMode, DiskStats, FaultPlan, SimDisk, SimFile};
pub use rng::SimRng;
pub use sched::{Cx, Scheduler, Step, Task};
pub use trace::Trace;
