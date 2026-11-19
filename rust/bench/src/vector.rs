//! Exact vector scan baseline: top-k by dot product (vectors are unit length, so dot = cosine)
//! over a contiguous in-memory f32 matrix loaded from the store. Written so LLVM auto-vectorizes
//! (16 independent accumulators, `chunks_exact`); the AVX2+FMA build of the same loop is picked at
//! run time when the CPU has it, so the committed build stays portable (no target-cpu=native).
//! No ANN here: the follow-up (after parity) is usearch or an own HNSW, decided with data.

use crate::corpus::Corpus;
use crate::keys::*;
use crate::kv::*;
use crate::records::{chunk_parts, decode_page, Records, DIMS};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const K: usize = 10;

pub struct Matrix {
    pub data: Vec<f32>,
    pub rows: usize,
}

impl Matrix {
    pub fn row(&self, r: usize) -> &[f32] {
        &self.data[r * DIMS..(r + 1) * DIMS]
    }
}

/// Top-k hits kept as a small descending list.
#[derive(Clone)]
pub struct TopK {
    items: [(f32, u32); K],
    len: usize,
}

impl Default for TopK {
    fn default() -> Self {
        Self::new()
    }
}

impl TopK {
    pub fn new() -> Self {
        TopK {
            items: [(f32::NEG_INFINITY, 0); K],
            len: 0,
        }
    }
    #[inline(always)]
    pub fn push(&mut self, score: f32, row: u32) {
        if self.len == K && score <= self.items[K - 1].0 {
            return;
        }
        let mut i = self.len.min(K - 1);
        if self.len < K {
            self.len += 1;
        }
        while i > 0 && self.items[i - 1].0 < score {
            self.items[i] = self.items[i - 1];
            i -= 1;
        }
        self.items[i] = (score, row);
    }
    pub fn merge(&mut self, other: &TopK) {
        for &(s, r) in &other.items[..other.len] {
            self.push(s, r);
        }
    }
    pub fn hits(&self) -> &[(f32, u32)] {
        &self.items[..self.len]
    }
}

#[inline(always)]
fn dot_plain(a: &[f32], b: &[f32]) -> f32 {
    let mut acc = [0f32; 16];
    let (ac, bc) = (a.chunks_exact(16), b.chunks_exact(16));
    let (ar, br) = (ac.remainder(), bc.remainder());
    for (x, y) in ac.zip(bc) {
        for i in 0..16 {
            acc[i] += x[i] * y[i];
        }
    }
    let mut s: f32 = acc.iter().sum();
    for (x, y) in ar.iter().zip(br) {
        s += x * y;
    }
    s
}

#[inline(always)]
fn dot_fma(a: &[f32], b: &[f32]) -> f32 {
    let mut acc = [0f32; 16];
    let (ac, bc) = (a.chunks_exact(16), b.chunks_exact(16));
    let (ar, br) = (ac.remainder(), bc.remainder());
    for (x, y) in ac.zip(bc) {
        for i in 0..16 {
            acc[i] = x[i].mul_add(y[i], acc[i]);
        }
    }
    let mut s: f32 = acc.iter().sum();
    for (x, y) in ar.iter().zip(br) {
        s = x.mul_add(*y, s);
    }
    s
}

/// Which rows a scan visits.
#[derive(Clone, Copy)]
pub enum Rows<'a> {
    /// Every row in `[start, end)`.
    Range(usize, usize),
    /// An explicit list of allowed rows (the filter).
    List(&'a [u32]),
}

#[inline(always)]
fn scan_impl(
    data: &[f32],
    q: &[f32],
    rows: Rows,
    top: &mut TopK,
    dot: impl Fn(&[f32], &[f32]) -> f32,
) {
    match rows {
        Rows::Range(s, e) => {
            for (i, row) in data[s * DIMS..e * DIMS].chunks_exact(DIMS).enumerate() {
                top.push(dot(row, q), (s + i) as u32);
            }
        }
        Rows::List(list) => {
            for &r in list {
                let r = r as usize;
                top.push(dot(&data[r * DIMS..(r + 1) * DIMS], q), r as u32);
            }
        }
    }
}

