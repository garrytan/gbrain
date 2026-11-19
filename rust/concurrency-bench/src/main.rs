//! Store tier: N writers on one brain through the public `gbrain_store::Store` API.
//!
//! One operation is put-shaped, the way gbrain writes a page: `submit_page_mutation` (page row,
//! page version and write-journal entry in one transaction), then `upsert_chunks` (4 chunks), then
//! `add_links_batch` (3 links). Each call is one durable commit. Two workloads:
//!
//! - `disjoint`: each writer updates its own 16 pages and links to its own 3 target pages.
//! - `hot`: every writer updates the same page and links to the same 3 targets.
//!
//! By default it measures the store as it opens today (redb, one writer at a time; a writer waits
//! on redb's write lock, so there are no busy errors). With `--concurrent` it opens the brain with
//! `concurrent_writes` (the optimistic store) and also reports conflicts (internal reruns) from
//! `Store::occ_stats`. With `--fjall` (built with the `fjall` feature) the brain's records live in
//! a fjall database instead of the redb file; `--concurrent` then puts the optimistic layer on it.
//!
//! Usage: store-bench [--concurrent] [--fjall] [--label NAME] [--writers 1,4,16,64] [--secs 3] [--dir DIR]
//! Prints one JSON object per (workload, writers) on stdout.

use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::journal::PageMutation;
use gbrain_store::links::LinkBatchInput;
use gbrain_store::{OpenOptions, Store};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

static REQUEST: AtomicU64 = AtomicU64::new(1);

fn request_id() -> String {
    format!(
        "00000000-0000-4000-8000-{:012}",
        REQUEST.fetch_add(1, Ordering::Relaxed)
    )
}

/// About 2 KB of page body, different per call so every put really changes the page.
fn body(writer: usize, n: u64) -> String {
    let mut s = format!("# Page by writer {writer}, update {n}\n\n");
    while s.len() < 2048 {
        s.push_str("Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod. ");
    }
    s
}

fn mutation(principal: &str, slug: &str, text: &str) -> PageMutation {
    serde_json::from_value(json!({
        "principal": {"kind": "local_cli", "id": principal},
        "requestId": request_id(),
        "slug": slug,
        "page": {"type": "note", "title": slug, "compiled_truth": text},
        "options": {},
    }))
    .expect("mutation")
}

fn chunks(writer: usize, n: u64) -> Vec<ChunkInput> {
    (0..4)
        .map(|j| {
            let mut text = format!("writer {writer} update {n} chunk {j}: ");
            while text.len() < 1024 {
                text.push_str("chunk text for keyword search and embedding. ");
            }
            serde_json::from_value(json!({"chunk_index": j, "chunk_text": text})).expect("chunk")
        })
        .collect()
}

fn links(from: &str, targets: &[String], n: u64) -> Vec<LinkBatchInput> {
    targets
        .iter()
        .map(|to| {
            serde_json::from_value(json!({
                "from_slug": from, "to_slug": to, "link_type": "mentions",
                "context": format!("update {n}"),
            }))
            .expect("link")
        })
        .collect()
}

/// One put-shaped operation. Returns the first error message, if any call failed.
fn put(store: &Store, writer: usize, slug: &str, targets: &[String], n: u64) -> Option<String> {
    let principal = format!("agent-{writer}");
    let r = store.submit_page_mutation(&mutation(&principal, slug, &body(writer, n)), None);
    match r {
        Ok(v) if v["state"] == "committed" => {}
        Ok(v) => return Some(format!("submit state {}", v["state"])),
        Err(e) => return Some(format!("submit {}: {}", e.code, e.message)),
    }
    if let Err(e) = store.upsert_chunks(slug, &chunks(writer, n), &UpsertChunksOptions::default()) {
        return Some(format!("upsert_chunks {}: {}", e.code, e.message));
    }
    if let Err(e) = store.add_links_batch(&links(slug, targets, n)) {
        return Some(format!("add_links_batch {}: {}", e.code, e.message));
    }
    None
}

fn seed_page(store: &Store, slug: &str) {
    let m = mutation("seed", slug, "seed body");
    store.submit_page_mutation(&m, None).expect("seed page");
}

/// Commits, conflicts, batches and the hottest conflict keys (prototype store only).
type OccCounts = (u64, u64, u64, Vec<(String, u64)>);

fn occ(store: &Store) -> Option<OccCounts> {
    store
        .occ_stats()
        .map(|s| (s.commits, s.conflicts, s.batches, s.hot_keys))
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let i = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[i]
}

