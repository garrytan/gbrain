//! Vector-search scale measurement: how long one `searchVector` call (and the `cosinesByChunkIds`
//! re-score the hybrid pipeline sends after it) takes on a brain of 10,000 or 50,000 pages with
//! 1536-dimension vectors, and whether the bounded scan answers exactly what the full scan answers.
//!
//! It is a measurement tool only. `load` writes an invented corpus through the public API
//! (`put_page`, then `upsert_chunks` with a vector per chunk and `seal`, as an import does), so the
//! store holds real page, chunk and vector records. The vectors are deterministic: each chunk is a
//! shared direction (embeddings of one model are not centred), plus a topic direction (one of 256),
//! plus noise. A query is a topic direction plus more noise, so a few hundred pages are close to it
//! and the rest share the common direction, as real text embeddings do. Run it from `rust/` with
//! `cargo run --release -p gbrain-store --example vector_scale --` followed by a mode.
//!
//! ```text
//! load    <store-dir> <pages> [chunks-per-page=2] [dims=1536]   write the corpus (no per-page fsync)
//! run     <store-dir> [queries=60] [limit=50] [filter=none]       time searchVector and the re-score
//! verify  <store-dir> [queries=40]                                bounded scan against the full scan
//! queries <out.json> [queries=60] [dims=1536]                     the `run` queries as JSON, for a
//!                                                                 timing through the TypeScript engine
//! ```
//!
//! `filter` is `none`, `small-source` (the `side` source, about 4% of pages), `large-source`
//! (`default`, about 96%), `type` (`concept` pages, about 10%) or `year` (`afterDate` one year back).
//!
//! `run` opens the store in a fresh process, makes two warm-up calls (the first builds the decoded
//! vector cache), then times every query and prints one JSON object: the machine, the data size,
//! N, and p50/p99/max in milliseconds for `searchVector`, for `cosinesByChunkIds` over the hit ids,
//! and for the two together. `GBRAIN_RUST_VECTOR_SCAN=full` makes the store take the full scan, the
//! path every call took before the bounded scan; the store reads it on every call.
//!
//! `verify` runs every query through both paths on the same store (the tool sets and removes
//! `GBRAIN_RUST_VECTOR_SCAN` in-process, one thread) for limits 1, 10, 50 and 200 crossed with
//! offsets 0 and 30, and every filter above, then four edges (limit 0, an offset past every page,
//! an infinite offset, a query of another width), and compares the full `searchVector` result
//! bytes (`serde_json` of the whole result or the refusal text). It exits 1 on any difference, or
//! when no full scan returned a row or no bounded call ran in under half the full scan's time
//! (the store does not report which path ran, so that is a timing check, not a record).

use std::fs::File;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::sources::SourceInput;
use gbrain_store::vectors::VectorSearchOptions;
use gbrain_store::{FileBackend, OpenOptions, Store, SystemEnv};
use serde_json::{Value, json};

const MODEL: &str = "text-embedding-3-large";
const TOPICS: usize = 256;
/// The source boosts the TypeScript member sends by default (`DEFAULT_SOURCE_BOOSTS`), longest
/// prefix first.
const FACTORS: &[(&str, f64)] = &[
    ("openclaw/chat/", 0.5),
    ("media/x/", 0.7),
    ("originals/", 1.5),
    ("companies/", 1.2),
    ("concepts/", 1.3),
    ("meetings/", 1.1),
    ("writing/", 1.4),
    ("archive/", 0.5),
    ("people/", 1.2),
    ("daily/", 0.8),
];
const PREFIXES: &[(&str, &str)] = &[
    ("people/", "person"),
    ("companies/", "company"),
    ("concepts/", "concept"),
    ("meetings/", "meeting"),
    ("daily/", "note"),
    ("notes/", "note"),
    ("archive/", "note"),
    ("writing/", "essay"),
    ("originals/", "essay"),
    ("media/x/", "tweet"),
];

fn die(msg: impl std::fmt::Display) -> ! {
    eprintln!("vector_scale: {msg}");
    std::process::exit(2)
}

fn status_kib(field: &str) -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with(field))
                .and_then(|l| l.split_whitespace().nth(1).and_then(|v| v.parse().ok()))
        })
        .unwrap_or(0)
}