fn scan_portable(data: &[f32], q: &[f32], rows: Rows, top: &mut TopK) {
    scan_impl(data, q, rows, top, dot_plain)
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2,fma")]
unsafe fn scan_avx2(data: &[f32], q: &[f32], rows: Rows, top: &mut TopK) {
    scan_impl(data, q, rows, top, dot_fma)
}

/// The scan kernel in use on this CPU: "avx2+fma" or "portable (baseline SSE2)".
pub fn simd_path() -> &'static str {
    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("avx2") && is_x86_feature_detected!("fma") {
            return "avx2+fma (runtime-detected)";
        }
    }
    "portable (baseline target features)"
}

pub fn scan(data: &[f32], q: &[f32], rows: Rows, top: &mut TopK) {
    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("avx2") && is_x86_feature_detected!("fma") {
            // SAFETY: the CPU features were just detected.
            unsafe { scan_avx2(data, q, rows, top) };
            return;
        }
    }
    scan_portable(data, q, rows, top)
}

/// Single-thread exact top-k.
pub fn top_k(m: &Matrix, q: &[f32], rows: Option<&[u32]>) -> TopK {
    let mut top = TopK::new();
    match rows {
        None => scan(&m.data, q, Rows::Range(0, m.rows), &mut top),
        Some(list) => scan(&m.data, q, Rows::List(list), &mut top),
    }
    top
}

/// All-core exact top-k: the row space is split into blocks, each scanned on a rayon worker.
pub fn top_k_mt(pool: &rayon::ThreadPool, m: &Matrix, q: &[f32], rows: Option<&[u32]>) -> TopK {
    let threads = pool.current_num_threads().max(1);
    pool.install(|| match rows {
        None => {
            let block = m.rows.div_ceil(threads * 4).max(1);
            (0..m.rows.div_ceil(block))
                .into_par_iter()
                .map(|b| {
                    let mut t = TopK::new();
                    scan(
                        &m.data,
                        q,
                        Rows::Range(b * block, ((b + 1) * block).min(m.rows)),
                        &mut t,
                    );
                    t
                })
                .reduce(TopK::new, |mut a, b| {
                    a.merge(&b);
                    a
                })
        }
        Some(list) => {
            let block = list.len().div_ceil(threads * 4).max(1);
            list.par_chunks(block)
                .map(|part| {
                    let mut t = TopK::new();
                    scan(&m.data, q, Rows::List(part), &mut t);
                    t
                })
                .reduce(TopK::new, |mut a, b| {
                    a.merge(&b);
                    a
                })
        }
    })
}

// ---- loading from the store ------------------------------------------------------------------

/// Everything the vector arm needs from the store: the matrix plus, for each row, which page and
/// chunk it is, and each page's source, type and corpus chunk offset.
pub struct Loaded {
    pub matrix: Matrix,
    pub row_page: Vec<u64>,
    pub row_idx: Vec<u32>,
    /// page id -> (source, type)
    pub page_meta: HashMap<u64, (String, String)>,
    /// page id -> first corpus row (prefix sum of chunk counts in page-id order)
    pub corpus_start: HashMap<u64, u64>,
}

