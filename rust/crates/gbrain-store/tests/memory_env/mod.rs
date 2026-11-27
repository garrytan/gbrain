#![allow(dead_code)]
//! A store on a clock the test moves, for the memory-record families (dream, contradictions,
//! facts, ontology, raw_files, stats). `GBRAIN_RUST_CONCURRENT_WRITES=1` puts it on the
//! concurrent-write record file (`OccKv`), as `common::open` does, so the gate checks both modes.

use gbrain_store::env::uuid_from_bytes;
use gbrain_store::occ_kv::OccKv;
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{Env, Kv, OpenOptions, Store};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};

// The store modes and `both_modes!`, shared with `common` (see the note in that file).
#[path = "../common/mode.rs"]
#[allow(clippy::duplicate_mod)]
pub mod mode;
pub use mode::StoreMode;
#[allow(unused_imports)]
pub(crate) use mode::both_modes;

static NEXT: AtomicU32 = AtomicU32::new(0);

/// 2027-01-15T08:00:00Z.
pub const T0: i64 = 1_800_000_000_000_000;

pub struct Clock {
    now: AtomicI64,
    ids: AtomicU64,
}

impl Clock {
    /// A clock that reads `micros` until it is moved.
    pub fn at(micros: i64) -> Arc<Clock> {
        Arc::new(Clock {
            now: AtomicI64::new(micros),
            ids: AtomicU64::new(1),
        })
    }
    pub fn set(&self, micros: i64) {
        self.now.store(micros, Ordering::SeqCst);
    }
    pub fn advance(&self, micros: i64) {
        self.now.fetch_add(micros, Ordering::SeqCst);
    }
    pub fn now(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
}

impl Env for Clock {
    fn now_micros(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        let n = self.ids.fetch_add(1, Ordering::SeqCst);
        let mut bytes = [0u8; 16];
        bytes[8..].copy_from_slice(&n.to_be_bytes());
        uuid_from_bytes(bytes)
    }
}

/// A fresh brain in its own directory (removed on drop) and the clock it reads.
pub struct Brain {
    pub store: Store,
    pub clock: Arc<Clock>,
    dir: PathBuf,
}

impl std::ops::Deref for Brain {
    type Target = Store;
    fn deref(&self) -> &Store {
        &self.store
    }
}

impl Drop for Brain {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn brain(name: &str) -> Brain {
    let concurrent = std::env::var("GBRAIN_RUST_CONCURRENT_WRITES").is_ok_and(|v| v == "1");
    brain_with(name, concurrent, false)
}

/// A brain in an explicit mode on the same injected clock, whatever the environment says.
pub fn brain_in(name: &str, mode: StoreMode) -> Brain {
    brain_with(name, mode.optimistic(), false)
}

/// An optimistic brain with the multi-user switch explicitly on, on the injected clock: protected members then need a fence.
pub fn brain_mu(name: &str) -> Brain {
    let brain = brain_with(name, true, true);
    // The resolved state, asserted at the open: a brain that lost the switch fails here, never runs a twin as a plain one.
    assert!(
        brain.store.multiuser(),
        "the store did not resolve multi-user mode on"
    );
    brain
}

fn brain_with(name: &str, concurrent: bool, multiuser: bool) -> Brain {
    let options = OpenOptions {
        multiuser,
        ..OpenOptions::default()
    };
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "mem-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let clock = Arc::new(Clock {
        now: AtomicI64::new(T0),
        ids: AtomicU64::new(1),
    });
    #[cfg(feature = "fjall")]
    if std::env::var("GBRAIN_RUST_BAKEOFF_STORE").is_ok_and(|v| v == "fjall") {
        use gbrain_store::fjall_kv::FjallKv;
        let kv = FjallKv::open_dir(&dir.join("records.fjall")).unwrap();
        let kv: Arc<dyn Kv> = if concurrent {
            Arc::new(OccKv::new_fjall(kv).unwrap())
        } else {
            Arc::new(kv)
        };
        let store = Store::open_kv(kv, clock.clone(), options.clone()).unwrap();
        return Brain { store, clock, dir };
    }
    let kv = RedbKv::open_path(&dir.join("records.redb")).unwrap();
    let kv: Arc<dyn Kv> = if concurrent {
        Arc::new(OccKv::new(kv).unwrap())
    } else {
        Arc::new(kv)
    };
    let store = Store::open_kv(kv, clock.clone(), options.clone()).unwrap();
    Brain { store, clock, dir }
}

/// Opens (or reopens) the brain whose record file is `<dir>/records.redb` on `clock`, in `mode`. The clock is the store's:
/// a test sets it below a persisted floor before a reopen to see that written times never go under it.
pub fn open_at(dir: &std::path::Path, clock: Arc<Clock>, mode: StoreMode) -> Store {
    open_at_with(dir, clock, mode, true)
}

/// `open_at` with the multi-user switch given explicitly. The multi-writer twins always say `true` (a fresh brain is never silently
/// a plain one); the extra argument keeps that a visible choice at the call.
pub fn open_at_with(
    dir: &std::path::Path,
    clock: Arc<Clock>,
    mode: StoreMode,
    multiuser: bool,
) -> Store {
    std::fs::create_dir_all(dir).unwrap();
    let base = RedbKv::open_path(&dir.join("records.redb")).unwrap();
    let kv: Arc<dyn Kv> = if mode.optimistic() {
        Arc::new(OccKv::new(base).unwrap())
    } else {
        Arc::new(base)
    };
    let options = OpenOptions {
        multiuser,
        ..OpenOptions::default()
    };
    let store = Store::open_kv(kv, clock, options).unwrap();
    assert_eq!(
        store.multiuser(),
        multiuser,
        "the store did not resolve the multi-user switch the open asked for"
    );
    store
}
