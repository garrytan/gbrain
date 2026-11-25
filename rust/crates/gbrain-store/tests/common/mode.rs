//! The two store modes a test can run in, and the macro that runs one body in both.
//!
//! This file is compiled twice on purpose: `common` includes it (for `open_in`) and so does
//! `memory_env` (for `brain_in`), so a test file that only needs the injected-clock brain does not
//! have to declare `mod common`. In a file that declares both, the two copies are two types: use
//! the one that belongs to the fixture you call.

/// Which record file a test store sits on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreMode {
    /// One writer at a time (`RedbKv` alone).
    Single,
    /// Optimistic transactions over one commit pipeline (`OccKv`, `concurrent_writes: true`).
    Optimistic,
}

impl StoreMode {
    pub const ALL: [StoreMode; 2] = [StoreMode::Single, StoreMode::Optimistic];

    pub fn optimistic(self) -> bool {
        self == StoreMode::Optimistic
    }

    /// The suffix a generated test name carries.
    pub fn label(self) -> &'static str {
        match self {
            StoreMode::Single => "single",
            StoreMode::Optimistic => "optimistic",
        }
    }
}

/// Emits `<name>_single` and `<name>_optimistic` tests that call `body(StoreMode::..)`.
///
/// A test that holds in both modes is written once as `fn body(mode: StoreMode)`, then listed:
/// `both_modes!(body => body_single, body_optimistic);`. The names are spelled out because stable
/// Rust cannot join identifiers without a dependency. `StoreMode` must be in scope at the call.
#[allow(unused_macros)]
macro_rules! both_modes {
    ($body:ident => $single:ident, $optimistic:ident) => {
        #[test]
        fn $single() {
            $body(StoreMode::Single)
        }
        #[test]
        fn $optimistic() {
            $body(StoreMode::Optimistic)
        }
    };
}
#[allow(unused_imports)]
pub(crate) use both_modes;

/// The options a test store opens with in `mode`. With `GBRAIN_RUST_MULTIUSER=1` the store runs in multi-user mode, with the commit
/// log (`GBRAIN_RUST_COMMIT_LOG=1`) and write origin (`GBRAIN_RUST_WRITE_ORIGIN=1`) sub-switches as the variables say; unset, these
/// are the options every test had.
#[allow(dead_code)]
pub fn open_options(mode: StoreMode) -> gbrain_store::OpenOptions {
    let on = |name: &str| std::env::var(name).is_ok_and(|v| v == "1");
    let mut options = gbrain_store::OpenOptions {
        concurrent_writes: mode.optimistic(),
        ..gbrain_store::OpenOptions::default()
    };
    if on("GBRAIN_RUST_MULTIUSER") {
        options.multiuser = true;
        options.multiuser_writes = gbrain_store::MultiUserWrites {
            commit_log: on("GBRAIN_RUST_COMMIT_LOG"),
            write_origin: on("GBRAIN_RUST_WRITE_ORIGIN"),
            host_id: Some("d0000000-0000-4000-8000-0000000000d1".into()),
            log_retention_bytes: None,
        };
    }
    options
}
