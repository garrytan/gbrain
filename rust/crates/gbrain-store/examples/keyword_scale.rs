//! Keyword-search scale measurement (row 4 of docs/designs/RUST_ENGINE.md, "Open before
//! `rust` can be selected"): how long each keyword member takes, and how much memory it needs, on
//! a brain the size the bake-off uses (50,000 pages, 200,000 chunks).
//!
//! It is a measurement tool only: it reads a bake-off corpus (`pages.jsonl`, `chunks.jsonl`),
//! loads it into an on-disk store through the public API (`put_page` with the page's chunks, one
//! transaction per page, as an import does), and times each member through the public API.
//!
//! ```text
//! cargo run --release --example keyword_scale -- load    <corpus-dir> <store-dir> [nosync]
//! cargo run --release --example keyword_scale -- queries <corpus-dir> <queries.json>
//! cargo run --release --example keyword_scale -- run     <store-dir> <queries.json> <member> [budget-secs] [passes]
//! ```
//!
//! `load ... nosync` loads through a file backend whose `sync` is a no-op until the end (one
//! `sync_all` after the last page), because a durable commit per page grows from 53 ms to over
//! 80 ms per page on this machine and would take hours at 50,000 pages. The file written is the
//! same redb file; only the load time is not that of a durable import.
//!
//! `run` opens the store in a fresh process (so its first call is the cold call), makes one
//! warm-up call, then times every query for each pass, and prints one JSON object (times in
//! milliseconds, `peak_rss_kib` from `VmHWM`). Members: `arm`, `chunks`, `pages_count`,
//! `pages_search`, `titles` (a Whole then a Title attempt), `titles_complete`, `fuzzy`.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use gbrain_store::chunks::ChunkInput;
use gbrain_store::keyword::{KeywordOptions, TitleAttempt, TitleAttemptKind};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::sources::SourceInput;
use gbrain_store::{FileBackend, OpenOptions, Store, SystemEnv};
use serde_json::{Value, json};

fn die(msg: impl std::fmt::Display) -> ! {
    eprintln!("keyword_scale: {msg}");
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

fn lines(path: &Path) -> impl Iterator<Item = Value> + use<> {
    let file = File::open(path).unwrap_or_else(|e| die(format!("{}: {e}", path.display())));
    BufReader::with_capacity(1 << 20, file)
        .lines()
        .map(|l| serde_json::from_str(&l.unwrap()).unwrap_or_else(|e| die(e)))
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
        self.0.read_exact_at(out, offset)
    }
    fn write_at(&self, offset: u64, data: &[u8]) -> std::io::Result<()> {
        self.0.write_all_at(data, offset)
    }
    fn set_len(&self, len: u64) -> std::io::Result<()> {
        self.0.set_len(len)
    }
    fn sync(&self) -> std::io::Result<()> {
        Ok(())
    }
}

