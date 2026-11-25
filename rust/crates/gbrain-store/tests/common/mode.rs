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

/// The options of a store a multi-writer test opens explicitly in multi-user mode, whatever the environment says. Every open of a
/// twin that checks multi-user behaviour goes through this (or `open_optimistic_mu`), so a fresh brain is never silently a plain one.
#[allow(dead_code)]
pub fn open_options_mu(mode: StoreMode) -> gbrain_store::OpenOptions {
    gbrain_store::OpenOptions {
        concurrent_writes: true,
        multiuser: true,
        ..mode_options_base(mode)
    }
}

#[allow(dead_code)]
fn mode_options_base(mode: StoreMode) -> gbrain_store::OpenOptions {
    gbrain_store::OpenOptions {
        concurrent_writes: mode.optimistic(),
        ..gbrain_store::OpenOptions::default()
    }
}
