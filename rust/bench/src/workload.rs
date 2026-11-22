//! The measured workload. One `Run` owns the store, runs the metrics in a fixed order and builds
//! the `gbrain-bakeoff-result/1` JSON. A metric that cannot be measured, or a store that cannot
//! meet a requirement, is reported as a result (an `error` field or a failed check), never a crash.

use crate::children::*;
use crate::corpus::Corpus;
use crate::engine::{open_records, Engine};
use crate::occ::StatsSnapshot;
use crate::owner::OwnerServer;
use crate::records::{Chunk, Page, Records};
use crate::synth::*;
use crate::util::*;
use crate::vector::{self, Loaded};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

pub const ALL_METRICS: &[&str] = &[
    "import",
    "cold_open",
    "get_page",
    "read_c1",
    "read_c4",
    "read_c16",
    "list_pages",
    "get_chunks",
    "vector_exact",
    "vector_exact_mt",
    "vector_filtered_10",
    "vector_filtered_1",
    "put_page",
    "write_w1",
    "write_w4",
    "write_w16",
    "write_hot_w16",
    "write_hot_w16_atomic",
    "crash_recovery",
    "second_process",
    "sim_crash",
    "sim_fsync_fault",
    "sim_commit_layer",
    "sim_negative_control",
    "disk_bytes",
    "peak_rss_bytes",
];

#[derive(Clone)]
pub struct Config {
    pub engine: Engine,
    pub corpus: PathBuf,
    pub store: PathBuf,
    pub scale: String,
    pub out: PathBuf,
    pub only: Option<Vec<String>>,
    pub quick: bool,
    pub commit_log: bool,
}

type Metric = Value;

fn metric_err(msg: impl std::fmt::Display) -> Metric {
    json!({"n": 0, "error": msg.to_string()})
}

pub struct Run {
    cfg: Config,
    corpus: Corpus,
    records: Option<Arc<Records>>,
    pub metrics: Map<String, Value>,
    pub notes: Vec<String>,
    /// Corpus pages only (source default / scale-b), in page-id order.
    pages: Vec<(u64, String, String)>,
    after_import_bytes: Option<u64>,
    phase_rss: Map<String, Value>,
    pub failed_checks: Vec<String>,
    nonce: String,
}

struct Worker {
    lat: Lat,
    errors: u64,
    ok: u64,
}

impl Run {
    pub fn new(cfg: Config) -> Result<Run, String> {
        let corpus = Corpus::open(&cfg.corpus)?;
        let nonce = format!(
            "{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_micros())
                .unwrap_or(0)
        );
        Ok(Run {
            cfg,
            corpus,
            records: None,
            metrics: Map::new(),
            notes: Vec::new(),
            pages: Vec::new(),
            after_import_bytes: None,
            phase_rss: Map::new(),
            failed_checks: Vec::new(),
            nonce,
        })
    }

    pub fn chunks(&self) -> usize {
        self.corpus.manifest.chunks
    }
    pub fn page_count(&self) -> usize {
        self.corpus.manifest.pages
    }

    fn n(&self, full: usize) -> usize {
        if self.cfg.quick {
            (full / 10).max(1)
        } else {
            full
        }
    }
    fn secs(&self) -> f64 {
        if self.cfg.quick {
            1.0
        } else {
            5.0
        }
    }
    fn wants(&self, name: &str) -> bool {
        self.cfg
            .only
            .as_ref()
            .is_none_or(|o| o.iter().any(|x| x == name))
    }

    fn log(&self, line: &str) {
        eprintln!("[{} {}] {line}", self.cfg.engine.name(), self.cfg.scale);
    }

    fn rec(&self) -> Result<Arc<Records>, String> {
        self.records
            .clone()
            .ok_or_else(|| "store is not open".to_string())
    }

    fn open(&mut self) -> Result<(), String> {
        let r = open_records(self.cfg.engine, &self.cfg.store, self.cfg.commit_log)
            .map_err(|e| e.to_string())?;
        self.records = Some(r);
        Ok(())
    }

    fn close(&mut self) {
        self.records = None; // drops the Db: the commit pipeline stops and the store file is released
    }

    fn ensure_pages(&mut self) -> Result<(), String> {
        if !self.pages.is_empty() {
            return Ok(());
        }
        let all = self.rec()?.all_page_keys().map_err(|e| e.to_string())?;
        self.pages = all
            .into_iter()
            .filter(|(_, s, _)| s == "default" || s == "scale-b")
            .collect();
        if self.pages.is_empty() {
            return Err("the store holds no corpus pages (run `import` first)".into());
        }
        Ok(())
    }

    fn stats(&self) -> StatsSnapshot {
        self.records
            .as_ref()
            .map(|r| r.db().stats.snapshot())
            .unwrap_or_default()
    }

    fn set(&mut self, name: &str, m: Metric) {
        if let Some(e) = m.get("error") {
            self.log(&format!("{name}: ERROR {e}"));
        } else {
            self.log(&format!("{name}: {}", summarize(&m)));
        }
        self.metrics.insert(name.to_string(), m);
    }

