//! An opt-in Okapi BM25 ranker for the keyword arm (`arm.rs`) and the title arm (`titles.rs`),
//! an experiment beside the `ts_rank` / `ts_rank_cd` compatibility rankers (design D5).
//!
//! The config entry `search.keyword_ranker` picks the ranker. No entry, or `ts_rank`, keeps the
//! compatibility rankers, and the arms then run exactly as before: this file is not reached.
//! `bm25` ranks with BM25; `bm25_prox` adds a term-proximity bonus. `search.bm25_k1` (default
//! 1.2, at least 0) and `search.bm25_b` (default 0.75, from 0 to 1) set the parameters. Any other
//! value refuses the search (`invalid_argument`), so a typo is never served as the default.
//!
//! A document is what the arm ranks: a chunk vector (keyword arm) or a page vector (title arm).
//!
//! - `tf` of a query lexeme sums one boost per stored position, from the position's weight
//!   relative to weight B, the weight of chunk text: A 2.5, B 1, C 0.5, D 0.25 (the ratios of the
//!   Postgres default weights {D 0.1, C 0.2, B 0.4, A 1.0}). A lexeme without positions counts
//!   as one D position.
//! - The document length is its number of distinct lexemes (the entries of its vector, which
//!   are also the entries its keyword-index forward record lists), so the index and the scan
//!   give the same length without rebuilding a vector.
//! - `N` and the average length are taken over every document of the kind; `df` is the number
//!   of documents holding the lexeme (its postings, or a scan of every vector when the index
//!   does not serve the read). With the index, `N` and the average are cached per open store and
//!   commit sequence, so they can lag a write that commits while the query runs by that write.
//! - `idf = ln(1 + (N - df + 0.5) / (df + 0.5))` (never negative). Only the lexemes the query
//!   can match positively count; a lexeme under `!` does not.
//! - `bm25_prox` adds `ln(0.3 + exp(-d)) - ln(0.3)` (0 to 1.47), where `d` is the smallest
//!   distance between positions of two different query lexemes in the document.
//!
//! The arms multiply the score by the same phrase and source factors as the `ts_rank` score.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, OnceLock};

use super::filters::readable_chunk_vector;
use super::index::Postings;
use super::titles::readable_page_vector;
use super::tsearch::{QItem, TsQuery, TsVector, wep_pos, wep_weight};
use crate::Store;
use crate::chunks::read_chunks;
use crate::config::read_config;
use crate::error::{Result, StoreError};
use crate::keys::{self, KW_CHUNK_FORWARD, KW_CHUNK_POSTING, KW_PAGE_FORWARD, KW_PAGE_POSTING};
use crate::kv::{KvRead, scan_prefix};
use crate::pages::all_pages;

/// The config entry that picks the ranker.
pub(crate) const RANKER_KEY: &str = "search.keyword_ranker";
/// The config entries of the BM25 parameters.
pub(crate) const K1_KEY: &str = "search.bm25_k1";
pub(crate) const B_KEY: &str = "search.bm25_b";

pub(crate) const DEFAULT_K1: f64 = 1.2;
pub(crate) const DEFAULT_B: f64 = 0.75;

/// Boost per weight code (0 = D .. 3 = A), relative to weight B.
const BOOSTS: [f64; 4] = [0.25, 0.5, 1.0, 2.5];

/// `alpha` of the proximity bonus.
const PROX_ALPHA: f64 = 0.3;

/// The BM25 parameters.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Params {
    pub k1: f64,
    pub b: f64,
    pub prox: bool,
}

/// The ranker a keyword or title arm read uses.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Ranker {
    /// The `ts_rank` / `ts_rank_cd` compatibility ranker (the default).
    Compat,
    Bm25(Params),
}

