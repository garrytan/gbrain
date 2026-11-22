#![allow(dead_code)]
//! A store on a clock the test moves, for the memory-record families (dream, contradictions,
//! facts, ontology, raw_files, stats).

use gbrain_store::env::uuid_from_bytes;
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{Env, OpenOptions, Store};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);

/// 2027-01-15T08:00:00Z.
pub const T0: i64 = 1_800_000_000_000_000;

pub struct Clock {
    now: AtomicI64,
    ids: AtomicU64,
}

impl Clock {
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
    let kv = RedbKv::open_path(&dir.join("records.redb")).unwrap();
    let store = Store::open_kv(Arc::new(kv), clock.clone(), OpenOptions::default()).unwrap();
    Brain { store, clock, dir }
}