    /// Run every selected metric in order.
    pub fn run_all(&mut self) {
        if self.wants("import") {
            let m = self.import().unwrap_or_else(metric_err);
            self.set("import", m);
        }
        if self.records.is_none() {
            if let Err(e) = self.open() {
                self.notes.push(format!("could not open the store: {e}"));
                self.log(&format!("cannot open store: {e}"));
                return;
            }
        }
        let (hwm, _) = rss_bytes();
        self.phase_rss
            .insert("after_import_or_open_vmhwm".into(), json!(hwm));

        if self.wants("cold_open") {
            let m = self.cold_open().unwrap_or_else(metric_err);
            self.set("cold_open", m);
        }
        for name in [
            "get_page",
            "read_c1",
            "read_c4",
            "read_c16",
            "list_pages",
            "get_chunks",
        ] {
            if !self.wants(name) {
                continue;
            }
            let m = match name {
                "get_page" => self.get_page(),
                "read_c1" => self.read_conc(1),
                "read_c4" => self.read_conc(4),
                "read_c16" => self.read_conc(16),
                "list_pages" => self.list_pages(),
                _ => self.get_chunks(),
            }
            .unwrap_or_else(metric_err);
            self.set(name, m);
        }
        let vector_names = [
            "vector_exact",
            "vector_exact_mt",
            "vector_filtered_10",
            "vector_filtered_1",
        ];
        if vector_names.iter().any(|n| self.wants(n)) {
            self.vector_metrics();
        }
        if self.wants("put_page") {
            let m = self.put_page().unwrap_or_else(metric_err);
            self.set("put_page", m);
        }
        for (name, w) in [("write_w1", 1), ("write_w4", 4), ("write_w16", 16)] {
            if self.wants(name) {
                let m = self.write_new_pages(w).unwrap_or_else(metric_err);
                self.set(name, m);
            }
        }
        if self.wants("write_hot_w16") {
            let m = self.write_hot(false).unwrap_or_else(metric_err);
            self.set("write_hot_w16", m);
        }
        if self.wants("write_hot_w16_atomic") {
            let m = self.write_hot(true).unwrap_or_else(metric_err);
            self.set("write_hot_w16_atomic", m);
        }
        if self.wants("crash_recovery") {
            let m = self.crash_recovery().unwrap_or_else(metric_err);
            self.set("crash_recovery", m);
        }
        if self.wants("second_process") {
            let m = self.second_process().unwrap_or_else(metric_err);
            self.set("second_process", m);
        }
        let sim_names = [
            "sim_crash",
            "sim_fsync_fault",
            "sim_commit_layer",
            "sim_negative_control",
        ];
        if sim_names.iter().any(|n| self.wants(n)) {
            self.sim_metrics(&sim_names);
        }
        if self.wants("disk_bytes") {
            let bytes = dir_bytes(&self.cfg.store);
            let m = json!({
                "n": 1,
                "bytes": bytes,
                "after_import_bytes": self.after_import_bytes,
                "after_writes_bytes": bytes,
                "scope": "bytes allocated on disk (st_blocks * 512) under the store directory; for LMDB the sparse map counts only used blocks",
            });
            self.set("disk_bytes", m);
        }
        if self.wants("peak_rss_bytes") {
            let (hwm, cur) = rss_bytes();
            let m = json!({
                "n": 1,
                "bytes": ru_maxrss_bytes(),
                "process_bytes": ru_maxrss_bytes(),
                "vmhwm_bytes": hwm,
                "current_rss_bytes": cur,
                "phases": self.phase_rss,
                "scope": "getrusage ru_maxrss of this process. It includes the vector matrix loaded for the scan metrics (see vector_exact.matrix_bytes), \
                          the store's own cache (redb's 1 GiB page cache, LMDB's mapped file pages) and the import read buffers; child processes are not included",
            });
            self.set("peak_rss_bytes", m);
        }
    }

    // ---- import --------------------------------------------------------------------------------

