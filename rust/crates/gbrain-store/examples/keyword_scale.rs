//! Keyword-search scale measurement (row 4 of docs/designs/RUST_ENGINE.md, "Open before
//! `rust` can be selected", and step 12 of docs/plans/rust-keyword-index.md): how long each keyword
//! member takes, how much memory and disk the keyword index needs, and whether the index answers
//! exactly what the scan answers, on a brain the size the bake-off uses (50,000 pages, 200,000
//! chunks).
//!
//! It is a measurement tool only. It reads a bake-off corpus (`pages.jsonl`, `chunks.jsonl`),
//! loads it into an on-disk store through the public API (`put_page` with the page's chunks, one
//! transaction per page, as an import does), and times or checks each member through the public
//! API. Run it from `rust/` with `cargo run --release -p gbrain-store --example keyword_scale -- `
//! followed by a mode (never `cargo test --release`: one test checks a `debug_assert`).
//!
//! ```text
//! load        <corpus-dir> <store-dir> [nosync]       load the corpus into a new store
//! queries     <corpus-dir> <queries.json>             write the query file (30 body, 30 title, 35 fuzzy)
//! build       <store-dir>                             open (the format 4 upgrade runs), wait for the
//!                                                     background index build; open and build ms, sizes, RSS
//! run         <store-dir> <queries.json> <member> [budget-secs=900] [passes=2]
//!                                                     time one member in this fresh process
//! index-check <store-dir>                             stored postings against a rebuild (opens read-only)
//! verify      <store-dir> <queries.json> <corpus-dir> [fixtures]
//!                                                     untimed: every query through the index and the
//!                                                     forced scan, full result bytes compared
//! sizes       <store-dir>                             key and value bytes per key family, one snapshot (read-only)
//! compact     <store-dir>                             redb compact in place (run on a copy)
//! not-only    <store-dir> <queries.json> [passes=1]   NOT-only fallback latency (the scan's time)
//! writes      <store-dir> <queries.json> <corpus-dir> [pages=200]
//!                                                     durable put_page and concurrent-writer sample
//!                                                     (writes into the store: run on a copy)
//! ```
//!
//! Members for `run`: `arm`, `chunks`, `pages_count`, `pages_search`, `titles` (a Whole then a
//! Title attempt), `titles_complete`, `fuzzy`.
//!
//! # Rerun recipe (the 200k numbers of rust/docs/store/keyword.md)
//!
//! ```text
//! # 1. The corpus (needs python3 with pyarrow and numpy; the download steps are in the script's
//! #    docstring, and rust/bench/corpus/PROVENANCE.md names the dataset and its licence):
//! python3 rust/bench/corpus/dbpedia.py --parquet-dir <dir with 0..5.parquet> --out <bench>/corpus-200k --chunks 200000
//! K="cargo run --release -p gbrain-store --example keyword_scale --"      # from rust/
//! # 2. Load without per-page fsync, and write the queries:
//! $K load <bench>/corpus-200k <bench>/store-200k nosync
//! $K queries <bench>/corpus-200k <bench>/queries-200k.json
//! # 3. Upgrade to format 4 and build the index (to time the build from a format 2 or 3 store, run
//! #    this on the store as loaded; any later open finds the index complete):
//! $K build <bench>/store-200k
//! # 4. Timing: one fresh process per member, every query measured, warm pass 2 is the number:
//! for m in arm chunks pages_count pages_search titles titles_complete fuzzy; do
//!   $K run <bench>/store-200k <bench>/queries-200k.json $m 900 2 > run-$m.json
//! done
//! # 5. Correctness and sizes:
//! $K index-check <bench>/store-200k
//! $K verify <bench>/store-200k <bench>/queries-200k.json <bench>/corpus-200k   # about 35 minutes
//! $K sizes <bench>/store-200k
//! # 6. Optional: the compacted size (on a copy), NOT-only latency, durable writes (on a copy):
//! cp -r <bench>/store-200k <bench>/copy && $K compact <bench>/copy
//! $K not-only <bench>/store-200k <bench>/queries-200k.json
//! $K writes <bench>/copy <bench>/queries-200k.json <bench>/corpus-200k 200
//! ```
//!
//! The 10k quick check is the same with `--chunks 10000` and `verify` (about 25 seconds).
//!
//! `load ... nosync` loads through a file backend whose `sync` is a no-op until the end (one
//! `sync_all` after the last page), because a durable commit per page grows from 53 ms to over
//! 80 ms per page on the machine this was first measured on and would take hours at 50,000 pages. The file
//! written is the same redb file; only the load time is not that of a durable import.
//!
//! `run` opens the store in a fresh process (so its first call is the cold call), makes one
//! warm-up call, then times every query for each pass, and prints one JSON object (times in
//! milliseconds, `peak_rss_kib` from `VmHWM`). With 30 queries per member (35 for `fuzzy`) a
//! pass's p99 is its slowest query.
//!
//! # verify
//!
//! `verify` opens the store read-only, so the record file keeps every byte; the store must be
//! format 4 with a complete keyword index (run `build` first). With `fixtures` it opens the store
//! for writing instead (a format 2 or 3 store is upgraded and its index built first; it waits
//! for the build). It then runs each case twice on the same store: once with the index, once
//! with `GBRAIN_RUST_KEYWORD_SCAN=1` set for that call (the store reads it on every call; the tool
//! sets and removes it in-process, which is why it runs on one thread and the index build has
//! finished). It compares the full canonical result bytes (`serde_json` of the whole result, not a
//! count) and prints one JSON summary: `mismatch_count`, `mismatches` (group, member, query,
//! options, first differing byte and the text around it), `compared_per_member`, and per case rows
//! with both times. It exits 1 on any mismatch (or a failed comparator self-check, which shows the
//! comparison sees an extra byte and a missing row). A store error is a result too: both sides
//! must fail with the same message.
//!
//! Cases: every query of every member (`arm chunks pages_count pages_search titles
//! titles_complete fuzzy`, group `base`), then groups `scoped` (source and type filters, scoped
//! fuzzy), `windows` (1,000 chunks, every page, the arm past its first window), `hidden_window`
//! (half of a query's pages, at most 200, excluded by slug, and a hard-excluded slug prefix, so a
//! member reads far past its first window), `handles` (slug handles, handles only, a handle that
//! names no page), `disjoint` (the arm's match query differs from its rank query), `not_only`
//! and `not_only_titles` (`-word`), `not_mixed` (`word -other`), and `cap_boundary` (the title
//! members' candidate cap at one below, at and one above a query's match count; the arm's
//! candidate window around its limit). With `fixtures`, verify first writes 300 private pages and
//! 12 public pages that all carry one word, then adds group `private_saturation`: the privacy
//! filter with windows of 20 and 5 that private pages would fill. The bake-off corpus has no
//! private page, so without `fixtures` the privacy filter is not exercised; the fixture writes into
//! the store, so run it on a copy.
//!
//! What verify cannot say: the store API does not report whether the index or the scan answered a
//! call (the only hook is a unit-test one), and this tool adds none. So there is no per-query
//! "answered by" field. Each row carries `index_ms` and `scan_ms` and `index_like` (the indexed
//! call took under half the scan's time); a NOT-only query that is answered by the scan has both
//! times about equal. That is a timing inference, not a record, and the summary says so.
//!
//! `index-check` is the other check: it compares the stored postings with postings rebuilt from
//! every page (`Store::keyword_index_verify`), and says nothing about what a member returns.
//!
//! `not-only` times five NOT-only queries (four on `arm chunks pages_count pages_search`, a fifth on
//! `arm` and `pages_search`; `verify` also has three on the title members): these have no
//! candidate bound, so the members scan them.
//!
//! `writes` puts `pages` corpus pages under new slugs through `Store::open_dir` (a durable commit
//! each, not the `nosync` load), then times the 30 queries of `chunks` and of `titles` alone and in
//! whole passes while another thread keeps putting pages (until it has committed 30), and ends with
//! an `index-check`. It measures the write cost with the index in place; it has no no-index
//! baseline, because a store that tracks an index state always writes postings.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
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