fn load(corpus: &Path, dir: &Path, nosync: bool) {
    let mut final_sync: Option<Arc<File>> = None;
    let store = if nosync {
        std::fs::create_dir_all(dir).unwrap();
        let file = Arc::new(
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(dir.join("records.redb"))
                .unwrap_or_else(|e| die(e)),
        );
        final_sync = Some(file.clone());
        let kv = RedbKv::open_backend(Box::new(NoSyncFile(file))).unwrap_or_else(|e| die(e));
        Store::open_kv(Arc::new(kv), Arc::new(SystemEnv), OpenOptions::default())
            .unwrap_or_else(|e| die(e))
    } else {
        Store::open_dir(dir, OpenOptions::default()).unwrap_or_else(|e| die(e))
    };
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(corpus.join("manifest.json")).unwrap())
            .unwrap();
    for source in manifest["sources"].as_array().unwrap() {
        let id = source.as_str().unwrap();
        if id != "default" {
            store
                .upsert_source(&SourceInput {
                    id: id.to_string(),
                    ..SourceInput::default()
                })
                .unwrap_or_else(|e| die(e));
        }
    }
    let start = Instant::now();
    let mut chunk_rows = lines(&corpus.join("chunks.jsonl")).peekable();
    let (mut pages, mut chunks) = (0u64, 0u64);
    for row in lines(&corpus.join("pages.jsonl")) {
        let i = row["i"].as_u64().unwrap();
        let mut inputs = Vec::new();
        while chunk_rows
            .peek()
            .is_some_and(|c| c["page"].as_u64() == Some(i))
        {
            let c = chunk_rows.next().unwrap();
            inputs.push(ChunkInput {
                chunk_index: c["idx"].as_u64().unwrap() as u32,
                chunk_text: c["text"].as_str().unwrap().to_string(),
                chunk_source: Some("compiled_truth".to_string()),
                modality: Some("text".to_string()),
                ..ChunkInput::default()
            });
        }
        chunks += inputs.len() as u64;
        let page = PageInput {
            page_type: row["type"].as_str().unwrap().to_string(),
            title: row["title"].as_str().unwrap().to_string(),
            compiled_truth: row["body"].as_str().unwrap().to_string(),
            timeline: Some(String::new()),
            frontmatter: row["frontmatter"].as_object().cloned(),
            ..PageInput::default()
        };
        let options = PutPageOptions {
            source_id: Some(row["source_id"].as_str().unwrap().to_string()),
            chunks: Some(inputs),
            ..PutPageOptions::default()
        };
        store
            .put_page(row["slug"].as_str().unwrap(), &page, &options)
            .unwrap_or_else(|e| die(format!("page {i}: {e}")));
        pages += 1;
        if pages % 5000 == 0 {
            eprintln!(
                "loaded {pages} pages in {:.1}s",
                start.elapsed().as_secs_f64()
            );
        }
    }
    drop(store);
    if let Some(file) = final_sync {
        file.sync_all().unwrap();
    }
    let secs = start.elapsed().as_secs_f64();
    println!(
        "{}",
        json!({"pages": pages, "chunks": chunks, "load_secs": secs, "nosync": nosync,
               "peak_rss_kib": status_kib("VmHWM")})
    );
}

// ---------------------------------------------------------------- queries

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

const STOP: &[&str] = &[
    "the", "and", "was", "for", "that", "with", "his", "her", "its", "are", "from", "has", "had",
    "were", "this", "which", "but", "not", "been", "also", "their", "who", "one", "after", "into",
    "than", "they", "have", "she", "can", "other", "such", "when", "more", "most", "all", "three",
    "two", "while", "where", "these", "then", "there", "about", "over", "between", "during",
    "first", "new", "out", "under", "only", "many", "some", "him", "would", "later", "both",
];

fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 3)
        .map(|w| w.to_lowercase())
        .collect()
}

/// 30 queries over `docs`: 10 single common words, 6 pairs and 4 triples of common words, 3
/// mid-frequency words, 3 rare words, 4 quoted phrases of consecutive words of a real document.
fn make_queries(docs: &[String], seed: u64) -> Vec<Value> {
    let mut rng = Rng(seed);
    let mut df: HashMap<String, u32> = HashMap::new();
    for d in docs {
        let mut ws = words(d);
        ws.sort();
        ws.dedup();
        for w in ws {
            *df.entry(w).or_default() += 1;
        }
    }
    let mut ranked: Vec<(&String, u32)> = df
        .iter()
        .filter(|(w, _)| !STOP.contains(&w.as_str()) && w.chars().all(|c| c.is_alphabetic()))
        .map(|(w, n)| (w, *n))
        .collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    let common: Vec<&String> = ranked.iter().skip(10).take(200).map(|r| r.0).collect();
    let n = docs.len() as u32;
    let mid: Vec<&String> = ranked
        .iter()
        .filter(|r| r.1 >= (n / 400).max(5) && r.1 <= (n / 40).max(10))
        .map(|r| r.0)
        .collect();
    let rare: Vec<&String> = ranked
        .iter()
        .filter(|r| r.1 <= 3 && r.0.len() >= 6)
        .map(|r| r.0)
        .collect();
    let mut out = Vec::new();
    let mut add = |kind: &str, text: String| out.push(json!({"kind": kind, "text": text}));
    for _ in 0..10 {
        add("common1", common[rng.below(common.len())].clone());
    }
    for _ in 0..6 {
        add(
            "common2",
            format!(
                "{} {}",
                common[rng.below(common.len())],
                common[rng.below(common.len())]
            ),
        );
    }
    for _ in 0..4 {
        add(
            "common3",
            format!(
                "{} {} {}",
                common[rng.below(common.len())],
                common[rng.below(common.len())],
                common[rng.below(common.len())]
            ),
        );
    }
    for _ in 0..3 {
        add("mid1", mid[rng.below(mid.len())].clone());
    }
    for _ in 0..3 {
        add("rare1", rare[rng.below(rare.len())].clone());
    }
    for _ in 0..4 {
        loop {
            let ws = words(&docs[rng.below(docs.len())]);
            if ws.len() < 8 {
                continue;
            }
            let at = rng.below(ws.len() - 3);
            let phrase = ws[at..at + 3].join(" ");
            if ws[at..at + 3].iter().any(|w| STOP.contains(&w.as_str())) {
                continue;
            }
            add("phrase3", format!("\"{phrase}\""));
            break;
        }
    }
    out
}