fn number(read: &dyn KvRead, key: &str, default: f64, ok: impl Fn(f64) -> bool) -> Result<f64> {
    let Some(text) = read_config(read, key)? else {
        return Ok(default);
    };
    match text.trim().parse::<f64>() {
        Ok(v) if v.is_finite() && ok(v) => Ok(v),
        _ => Err(StoreError::invalid(format!(
            "{key} is '{text}', which is not a number in its range; the keyword search did not run"
        ))),
    }
}

impl Ranker {
    /// The ranker the config in `read` picks.
    pub(crate) fn read(read: &dyn KvRead) -> Result<Self> {
        let prox = match read_config(read, RANKER_KEY)?.as_deref().map(str::trim) {
            None | Some("ts_rank") => return Ok(Ranker::Compat),
            Some("bm25") => false,
            Some("bm25_prox") => true,
            Some(other) => {
                return Err(StoreError::invalid(format!(
                    "{RANKER_KEY} is '{other}'; it must be ts_rank, bm25 or bm25_prox, so the keyword search did not run"
                )));
            }
        };
        Ok(Ranker::Bm25(Params {
            k1: number(read, K1_KEY, DEFAULT_K1, |v| v >= 0.0)?,
            b: number(read, B_KEY, DEFAULT_B, |v| (0.0..=1.0).contains(&v))?,
            prox,
        }))
    }
}

/// The documents a ranker reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum DocKind {
    Chunk,
    Page,
}

impl DocKind {
    fn forward_tag(self) -> u8 {
        match self {
            DocKind::Chunk => KW_CHUNK_FORWARD,
            DocKind::Page => KW_PAGE_FORWARD,
        }
    }

    fn posting_kind(self) -> u8 {
        match self {
            DocKind::Chunk => KW_CHUNK_POSTING,
            DocKind::Page => KW_PAGE_POSTING,
        }
    }
}

/// `N` and the average document length.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Corpus {
    pub n: f64,
    pub avgdl: f64,
}

impl Corpus {
    fn of(n: usize, total: usize) -> Self {
        Corpus {
            n: n as f64,
            avgdl: if n == 0 { 0.0 } else { total as f64 / n as f64 },
        }
    }
}

/// The lexemes of a forward record of `kind` (`index.rs`: `kind(1) len(2) text` entries).
pub(crate) fn forward_len(bytes: &[u8], kind: u8) -> usize {
    let (mut at, mut count) = (0, 0);
    while at + 3 <= bytes.len() {
        let len = usize::from(u16::from_be_bytes([bytes[at + 1], bytes[at + 2]]));
        if bytes[at] == kind {
            count += 1;
        }
        at = (at + 3 + len).min(bytes.len());
    }
    count
}

/// A document's length from its forward record: the index path.
pub(crate) fn indexed_len(read: &dyn KvRead, kind: DocKind, key: &[u8]) -> Result<usize> {
    Ok(read
        .get(key)?
        .map_or(0, |bytes| forward_len(&bytes, kind.posting_kind())))
}

/// The chunk forward key.
pub(crate) fn chunk_len_key(page_id: u64, index: u32) -> Vec<u8> {
    keys::chunk_forward(page_id, index)
}

/// The page forward key.
pub(crate) fn page_len_key(page_id: u64) -> Vec<u8> {
    keys::page_forward(page_id)
}

/// `N` and the average length from the forward records.
fn indexed_corpus(read: &dyn KvRead, kind: DocKind) -> Result<Corpus> {
    let (mut n, mut total) = (0usize, 0usize);
    let posting = kind.posting_kind();
    scan_prefix(
        read,
        &[keys::TRIGRAM, kind.forward_tag()],
        false,
        &mut |_, v| {
            let len = forward_len(v, posting);
            if len > 0 {
                n += 1;
                total += len;
            }
            true
        },
    )?;
    Ok(Corpus::of(n, total))
}

type CacheKey = (usize, DocKind);

fn cache() -> &'static Mutex<HashMap<CacheKey, (u64, Corpus)>> {
    static CACHE: OnceLock<Mutex<HashMap<CacheKey, (u64, Corpus)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The most stores the cache keeps an entry for before it starts over.