    fn import(&mut self) -> Result<Metric, String> {
        self.close();
        if self.cfg.store.exists() {
            std::fs::remove_dir_all(&self.cfg.store)
                .map_err(|e| format!("cannot wipe {}: {e}", self.cfg.store.display()))?;
        }
        self.open()?;
        let records = self.rec()?;
        let before = records.db().stats.snapshot();
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<(Page, Vec<Chunk>)>>(2);
        let corpus_dir = self.cfg.corpus.clone();
        let reader = std::thread::spawn(move || -> Result<(), String> {
            let corpus = Corpus::open(&corpus_dir)?;
            let mut batch: Vec<(Page, Vec<Chunk>)> = Vec::new();
            let mut in_batch = 0usize;
            corpus.stream_pages(|p, c| {
                in_batch += c.len().max(1);
                batch.push((p, c));
                if in_batch >= 1000 {
                    in_batch = 0;
                    tx.send(std::mem::take(&mut batch))
                        .map_err(|_| "importer stopped".to_string())?;
                }
                Ok(())
            })?;
            if !batch.is_empty() {
                tx.send(batch).map_err(|_| "importer stopped".to_string())?;
            }
            Ok(())
        });
        let t0 = Instant::now();
        let mut chunks = 0usize;
        let mut pages = 0usize;
        let mut batches = 0usize;
        let mut failure = None;
        for batch in rx.iter() {
            chunks += batch.iter().map(|b| b.1.len()).sum::<usize>();
            pages += batch.len();
            batches += 1;
            if let Err(e) = records.import_batch(&batch) {
                failure = Some(e.to_string());
                break;
            }
        }
        drop(rx);
        let read = reader
            .join()
            .map_err(|_| "reader thread panicked".to_string())?;
        if let Some(e) = failure {
            return Err(format!("store refused the import: {e}"));
        }
        read?;
        let seconds = t0.elapsed().as_secs_f64();
        let after = records.db().stats.snapshot();
        self.after_import_bytes = Some(dir_bytes(&self.cfg.store));
        Ok(json!({
            "n": 1,
            "seconds": round3(seconds),
            "chunks_per_s": round1(chunks as f64 / seconds.max(1e-9)),
            "chunks": chunks,
            "pages": pages,
            "batches": batches,
            "store_commit_seconds": round3((after.store_commit_ns - before.store_commit_ns) as f64 / 1e9),
            "note": "wall time includes parsing the corpus files (JSON + vectors) on a reader thread overlapped with commits; one durable commit per ~1000 chunks; \
                     store_commit_seconds is the part spent inside the base store's durable commit",
        }))
    }

    // ---- read-side -----------------------------------------------------------------------------

    fn cold_open(&mut self) -> Result<Metric, String> {
        self.ensure_pages()?;
        let (_, source, slug) = self.pages[0].clone();
        self.close();
        let mut runs = Vec::new();
        let mut failures = Vec::new();
        for _ in 0..3 {
            let args = self.child_args(
                "child-cold-open",
                &[("--source", &source), ("--slug", &slug)],
            );
            match run_child(&args, Duration::from_secs(300)) {
                Ok(r) => match last_json_line(&r.stdout) {
                    Some(o) if o["ok"] == true && o["found"] == true => runs.push((
                        o["ms"].as_f64().unwrap_or(0.0),
                        o["open_ms"].as_f64().unwrap_or(0.0),
                        o["first_get_ms"].as_f64().unwrap_or(0.0),
                        r.wall_ms,
                    )),
                    o => failures.push(
                        o.map(|o| o["message"].to_string())
                            .unwrap_or_else(|| r.stderr.chars().take(200).collect()),
                    ),
                },
                Err(e) => failures.push(e.to_string()),
            }
        }
        self.open()?;
        if runs.is_empty() {
            return Ok(metric_err(failures.first().cloned().unwrap_or_default()));
        }
        let med = |f: fn(&(f64, f64, f64, f64)) -> f64| {
            let mut v: Vec<f64> = runs.iter().map(f).collect();
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            round3(v[v.len() / 2])
        };
        Ok(json!({
            "n": runs.len(),
            "ms": med(|r| r.0),
            "open_ms": med(|r| r.1),
            "first_get_ms": med(|r| r.2),
            "process_wall_ms": med(|r| r.3),
            "failures": failures.len(),
            "note": "median of 3 fresh processes: open store + commit pipeline + page-id scan + first get_page (ms = open_ms + first_get_ms, process start-up excluded; process_wall_ms includes it). The OS file cache is warm.",
        }))
    }

    fn child_args(&self, sub: &str, extra: &[(&str, &str)]) -> Vec<String> {
        let mut a = vec![
            sub.to_string(),
            "--engine".into(),
            self.cfg.engine.name().into(),
            "--store".into(),
            self.cfg.store.display().to_string(),
        ];
        if !self.cfg.commit_log {
            a.push("--no-commit-log".into());
        }
        for (k, v) in extra {
            a.push(k.to_string());
            a.push(v.to_string());
        }
        a
    }

    fn get_page(&mut self) -> Result<Metric, String> {
        self.ensure_pages()?;
        let records = self.rec()?;
        let ops = self.n(20_000);
        let mut rng = Rng::new(11);
        let mut lat = Lat::default();
        let mut misses = 0;
        let t0 = Instant::now();
        for _ in 0..ops {
            let (_, s, slug) = &self.pages[rng.below(self.pages.len())];
            let t = Instant::now();
            match records.get_page(s, slug) {
                Ok(Some(_)) => {}
                _ => misses += 1,
            }
            lat.push(t.elapsed());
        }
        let mut m = lat.metric(t0.elapsed().as_secs_f64());
        m.insert("misses".into(), json!(misses));
        Ok(Value::Object(m))
    }

    /// Run `f(thread index, stop flag)` on `threads` threads for `secs`; returns merged results.
    fn run_threads<F>(&self, threads: usize, secs: f64, f: F) -> (Lat, u64, u64, f64)
    where
        F: Fn(usize, &AtomicBool) -> Worker + Sync,
    {
        let stop = AtomicBool::new(false);
        let barrier = Barrier::new(threads + 1);
        let mut lat = Lat::default();
        let (mut errors, mut ok) = (0, 0);
        let mut wall = 0.0;
        std::thread::scope(|s| {
            let handles: Vec<_> = (0..threads)
                .map(|i| {
                    let (f, stop, barrier) = (&f, &stop, &barrier);
                    s.spawn(move || {
                        barrier.wait();
                        f(i, stop)
                    })
                })
                .collect();
            barrier.wait();
            let t0 = Instant::now();
            std::thread::sleep(Duration::from_secs_f64(secs));
            stop.store(true, Ordering::Relaxed);
            for h in handles {
                let w = h.join().expect("worker thread panicked");
                lat.extend(w.lat);
                errors += w.errors;
                ok += w.ok;
            }
            wall = t0.elapsed().as_secs_f64();
        });
        (lat, ok, errors, wall)
    }