fn make_queries_file(corpus: &Path, file: &Path) {
    let chunks: Vec<String> = lines(&corpus.join("chunks.jsonl"))
        .map(|c| c["text"].as_str().unwrap().to_string())
        .collect();
    let mut titles = Vec::new();
    for p in lines(&corpus.join("pages.jsonl")) {
        titles.push((
            p["title"].as_str().unwrap().to_string(),
            p["source_id"].as_str().unwrap().to_string(),
        ));
    }
    let title_docs: Vec<String> = titles.iter().map(|t| t.0.clone()).collect();
    // Fuzzy names: 10 exact titles, 20 titles with one character dropped or two swapped, and 5
    // names that match nothing.
    let mut rng = Rng(7);
    let mut fuzzy = Vec::new();
    for k in 0..30 {
        let t = &titles[rng.below(titles.len())].0;
        let mut cs: Vec<char> = t.chars().collect();
        if k >= 10 && cs.len() > 4 {
            let at = rng.below(cs.len() - 2) + 1;
            if k % 2 == 0 {
                cs.remove(at);
            } else {
                cs.swap(at, at + 1);
            }
        }
        let scoped = k % 3 == 0;
        fuzzy.push(json!({"name": cs.into_iter().collect::<String>(), "scoped": scoped}));
    }
    for name in [
        "zzqxv unlisted",
        "qwerty asdf zxcv",
        "nonexistent entity name",
        "xylophone ranger",
        "lorem ipsum dolor",
    ] {
        fuzzy.push(json!({"name": name, "scoped": false}));
    }
    let doc = json!({
        "body": make_queries(&chunks, 1),
        "title": make_queries(&title_docs, 2),
        "fuzzy": fuzzy,
    });
    std::fs::write(file, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
}

// ---------------------------------------------------------------- run

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

fn run(dir: &Path, queries_file: &Path, member: &str, budget_secs: f64, passes: usize) {
    let queries: Value =
        serde_json::from_str(&std::fs::read_to_string(queries_file).unwrap()).unwrap();
    let t = Instant::now();
    let store = Store::open_dir(dir, OpenOptions::default()).unwrap_or_else(|e| die(e));
    let open_ms = ms(t);
    let rss_after_open = status_kib("VmRSS");
    let title_member = member.starts_with("titles");
    let set = match member {
        "fuzzy" => "fuzzy",
        _ if title_member => "title",
        _ => "body",
    };
    let items: Vec<Value> = queries[set].as_array().unwrap().clone();
    let base = KeywordOptions {
        limit: Some(20.0),
        ..KeywordOptions::default()
    };
    // One call; returns a result size so the work cannot be elided and the query is seen to hit.
    let call = |q: &Value| -> usize {
        let text = q["text"].as_str().unwrap_or("");
        let phrase = q["kind"] == "phrase3";
        let opts = KeywordOptions {
            phrase,
            ..base.clone()
        };
        match member {
            "arm" => store
                .search_keyword_arm(text, text, &opts)
                .unwrap_or_else(|e| die(e))
                .len(),
            "chunks" => store
                .search_keyword_chunks(text, &opts)
                .unwrap_or_else(|e| die(e))
                .len(),
            "pages_count" => store
                .count_keyword_pages(text, &opts)
                .unwrap_or_else(|e| die(e)) as usize,
            "pages_search" => store
                .search_keyword_pages(text, &opts)
                .unwrap_or_else(|e| die(e))
                .len(),
            "titles" | "titles_complete" => {
                let kinds: &[TitleAttemptKind] = if member == "titles" {
                    &[TitleAttemptKind::Whole, TitleAttemptKind::Title]
                } else {
                    &[TitleAttemptKind::Complete]
                };
                let attempts: Vec<TitleAttempt> = kinds
                    .iter()
                    .map(|k| TitleAttempt {
                        texts: vec![text.to_string()],
                        kind: *k,
                        limit: 20.0,
                        offset: 0.0,
                    })
                    .collect();
                let out = store
                    .search_titles_attempts(&attempts, &text.to_lowercase(), 5000.0, &opts)
                    .unwrap_or_else(|e| die(e));
                out.iter()
                    .map(|a| a["rows"].as_array().map_or(0, Vec::len))
                    .sum()
            }
            "fuzzy" => {
                let scoped = q["scoped"].as_bool().unwrap_or(false);
                let r = store
                    .find_by_title_fuzzy(
                        q["name"].as_str().unwrap(),
                        scoped.then_some("wiki"),
                        None,
                        scoped.then_some("default"),
                    )
                    .unwrap_or_else(|e| die(e));
                usize::from(!r.is_null())
            }
            other => die(format!("unknown member {other}")),
        }
    };
    let query_of = |v: &Value| -> Value {
        if set == "fuzzy" {
            json!({"text": v["name"], "scoped": v["scoped"], "kind": "fuzzy"})
        } else {
            v.clone()
        }
    };
    let items: Vec<Value> = items.iter().map(query_of).collect();
    let call = |q: &Value| {
        if set == "fuzzy" {
            let q = json!({"name": q["text"], "scoped": q["scoped"]});
            call(&q)
        } else {
            call(q)
        }
    };

    // Cold: the first call after opening the store, in this process.
    let t = Instant::now();
    let cold_hits = call(&items[0]);
    let cold_ms = ms(t);
    let rss_after_cold = status_kib("VmRSS");
    // One warm-up call, not counted.
    let t = Instant::now();
    call(&items[0]);
    let warmup_ms = ms(t);

    let started = Instant::now();
    let mut pass_out = Vec::new();
    'passes: for pass in 0..passes {
        let mut times = Vec::new();
        let mut per_query = Vec::new();
        for q in &items {
            if started.elapsed().as_secs_f64() > budget_secs {
                pass_out.push(json!({"pass": pass + 1, "stopped_by_budget": true,
                                     "measured": times.len(), "times_ms": times}));
                break 'passes;
            }
            let t = Instant::now();
            let hits = call(q);
            let d = ms(t);
            times.push(d);
            per_query.push(json!({"text": q["text"], "kind": q["kind"], "hits": hits, "ms": d}));
        }
        let mut sorted = times.clone();
        sorted.sort_by(f64::total_cmp);
        pass_out.push(json!({
            "pass": pass + 1, "measured": times.len(),
            "p50_ms": percentile(&sorted, 50.0), "p99_ms": percentile(&sorted, 99.0),
            "min_ms": sorted.first(), "max_ms": sorted.last(),
            "mean_ms": times.iter().sum::<f64>() / times.len() as f64,
            "per_query": per_query,
        }));
    }
    println!(
        "{}",
        json!({
            "member": member, "queries": items.len(), "open_ms": open_ms,
            "rss_after_open_kib": rss_after_open, "rss_after_cold_kib": rss_after_cold,
            "cold_ms": cold_ms, "cold_hits": cold_hits, "warmup_ms": warmup_ms,
            "passes": pass_out, "peak_rss_kib": status_kib("VmHWM"),
        })
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let a = |i: usize| -> &str {
        args.get(i)
            .map(String::as_str)
            .unwrap_or_else(|| die("missing argument; see the file header"))
    };
    match a(0) {
        "load" => load(
            Path::new(a(1)),
            Path::new(a(2)),
            args.get(3).is_some_and(|v| v == "nosync"),
        ),
        "queries" => make_queries_file(Path::new(a(1)), Path::new(a(2))),
        "run" => run(
            Path::new(a(1)),
            Path::new(a(2)),
            a(3),
            args.get(4).and_then(|v| v.parse().ok()).unwrap_or(900.0),
            args.get(5).and_then(|v| v.parse().ok()).unwrap_or(2),
        ),
        _ => die("mode is load, queries or run"),
    }
}