const CACHE_STORES: usize = 64;

impl Store {
    /// `N` and the average length over the keyword index, for a read the index serves.
    pub(crate) fn bm25_indexed_corpus(&self, read: &dyn KvRead, kind: DocKind) -> Result<Corpus> {
        if self.bound.is_some() {
            return indexed_corpus(read, kind);
        }
        let key = (Arc::as_ptr(&self.kv) as *const () as usize, kind);
        let version = self.kv.version()?;
        if let Some((v, corpus)) = cache().lock().ok().and_then(|c| c.get(&key).copied())
            && v == version
        {
            return Ok(corpus);
        }
        let corpus = indexed_corpus(read, kind)?;
        if let Ok(mut c) = cache().lock() {
            if c.len() >= CACHE_STORES {
                c.clear();
            }
            c.insert(key, (version, corpus));
        }
        Ok(corpus)
    }
}

/// `N`, the average length and `df` of `words` by building every vector: the scan path.
pub(crate) fn scanned_stats(
    read: &dyn KvRead,
    kind: DocKind,
    words: &[String],
) -> Result<(Corpus, HashMap<String, usize>)> {
    let (mut n, mut total) = (0usize, 0usize);
    let mut df: HashMap<String, usize> = words.iter().map(|w| (w.clone(), 0)).collect();
    let mut count = |v: &TsVector| {
        if v.entries.is_empty() {
            return;
        }
        n += 1;
        total += v.entries.len();
        for w in words {
            if v.find(w).is_some() {
                *df.get_mut(w).expect("seeded") += 1;
            }
        }
    };
    for page in all_pages(read)? {
        match kind {
            DocKind::Chunk => {
                for chunk in read_chunks(read, page.id)? {
                    if let Some(v) = readable_chunk_vector(&chunk) {
                        count(&v);
                    }
                }
            }
            DocKind::Page => {
                if let Some(v) = readable_page_vector(read, &page)? {
                    count(&v);
                }
            }
        }
    }
    Ok((Corpus::of(n, total), df))
}

/// The lexemes `q` can match positively, each once, in query order: none under `!`.
pub(crate) fn positive_lexemes(q: &TsQuery) -> Vec<String> {
    // Prefix order puts an operator before its right operand, then its left (as
    // `Postings::candidates` walks it): walk from the end with a stack of lexeme sets.
    let mut stack: Vec<Vec<String>> = Vec::new();
    for item in q.items.iter().rev() {
        let next = match item {
            QItem::Val(word) => vec![word.clone()],
            QItem::Stop => Vec::new(),
            QItem::Opr {
                op: super::tsearch::Op::Not,
                ..
            } => {
                stack.pop();
                Vec::new()
            }
            QItem::Opr { .. } => {
                let right = stack.pop().unwrap_or_default();
                let mut left = stack.pop().unwrap_or_default();
                left.extend(right);
                left
            }
        };
        stack.push(next);
    }
    let mut seen = BTreeSet::new();
    stack
        .into_iter()
        .flatten()
        .filter(|w| seen.insert(w.clone()))
        .collect()
}

/// A BM25 scorer for one query over one corpus.
pub(crate) struct Scorer {
    params: Params,
    corpus: Corpus,
    /// The positive query lexemes with their idf.
    terms: Vec<(String, f64)>,
}

fn idf(n: f64, df: f64) -> f64 {
    (1.0 + (n - df + 0.5) / (df + 0.5)).ln()
}

impl Scorer {
    pub(crate) fn new(params: Params, corpus: Corpus, terms: Vec<(String, usize)>) -> Self {
        let terms = terms
            .into_iter()
            .map(|(w, df)| {
                let df = df as f64;
                (w, idf(corpus.n.max(df), df))
            })
            .collect();
        Scorer {
            params,
            corpus,
            terms,
        }
    }