    fn read_conc(&mut self, clients: usize) -> Result<Metric, String> {
        self.ensure_pages()?;
        let records = self.rec()?;
        let pages = &self.pages;
        let (lat, ok, errors, wall) = self.run_threads(clients, self.secs(), |i, stop| {
            let mut rng = Rng::new(100 + i as u64);
            let mut w = Worker {
                lat: Lat::default(),
                errors: 0,
                ok: 0,
            };
            while !stop.load(Ordering::Relaxed) {
                let (_, s, slug) = &pages[rng.below(pages.len())];
                let t = Instant::now();
                match records.get_page(s, slug) {
                    Ok(Some(_)) => w.ok += 1,
                    _ => w.errors += 1,
                }
                w.lat.push(t.elapsed());
            }
            w
        });
        let mut m = lat.metric(wall);
        m.insert("clients".into(), json!(clients));
        m.insert("errors".into(), json!(errors));
        m.insert("ok".into(), json!(ok));
        Ok(Value::Object(m))
    }

    fn list_pages(&mut self) -> Result<Metric, String> {
        self.ensure_pages()?;
        let records = self.rec()?;
        let mut slugs: Vec<&String> = self
            .pages
            .iter()
            .filter(|p| p.1 == "default")
            .map(|p| &p.2)
            .collect();
        slugs.sort();
        if slugs.len() < 200 {
            return Err("fewer than 200 pages in source default".into());
        }
        let ops = self.n(2000);
        let mut rng = Rng::new(21);
        let mut lat = Lat::default();
        let mut short = 0;
        let t0 = Instant::now();
        for _ in 0..ops {
            let start = slugs[rng.below(slugs.len() - 100)];
            let t = Instant::now();
            match records.list_pages("default", start, 100) {
                Ok(p) if p.len() == 100 => {}
                _ => short += 1,
            }
            lat.push(t.elapsed());
        }
        let mut m = lat.metric(t0.elapsed().as_secs_f64());
        m.insert("page_size".into(), json!(100));
        m.insert("short_or_failed".into(), json!(short));
        Ok(Value::Object(m))
    }

    fn get_chunks(&mut self) -> Result<Metric, String> {
        self.ensure_pages()?;
        let records = self.rec()?;
        let ops = self.n(2000);
        let mut rng = Rng::new(31);
        let mut lat = Lat::default();
        let mut chunk_total = 0usize;
        let t0 = Instant::now();
        for _ in 0..ops {
            let id = self.pages[rng.below(self.pages.len())].0;
            let t = Instant::now();
            if let Ok(c) = records.get_chunks(id) {
                chunk_total += c.len();
            }
            lat.push(t.elapsed());
        }
        let mut m = lat.metric(t0.elapsed().as_secs_f64());
        m.insert(
            "avg_chunks_per_page".into(),
            json!(round3(chunk_total as f64 / ops as f64)),
        );
        Ok(Value::Object(m))
    }

    // ---- vector scans --------------------------------------------------------------------------

    fn vector_metrics(&mut self) {
        let records = match self.rec() {
            Ok(r) => r,
            Err(e) => {
                self.set("vector_exact", metric_err(e));
                return;
            }
        };
        let t0 = Instant::now();
        let loaded = match vector::load_from_store(&records, self.chunks()) {
            Ok(l) => l,
            Err(e) => {
                let m = metric_err(format!("could not load vectors from the store: {e}"));
                self.set("vector_exact", m);
                return;
            }
        };
        let load_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let (hwm, _) = rss_bytes();
        self.phase_rss
            .insert("after_vector_load_vmhwm".into(), json!(hwm));
        let matrix_bytes = loaded.matrix.data.len() * 4;
        let queries = match self.corpus.queries() {
            Ok(q) => q,
            Err(e) => {
                self.set("vector_exact", metric_err(e));
                return;
            }
        };
        let nq = self.n(200).min(queries.len() / crate::records::DIMS);
        let truth = vector::ensure_truth(&self.corpus).ok();
        if truth.is_none() {
            self.notes
                .push("ground truth could not be read or built; recall_at_10 is null".into());
        }
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1);
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .expect("rayon pool");
        let q = |i: usize| &queries[i * crate::records::DIMS..(i + 1) * crate::records::DIMS];
        let total_rows = loaded.matrix.rows;
        let full_corpus = total_rows == self.chunks();