fn run(
    label: &str,
    concurrent: bool,
    workload: &str,
    writers: usize,
    secs: f64,
    root: &Path,
) -> Value {
    let dir = root.join(format!("{label}-{workload}-w{writers}"));
    let _ = std::fs::remove_dir_all(&dir);
    let options = OpenOptions {
        concurrent_writes: concurrent,
        ..OpenOptions::default()
    };
    let store = Arc::new(Store::open_dir(&dir, options).expect("open"));
    // Setup: target pages (and the pages written) exist before the clock starts.
    let plan: Vec<(Vec<String>, Vec<String>)> = (0..writers)
        .map(|i| {
            if workload == "hot" {
                (
                    vec!["hot".to_string()],
                    (0..3).map(|t| format!("hot-t{t}")).collect(),
                )
            } else {
                (
                    (0..16).map(|p| format!("w{i}-p{p}")).collect(),
                    (0..3).map(|t| format!("w{i}-t{t}")).collect(),
                )
            }
        })
        .collect();
    let mut seeded = std::collections::BTreeSet::new();
    for (pages, targets) in &plan {
        for slug in pages.iter().chain(targets) {
            if seeded.insert(slug.clone()) {
                seed_page(&store, slug);
            }
        }
    }
    let before = occ(&store);
    let stop = Arc::new(AtomicBool::new(false));
    let barrier = Arc::new(Barrier::new(writers + 1));
    let handles: Vec<_> = plan
        .into_iter()
        .enumerate()
        .map(|(i, (pages, targets))| {
            let (store, stop, barrier) = (store.clone(), stop.clone(), barrier.clone());
            std::thread::spawn(move || {
                let mut lat = Vec::new();
                let mut errors = Vec::new();
                barrier.wait();
                let mut n = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    let slug = &pages[n as usize % pages.len()];
                    let t = Instant::now();
                    match put(&store, i, slug, &targets, n) {
                        None => lat.push(t.elapsed().as_secs_f64() * 1e3),
                        Some(e) => errors.push(e),
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
    let mut lat = Vec::new();
    let mut errors = Vec::new();
    for h in handles {
        let (l, e) = h.join().expect("writer thread");
        lat.extend(l);
        errors.extend(e);
    }
    let wall = start.elapsed().as_secs_f64();
    lat.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    let ok = lat.len() as u64;
    let mut out = json!({
        "tier": "store",
        "store": label,
        "workload": workload,
        "writers": writers,
        "ops": ok,
        "ops_per_s": (ok as f64 / wall * 10.0).round() / 10.0,
        "commits_per_s": (3.0 * ok as f64 / wall * 10.0).round() / 10.0,
        "p50_ms": (percentile(&lat, 0.50) * 100.0).round() / 100.0,
        "p99_ms": (percentile(&lat, 0.99) * 100.0).round() / 100.0,
        "errors": errors.len(),
        "first_error": errors.first(),
    });
    if let (Some(b), Some(a)) = (before, occ(&store)) {
        let commits = a.0 - b.0;
        let conflicts = a.1 - b.1;
        let batches = (a.2 - b.2).max(1);
        out["conflicts"] = json!(conflicts);
        out["conflicts_per_op"] =
            json!(((conflicts as f64 / ok.max(1) as f64) * 1000.0).round() / 1000.0);
        out["avg_batch"] = json!(((commits as f64 / batches as f64) * 10.0).round() / 10.0);
        out["hot_keys"] = json!(a.3.into_iter().take(4).collect::<Vec<_>>());
    }
    drop(store);
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
    let concurrent = args.iter().any(|a| a == "--concurrent");
    let fjall = args.iter().any(|a| a == "--fjall");
    if fjall {
        assert!(
            cfg!(feature = "fjall"),
            "--fjall needs a build with --features fjall"
        );
        // SAFETY: set once at start, before any thread exists.
        unsafe { std::env::set_var("GBRAIN_RUST_BAKEOFF_STORE", "fjall") };
    }
    let label = flag("--label").unwrap_or_else(|| {
        match (concurrent, fjall) {
            (true, false) => "proto-occ",
            (false, false) => "today",
            (true, true) => "proto-occ-fjall",
            (false, true) => "fjall",
        }
        .to_string()
    });
    let writers: Vec<usize> = flag("--writers")
        .unwrap_or_else(|| "1,4,16,64".into())
        .split(',')
        .map(|s| s.parse().expect("--writers"))
        .collect();
    let secs: f64 = flag("--secs").map_or(3.0, |s| s.parse().expect("--secs"));
    let root = PathBuf::from(flag("--dir").unwrap_or_else(|| "/var/tmp/gbrain-cbench".into()));
    let workloads = flag("--workloads").unwrap_or_else(|| "disjoint,hot".into());
    for workload in workloads.split(',') {
        for &w in &writers {
            println!("{}", run(&label, concurrent, workload, w, secs, &root));
        }
    }
    let _ = std::fs::remove_dir(&root);
}