/// The CPU model and count, for the result line.
fn machine() -> Value {
    let cpu = std::fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("model name"))
                .and_then(|l| l.split_once(':').map(|(_, v)| v.trim().to_string()))
        })
        .unwrap_or_else(|| "unknown".to_string());
    let cores = std::thread::available_parallelism().map_or(0, |n| n.get());
    let mem_kib = std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|s| {
            s.lines().find(|l| l.starts_with("MemTotal")).and_then(|l| {
                l.split_whitespace()
                    .nth(1)
                    .and_then(|v| v.parse::<u64>().ok())
            })
        })
        .unwrap_or(0);
    json!({"cpu": cpu, "cores": cores, "mem_gib": mem_kib / (1024 * 1024)})
}

// ---------------------------------------------------------------- vectors

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // splitmix64
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn unit(&mut self) -> f64 {
        ((self.next() >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }
    fn gauss(&mut self) -> f64 {
        let (u, v) = (self.unit(), self.unit());
        (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn direction(seed: u64, dims: usize) -> Vec<f64> {
    let mut rng = Rng(seed);
    (0..dims).map(|_| rng.gauss()).collect()
}

/// `common * 0.5 + topic * 0.8 + noise * spread`, as float32.
fn mix(common: &[f64], topic: &[f64], rng: &mut Rng, spread: f64) -> Vec<f32> {
    common
        .iter()
        .zip(topic)
        .map(|(c, t)| (0.5 * c + 0.8 * t + spread * rng.gauss()) as f32)
        .collect()
}

struct Dirs {
    common: Vec<f64>,
    topics: Vec<Vec<f64>>,
}

fn dirs(dims: usize) -> Dirs {
    Dirs {
        common: direction(1, dims),
        topics: (0..TOPICS)
            .map(|t| direction(1000 + t as u64, dims))
            .collect(),
    }
}

/// Query `i`: a topic direction with more noise than a stored chunk has.
fn query(d: &Dirs, i: u64) -> Vec<f64> {
    let mut rng = Rng(0xABCD_0000 + i);
    let topic = &d.topics[rng.below(TOPICS as u64) as usize];
    mix(&d.common, topic, &mut rng, 0.9)
        .into_iter()
        .map(f64::from)
        .collect()
}

// ---------------------------------------------------------------- load

/// A record file whose `sync` does nothing; the loader syncs once at the end.
#[derive(Debug)]
struct NoSyncFile(Arc<File>);

impl FileBackend for NoSyncFile {
    fn size(&self) -> std::io::Result<u64> {
        Ok(self.0.metadata()?.len())
    }
    fn read_at(&self, offset: u64, out: &mut [u8]) -> std::io::Result<()> {
        read_exact_at(&self.0, out, offset)
    }
    fn write_at(&self, offset: u64, data: &[u8]) -> std::io::Result<()> {
        write_all_at(&self.0, data, offset)
    }
    fn set_len(&self, len: u64) -> std::io::Result<()> {
        self.0.set_len(len)
    }
    fn sync(&self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(unix)]
fn read_exact_at(file: &File, out: &mut [u8], offset: u64) -> std::io::Result<()> {
    std::os::unix::fs::FileExt::read_exact_at(file, out, offset)
}

#[cfg(unix)]
fn write_all_at(file: &File, data: &[u8], offset: u64) -> std::io::Result<()> {
    std::os::unix::fs::FileExt::write_all_at(file, data, offset)
}

// Windows has no `read_exact_at`; `seek_read` and `seek_write` may transfer less than asked, so loop.
#[cfg(windows)]
fn read_exact_at(file: &File, mut out: &mut [u8], mut offset: u64) -> std::io::Result<()> {
    while !out.is_empty() {
        match std::os::windows::fs::FileExt::seek_read(file, out, offset)? {
            0 => return Err(std::io::ErrorKind::UnexpectedEof.into()),
            n => {
                out = &mut out[n..];
                offset += n as u64;
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn write_all_at(file: &File, mut data: &[u8], mut offset: u64) -> std::io::Result<()> {
    while !data.is_empty() {
        match std::os::windows::fs::FileExt::seek_write(file, data, offset)? {
            0 => return Err(std::io::ErrorKind::WriteZero.into()),
            n => {
                data = &data[n..];
                offset += n as u64;
            }
        }
    }
    Ok(())
}

fn body(rng: &mut Rng, words: usize) -> String {
    const WORDS: &[&str] = &[
        "founder",
        "market",
        "growth",
        "product",
        "revenue",
        "team",
        "hiring",
        "seed",
        "series",
        "customer",
        "launch",
        "pricing",
        "retention",
        "platform",
        "agent",
        "memory",
        "search",
        "brain",
        "meeting",
        "notes",
        "investor",
        "roadmap",
        "design",
        "engine",
        "vector",
    ];
    (0..words)
        .map(|_| WORDS[rng.below(WORDS.len() as u64) as usize])
        .collect::<Vec<_>>()
        .join(" ")
}

fn load(dir: &Path, pages: u64, per_page: u32, dims: usize) {
    // The loader skips every fsync, so it only ever writes a brain it creates: refuse a directory
    // that already holds anything before writing a byte.
    if std::fs::read_dir(dir).is_ok_and(|mut entries| entries.next().is_some()) {
        die(format!(
            "{}: not empty; load writes only a new brain",
            dir.display()
        ));
    }
    std::fs::create_dir_all(dir).unwrap_or_else(|e| die(e));
    let file = Arc::new(
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(dir.join("records.redb"))
            .unwrap_or_else(|e| die(format!("{}: {e}", dir.display()))),
    );
    if let Err(e) = file.try_lock() {
        die(format!(
            "{}: another handle holds this brain ({e})",
            dir.display()
        ));
    }
    let kv = RedbKv::open_backend(Box::new(NoSyncFile(file.clone()))).unwrap_or_else(|e| die(e));
    let store = Store::open_kv(Arc::new(kv), Arc::new(SystemEnv), OpenOptions::default())
        .unwrap_or_else(|e| die(e));
    store
        .upsert_source(&SourceInput {
            id: "side".to_string(),
            ..SourceInput::default()
        })
        .unwrap_or_else(|e| die(e));
    store
        .set_config("embedding_dimensions", &dims.to_string())
        .unwrap_or_else(|e| die(e));
    let d = dirs(dims);
    let start = Instant::now();
    let mut chunks = 0u64;
    for i in 0..pages {
        let mut rng = Rng(0x5EED_0000 + i);
        let (prefix, page_type) = PREFIXES[rng.below(PREFIXES.len() as u64) as usize];
        let source = if rng.below(25) == 0 {
            "side"
        } else {
            "default"
        };
        let slug = format!("{prefix}page-{i}");
        let topic = rng.below(TOPICS as u64) as usize;
        // About a year and a half of dates, so a one-year window keeps part of the brain.
        let day = rng.below(690);
        let date = format!(
            "{}-{:02}-{:02}",
            2025 + day / 360,
            1 + (day % 360) / 30,
            1 + day % 28
        );
        let page: PageInput = serde_json::from_value(json!({
            "type": page_type,
            "title": format!("Page {i} about topic {topic}"),
            "compiled_truth": body(&mut rng, 220),
            "timeline": "",
            "frontmatter": {"topic": topic, "date": date, "tags": ["bench", format!("t{}", topic % 7)]},
        }))
        .unwrap();
        let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
        store
            .put_page(&slug, &page, &opts)
            .unwrap_or_else(|e| die(format!("page {i}: {e}")));
        let n = 1 + rng.below(u64::from(per_page) * 2 - 1) as u32;
        let inputs: Vec<ChunkInput> = (0..n)
            .map(|c| {
                let v = mix(&d.common, &d.topics[topic], &mut rng, 0.6);
                serde_json::from_value(json!({
                    "chunk_index": c,
                    "chunk_text": body(&mut rng, 80),
                    "chunk_source": if c == 0 { "compiled_truth" } else { "timeline" },
                    "embedding": v,
                    "model": MODEL,
                }))
                .unwrap()
            })
            .collect();
        chunks += u64::from(n);
        let up: UpsertChunksOptions =
            serde_json::from_value(json!({"sourceId": source, "seal": true})).unwrap();
        store
            .upsert_chunks(&slug, &inputs, &up)
            .unwrap_or_else(|e| die(format!("chunks {i}: {e}")));
        if (i + 1) % 5000 == 0 {
            eprintln!(
                "loaded {} pages in {:.1}s",
                i + 1,
                start.elapsed().as_secs_f64()
            );
        }
    }
    drop(store);
    file.sync_all().unwrap();
    println!(
        "{}",
        json!({"pages": pages, "chunks": chunks, "dims": dims,
               "load_secs": start.elapsed().as_secs_f64(), "peak_rss_kib": status_kib("VmHWM")})
    );
}

// ---------------------------------------------------------------- queries

fn options(filter: &str, limit: u64, offset: u64) -> VectorSearchOptions {
    let factors: Vec<Value> = FACTORS.iter().map(|(p, f)| json!([p, f])).collect();
    let mut o = json!({
        "limit": limit, "offset": offset, "model": MODEL, "source_factors": factors,
    });
    match filter {
        "none" => {}
        "small-source" => o["source_ids"] = json!(["side"]),
        "large-source" => o["source_ids"] = json!(["default"]),
        "type" => o["types"] = json!(["concept"]),
        "year" => {
            // A page is dated by its `effective_date` (the frontmatter `date`), else `updated_at`.
            let now_us = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_micros() as i64;
            o["after_date"] =
                json!({"micros": (now_us - 365 * 86_400_000_000).to_string(), "inclusive": false});
        }
        other => die(format!("unknown filter {other}")),
    }
    serde_json::from_value(o).unwrap_or_else(|e| die(format!("options: {e}")))
}

fn open(dir: &Path) -> Store {
    Store::open_dir_read_only(dir).unwrap_or_else(|e| die(e))
}

fn counts(store: &Store) -> (u64, u64) {
    let stats = store
        .get_stats(&gbrain_store::stats::ScopeInput::default())
        .unwrap_or_else(|e| die(e));
    (
        stats["page_count"].as_u64().unwrap_or(0),
        stats["chunk_count"].as_u64().unwrap_or(0),
    )
}

fn pct(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

fn summary(mut ms: Vec<f64>) -> Value {
    ms.sort_by(f64::total_cmp);
    json!({"p50": pct(&ms, 50.0), "p99": pct(&ms, 99.0), "max": ms.last().copied().unwrap_or(0.0)})
}

fn run(dir: &Path, n: u64, limit: u64, filter: &str) {
    let open_start = Instant::now();
    let store = open(dir);
    let open_ms = open_start.elapsed().as_secs_f64() * 1e3;
    let (pages, chunks) = counts(&store);
    let dims = store
        .get_config("embedding_dimensions")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1536);
    let d = dirs(dims);
    let opts = options(filter, limit, 0);
    let first = Instant::now();
    store
        .search_vector(&query(&d, 9_999), &opts)
        .unwrap_or_else(|e| die(e));
    let first_ms = first.elapsed().as_secs_f64() * 1e3;
    store
        .search_vector(&query(&d, 9_998), &opts)
        .unwrap_or_else(|e| die(e));
    let (mut search, mut rescore, mut both) = (Vec::new(), Vec::new(), Vec::new());
    let mut rows_seen = 0usize;
    for i in 0..n {
        let q = query(&d, i);
        let t = Instant::now();
        let rows = store.search_vector(&q, &opts).unwrap_or_else(|e| die(e));
        let s = t.elapsed().as_secs_f64() * 1e3;
        let ids: Vec<u64> = rows.iter().filter_map(|r| r["chunk_id"].as_u64()).collect();
        let t = Instant::now();
        store
            .cosines_by_chunk_ids(&ids, &q)
            .unwrap_or_else(|e| die(e));
        let r = t.elapsed().as_secs_f64() * 1e3;
        rows_seen += rows.len();
        search.push(s);
        rescore.push(r);
        both.push(s + r);
    }
    let scan = std::env::var("GBRAIN_RUST_VECTOR_SCAN").unwrap_or_else(|_| "default".into());
    println!(
        "{}",
        json!({
            "machine": machine(), "pages": pages, "chunks": chunks, "dims": dims,
            "filter": filter, "limit": limit, "n": n, "scan": scan,
            "open_ms": open_ms, "first_call_ms": first_ms,
            "avg_rows": rows_seen as f64 / n.max(1) as f64,
            "search_vector_ms": summary(search), "cosines_ms": summary(rescore),
            "together_ms": summary(both), "peak_rss_kib": status_kib("VmHWM"),
        })
    );
}

// ---------------------------------------------------------------- verify

fn with_full_scan<T>(f: impl FnOnce() -> T) -> T {
    // SAFETY: the tool runs on one thread and no other thread reads the environment.
    unsafe { std::env::set_var("GBRAIN_RUST_VECTOR_SCAN", "full") };
    let out = f();
    unsafe { std::env::remove_var("GBRAIN_RUST_VECTOR_SCAN") };
    out
}

fn verify(dir: &Path, n: u64) {
    if std::env::var_os("GBRAIN_RUST_VECTOR_SCAN").is_some() {
        die("unset GBRAIN_RUST_VECTOR_SCAN before verify");
    }
    if n == 0 {
        die("verify needs at least one query");
    }
    let store = open(dir);
    let dims = store
        .get_config("embedding_dimensions")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1536);
    let d = dirs(dims);
    let (mut compared, mut mismatches) = (0u64, Vec::new());
    let (mut fast_ms, mut full_ms) = (0f64, 0f64);
    // Positive controls: cases whose full scan returned rows, and cases with rows where the bounded
    // call took under half the full scan's time (a timing sign the bounded path ran; the store
    // reports no path, so the unit test `the_bounded_scan_reads_only_the_pages_that_can_rank`
    // is the deterministic check).
    let (mut nonempty, mut faster) = (0u64, 0u64);
    let mut compare = |filter: &str,
                       limit: Value,
                       offset: Value,
                       i: u64,
                       q: &[f64],
                       opts: &VectorSearchOptions| {
        let t = Instant::now();
        let fast = store.search_vector(q, opts).map_err(|e| e.to_string());
        let fast_t = t.elapsed().as_secs_f64() * 1e3;
        let t = Instant::now();
        let full = with_full_scan(|| store.search_vector(q, opts).map_err(|e| e.to_string()));
        let full_t = t.elapsed().as_secs_f64() * 1e3;
        fast_ms += fast_t;
        full_ms += full_t;
        compared += 1;
        let rows = full.as_ref().is_ok_and(|rows| !rows.is_empty());
        nonempty += u64::from(rows);
        // Only a case with rows counts: a limit-0 call or a refusal is fast on both paths.
        faster += u64::from(rows && fast_t * 2.0 < full_t);
        let a = serde_json::to_string(&fast).unwrap();
        let b = serde_json::to_string(&full).unwrap();
        if a != b {
            let at = a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count();
            mismatches.push(json!({
                "filter": filter, "limit": limit, "offset": offset, "query": i,
                "first_difference_at": at,
                "bounded": a.get(at.saturating_sub(80)..(at + 80).min(a.len())),
                "full": b.get(at.saturating_sub(80)..(at + 80).min(b.len())),
            }));
        }
    };
    for filter in ["none", "small-source", "large-source", "type", "year"] {
        for limit in [1u64, 10, 50, 200] {
            for offset in [0u64, 30] {
                let opts = options(filter, limit, offset);
                for i in 0..n {
                    let q = query(&d, 50_000 + i);
                    compare(filter, json!(limit), json!(offset), i, &q, &opts);
                }
            }
        }
    }
    // Edges: no rows asked for, an offset past every page, an infinite offset, and a query of
    // another width (both paths must refuse it the same way).
    let edges: [(Value, Value, usize); 4] = [
        (json!(0), json!(0), dims),
        (json!(20), json!(10_000_000), dims),
        (json!(20), json!("Infinity"), dims),
        (json!(20), json!(0), dims + 1),
    ];
    for (limit, offset, width) in edges {
        let mut o = serde_json::to_value(json!({"limit": limit, "offset": offset, "model": MODEL}))
            .unwrap();
        o["source_factors"] = json!(
            FACTORS
                .iter()
                .map(|(p, f)| json!([p, f]))
                .collect::<Vec<_>>()
        );
        let opts: VectorSearchOptions = serde_json::from_value(o).unwrap();
        let mut q = query(&d, 77);
        q.resize(width, 0.25);
        compare("edge", limit, offset, 77, &q, &opts);
    }
    let ok = mismatches.is_empty() && nonempty > 0 && faster > 0;
    println!(
        "{}",
        json!({"compared": compared, "mismatch_count": mismatches.len(),
               "nonempty_full_results": nonempty, "bounded_under_half_full_time": faster,
               "mismatches": mismatches.iter().take(10).collect::<Vec<_>>(),
               "bounded_ms_total": fast_ms, "full_ms_total": full_ms})
    );
    if !ok {
        std::process::exit(1);
    }
}

fn write_queries(out: &Path, n: u64, dims: usize) {
    let d = dirs(dims);
    let all: Vec<Vec<f64>> = (0..n).map(|i| query(&d, i)).collect();
    std::fs::write(out, serde_json::to_vec(&all).unwrap()).unwrap_or_else(|e| die(e));
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |i: usize| args.get(i).map(String::as_str);
    let num = |i: usize, default: u64| {
        arg(i).map_or(default, |v| {
            v.parse()
                .unwrap_or_else(|_| die(format!("not a number: {v}")))
        })
    };
    match (arg(0), arg(1)) {
        (Some("load"), Some(dir)) => load(
            Path::new(dir),
            num(2, 10_000),
            num(3, 2) as u32,
            num(4, 1536) as usize,
        ),
        (Some("run"), Some(dir)) => run(
            Path::new(dir),
            num(2, 60),
            num(3, 50),
            arg(4).unwrap_or("none"),
        ),
        (Some("verify"), Some(dir)) => verify(Path::new(dir), num(2, 40)),
        (Some("queries"), Some(out)) => {
            write_queries(Path::new(out), num(2, 60), num(3, 1536) as usize)
        }
        _ => die(
            "usage: load <dir> <pages> [chunks-per-page] [dims] | run <dir> [queries] [limit] [filter] | verify <dir> [queries] | queries <out.json> [queries] [dims]",
        ),
    }
}