    /// Builds the scorer for `q` from the postings the arm read (the index path).
    pub(crate) fn from_postings(
        params: Params,
        corpus: Corpus,
        q: &TsQuery,
        postings: &Postings,
    ) -> Self {
        let terms = positive_lexemes(q)
            .into_iter()
            .map(|w| {
                let df = postings.doc_freq(&w);
                (w, df)
            })
            .collect();
        Scorer::new(params, corpus, terms)
    }

    /// Builds the scorer for `q` from a scan of every vector (the scan path).
    pub(crate) fn from_scan(
        params: Params,
        read: &dyn KvRead,
        kind: DocKind,
        q: &TsQuery,
    ) -> Result<Self> {
        let words = positive_lexemes(q);
        let (corpus, df) = scanned_stats(read, kind, &words)?;
        let terms = words
            .into_iter()
            .map(|w| {
                let d = df.get(&w).copied().unwrap_or(0);
                (w, d)
            })
            .collect();
        Ok(Scorer::new(params, corpus, terms))
    }

    /// The BM25 score of `vector` (full or holding at least the query lexemes) of length `dl`.
    pub(crate) fn score(&self, vector: &TsVector, dl: usize) -> f64 {
        let Params { k1, b, prox } = self.params;
        let ratio = if self.corpus.avgdl > 0.0 {
            dl as f64 / self.corpus.avgdl
        } else {
            1.0
        };
        let norm = k1 * (1.0 - b + b * ratio);
        let mut score = 0.0;
        let mut positions: Vec<(u16, usize)> = Vec::new();
        for (t, (word, idf)) in self.terms.iter().enumerate() {
            let Some(at) = vector.find(word) else {
                continue;
            };
            let pos = &vector.entries[at].pos;
            let tf: f64 = if pos.is_empty() {
                BOOSTS[0]
            } else {
                pos.iter()
                    .map(|&p| BOOSTS[usize::from(wep_weight(p))])
                    .sum()
            };
            score += idf * tf * (k1 + 1.0) / (tf + norm);
            if prox {
                positions.extend(pos.iter().map(|&p| (wep_pos(p), t)));
            }
        }
        if prox {
            score += proximity(&mut positions);
        }
        score
    }
}