pub fn load_from_store(records: &Records, chunks_hint: usize) -> Result<Loaded> {
    let db = records.db();
    // Pages first (small), then every chunk record in key order.
    let (ps, pe) = (vec![PAGE], vec![PAGE + 1]);
    let mut page_meta = HashMap::new();
    let mut counts: Vec<(u64, u32)> = Vec::new();
    db.read(|snap| {
        let mut err = None;
        snap.scan(
            Table::Data,
            &ps,
            &pe,
            false,
            &mut |_, v| match decode_page(v) {
                Ok(p) => {
                    counts.push((p.id, p.chunk_count));
                    page_meta.insert(p.id, (p.source_id, p.page_type));
                    true
                }
                Err(e) => {
                    err = Some(e);
                    false
                }
            },
        )?;
        err.map_or(Ok(()), Err)
    })?;
    counts.sort_unstable();
    let mut corpus_start = HashMap::with_capacity(counts.len());
    let mut acc = 0u64;
    for (id, n) in counts {
        corpus_start.insert(id, acc);
        acc += n as u64;
    }

    let mut data: Vec<f32> = Vec::with_capacity(chunks_hint * DIMS);
    let mut row_page = Vec::with_capacity(chunks_hint);
    let mut row_idx = Vec::with_capacity(chunks_hint);
    let (cs, ce) = all_chunks_range();
    db.read(|snap| {
        let mut err = None;
        snap.scan(Table::Data, &cs, &ce, false, &mut |k, v| {
            let Some((page, idx)) = parse_chunk_key(k) else {
                return true;
            };
            match chunk_parts(v) {
                Ok((vb, _)) if vb.len() == DIMS * 4 => {
                    data.extend(
                        vb.chunks_exact(4)
                            .map(|b| f32::from_le_bytes(b.try_into().unwrap())),
                    );
                    row_page.push(page);
                    row_idx.push(idx);
                    true
                }
                Ok(_) => {
                    err = Some(Error::Corrupt(
                        "chunk vector has the wrong dimension".into(),
                    ));
                    false
                }
                Err(e) => {
                    err = Some(e);
                    false
                }
            }
        })?;
        err.map_or(Ok(()), Err)
    })?;
    let rows = row_page.len();
    Ok(Loaded {
        matrix: Matrix { data, rows },
        row_page,
        row_idx,
        page_meta,
        corpus_start,
    })
}

impl Loaded {
    /// Rows whose page satisfies `pred(source, type)`.
    pub fn allowed_rows(&self, pred: impl Fn(&str, &str) -> bool) -> Vec<u32> {
        (0..self.matrix.rows)
            .filter(|&r| {
                self.page_meta
                    .get(&self.row_page[r])
                    .is_some_and(|(s, t)| pred(s, t))
            })
            .map(|r| r as u32)
            .collect()
    }

    /// Corpus row (the row in vectors.f32) of a store row, if the page came from the corpus import.
    pub fn corpus_row(&self, r: u32) -> Option<u64> {
        let r = r as usize;
        self.corpus_start
            .get(&self.row_page[r])
            .map(|s| s + self.row_idx[r] as u64)
    }
}

// ---- ground truth ----------------------------------------------------------------------------

pub struct Truth {
    pub top: Vec<Vec<u32>>,
}

/// Format tag of `truth_top10.json`; the TypeScript baseline writes and checks the same tag.
pub const TRUTH_FORMAT: &str = "gbrain-bench-truth/1";

/// Byte size and sha256 (lowercase hex) of one corpus file.
#[derive(Serialize, Deserialize, PartialEq, Eq, Debug, Clone)]
pub struct FileIdentity {
    pub bytes: u64,
    pub sha256: String,
}

/// The corpus files a cached truth was computed from. Same JSON layout as the TypeScript
/// baseline's `TruthFingerprint` (`rust/bench/baseline/lib/truth.ts`).
#[derive(Serialize, Deserialize, PartialEq, Eq, Debug, Clone)]
pub struct TruthFingerprint {
    pub k: usize,
    pub dims: usize,
    pub vectors: FileIdentity,
    pub queries: FileIdentity,
}

#[derive(Serialize, Deserialize)]
struct TruthFile {
    format: String,
    fingerprint: TruthFingerprint,
    top10: Vec<Vec<u32>>,
}

fn file_identity(path: &std::path::Path) -> std::result::Result<FileIdentity, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let name = path.display();
    let mut file = std::fs::File::open(path).map_err(|e| format!("{name}: {e}"))?;
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 8 << 20];
    let mut bytes = 0u64;
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("{name}: {e}"))?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
        bytes += n as u64;
    }
    let sha256 = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    Ok(FileIdentity { bytes, sha256 })
}