/// One corpus page as `put_page` arguments: the page row and the chunk rows that follow it in
/// `chunks.jsonl` (they are in page order, so `chunk_rows` is consumed as pages are read).
fn build_put<I: Iterator<Item = Value>>(
    row: &Value,
    chunk_rows: &mut std::iter::Peekable<I>,
) -> (String, PageInput, PutPageOptions) {
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
    (row["slug"].as_str().unwrap().to_string(), page, options)
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
        // The normal open holds redb's exclusive lock on the record file, so a second writer is refused
        // (`store_locked`). This backend bypasses redb's file, so take the same kind of lock here and keep
        // it until the loader exits: a brain another handle holds is never opened for writing.
        if let Err(e) = file.try_lock() {
            die(format!(
                "{}: another handle or process already has this brain open ({e}); \
                 `nosync` loads only into a store nothing else holds",
                dir.display()
            ));
        }
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
        let (slug, page, options) = build_put(&row, &mut chunk_rows);
        chunks += options.chunks.as_ref().map_or(0, |c| c.len() as u64);
        store
            .put_page(&slug, &page, &options)
            .unwrap_or_else(|e| die(format!("page {}: {e}", row["i"])));
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
/// A kind the corpus cannot give (no word of that frequency, no document long enough for a
/// phrase) is left out with a note on stderr.
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
    // Each tier draws only when it has words, so a corpus with all of them gets the same queries
    // as before; an empty tier would otherwise divide by zero in `rng.below`.
    let rounds = |kind: &str, words: &[&String], n: usize| {
        if words.is_empty() {
            eprintln!(
                "keyword_scale: the corpus has no word for the {kind} queries; they are left out"
            );
            0
        } else {
            n
        }
    };
    let (n_common, n_mid, n_rare) = (
        rounds("common", &common, 1),
        rounds("mid1", &mid, 3),
        rounds("rare1", &rare, 3),
    );
    let mut out = Vec::new();
    let mut add = |kind: &str, text: String| out.push(json!({"kind": kind, "text": text}));
    for _ in 0..10 * n_common {
        add("common1", common[rng.below(common.len())].clone());
    }
    for _ in 0..6 * n_common {
        add(
            "common2",
            format!(
                "{} {}",
                common[rng.below(common.len())],
                common[rng.below(common.len())]
            ),
        );
    }
    for _ in 0..4 * n_common {
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
    for _ in 0..n_mid {
        add("mid1", mid[rng.below(mid.len())].clone());
    }
    for _ in 0..n_rare {
        add("rare1", rare[rng.below(rare.len())].clone());
    }
    // A phrase comes from a document of 8 or more words with three consecutive words that are
    // not stop words. Without one such document the sampling below would never end (a corpus of
    // short titles), so the phrases are left out; the check draws nothing from `rng`, so a corpus
    // that has one gets the same queries as before.
    let phrase_source = docs.iter().any(|d| {
        let ws = words(d);
        ws.len() >= 8
            && (0..ws.len() - 3)
                .any(|at| ws[at..at + 3].iter().all(|w| !STOP.contains(&w.as_str())))
    });
    if !phrase_source {
        eprintln!(
            "keyword_scale: no document has 8 or more words with three consecutive non-stop words; the queries have no phrase3 entries"
        );
    }
    for _ in 0..if phrase_source { 4 } else { 0 } {
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

/// Opens the store (the format 4 upgrade runs here) and waits for the background keyword index
/// build to complete. Prints the open time, the build time and the store size before and after.
fn build(dir: &Path) {
    let size = |d: &Path| -> u64 {
        std::fs::read_dir(d)
            .map(|it| {
                it.filter_map(|e| e.ok()?.metadata().ok())
                    .map(|m| m.len())
                    .sum()
            })
            .unwrap_or(0)
    };
    let before = size(dir);
    let t = Instant::now();
    let store = Store::open_dir(dir, OpenOptions::default()).unwrap_or_else(|e| die(e));
    let open_ms = ms(t);
    let first = store.keyword_index_state().unwrap_or_else(|e| die(e));
    let mut last_cursor = None;
    let mut samples = Vec::new();
    loop {
        let st = store.keyword_index_state().unwrap_or_else(|e| die(e));
        let Some(st) = st else {
            die("store keeps no keyword index state")
        };
        if st.complete {
            break;
        }
        if st.cursor != last_cursor {
            last_cursor = st.cursor;
            if samples.len() < 2000 {
                samples.push(json!({"ms": ms(t), "cursor": st.cursor}));
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    let build_ms = ms(t);
    let rss_peak = status_kib("VmHWM");
    drop(store);
    let after = size(dir);
    println!(
        "{}",
        json!({
            "open_ms": open_ms, "state_after_open": format!("{first:?}"),
            "build_done_ms_since_open_start": build_ms,
            "bytes_before": before, "bytes_after": after,
            "peak_rss_kib": rss_peak, "progress": samples,
        })
    );
}

/// Sums key and value bytes per key family (first key byte) in one snapshot of `records.redb`.
fn sizes(dir: &Path) {
    use gbrain_store::kv::Kv;
    let kv = gbrain_store::redb_kv::RedbReadOnlyKv::open_path(&dir.join("records.redb"))
        .unwrap_or_else(|e| die(e));
    let snap = kv.snapshot().unwrap_or_else(|e| die(e));
    let mut fam: std::collections::BTreeMap<String, (u64, u64)> = Default::default();
    snap.scan(&[], &[0xFF; 64], false, &mut |k, v| {
        let e = fam.entry((k[0] as char).to_string()).or_default();
        e.0 += 1;
        e.1 += (k.len() + v.len()) as u64;
        true
    })
    .unwrap_or_else(|e| die(e));
    println!("{}", json!(fam));
}

/// Compacts `records.redb` in place (run on a copy) and prints the file size before and after.
fn compact(dir: &Path) {
    let path = dir.join("records.redb");
    let before = std::fs::metadata(&path).unwrap().len();
    let mut db = redb::Database::open(&path).unwrap_or_else(|e| die(e));
    let t = Instant::now();
    let mut rounds = 0;
    while db.compact().unwrap_or_else(|e| die(e)) {
        rounds += 1;
    }
    drop(db);
    let after = std::fs::metadata(&path).unwrap().len();
    println!(
        "{}",
        json!({"before": before, "after": after, "rounds": rounds, "ms": ms(t)})
    );
}

/// Waits for the keyword index to be complete (the background build runs from `Store::open_dir`
/// on a format 2 or 3 store) and returns the milliseconds waited. Dies after two hours.
fn wait_index_complete(store: &Store) -> f64 {
    let t = Instant::now();
    loop {
        match store.keyword_index_state().unwrap_or_else(|e| die(e)) {
            None => die("store keeps no keyword index state"),
            Some(st) if st.complete => return ms(t),
            Some(_) if ms(t) > 7_200_000.0 => {
                die("the keyword index build did not finish in 2 hours")
            }
            Some(_) => std::thread::sleep(std::time::Duration::from_millis(250)),
        }
    }
}

/// Verifies every page's keyword postings against a rebuild (a read-only open): the `index-check`
/// mode. It checks what is stored; `verify` checks what the members answer.
fn index_check(dir: &Path) {
    let store = Store::open_dir_read_only(dir).unwrap_or_else(|e| die(e));
    let t = Instant::now();
    let r = store.keyword_index_verify(None).unwrap_or_else(|e| die(e));
    let ok = r.ok;
    println!(
        "{}",
        json!({"ms": ms(t), "report": r, "peak_rss_kib": status_kib("VmHWM")})
    );
    if !ok {
        std::process::exit(1);
    }
}

// ---------------------------------------------------------------- cases

/// One keyword call described as data, so `verify` can run it through the index and through the
/// scan and `not-only` can time it.
#[derive(Clone)]
struct Case {
    group: &'static str,
    member: &'static str,
    kind: String,
    text: String,
    /// The arm's rank query when it is not `text` (a disjoint match and rank query).
    rank: Option<String>,
    /// `KeywordOptions` as JSON (camelCase keys).
    opts: Value,
    /// `candidates_cap` of the title members.
    cap: f64,
    /// The row limit of each title attempt.
    title_limit: f64,
    /// `find_by_title_fuzzy`'s directory prefix and source.
    fuzzy_scope: Option<(&'static str, &'static str)>,
}

const BODY_MEMBERS: [&str; 4] = ["arm", "chunks", "pages_count", "pages_search"];
const TITLE_MEMBERS: [&str; 2] = ["titles", "titles_complete"];

impl Case {
    fn new(group: &'static str, member: &'static str, kind: &str, text: &str, opts: Value) -> Self {
        Case {
            group,
            member,
            kind: kind.to_string(),
            text: text.to_string(),
            rank: None,
            opts,
            cap: 5000.0,
            title_limit: 20.0,
            fuzzy_scope: None,
        }
    }
}

/// `base` with the keys of `extra` set.
fn merged(base: &Value, extra: Value) -> Value {
    let mut out = base.clone();
    for (k, v) in extra.as_object().unwrap() {
        out[k.as_str()] = v.clone();
    }
    out
}

fn base_opts(kind: &str) -> Value {
    json!({"limit": 20, "phrase": kind == "phrase3"})
}

/// Runs one case and returns its full result as JSON (a store error is the result `{"error": ..}`,
/// so both sides must also fail the same way).
fn exec(store: &Store, c: &Case) -> Value {
    let run = || -> Result<Value, String> {
        let opts: KeywordOptions =
            serde_json::from_value(c.opts.clone()).map_err(|e| format!("bad options: {e}"))?;
        let e = |e: gbrain_store::StoreError| e.to_string();
        match c.member {
            "arm" => store
                .search_keyword_arm(&c.text, c.rank.as_deref().unwrap_or(&c.text), &opts)
                .map(Value::Array)
                .map_err(e),
            "chunks" => store
                .search_keyword_chunks(&c.text, &opts)
                .map(Value::Array)
                .map_err(e),
            "pages_count" => store
                .count_keyword_pages(&c.text, &opts)
                .map(Value::from)
                .map_err(e),
            "pages_search" => store
                .search_keyword_pages(&c.text, &opts)
                .map(Value::Array)
                .map_err(e),
            "titles" | "titles_complete" => {
                let kinds: &[TitleAttemptKind] = if c.member == "titles" {
                    &[TitleAttemptKind::Whole, TitleAttemptKind::Title]
                } else {
                    &[TitleAttemptKind::Complete]
                };
                let attempts: Vec<TitleAttempt> = kinds
                    .iter()
                    .map(|k| TitleAttempt {
                        texts: vec![c.text.clone()],
                        kind: *k,
                        limit: c.title_limit,
                        offset: 0.0,
                    })
                    .collect();
                store
                    .search_titles_attempts(&attempts, &c.text.to_lowercase(), c.cap, &opts)
                    .map(Value::Array)
                    .map_err(e)
            }
            "fuzzy" => store
                .find_by_title_fuzzy(
                    &c.text,
                    c.fuzzy_scope.map(|s| s.0),
                    None,
                    c.fuzzy_scope.map(|s| s.1),
                )
                .map_err(e),
            other => Err(format!("unknown member {other}")),
        }
    };
    run().unwrap_or_else(|error| json!({ "error": error }))
}

/// The number of results in a member's answer (rows, or the count of `pages_count`).
fn hits_of(v: &Value) -> Option<u64> {
    match v {
        Value::Array(a) if a.iter().all(|x| x["rows"].is_array()) && !a.is_empty() => Some(
            a.iter()
                .map(|x| x["rows"].as_array().map_or(0, Vec::len) as u64)
                .sum(),
        ),
        Value::Array(a) => Some(a.len() as u64),
        Value::Number(n) => n.as_u64(),
        Value::Null => Some(0),
        Value::Object(o) if o.contains_key("error") => None,
        Value::Object(_) => Some(1),
        _ => None,
    }
}

/// The (kind, text) pairs of one query set of the queries file.
fn query_set(queries: &Value, set: &str) -> Vec<(String, String)> {
    queries[set]
        .as_array()
        .unwrap_or_else(|| die(format!("queries file has no {set} set")))
        .iter()
        .map(|q| {
            (
                q["kind"].as_str().unwrap_or("").to_string(),
                q["text"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect()
}

fn of_kind(set: &[(String, String)], kind: &str) -> Vec<String> {
    set.iter()
        .filter(|q| q.0 == kind)
        .map(|q| q.1.clone())
        .collect()
}

/// The queries `run` measures, as cases: every body query on the four body members, every title
/// query on both title members, every fuzzy name.
fn base_cases(queries: &Value) -> Vec<Case> {
    let mut out = Vec::new();
    for (kind, text) in query_set(queries, "body") {
        for member in BODY_MEMBERS {
            out.push(Case::new("base", member, &kind, &text, base_opts(&kind)));
        }
    }
    for (kind, text) in query_set(queries, "title") {
        for member in TITLE_MEMBERS {
            out.push(Case::new("base", member, &kind, &text, base_opts(&kind)));
        }
    }
    for f in queries["fuzzy"].as_array().unwrap() {
        let mut c = Case::new(
            "base",
            "fuzzy",
            "fuzzy",
            f["name"].as_str().unwrap(),
            json!({}),
        );
        c.fuzzy_scope = f["scoped"]
            .as_bool()
            .unwrap_or(false)
            .then_some(("wiki", "default"));
        out.push(c);
    }
    out
}

/// The same queries under a source and type scope (the bake-off corpus has two sources, and
/// `scale-b` holds only `person` and `note` pages), and scoped fuzzy names.
fn scoped_cases(queries: &Value) -> Vec<Case> {
    let scope = json!({"sources": ["scale-b"], "type": "person"});
    let types = json!({"sources": ["scale-b", "default"], "types": ["note", "concept"]});
    let mut out = Vec::new();
    for (kind, text) in query_set(queries, "body").iter().step_by(4) {
        for member in BODY_MEMBERS {
            out.push(Case::new(
                "scoped",
                member,
                kind,
                text,
                merged(&base_opts(kind), scope.clone()),
            ));
        }
    }
    for (kind, text) in query_set(queries, "title") {
        for member in TITLE_MEMBERS {
            for extra in [&scope, &types] {
                out.push(Case::new(
                    "scoped",
                    member,
                    &kind,
                    &text,
                    merged(&base_opts(&kind), extra.clone()),
                ));
            }
        }
    }
    for f in queries["fuzzy"].as_array().unwrap().iter().take(12) {
        let mut c = Case::new(
            "scoped",
            "fuzzy",
            "fuzzy",
            f["name"].as_str().unwrap(),
            json!({}),
        );
        c.fuzzy_scope = Some(("wiki", "scale-b"));
        out.push(c);
    }
    out
}

/// Wider windows than `run` uses, so the full matching set of a rare or mid-frequency word is
/// compared: 1,000 chunks, every page, and the arm past its first window.
fn window_cases(queries: &Value) -> Vec<Case> {
    let body = query_set(queries, "body");
    let texts: Vec<String> = of_kind(&body, "rare1")
        .into_iter()
        .chain(of_kind(&body, "mid1").into_iter().take(2))
        .collect();
    let mut out = Vec::new();
    for t in &texts {
        out.push(Case::new(
            "windows",
            "chunks",
            "window",
            t,
            json!({"limit": 1000}),
        ));
        out.push(Case::new("windows", "pages_search", "window", t, json!({})));
        out.push(Case::new(
            "windows",
            "arm",
            "window",
            t,
            json!({"limit": 100, "offset": 20, "innerLimit": 500}),
        ));
    }
    out
}

/// The slugs of the first `n` results of a member (through the index, before the scan is forced).
fn top_slugs(store: &Store, member: &'static str, text: &str, n: u64) -> Vec<String> {
    let mut c = Case::new("setup", member, "setup", text, json!({"limit": n}));
    c.title_limit = n as f64;
    let result = exec(store, &c);
    let rows: Vec<Value> = match result {
        Value::Array(a) if member.starts_with("titles") => a
            .iter()
            .flat_map(|attempt| attempt["rows"].as_array().cloned().unwrap_or_default())
            .collect(),
        Value::Array(a) => a,
        _ => Vec::new(),
    };
    let mut slugs: Vec<String> = rows
        .iter()
        .filter_map(|r| r["slug"].as_str().map(String::from))
        .collect();
    let mut seen = std::collections::HashSet::new();
    slugs.retain(|s| seen.insert(s.clone()));
    slugs
}

/// Windows that hide many pages: the slugs of a query's top pages (half its matches, at most 200; 100
/// for titles) are excluded, and a
/// slug prefix is hard-excluded, so a member has to read far past its first window. The bench corpus
/// has no private page; `private_saturation_cases` covers the privacy filter on a fixture.
fn hidden_window_cases(store: &Store, queries: &Value) -> Vec<Case> {
    let body = query_set(queries, "body");
    let title = query_set(queries, "title");
    let texts = [
        of_kind(&body, "common1")[0].clone(),
        of_kind(&body, "common2")[0].clone(),
        of_kind(&body, "mid1")[0].clone(),
    ];
    let mut out = Vec::new();
    for t in &texts {
        // Half of the matching pages (at most 200) are hidden, so some page is left to return.
        let matching = exec(
            store,
            &Case::new("setup", "pages_count", "setup", t, json!({})),
        )
        .as_u64()
        .unwrap_or(0);
        let hidden = top_slugs(store, "pages_search", t, (matching / 2).clamp(1, 200));
        for member in ["chunks", "pages_search", "arm"] {
            out.push(Case::new(
                "hidden_window",
                member,
                "hidden",
                t,
                json!({"limit": 20, "excludeSlugs": hidden}),
            ));
        }
    }
    let big: Vec<(String, usize)> = title
        .iter()
        .map(|q| (q.1.clone(), title_match_count(store, &q.1)))
        .filter(|(_, n)| *n >= 4)
        .take(2)
        .collect();
    for (t, n) in &big {
        let hidden = top_slugs(store, "titles", t, (*n as u64 / 2).clamp(1, 100));
        out.push(Case::new(
            "hidden_window",
            "titles",
            "hidden",
            t,
            json!({"limit": 20, "excludeSlugs": hidden}),
        ));
    }
    for member in ["chunks", "arm"] {
        let opts = json!({"limit": 20, "hardExcludes": ["wiki/a", "wiki/b", "wiki/c", "wiki/s"]});
        out.push(Case::new(
            "hidden_window",
            member,
            "hard_exclude",
            &texts[0],
            opts,
        ));
    }
    out
}

/// Slug handles: a page whose slug basename is a handle matches on every chunk, whatever its text.
fn handle_cases(queries: &Value, slugs: &[String]) -> Vec<Case> {
    let body = query_set(queries, "body");
    let text = of_kind(&body, "rare1")[0].clone();
    let basename = |s: &String| s.rsplit('/').next().unwrap_or(s).to_string();
    let mut sets: Vec<Vec<String>> = slugs.iter().take(3).map(|s| vec![basename(s)]).collect();
    sets.push(vec!["no-such-handle-9999".to_string()]);
    sets.push(slugs.iter().take(3).map(basename).collect());
    let mut out = Vec::new();
    for handles in sets {
        let o = json!({"limit": 20, "handles": handles});
        out.push(Case::new("handles", "chunks", "handle", &text, o.clone()));
        out.push(Case::new("handles", "arm", "handle", &text, o.clone()));
        out.push(Case::new(
            "handles",
            "pages_count",
            "handle",
            &text,
            o.clone(),
        ));
        out.push(Case::new(
            "handles",
            "pages_search",
            "handle",
            &text,
            merged(&o, json!({"handlesOnly": true})),
        ));
    }
    out
}

/// The arm's match query and rank query differ.
fn disjoint_cases(queries: &Value) -> Vec<Case> {
    let body = query_set(queries, "body");
    let (c1, c2) = (of_kind(&body, "common1"), of_kind(&body, "common2"));
    let (m1, r1, p3) = (
        of_kind(&body, "mid1"),
        of_kind(&body, "rare1"),
        of_kind(&body, "phrase3"),
    );
    let unquoted = p3[0].trim_matches('"').to_string();
    let pairs = [
        (m1[0].clone(), c1[0].clone()),
        (c1[1].clone(), r1[0].clone()),
        (r1[1].clone(), m1[1].clone()),
        (unquoted, p3[0].clone()),
        (format!("{} OR {}", m1[0], m1[1]), m1[0].clone()),
        (c2[0].clone(), c2[1].clone()),
    ];
    pairs
        .into_iter()
        .map(|(m, r)| {
            let mut c = Case::new(
                "disjoint",
                "arm",
                "disjoint",
                &m,
                json!({"limit": 20, "phrase": true}),
            );
            c.rank = Some(r);
            c
        })
        .collect()
}

/// NOT-only queries (`-word`) have no candidate bound, so the members scan them: both sides of the
/// comparison are the scan. Mixed shapes (`word -other`) are bounded by the positive word.
fn not_only_cases(queries: &Value) -> Vec<Case> {
    let body = query_set(queries, "body");
    let (c1, c2, c3) = (
        of_kind(&body, "common1"),
        of_kind(&body, "common2"),
        of_kind(&body, "common3"),
    );
    let (m1, r1) = (of_kind(&body, "mid1"), of_kind(&body, "rare1"));
    let texts = [
        format!("-{}", c1[0]),
        format!("-{}", m1[0]),
        format!("-{}", r1[0]),
        format!("-{} -{}", c1[1], m1[1]),
        format!(
            "-{} -{} -{}",
            c1[2],
            c2[0].split(' ').next().unwrap_or(""),
            c3[0].split(' ').next().unwrap_or("")
        ),
    ];
    let mut out = Vec::new();
    for t in &texts[..4] {
        for member in BODY_MEMBERS {
            out.push(Case::new("not_only", member, "not_only", t, base_opts("")));
        }
    }
    out.push(Case::new(
        "not_only",
        "arm",
        "not_only",
        &texts[4],
        base_opts(""),
    ));
    out.push(Case::new(
        "not_only",
        "pages_search",
        "not_only",
        &texts[4],
        base_opts(""),
    ));
    for t in &texts[..3] {
        for member in TITLE_MEMBERS {
            out.push(Case::new(
                "not_only_titles",
                member,
                "not_only",
                t,
                base_opts(""),
            ));
        }
    }
    let mixed = [
        format!("{} -{}", m1[0], c1[0]),
        format!("{} -{}", c1[1], c1[2]),
        format!("{} -{}", r1[0], m1[1]),
    ];
    for t in &mixed {
        for member in ["chunks", "pages_search", "arm"] {
            out.push(Case::new(
                "not_mixed",
                member,
                "not_mixed",
                t,
                base_opts(""),
            ));
        }
    }
    out
}

/// How many pages a title query matches: the `Title` attempt has no cap.
fn title_match_count(store: &Store, text: &str) -> usize {
    let attempt = TitleAttempt {
        texts: vec![text.to_string()],
        kind: TitleAttemptKind::Title,
        limit: 1e6,
        offset: 0.0,
    };
    store
        .search_titles_attempts(
            &[attempt],
            &text.to_lowercase(),
            5000.0,
            &KeywordOptions::default(),
        )
        .map(|a| a[0]["rows"].as_array().map_or(0, Vec::len))
        .unwrap_or(0)
}

/// The title members' candidate cap at a query's match count minus one, equal and plus one, and the
/// arm's per-page candidate window around its limit.
fn cap_boundary_cases(store: &Store, queries: &Value) -> Vec<Case> {
    let title = query_set(queries, "title");
    let counted: Vec<(String, usize)> = title
        .iter()
        .map(|q| (q.1.clone(), title_match_count(store, &q.1)))
        .filter(|(_, n)| (2..=5000).contains(n))
        .collect();
    let stride = (counted.len() / 5).max(1);
    let mut out = Vec::new();
    for (text, n) in counted.iter().step_by(stride).take(5) {
        for cap in [1, n - 1, *n, n + 1] {
            for member in TITLE_MEMBERS {
                let mut c = Case::new("cap_boundary", member, "cap", text, json!({}));
                c.cap = cap as f64;
                c.title_limit = 10_000.0;
                out.push(c);
            }
        }
    }
    let mid = of_kind(&query_set(queries, "body"), "mid1");
    for t in mid.iter().take(2) {
        for inner in [4, 5, 6] {
            out.push(Case::new(
                "cap_boundary",
                "arm",
                "inner",
                t,
                json!({"limit": 5, "innerLimit": inner}),
            ));
        }
    }
    out
}

const PRIVATE_PAGES: usize = 300;
const PUBLIC_PAGES: usize = 12;

/// Writes pages that saturate every window of one word: 300 private pages (many mentions) and 12
/// public ones (one mention) all carry "zorblax". Written through `put_page`, so it also exercises
/// the write path that keeps the postings in step. Writes into the store: run on a copy.
fn write_fixtures(store: &Store) -> Value {
    let t = Instant::now();
    let put = |slug: String, title: String, text: String, visibility: &str| {
        let chunk = |i: u32| ChunkInput {
            chunk_index: i,
            chunk_text: text.clone(),
            chunk_source: Some("compiled_truth".to_string()),
            modality: Some("text".to_string()),
            ..ChunkInput::default()
        };
        let page = PageInput {
            page_type: "note".to_string(),
            title,
            compiled_truth: text.clone(),
            timeline: Some(String::new()),
            frontmatter: json!({"visibility": visibility}).as_object().cloned(),
            ..PageInput::default()
        };
        let options = PutPageOptions {
            source_id: Some("default".to_string()),
            chunks: Some(vec![chunk(0), chunk(1)]),
            ..PutPageOptions::default()
        };
        store
            .put_page(&slug, &page, &options)
            .unwrap_or_else(|e| die(format!("fixture {slug}: {e}")));
    };
    for k in 0..PRIVATE_PAGES {
        let text = "zorblax saturation private. ".repeat(20);
        put(
            format!("fixture/private-{k}"),
            format!("Zorblax saturation {k}"),
            text,
            "private",
        );
    }
    for k in 0..PUBLIC_PAGES {
        let text = "zorblax appears once among words about gardens, rivers, mountains and weather over the hills".to_string();
        put(
            format!("fixture/public-{k}"),
            format!("Zorblax public {k}"),
            text,
            "world",
        );
    }
    json!({"private_pages": PRIVATE_PAGES, "public_pages": PUBLIC_PAGES, "ms": ms(t)})
}

/// The privacy filter over the fixture: private pages outrank and outnumber the public ones, so a
/// window of 20 (or 5) is saturated by hidden pages unless the filter runs before the window.
fn private_saturation_cases() -> Vec<Case> {
    let policy =
        json!({"honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn", "identity": []});
    let hide = json!({"excludePrivate": policy, "requireSafeChunks": false});
    let mut out = Vec::new();
    for text in ["zorblax", "zorblax saturation"] {
        for (label, limit, private) in [
            ("hide20", 20, true),
            ("hide5", 5, true),
            ("see20", 20, false),
        ] {
            let mut opts = json!({"limit": limit});
            if private {
                opts = merged(&opts, hide.clone());
            }
            for member in BODY_MEMBERS {
                out.push(Case::new(
                    "private_saturation",
                    member,
                    label,
                    text,
                    opts.clone(),
                ));
            }
            if label != "hide5" {
                for member in TITLE_MEMBERS {
                    out.push(Case::new(
                        "private_saturation",
                        member,
                        label,
                        text,
                        opts.clone(),
                    ));
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------- verify

/// `GBRAIN_RUST_KEYWORD_SCAN=1` forces the scan; the store reads it on every call.
fn set_scan(on: bool) {
    // SAFETY: the tool calls this from its only running thread (the index build has finished and
    // no other thread reads or writes the environment), so no reader races the change.
    unsafe {
        if on {
            std::env::set_var("GBRAIN_RUST_KEYWORD_SCAN", "1");
        } else {
            std::env::remove_var("GBRAIN_RUST_KEYWORD_SCAN");
        }
    }
}

fn canon(v: &Value) -> Vec<u8> {
    serde_json::to_vec(v).unwrap_or_else(|e| die(e))
}

/// The offset of the first byte where two canonical results differ (`None`: identical).
fn first_diff(a: &[u8], b: &[u8]) -> Option<usize> {
    (a != b).then(|| {
        a.iter()
            .zip(b)
            .position(|(x, y)| x != y)
            .unwrap_or(a.len().min(b.len()))
    })
}

fn excerpt(bytes: &[u8], at: usize) -> String {
    let from = at.saturating_sub(60);
    String::from_utf8_lossy(&bytes[from..bytes.len().min(at + 100)]).into_owned()
}

fn short(text: &str) -> String {
    text.chars().take(120).collect()
}

/// Shows the comparison can find a difference: a result differs from itself with a byte added, and
/// from the same query with one row fewer.
fn comparator_self_check(store: &Store, queries: &Value) -> Value {
    let body = query_set(queries, "body");
    let text = of_kind(&body, "common1")[0].clone();
    let full = canon(&exec(
        store,
        &Case::new("self", "chunks", "self", &text, json!({"limit": 20})),
    ));
    let fewer = canon(&exec(
        store,
        &Case::new("self", "chunks", "self", &text, json!({"limit": 19})),
    ));
    let mut padded = full.clone();
    padded.push(b' ');
    let found_byte = first_diff(&full, &padded).is_some();
    let found_row = first_diff(&full, &fewer).is_some();
    json!({"query": text, "detects_extra_byte": found_byte, "detects_one_row_fewer": found_row,
           "ok": found_byte && found_row && first_diff(&full, &full).is_none()})
}

fn verify(dir: &Path, queries_file: &Path, corpus: &Path, fixtures: bool) {
    if std::env::var_os("GBRAIN_RUST_KEYWORD_SCAN").is_some() {
        die("GBRAIN_RUST_KEYWORD_SCAN is set; verify toggles it itself, so unset it first");
    }
    let queries: Value =
        serde_json::from_str(&std::fs::read_to_string(queries_file).unwrap_or_else(|e| die(e)))
            .unwrap_or_else(|e| die(e));
    let started = Instant::now();
    // Without `fixtures` verify only reads, so it opens the store read-only: the record file
    // keeps every byte (a writable open commits redb's allocator state on close).
    let (store, build_wait_ms) = if fixtures {
        let store = Store::open_dir(dir, OpenOptions::default()).unwrap_or_else(|e| die(e));
        let waited = wait_index_complete(&store);
        (store, waited)
    } else {
        let store = Store::open_dir_read_only(dir).unwrap_or_else(|e| die(e));
        match store.keyword_index_state().unwrap_or_else(|e| die(e)) {
            Some(st) if st.complete => {}
            _ => die("the keyword index is not complete; run `build` on the store first"),
        }
        (store, 0.0)
    };
    let fixture_report = fixtures.then(|| write_fixtures(&store));
    let slugs: Vec<String> = lines(&corpus.join("pages.jsonl"))
        .take(3000)
        .filter_map(|p| p["slug"].as_str().map(String::from))
        .collect();
    if slugs.len() < 10 {
        die("the corpus has fewer than 10 pages");
    }
    let self_check = comparator_self_check(&store, &queries);

    let mut cases = base_cases(&queries);
    cases.extend(scoped_cases(&queries));
    cases.extend(window_cases(&queries));
    cases.extend(hidden_window_cases(&store, &queries));
    cases.extend(handle_cases(&queries, &slugs));
    cases.extend(disjoint_cases(&queries));
    cases.extend(not_only_cases(&queries));
    cases.extend(cap_boundary_cases(&store, &queries));
    if fixtures {
        cases.extend(private_saturation_cases());
    }

    let total = cases.len();
    let mut rows = Vec::new();
    let mut mismatches = Vec::new();
    for (n, c) in cases.iter().enumerate() {
        set_scan(false);
        let t = Instant::now();
        let by_index = exec(&store, c);
        let index_ms = ms(t);
        set_scan(true);
        let t = Instant::now();
        let by_scan = exec(&store, c);
        let scan_ms = ms(t);
        set_scan(false);
        let (a, b) = (canon(&by_index), canon(&by_scan));
        let diff = first_diff(&a, &b);
        if let Some(at) = diff {
            mismatches.push(json!({
                "group": c.group, "member": c.member, "kind": c.kind, "text": short(&c.text),
                "options": c.opts, "index_bytes": a.len(), "scan_bytes": b.len(),
                "first_diff_offset": at, "index_excerpt": excerpt(&a, at), "scan_excerpt": excerpt(&b, at),
            }));
        }
        rows.push(json!({
            "group": c.group, "member": c.member, "kind": c.kind, "text": short(&c.text),
            "bytes": a.len(), "hits": hits_of(&by_scan), "index_ms": index_ms, "scan_ms": scan_ms,
            "index_like": index_ms < scan_ms * 0.5, "equal": diff.is_none(),
        }));
        if (n + 1) % 20 == 0 || n + 1 == total {
            eprintln!(
                "verify: {}/{} cases, {} mismatches, {:.0}s",
                n + 1,
                total,
                mismatches.len(),
                started.elapsed().as_secs_f64()
            );
        }
    }

    let mut per_member: std::collections::BTreeMap<String, u64> = Default::default();
    let mut per_group: std::collections::BTreeMap<String, Value> = Default::default();
    for r in &rows {
        *per_member
            .entry(r["member"].as_str().unwrap().to_string())
            .or_default() += 1;
        let g = per_group.entry(r["group"].as_str().unwrap().to_string()).or_insert_with(
            || json!({"cases": 0, "empty_results": 0, "index_like_by_timing": 0, "members": {}}),
        );
        g["cases"] = json!(g["cases"].as_u64().unwrap() + 1);
        if r["hits"].as_u64() == Some(0) {
            g["empty_results"] = json!(g["empty_results"].as_u64().unwrap() + 1);
        }
        if r["index_like"].as_bool() == Some(true) {
            g["index_like_by_timing"] = json!(g["index_like_by_timing"].as_u64().unwrap() + 1);
        }
        let m = r["member"].as_str().unwrap();
        g["members"][m] = json!(g["members"][m].as_u64().unwrap_or(0) + 1);
    }
    let not_only: Vec<&Value> = rows
        .iter()
        .filter(|r| r["group"].as_str().is_some_and(|g| g.starts_with("not_")))
        .collect();
    let ok = mismatches.is_empty() && self_check["ok"] == true;
    println!(
        "{}",
        json!({
            "mode": "verify", "ok": ok, "mismatch_count": mismatches.len(), "cases": total,
            "compared_per_member": per_member, "groups": per_group,
            "answered_by": "The store API does not say whether the index or the scan answered a call, \
                so none is recorded. index_like_by_timing counts cases where the indexed call took under \
                half the forced-scan time; the not_only rows give both times, and a NOT-only query is \
                scan-like when index_ms is close to scan_ms.",
            "comparator_self_check": self_check, "fixtures": fixture_report,
            "index_wait_ms": build_wait_ms, "total_secs": started.elapsed().as_secs_f64(),
            "peak_rss_kib": status_kib("VmHWM"),
            "mismatches": mismatches, "not_only_rows": not_only, "rows": rows,
        })
    );
    if !ok {
        std::process::exit(1);
    }
}

// ---------------------------------------------------------------- side samples

fn stats(times: &[f64]) -> Value {
    let mut sorted = times.to_vec();
    sorted.sort_by(f64::total_cmp);
    json!({
        "n": times.len(), "p50_ms": percentile(&sorted, 50.0), "p99_ms": percentile(&sorted, 99.0),
        "min_ms": sorted.first(), "max_ms": sorted.last(),
        "mean_ms": times.iter().sum::<f64>() / times.len().max(1) as f64,
    })
}

/// NOT-only fallback latency: the members scan these queries, so this is the scan's time on a store
/// that has a complete index.
fn not_only(dir: &Path, queries_file: &Path, passes: usize) {
    let queries: Value =
        serde_json::from_str(&std::fs::read_to_string(queries_file).unwrap()).unwrap();
    let store = Store::open_dir(dir, OpenOptions::default()).unwrap_or_else(|e| die(e));
    wait_index_complete(&store);
    let cases: Vec<Case> = not_only_cases(&queries)
        .into_iter()
        .filter(|c| c.group == "not_only")
        .collect();
    let mut by_member: std::collections::BTreeMap<&str, Vec<f64>> = Default::default();
    let mut per_query = Vec::new();
    for pass in 0..passes {
        for c in &cases {
            let t = Instant::now();
            let hits = hits_of(&exec(&store, c));
            let d = ms(t);
            by_member.entry(c.member).or_default().push(d);
            per_query.push(json!({"pass": pass + 1, "member": c.member, "text": c.text, "hits": hits, "ms": d}));
        }
    }
    let members: Vec<Value> = by_member
        .iter()
        .map(|(m, t)| json!({"member": m, "stats": stats(t)}))
        .collect();
    println!(
        "{}",
        json!({"mode": "not-only", "passes": passes, "members": members, "per_query": per_query,
                           "peak_rss_kib": status_kib("VmHWM")})
    );
}

/// Durable `put_page` and concurrent-writer samples. Writes into the store: run on a copy. The
/// pages are the first corpus pages under new slugs, written through `Store::open_dir` (a durable
/// commit each, not the `nosync` load). The concurrent sample times the 30 queries of a member alone, then
/// in whole passes while another thread keeps writing pages, until it has committed 30. The index is
/// checked against a rebuild afterwards.
fn writes(dir: &Path, queries_file: &Path, corpus: &Path, pages: usize) {
    let queries: Value =
        serde_json::from_str(&std::fs::read_to_string(queries_file).unwrap()).unwrap();
    let store = Store::open_dir(dir, OpenOptions::default()).unwrap_or_else(|e| die(e));
    wait_index_complete(&store);
    let mut chunk_rows = lines(&corpus.join("chunks.jsonl")).peekable();
    let pool: Vec<(PageInput, PutPageOptions)> = lines(&corpus.join("pages.jsonl"))
        .take(pages)
        .map(|row| {
            let (_, page, options) = build_put(&row, &mut chunk_rows);
            (page, options)
        })
        .collect();
    let put = |prefix: &str, k: usize| -> f64 {
        let (page, options) = &pool[k % pool.len()];
        let t = Instant::now();
        store
            .put_page(&format!("bench/{prefix}-{k}"), page, options)
            .unwrap_or_else(|e| die(format!("put {prefix}-{k}: {e}")));
        ms(t)
    };
    let sequential: Vec<f64> = (0..pages).map(|k| put("put", k)).collect();

    let mut concurrent = Vec::new();
    for member in ["chunks", "titles"] {
        let set = if member == "titles" { "title" } else { "body" };
        let cases: Vec<Case> = query_set(&queries, set)
            .iter()
            .map(|(kind, text)| {
                Case::new(
                    "writes",
                    if member == "titles" {
                        "titles"
                    } else {
                        "chunks"
                    },
                    kind,
                    text,
                    base_opts(kind),
                )
            })
            .collect();
        let pass = || -> Vec<f64> {
            cases
                .iter()
                .map(|c| {
                    let t = Instant::now();
                    exec(&store, c);
                    ms(t)
                })
                .collect()
        };
        pass();
        let alone = pass();
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};
        let (stop, puts) = (AtomicBool::new(false), AtomicUsize::new(0));
        let began = Instant::now();
        let (during, written) = std::thread::scope(|s| {
            let writer = s.spawn(|| {
                let mut times = Vec::new();
                while !stop.load(Relaxed) {
                    times.push(put(&format!("conc-{member}"), times.len()));
                    puts.store(times.len(), Relaxed);
                }
                times
            });
            // Whole passes until the writer has committed 30 pages (at most 120 s).
            let mut during = pass();
            while puts.load(Relaxed) < 30 && began.elapsed().as_secs() < 120 {
                during.extend(pass());
            }
            stop.store(true, Relaxed);
            (during, writer.join().unwrap())
        });
        concurrent.push(json!({"member": member, "queries_alone": stats(&alone),
                               "queries_during_writes": stats(&during), "writer_puts": stats(&written)}));
    }
    let t = Instant::now();
    let report = store.keyword_index_verify(None).unwrap_or_else(|e| die(e));
    let ok = report.ok;
    println!(
        "{}",
        json!({
            "mode": "writes", "durable_put_page": stats(&sequential), "concurrent": concurrent,
            "index_check_after": {"ms": ms(t), "report": report}, "peak_rss_kib": status_kib("VmHWM"),
        })
    );
    if !ok {
        std::process::exit(1);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let a = |i: usize| -> &str {
        args.get(i)
            .map(String::as_str)
            .unwrap_or_else(|| die("missing argument; see the file header"))
    };
    let num = |i: usize, default: f64| args.get(i).and_then(|v| v.parse().ok()).unwrap_or(default);
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
            num(4, 900.0),
            num(5, 2.0) as usize,
        ),
        "build" => build(Path::new(a(1))),
        "sizes" => sizes(Path::new(a(1))),
        "compact" => compact(Path::new(a(1))),
        "index-check" => index_check(Path::new(a(1))),
        "verify" => verify(
            Path::new(a(1)),
            Path::new(a(2)),
            Path::new(a(3)),
            args.get(4).is_some_and(|v| v == "fixtures"),
        ),
        "not-only" => not_only(Path::new(a(1)), Path::new(a(2)), num(3, 1.0) as usize),
        "writes" => writes(
            Path::new(a(1)),
            Path::new(a(2)),
            Path::new(a(3)),
            num(4, 200.0) as usize,
        ),
        _ => die(
            "mode is load, queries, run, build, sizes, compact, index-check, verify, not-only or writes",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// Documents with every word frequency the generator needs: common words, mid-frequency
    /// words, rare words, `extra` appended to the first document.
    fn docs(words_per_doc: usize, extra: &str) -> Vec<String> {
        let letters = |n: usize| -> String {
            (0..3)
                .map(|k| (b'a' + ((n / 26usize.pow(k)) % 26) as u8) as char)
                .collect()
        };
        let mut out: Vec<String> = (0..400)
            .map(|i| {
                let mut ws: Vec<String> = (0..words_per_doc)
                    .map(|k| format!("common{}", letters((i + k) % 220)))
                    .collect();
                ws.push(format!("middling{}", letters(i % 40)));
                if i < 20 {
                    ws.push(format!("rareword{}", letters(i)));
                }
                ws.join(" ")
            })
            .collect();
        out[0].push_str(extra);
        out
    }

    fn phrases(docs: Vec<String>) -> Vec<String> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(make_queries(&docs, 2));
        });
        let queries = rx
            .recv_timeout(Duration::from_secs(20))
            .expect("make_queries returned within 20 s");
        queries
            .iter()
            .filter(|q| q["kind"] == "phrase3")
            .map(|q| q["text"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn queries_end_when_no_document_is_long_enough_for_a_phrase() {
        // Every document has 4 words, under the 8 a phrase source needs (short titles).
        assert_eq!(phrases(docs(3, "")), Vec::<String>::new());
    }

    #[test]
    fn queries_still_take_phrases_from_the_long_documents() {
        let found = phrases(docs(3, " alpha bravo charlie delta echo foxtrot"));
        assert_eq!(found.len(), 4);
        assert!(found.iter().all(|p| p.starts_with('"') && p.ends_with('"')));
    }

    /// How many queries of each kind `make_queries` returns for `docs`.
    fn kinds(docs: &[String]) -> Vec<(String, usize)> {
        let mut counts: Vec<(String, usize)> = Vec::new();
        for q in make_queries(docs, 2) {
            let kind = q["kind"].as_str().unwrap().to_string();
            match counts.iter_mut().find(|c| c.0 == kind) {
                Some(c) => c.1 += 1,
                None => counts.push((kind, 1)),
            }
        }
        counts
    }

    #[test]
    fn queries_leave_out_the_word_tiers_a_corpus_does_not_have() {
        // 12 words in every one of 50 documents: common words, but none of mid or rare frequency.
        let uniform: Vec<String> = (0..50)
            .map(|_| {
                "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima".into()
            })
            .collect();
        assert_eq!(
            kinds(&uniform),
            [
                ("common1".to_string(), 10),
                ("common2".to_string(), 6),
                ("common3".to_string(), 4),
                ("phrase3".to_string(), 4),
            ]
        );
        // Under 11 distinct words, all under 6 letters: no common word (the 10 most frequent are
        // skipped) and no rare one.
        let tiny = vec!["ant bee cat".to_string()];
        assert_eq!(kinds(&tiny), Vec::<(String, usize)>::new());
    }

    #[test]
    fn queries_keep_every_tier_of_a_full_corpus() {
        let counts = kinds(&docs(3, " alpha bravo charlie delta echo foxtrot"));
        let names: Vec<&str> = counts.iter().map(|c| c.0.as_str()).collect();
        assert_eq!(
            names,
            ["common1", "common2", "common3", "mid1", "rare1", "phrase3"]
        );
    }
}