        // Single thread, then all cores, over every row.
        for (name, mt) in [("vector_exact", false), ("vector_exact_mt", true)] {
            if !self.wants(name) {
                continue;
            }
            let mut lat = Lat::default();
            let mut recall_sum = 0.0;
            let t0 = Instant::now();
            for i in 0..nq {
                let t = Instant::now();
                let top = if mt {
                    vector::top_k_mt(&pool, &loaded.matrix, q(i), None)
                } else {
                    vector::top_k(&loaded.matrix, q(i), None)
                };
                lat.push(t.elapsed());
                if let (Some(tr), true) = (&truth, full_corpus) {
                    recall_sum += recall(&loaded, top.hits(), &tr.top[i]);
                }
            }
            let mut m = lat.metric(t0.elapsed().as_secs_f64());
            m.insert("rows".into(), json!(total_rows));
            m.insert("threads".into(), json!(if mt { threads } else { 1 }));
            m.insert(
                "recall_at_10".into(),
                if truth.is_some() && full_corpus {
                    json!(round3(recall_sum / nq as f64))
                } else {
                    Value::Null
                },
            );
            m.insert("load_ms".into(), json!(round1(load_ms)));
            m.insert("matrix_bytes".into(), json!(matrix_bytes));
            m.insert("simd".into(), json!(vector::simd_path()));
            self.set(name, Value::Object(m));
        }