/// The identity of the corpus files the truth depends on: byte size and sha256 of `vectors.f32`
/// and `queries.f32`, with the dims and the top-N the truth holds.
pub fn truth_fingerprint(corpus: &Corpus) -> std::result::Result<TruthFingerprint, String> {
    Ok(TruthFingerprint {
        k: K,
        dims: corpus.manifest.dims,
        vectors: file_identity(&corpus.dir.join("vectors.f32"))?,
        queries: file_identity(&corpus.dir.join("queries.f32"))?,
    })
}

/// Return the exact top-10 of every query over the raw corpus vectors, from `truth_top10.json` in
/// the corpus directory when it was computed from these exact `vectors.f32` and `queries.f32`.
/// A missing file, a file with no fingerprint (the older bare array) or a different fingerprint is
/// recomputed and rewritten (atomically). The file is shared with the TypeScript baseline: one JSON
/// object with a `fingerprint` and `top10`, one entry per query, each the 10 nearest chunk row
/// indices (rows of vectors.f32), best first.
pub fn ensure_truth(corpus: &Corpus) -> std::result::Result<Truth, String> {
    let path = corpus.truth_path();
    let fingerprint = truth_fingerprint(corpus)?;
    if path.exists() {
        if let Ok(t) = read_truth(
            &path,
            &fingerprint,
            corpus.manifest.queries,
            corpus.manifest.chunks,
        ) {
            return Ok(t);
        }
    }
    let data = corpus.read_f32_file("vectors.f32")?;
    let rows = data.len() / DIMS;
    let m = Matrix { data, rows };
    let queries = corpus.queries()?;
    let nq = queries.len() / DIMS;
    let pool = rayon::ThreadPoolBuilder::new()
        .build()
        .map_err(|e| e.to_string())?;
    let mut top = Vec::with_capacity(nq);
    for q in 0..nq {
        let t = top_k_mt(&pool, &m, &queries[q * DIMS..(q + 1) * DIMS], None);
        top.push(t.hits().iter().map(|h| h.1).collect::<Vec<_>>());
    }
    let file = TruthFile {
        format: TRUTH_FORMAT.into(),
        fingerprint,
        top10: top,
    };
    let tmp = corpus
        .dir
        .join(format!("truth_top10.json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_vec(&file).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?; // atomic: readers never see half a file
    Ok(Truth { top: file.top10 })
}

/// Read a cached truth, refusing it unless its fingerprint equals `expected` and it holds at least
/// `min_queries` well-formed rows below `rows`.
pub fn read_truth(
    path: &std::path::Path,
    expected: &TruthFingerprint,
    min_queries: usize,
    rows: usize,
) -> std::result::Result<Truth, String> {
    let file: TruthFile = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let v = file.top10;
    if file.format != TRUTH_FORMAT
        || &file.fingerprint != expected
        || v.len() < min_queries
        || v.iter()
            .take(min_queries)
            .any(|r| r.len() != K || r.iter().any(|&x| x as usize >= rows))
    {
        return Err("truth_top10.json does not match this corpus".into());
    }
    Ok(Truth { top: v })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::Rng;

    fn random_matrix(rows: usize, seed: u64) -> Matrix {
        let mut rng = Rng::new(seed);
        let data = (0..rows * DIMS).map(|_| rng.unit_f32() - 0.5).collect();
        Matrix { data, rows }
    }

    fn brute(m: &Matrix, q: &[f32], rows: Option<&[u32]>) -> Vec<u32> {
        let mut all: Vec<(f32, u32)> = match rows {
            None => (0..m.rows as u32)
                .map(|r| (dot_plain(m.row(r as usize), q), r))
                .collect(),
            Some(l) => l
                .iter()
                .map(|&r| (dot_plain(m.row(r as usize), q), r))
                .collect(),
        };
        all.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        all.iter().take(K).map(|x| x.1).collect()
    }

    #[test]
    fn scan_matches_brute_force_single_and_multi_thread_and_filtered() {
        let m = random_matrix(3000, 7);
        let q: Vec<f32> = random_matrix(1, 99).data;
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(4)
            .build()
            .unwrap();
        let ids = |t: &TopK| t.hits().iter().map(|h| h.1).collect::<Vec<_>>();
        assert_eq!(ids(&top_k(&m, &q, None)), brute(&m, &q, None));
        assert_eq!(ids(&top_k_mt(&pool, &m, &q, None)), brute(&m, &q, None));
        let allowed: Vec<u32> = (0..3000u32).filter(|r| r % 7 == 3).collect();
        assert_eq!(
            ids(&top_k(&m, &q, Some(&allowed))),
            brute(&m, &q, Some(&allowed))
        );
        assert_eq!(
            ids(&top_k_mt(&pool, &m, &q, Some(&allowed))),
            brute(&m, &q, Some(&allowed))
        );
        assert!(top_k(&m, &q, Some(&[])).hits().is_empty());
    }

    #[test]
    fn avx2_and_portable_kernels_agree_on_the_ranking() {
        let m = random_matrix(500, 3);
        let q = random_matrix(1, 5).data;
        let mut a = TopK::new();
        scan_portable(&m.data, &q, Rows::Range(0, 500), &mut a);
        let b = top_k(&m, &q, None);
        assert_eq!(
            a.hits().iter().map(|h| h.1).collect::<Vec<_>>(),
            b.hits().iter().map(|h| h.1).collect::<Vec<_>>()
        );
    }

    #[test]
    fn topk_keeps_the_ten_best_in_order() {
        let mut t = TopK::new();
        for (i, s) in [
            0.5f32, 0.9, 0.1, 0.7, 0.3, 0.8, 0.2, 0.6, 0.4, 1.0, 0.95, 0.05,
        ]
        .iter()
        .enumerate()
        {
            t.push(*s, i as u32);
        }
        let scores: Vec<f32> = t.hits().iter().map(|h| h.0).collect();
        assert_eq!(
            scores,
            vec![1.0, 0.95, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]
        );
    }

    /// Write a tiny corpus (just the files ground truth reads) with `rows` chunks and 2 queries.
    fn write_tiny_corpus(dir: &std::path::Path, rows: usize, seed: u64) {
        std::fs::create_dir_all(dir).unwrap();
        let bytes =
            |m: &Matrix| -> Vec<u8> { m.data.iter().flat_map(|x| x.to_le_bytes()).collect() };
        std::fs::write(dir.join("vectors.f32"), bytes(&random_matrix(rows, seed))).unwrap();
        std::fs::write(
            dir.join("queries.f32"),
            bytes(&random_matrix(2, seed + 1000)),
        )
        .unwrap();
        let manifest = format!(
            r#"{{"format":"gbrain-bench-corpus/1","dims":{DIMS},"pages":{},"chunks":{rows},"queries":2,"sources":["default"]}}"#,
            rows / 4
        );
        std::fs::write(dir.join("manifest.json"), manifest).unwrap();
    }

    /// Ground truth belongs to the corpus files beside it. A corpus rebuilt in the same directory
    /// with the same shape but different vectors must get its own truth, not the cached one.
    #[test]
    fn a_rebuilt_corpus_of_the_same_size_gets_its_own_truth() {
        let dir = std::env::temp_dir().join(format!(
            "gbrain-truth-cache-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_tiny_corpus(&dir, 16, 1);
        let a = ensure_truth(&Corpus::open(&dir).unwrap()).unwrap();
        let again = ensure_truth(&Corpus::open(&dir).unwrap()).unwrap();
        assert_eq!(a.top, again.top, "an unchanged corpus reuses its truth");

        write_tiny_corpus(&dir, 16, 2);
        let corpus_b = Corpus::open(&dir).unwrap();
        let b = ensure_truth(&corpus_b).unwrap();
        let m = Matrix {
            data: corpus_b.read_f32_file("vectors.f32").unwrap(),
            rows: 16,
        };
        let queries = corpus_b.queries().unwrap();
        let exact: Vec<Vec<u32>> = (0..2)
            .map(|q| brute(&m, &queries[q * DIMS..(q + 1) * DIMS], None))
            .collect();
        assert_ne!(
            a.top, exact,
            "the two corpora must have different neighbors"
        );
        assert_eq!(b.top, exact);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
