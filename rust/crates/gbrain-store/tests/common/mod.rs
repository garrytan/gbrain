#![allow(dead_code)]
//! Shared helpers for the integration tests.

use gbrain_store::{OpenOptions, Store};
use std::path::{Path, PathBuf};

pub mod clock;
pub mod format;
pub mod logged;
#[allow(clippy::duplicate_mod)]
pub mod mode;
pub mod mu;

pub use mode::StoreMode;
#[allow(unused_imports)]
pub(crate) use mode::both_modes;
use std::sync::atomic::{AtomicU32, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);

/// A fresh directory under cargo's target tmp dir, removed on drop.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(name: &str) -> Self {
        let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Opens the test brain. `GBRAIN_RUST_CONCURRENT_WRITES=1` runs the suite with concurrent writes
/// on, so the gate checks both modes.
pub fn open(dir: &TempDir) -> Store {
    let options = OpenOptions {
        concurrent_writes: std::env::var("GBRAIN_RUST_CONCURRENT_WRITES").is_ok_and(|v| v == "1"),
        ..OpenOptions::default()
    };
    Store::open_dir(&dir.path().join("brain"), options).unwrap()
}

/// Opens the test brain with concurrent writes on.
pub fn open_concurrent(dir: &TempDir) -> Store {
    let options = OpenOptions {
        concurrent_writes: true,
        ..OpenOptions::default()
    };
    Store::open_dir(&dir.path().join("brain"), options).unwrap()
}

/// Opens the test brain in an explicit mode, whatever `GBRAIN_RUST_CONCURRENT_WRITES` says.
pub fn open_in(dir: &TempDir, mode: StoreMode) -> Store {
    let options = OpenOptions {
        concurrent_writes: mode.optimistic(),
        ..OpenOptions::default()
    };
    Store::open_dir(&dir.path().join("brain"), options).unwrap()
}