        // Filtered scans. scale-b = 10% of pages; then the biggest single type inside scale-b.
        let scale_b = loaded.allowed_rows(|s, _| s == "scale-b");
        let mut type_rows: HashMap<String, usize> = HashMap::new();
        for &r in &scale_b {
            if let Some((_, t)) = loaded.page_meta.get(&loaded.row_page[r as usize]) {
                *type_rows.entry(t.clone()).or_default() += 1;
            }
        }
        let mut types: Vec<(String, usize)> = type_rows.into_iter().collect();
        types.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let one_type = types.first().map(|t| t.0.clone());
        let type_rows_list = one_type
            .as_ref()
            .map(|t| loaded.allowed_rows(|s, ty| s == "scale-b" && ty == t))
            .unwrap_or_default();
        for (name, rows, label) in [
            ("vector_filtered_10", &scale_b, "source scale-b".to_string()),
            (
                "vector_filtered_1",
                &type_rows_list,
                format!(
                    "source scale-b and type {}",
                    one_type.clone().unwrap_or_default()
                ),
            ),
        ] {
            if !self.wants(name) {
                continue;
            }
            if rows.is_empty() {
                self.set(
                    name,
                    metric_err(format!("no rows match the filter ({label})")),
                );
                continue;
            }
            let mut lat = Lat::default();
            let mut lat_mt = Lat::default();
            let t0 = Instant::now();
            let mut wrong = 0;
            for i in 0..nq {
                let t = Instant::now();
                let top = vector::top_k(&loaded.matrix, q(i), Some(rows));
                lat.push(t.elapsed());
                if top.hits().iter().any(|h| rows.binary_search(&h.1).is_err()) {
                    wrong += 1;
                }
            }
            let wall = t0.elapsed().as_secs_f64();
            for i in 0..nq {
                let t = Instant::now();
                vector::top_k_mt(&pool, &loaded.matrix, q(i), Some(rows));
                lat_mt.push(t.elapsed());
            }
            let mut m = lat.metric(wall);
            m.insert("filter".into(), json!(label));
            m.insert("matching_rows".into(), json!(rows.len()));
            m.insert(
                "selectivity".into(),
                json!(round3(rows.len() as f64 / total_rows as f64)),
            );
            m.insert("threads".into(), json!(1));
            m.insert("mt_p50_ms".into(), json!(round3(lat_mt.pct_ms(50.0))));
            m.insert("mt_p99_ms".into(), json!(round3(lat_mt.pct_ms(99.0))));
            m.insert("results_outside_filter".into(), json!(wrong));
            m.insert("simd".into(), json!(vector::simd_path()));
            self.set(name, Value::Object(m));
            if name == "vector_filtered_1" {
                let sel = rows.len() as f64 / total_rows as f64;
                if sel > 0.035 {
                    self.notes.push(format!(
                        "vector_filtered_1 selectivity is {:.1}% of chunks, not the spec's ~2.5%: in this corpus scale-b holds only types person and note, so one type is about half of scale-b. The measured selectivity is in the metric.",
                        sel * 100.0
                    ));
                }
            }
        }
    }

    // ---- writes --------------------------------------------------------------------------------

    fn put_page(&mut self) -> Result<Metric, String> {
        self.ensure_pages()?;
        let records = self.rec()?;
        let ops = self.n(500);
        let mut rng = Rng::new(41);
        let mut lat = Lat::default();
        let mut errors = 0;
        let before = self.stats();
        let t0 = Instant::now();
        for _ in 0..ops {
            let (_, s, slug) = &self.pages[rng.below(self.pages.len())];
            let Ok(Some(page)) = records.get_page(s, slug) else {
                errors += 1;
                continue;
            };
            let chunks = random_chunks(&mut rng, 4);
            let t = Instant::now();
            if records.put_page_with_chunks(&page, &chunks).is_err() {
                errors += 1;
            }
            lat.push(t.elapsed());
        }
        let mut m = lat.metric(t0.elapsed().as_secs_f64());
        m.insert("errors".into(), json!(errors));
        self.add_commit_stats(&mut m, before);
        m.insert("note".into(), json!("upserts random existing corpus pages and replaces their chunks with 4 fresh random vectors; ops_per_s includes the untimed read of the existing page"));
        Ok(Value::Object(m))
    }

    fn add_commit_stats(&self, m: &mut Map<String, Value>, before: StatsSnapshot) {
        let a = self.stats();
        let batches = a.batches - before.batches;
        m.insert("conflicts".into(), json!(a.conflicts - before.conflicts));
        m.insert("retries".into(), json!(a.retries - before.retries));
        m.insert("gave_up".into(), json!(a.gave_up - before.gave_up));
        m.insert("batches".into(), json!(batches));
        m.insert(
            "avg_batch".into(),
            json!(round1(if batches == 0 {
                0.0
            } else {
                (a.batched_txns - before.batched_txns) as f64 / batches as f64
            })),
        );
        m.insert("max_batch".into(), json!(a.max_batch));
        m.insert(
            "store_commit_ms_avg".into(),
            json!(round3(if batches == 0 {
                0.0
            } else {
                (a.store_commit_ns - before.store_commit_ns) as f64 / batches as f64 / 1e6
            })),
        );
    }

    fn write_new_pages(&mut self, writers: usize) -> Result<Metric, String> {
        let records = self.rec()?;
        let before = self.stats();
        let tag = format!("w{writers}-{}", self.nonce);
        let (lat, ok, errors, wall) = self.run_threads(writers, self.secs(), |i, stop| {
            let mut rng = Rng::new(7000 + i as u64 + (writers as u64) * 100);
            let mut w = Worker {
                lat: Lat::default(),
                errors: 0,
                ok: 0,
            };
            let mut n = 0u64;
            while !stop.load(Ordering::Relaxed) {
                let slug = format!("{tag}/{i}-{n}");
                n += 1;
                let page = synth_page(records.alloc_page_id(), "bench-write", &slug);
                let chunks = random_chunks(&mut rng, 4);
                let t = Instant::now();
                match records.put_page_with_chunks(&page, &chunks) {
                    Ok(_) => w.ok += 1,
                    Err(_) => w.errors += 1,
                }
                w.lat.push(t.elapsed());
            }
            w
        });
        let mut m = lat.metric(wall);
        m.insert("writers".into(), json!(writers));
        m.insert("committed".into(), json!(ok));
        m.insert("errors".into(), json!(errors));
        self.add_commit_stats(&mut m, before);
        m.insert("note".into(), json!("each writer inserts its own new pages (1 page + 4 chunks of 1,024 floats); every acknowledged commit is durable (fsync). conflicts and retries come from the optimistic layer"));
        Ok(Value::Object(m))
    }

    fn write_hot(&mut self, atomic: bool) -> Result<Metric, String> {
        let records = self.rec()?;
        let name = format!(
            "hot-{}-{}",
            if atomic { "atomic" } else { "rmw" },
            self.nonce
        );
        let before = self.stats();
        let start = records.counter(&name).map_err(|e| e.to_string())?;
        let (lat, ok, errors, wall) = self.run_threads(16, self.secs(), |_, stop| {
            let mut w = Worker {
                lat: Lat::default(),
                errors: 0,
                ok: 0,
            };
            while !stop.load(Ordering::Relaxed) {
                let t = Instant::now();
                let r = if atomic {
                    records.add_counter(&name, 1)
                } else {
                    records.increment_counter(&name, 1).map(|_| ())
                };
                match r {
                    Ok(()) => w.ok += 1,
                    Err(_) => w.errors += 1,
                }
                w.lat.push(t.elapsed());
            }
            w
        });
        let end = records.counter(&name).map_err(|e| e.to_string())?;
        let correct = end - start == ok as i64;
        if !correct {
            self.failed_checks.push(format!(
                "{} lost updates: counter moved {} but {ok} commits were acknowledged",
                if atomic {
                    "write_hot_w16_atomic"
                } else {
                    "write_hot_w16"
                },
                end - start
            ));
        }
        let mut m = lat.metric(wall);
        m.insert("writers".into(), json!(16));
        m.insert("committed".into(), json!(ok));
        m.insert("failed".into(), json!(errors));
        m.insert("counter_delta".into(), json!(end - start));
        m.insert("correct".into(), json!(correct));
        self.add_commit_stats(&mut m, before);
        m.insert(
            "note".into(),
            json!(if atomic {
                "same workload with the conflict-free atomic add: no read, so no conflicts; the pipeline adds in commit order"
            } else {
                "16 writers do read-modify-write on ONE key: each commit invalidates every other in-flight transaction, so most attempts conflict and retry (randomized backoff). correct = counter delta equals acknowledged commits"
            }),
        );
        Ok(Value::Object(m))
    }

    // ---- crash and second process --------------------------------------------------------------

    fn crash_recovery(&mut self) -> Result<Metric, String> {
        self.close();
        let kill_after = Duration::from_secs(if self.cfg.quick { 1 } else { 2 });
        let args = self.child_args("child-crash", &[]);
        let run = run_crash_writer(&args, kill_after, Duration::from_secs(300))
            .map_err(|e| e.to_string())?;
        let t0 = Instant::now();
        let reopened = self.open();
        let reopen_ms = t0.elapsed().as_secs_f64() * 1000.0;
        if let Err(e) = reopened {
            let m = json!({"n": 0, "acked": run.acked.len(), "reopen_ms": round3(reopen_ms), "reopened": false, "consistent": false, "lost": null,
                           "error": format!("the store did not reopen after SIGKILL: {e}")});
            self.failed_checks
                .push("crash_recovery: store did not reopen".into());
            return Ok(m);
        }
        if !run.ready {
            return Ok(metric_err(format!(
                "crash writer never became ready: {}",
                run.stderr.chars().take(300).collect::<String>()
            )));
        }
        let records = self.rec()?;
        let lost = count_lost(&records, &run.acked);
        let problems =
            check_consistency(&records, self.cfg.commit_log).map_err(|e| e.to_string())?;
        let version = records.db().published_version();
        let max_acked = run.acked.iter().map(|a| a.2).max().unwrap_or(0);
        let mut problems = problems;
        if max_acked > version {
            problems.push(format!("an acknowledged commit (version {max_acked}) is newer than the recovered version {version}"));
        }
        // The reopened store must accept writes again.
        let writable = records
            .put_page_with_chunks(
                &synth_page(records.alloc_page_id(), "bench-crash", "after-crash"),
                &random_chunks(&mut Rng::new(5), 4),
            )
            .is_ok();
        let consistent = problems.is_empty();
        if lost > 0 || !consistent || !writable {
            self.failed_checks.push(format!(
                "crash_recovery: lost {lost}, consistent {consistent}, writable {writable}"
            ));
        }
        Ok(json!({
            "n": 1,
            "acked": run.acked.len(),
            "lost": lost,
            "reopen_ms": round3(reopen_ms),
            "consistent": consistent,
            "writable_after": writable,
            "problems": problems,
            "recovered_version": version,
            "max_acked_version": max_acked,
            "kill_after_s": kill_after.as_secs(),
            "note": "child writes 4-chunk pages with 4 threads, acknowledges each durable commit on a pipe, and is SIGKILLed after the delay; reopen_ms covers open + commit-pipeline start + page-id scan. lost = acknowledged pages missing or with different chunks",
        }))
    }

    /// The deterministic simulations (see simrun.rs), run in a child process so their memory and
    /// any panic stay out of this run's numbers. Seed counts are fixed so runs are comparable.
    fn sim_metrics(&mut self, names: &[&str]) {
        self.close();
        let (seeds, kill_seeds) = if self.cfg.quick { (50, 10) } else { (500, 40) };
        let dir = format!("{}-sim", self.cfg.store.display());
        let engine = self.cfg.engine.name();
        let args: Vec<String> = [
            "sim",
            "--engine",
            engine,
            "--seeds",
            &seeds.to_string(),
            "--kill-seeds",
            &kill_seeds.to_string(),
            "--store",
            &dir,
            "--json",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let run = match run_child(&args, Duration::from_secs(900)) {
            Ok(r) => r,
            Err(e) => {
                for n in names.iter().filter(|n| self.wants(n)).collect::<Vec<_>>() {
                    self.set(
                        n,
                        metric_err(format!("could not start the simulation: {e}")),
                    );
                }
                return;
            }
        };
        for line in run.stderr.lines().filter(|l| l.contains("sim_")) {
            self.log(line);
        }
        let doc = last_json_line(&run.stdout);
        let rows = doc.as_ref().and_then(|d| d[engine].as_object());
        for n in names.iter().filter(|n| self.wants(n)).collect::<Vec<_>>() {
            match rows.and_then(|r| r.get(*n)) {
                Some(row) => {
                    let bad: u64 = ["lost", "torn", "nonserializable", "corrupt"]
                        .iter()
                        .map(|k| row[*k].as_u64().unwrap_or(0))
                        .sum();
                    // The negative control is supposed to find violations.
                    if bad > 0 && *n != "sim_negative_control" {
                        self.failed_checks
                            .push(format!("{n}: {bad} violation(s); see repro_note"));
                    }
                    self.set(n, row.clone());
                }
                None if *n == "sim_negative_control" && engine != "redb" => {}
                None => self.set(
                    n,
                    metric_err(format!(
                        "the simulation produced no {n} row (timed out: {}): {}",
                        run.timed_out,
                        run.stderr
                            .chars()
                            .rev()
                            .take(300)
                            .collect::<String>()
                            .chars()
                            .rev()
                            .collect::<String>()
                    )),
                ),
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn second_process(&mut self) -> Result<Metric, String> {
        self.ensure_pages()?;
        let records = self.rec()?;
        let (_, source, slug) = self.pages[0].clone();
        let timeout = Duration::from_secs(if self.cfg.quick { 8 } else { 20 });
        // 1. Try to open the store files directly while the owner holds them.
        let args = self.child_args(
            "child-probe-open",
            &[("--source", &source), ("--slug", &slug)],
        );
        let run = run_child(&args, timeout).map_err(|e| e.to_string())?;
        let out = last_json_line(&run.stdout);
        let outcome = if run.timed_out {
            format!("no answer within {} s (killed)", timeout.as_secs())
        } else {
            match &out {
                Some(o) if o["ok"] == true => format!("opened: second process opened the store files directly and read a page in {:.1} ms (writes through it would bypass the commit pipeline)", o["first_get_ms"].as_f64().unwrap_or(0.0)),
                Some(o) => format!("refused after {:.0} ms: {}", o["open_ms"].as_f64().unwrap_or(run.wall_ms), o["message"].as_str().unwrap_or("unknown")),
                None => format!("no result from probe: {}", run.stderr.chars().take(200).collect::<String>()),
            }
        };
        // 2. The owner-socket path: a second process becomes a client of the owner.
        let sock = self.cfg.store.with_extension("owner.sock");
        let server = OwnerServer::start(records.clone(), &sock).map_err(|e| e.to_string())?;
        let keys_path = self.cfg.store.with_extension("owner-keys.tsv");
        let mut rng = Rng::new(51);
        let keys: String = (0..1000)
            .map(|_| {
                let (_, s, sl) = &self.pages[rng.below(self.pages.len())];
                format!("{s}\t{sl}\n")
            })
            .collect();
        std::fs::write(&keys_path, keys).map_err(|e| e.to_string())?;
        let clients = if self.cfg.quick { 2 } else { 4 };
        let (gets, puts) = if self.cfg.quick { (200, 5) } else { (2000, 50) };
        let handles: Vec<_> = (0..clients)
            .map(|c| {
                let args = vec![
                    "child-owner-client".to_string(),
                    "--socket".into(),
                    sock.display().to_string(),
                    "--keys".into(),
                    keys_path.display().to_string(),
                    "--gets".into(),
                    gets.to_string(),
                    "--puts".into(),
                    puts.to_string(),
                    "--seed".into(),
                    (900 + c).to_string(),
                ];
                std::thread::spawn(move || run_child(&args, Duration::from_secs(120)))
            })
            .collect();
        let mut get = Lat::default();
        let mut put = Lat::default();
        let mut errors = 0u64;
        let mut failed_clients = 0;
        let mut first_error = String::new();
        let t0 = Instant::now();
        for h in handles {
            match h.join() {
                Ok(Ok(r)) => match last_json_line(&r.stdout) {
                    Some(o) if o["ok"] == true => {
                        for (key, lat) in [("get_us", &mut get), ("put_us", &mut put)] {
                            for us in o[key]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(|x| x.as_u64())
                            {
                                lat.push(Duration::from_micros(us));
                            }
                        }
                        errors += o["errors"].as_u64().unwrap_or(0);
                        if first_error.is_empty() {
                            first_error = o["first_error"].as_str().unwrap_or("").to_string();
                        }
                    }
                    _ => failed_clients += 1,
                },
                _ => failed_clients += 1,
            }
        }
        let wall = t0.elapsed().as_secs_f64();
        drop(server);
        let _ = std::fs::remove_file(&keys_path);
        if errors > 0 || failed_clients > 0 {
            self.failed_checks.push(format!("second_process: {errors} client errors, {failed_clients} failed client processes ({first_error})"));
        }
        Ok(json!({
            "n": 1,
            "outcome": outcome,
            "probe_wall_ms": round3(run.wall_ms),
            "client_processes": clients,
            "client_get_page_p50_ms": round3(get.pct_ms(50.0)),
            "client_get_page_p99_ms": round3(get.pct_ms(99.0)),
            "client_get_page_ops_per_s": round1(get.len() as f64 / wall.max(1e-9)),
            "client_put_page_p50_ms": round3(put.pct_ms(50.0)),
            "client_put_page_p99_ms": round3(put.pct_ms(99.0)),
            "client_errors": errors,
            "client_failed_processes": failed_clients,
            "note": "the direct open is attempted by a second process while this one holds the store open; the owner-socket clients (Unix socket, one thread per connection, owner commits through the same pipeline) never touch the store files, so no client ever sees a busy or lock error",
        }))
    }
}

fn recall(l: &Loaded, hits: &[(f32, u32)], truth: &[u32]) -> f64 {
    let got: Vec<u64> = hits.iter().filter_map(|h| l.corpus_row(h.1)).collect();
    truth.iter().filter(|t| got.contains(&(**t as u64))).count() as f64 / truth.len().max(1) as f64
}

fn summarize(m: &Value) -> String {
    let get = |k: &str| m.get(k).filter(|v| !v.is_null()).map(|v| v.to_string());
    [
        "ms",
        "seconds",
        "chunks_per_s",
        "p50_ms",
        "p99_ms",
        "ops_per_s",
        "conflicts",
        "acked",
        "lost",
        "consistent",
        "outcome",
        "bytes",
    ]
    .iter()
    .filter_map(|k| get(k).map(|v| format!("{k}={v}")))
    .collect::<Vec<_>>()
    .join(" ")
}

pub fn write_result(path: &Path, doc: &Value) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_vec_pretty(doc).unwrap_or_default())?;
    std::fs::rename(tmp, path)
}
