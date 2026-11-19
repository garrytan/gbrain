//! Raw key-value tier: the same put-shaped transaction as one key-value transaction, on each
//! concurrency design, with no gbrain record code on top. Every acknowledged commit is fsynced.
//!
//! One transaction reads the page row and the page's version counter, then writes the page row
//! (2 KB), one page version (2 KB), the counter, 4 chunks (1 KB each), 3 links and one journal
//! entry. Workloads as in the store tier: `disjoint` (each writer its own 16 pages) and `hot`
//! (every writer the same page).
//!
//! Designs:
//! - `serial/<engine>`: one writer at a time (a process lock around read + commit), one fsync per
//!   transaction. This is today's model; redb's own write lock behaves the same way.
//! - `sharded<K>/redb`: K redb files, a page lives in file `page % K`, one writer per file. A
//!   transaction that touches pages in two files is not atomic in this design.
//! - `occ/<engine>`: optimistic transactions with one ordered commit pipeline and group commit
//!   (the bake-off layer, `rust/bench/src/occ.rs`; the prototype store is a port of it). A
//!   conflict reruns the transaction after a short randomized backoff, up to 200 attempts; a put
//!   that loses 200 times is counted in `errors`. This layer has no row-lock queueing; the
//!   prototype store adds it (see the store tier).
//!
//! Usage: rawkv-bench [--writers 1,4,16,64] [--secs 3] [--modes a,b] [--dir DIR]

use gbrain_bakeoff::fjall_store::FjallStore;
use gbrain_bakeoff::kv::{BaseStore, Table, WriteBatch};
use gbrain_bakeoff::lmdb_store::LmdbStore;
use gbrain_bakeoff::occ::{Db, Options};
use gbrain_bakeoff::redb_store::RedbStore;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::time::{Duration, Instant};

fn open(engine: &str, dir: &Path) -> Arc<dyn BaseStore> {
    match engine {
        "redb" => Arc::new(RedbStore::open(dir).expect("redb")),
        "fjall" => Arc::new(FjallStore::open(dir).expect("fjall")),
        "lmdb" => Arc::new(LmdbStore::open(dir).expect("lmdb")),
        e => panic!("unknown engine {e}"),
    }
}

fn key(tag: u8, parts: &[u64]) -> Vec<u8> {
    let mut k = vec![tag];
    for p in parts {
        k.extend_from_slice(&p.to_be_bytes());
    }
    k
}

fn filler(len: usize, seed: u64) -> Vec<u8> {
    let mut v = format!("{seed} ").into_bytes();
    v.resize(len, b'x');
    v
}

/// The writes of one put on `page` by `writer`, given the page's current version counter.
fn put_writes(page: u64, writer: u64, n: u64, counter: u64) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut w = vec![
        (key(b'P', &[page]), filler(2048, n)),
        (key(b'V', &[page, counter]), filler(2048, n)),
        (key(b'C', &[page]), (counter + 1).to_be_bytes().to_vec()),
        (key(b'J', &[writer, n]), filler(512, n)),
    ];
    for j in 0..4 {
        w.push((key(b'K', &[page, j]), filler(1024, n + j)));
    }
    for t in 0..3 {
        w.push((key(b'L', &[page, 1_000_000 + t]), filler(200, n)));
    }
    w
}

fn counter(bytes: Option<Vec<u8>>) -> u64 {
    bytes.map_or(0, |b| u64::from_be_bytes(b.try_into().expect("counter")))
}

/// One design under test: something that runs one put transaction.
trait Design: Send + Sync {
    /// Runs one put. `Err` when the design gave up (the caller would see an error).
    fn put(&self, page: u64, writer: u64, n: u64) -> Result<(), String>;
    fn conflicts(&self) -> Option<(u64, u64, u64)> {
        None
    }
}

/// One writer per file: a lock around read + commit, one fsync per transaction.
struct Locked {
    shards: Vec<(Mutex<()>, Arc<dyn BaseStore>)>,
}

impl Design for Locked {
    fn put(&self, page: u64, writer: u64, n: u64) -> Result<(), String> {
        let (lock, store) = &self.shards[(page % self.shards.len() as u64) as usize];
        let _guard = lock.lock().expect("lock");
        let snap = store.snapshot().expect("snapshot");
        let _page = snap.get(Table::Data, &key(b'P', &[page])).expect("get");
        let c = counter(snap.get(Table::Data, &key(b'C', &[page])).expect("get"));
        drop(snap);
        let mut batch = WriteBatch::default();
        for (k, v) in put_writes(page, writer, n, c) {
            batch.put(Table::Data, k, v);
        }
        store.commit(&batch).map_err(|e| e.to_string())
    }
}

struct Occ {
    db: Db,
}