/// `ln(alpha + exp(-d)) - ln(alpha)` for the smallest distance `d` between positions of two
/// different terms; 0 when fewer than two terms have positions.
fn proximity(positions: &mut [(u16, usize)]) -> f64 {
    positions.sort_unstable();
    let mut best: Option<u16> = None;
    for pair in positions.windows(2) {
        let ((pa, ta), (pb, tb)) = (pair[0], pair[1]);
        if ta != tb {
            let d = pb - pa;
            best = Some(best.map_or(d, |b| b.min(d)));
        }
    }
    match best {
        Some(d) => (PROX_ALPHA + (-f64::from(d)).exp()).ln() - PROX_ALPHA.ln(),
        None => 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keyword::tsearch::{Weight, setweight, to_tsvector, websearch_to_tsquery};

    fn mem() -> Store {
        crate::test_support::store()
    }

    #[test]
    fn no_config_and_ts_rank_keep_the_compatibility_ranker() {
        let store = mem();
        let read = store.read().unwrap();
        assert_eq!(Ranker::read(&*read).unwrap(), Ranker::Compat);
        store.set_config(RANKER_KEY, "ts_rank").unwrap();
        let read = store.read().unwrap();
        assert_eq!(Ranker::read(&*read).unwrap(), Ranker::Compat);
    }

    #[test]
    fn bm25_reads_its_parameters_and_refuses_bad_values() {
        let store = mem();
        store.set_config(RANKER_KEY, "bm25").unwrap();
        let read = store.read().unwrap();
        assert_eq!(
            Ranker::read(&*read).unwrap(),
            Ranker::Bm25(Params {
                k1: 1.2,
                b: 0.75,
                prox: false
            })
        );
        store.set_config(RANKER_KEY, "bm25_prox").unwrap();
        store.set_config(K1_KEY, "0.9").unwrap();
        store.set_config(B_KEY, "0.4").unwrap();
        let read = store.read().unwrap();
        assert_eq!(
            Ranker::read(&*read).unwrap(),
            Ranker::Bm25(Params {
                k1: 0.9,
                b: 0.4,
                prox: true
            })
        );
        store.set_config(B_KEY, "1.5").unwrap();
        let read = store.read().unwrap();
        assert_eq!(Ranker::read(&*read).unwrap_err().code, "invalid_argument");
        store.set_config(B_KEY, "0.4").unwrap();
        store.set_config(RANKER_KEY, "bm52").unwrap();
        let read = store.read().unwrap();
        assert_eq!(Ranker::read(&*read).unwrap_err().code, "invalid_argument");
    }

    #[test]
    fn negated_lexemes_do_not_count() {
        let q = websearch_to_tsquery("alpha beta -gamma").unwrap();
        assert_eq!(positive_lexemes(&q), vec!["alpha", "beta"]);
        let q = websearch_to_tsquery("alpha or beta alpha").unwrap();
        assert_eq!(positive_lexemes(&q), vec!["alpha", "beta"]);
    }

    fn doc(text: &str) -> TsVector {
        setweight(to_tsvector(text).unwrap(), Weight::B)
    }

    #[test]
    fn rare_terms_short_documents_and_weights_score_higher() {
        let params = Params {
            k1: 1.2,
            b: 0.75,
            prox: false,
        };
        let corpus = Corpus {
            n: 100.0,
            avgdl: 4.0,
        };
        let s = Scorer::new(
            params,
            corpus,
            vec![("rare".into(), 1), ("common".into(), 90)],
        );
        let rare = doc("rare words here");
        let common = doc("common words here");
        assert!(s.score(&rare, 3) > s.score(&common, 3));
        // The same match in a longer document scores lower.
        assert!(s.score(&rare, 3) > s.score(&rare, 30));
        // A title (A) position counts more than body text (B).
        let title = setweight(to_tsvector("rare").unwrap(), Weight::A);
        assert!(s.score(&title, 3) > s.score(&rare, 3));
        // idf never goes negative, even for a lexeme in every document.
        assert!(idf(10.0, 10.0) > 0.0);
    }

    #[test]
    fn proximity_rewards_adjacent_terms_only_in_the_prox_variant() {
        let corpus = Corpus {
            n: 10.0,
            avgdl: 8.0,
        };
        let terms = || vec![("alpha".into(), 2), ("beta".into(), 2)];
        let near = doc("alpha beta one two three four five six");
        let far = doc("alpha one two three four five six beta");
        let plain = Scorer::new(
            Params {
                k1: 1.2,
                b: 0.75,
                prox: false,
            },
            corpus,
            terms(),
        );
        assert_eq!(plain.score(&near, 8), plain.score(&far, 8));
        let prox = Scorer::new(
            Params {
                k1: 1.2,
                b: 0.75,
                prox: true,
            },
            corpus,
            terms(),
        );
        assert!(prox.score(&near, 8) > prox.score(&far, 8));
        assert!(prox.score(&near, 8) - plain.score(&near, 8) <= (1.3f64 / 0.3).ln() + 1e-12);
    }

    #[test]
    fn forward_len_counts_only_its_kind() {
        let mut bytes = Vec::new();
        for (kind, text) in [
            (KW_PAGE_POSTING, "abc"),
            (0x03, "xyz"),
            (KW_PAGE_POSTING, "de"),
        ] {
            bytes.push(kind);
            bytes.extend_from_slice(&(text.len() as u16).to_be_bytes());
            bytes.extend_from_slice(text.as_bytes());
        }
        assert_eq!(forward_len(&bytes, KW_PAGE_POSTING), 2);
        assert_eq!(forward_len(&bytes, KW_CHUNK_POSTING), 0);
    }
}