impl Design for Occ {
    fn put(&self, page: u64, writer: u64, n: u64) -> Result<(), String> {
        self.db
            .run(|t| {
                let _page = t.get(&key(b'P', &[page]))?;
                let c = counter(t.get(&key(b'C', &[page]))?);
                for (k, v) in put_writes(page, writer, n, c) {
                    t.put(k, v);
                }
                Ok(())
            })
            .map_err(|e| e.to_string())
    }
    fn conflicts(&self) -> Option<(u64, u64, u64)> {
        let s = self.db.stats.snapshot();
        Some((s.conflicts, s.batches, s.batched_txns))
    }
}

fn build(mode: &str, dir: &Path) -> Box<dyn Design> {
    let (design, engine) = mode.split_once('/').expect("mode is design/engine");
    if let Some(k) = design.strip_prefix("sharded") {
        let k: usize = k.parse().expect("shard count");
        let shards = (0..k)
            .map(|i| (Mutex::new(()), open(engine, &dir.join(format!("shard{i}")))))
            .collect();
        return Box::new(Locked { shards });
    }
    match design {
        "serial" => Box::new(Locked {
            shards: vec![(Mutex::new(()), open(engine, dir))],
        }),
        "occ" => {
            let opts = Options {
                commit_log: false,
                ..Options::default()
            };
            Box::new(Occ {
                db: Db::open(open(engine, dir), opts).expect("occ"),
            })
        }
        d => panic!("unknown design {d}"),
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((sorted.len() as f64 - 1.0) * p).round() as usize]
}

fn run(mode: &str, workload: &str, writers: usize, secs: f64, root: &Path) -> Value {
    let dir = root.join(format!("{}-{workload}-w{writers}", mode.replace('/', "-")));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("dir");
    let design: Arc<dyn Design> = Arc::from(build(mode, &dir));
    let before = design.conflicts();
    let stop = Arc::new(AtomicBool::new(false));
    let barrier = Arc::new(Barrier::new(writers + 1));
    let hot = workload == "hot";
    let handles: Vec<_> = (0..writers)
        .map(|i| {
            let (design, stop, barrier) = (design.clone(), stop.clone(), barrier.clone());
            std::thread::spawn(move || {
                let mut lat = Vec::new();
                let mut errors = 0u64;
                barrier.wait();
                let mut n = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    let page = if hot { 0 } else { i as u64 * 16 + n % 16 };
                    let t = Instant::now();
                    match design.put(page, i as u64, n) {
                        Ok(()) => lat.push(t.elapsed().as_secs_f64() * 1e3),
                        Err(_) => errors += 1,
                    }
                    n += 1;
                }
                (lat, errors)
            })
        })
        .collect();
    barrier.wait();
    let start = Instant::now();
    std::thread::sleep(Duration::from_secs_f64(secs));
    stop.store(true, Ordering::Relaxed);
    let mut lat: Vec<f64> = Vec::new();
    let mut errors = 0u64;
    for h in handles {
        let (l, e) = h.join().expect("writer");
        lat.extend(l);
        errors += e;
    }
    let wall = start.elapsed().as_secs_f64();
    lat.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    let ok = lat.len() as u64;
    let mut out = json!({
        "tier": "raw",
        "mode": mode,
        "workload": workload,
        "writers": writers,
        "ops": ok,
        "ops_per_s": (ok as f64 / wall * 10.0).round() / 10.0,
        "p50_ms": (percentile(&lat, 0.50) * 100.0).round() / 100.0,
        "p99_ms": (percentile(&lat, 0.99) * 100.0).round() / 100.0,
        "errors": errors,
    });
    if let (Some(b), Some(a)) = (before, design.conflicts()) {
        let conflicts = a.0 - b.0;
        out["conflicts"] = json!(conflicts);
        out["conflicts_per_op"] =
            json!(((conflicts as f64 / ok.max(1) as f64) * 1000.0).round() / 1000.0);
        out["avg_batch"] =
            json!((((a.2 - b.2) as f64 / (a.1 - b.1).max(1) as f64) * 10.0).round() / 10.0);
    }
    drop(design);
    let _ = std::fs::remove_dir_all(&dir);
    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let writers: Vec<usize> = flag("--writers")
        .unwrap_or_else(|| "1,4,16,64".into())
        .split(',')
        .map(|s| s.parse().expect("--writers"))
        .collect();
    let secs: f64 = flag("--secs").map_or(3.0, |s| s.parse().expect("--secs"));
    let root = PathBuf::from(flag("--dir").unwrap_or_else(|| "/var/tmp/gbrain-rawkv".into()));
    let modes = flag("--modes").unwrap_or_else(|| {
        "serial/redb,sharded4/redb,sharded16/redb,serial/lmdb,serial/fjall,occ/redb,occ/lmdb,occ/fjall"
            .into()
    });
    let workloads = flag("--workloads").unwrap_or_else(|| "disjoint,hot".into());
    for workload in workloads.split(',') {
        for mode in modes.split(',') {
            for &w in &writers {
                println!("{}", run(mode, workload, w, secs, &root));
            }
        }
    }
    let _ = std::fs::remove_dir(&root);
}
