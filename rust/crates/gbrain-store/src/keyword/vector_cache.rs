//! A bounded, process-wide cache of the keyword vectors the members rebuild on every query.
//!
//! The store keeps no `search_vector`: each member rebuilds a chunk's (`filters::chunk_vector`)
//! or a page's (`titles::page_vector`) vector from its text. `to_tsvector` is most of a query's
//! time, so the rebuilt vectors are cached here.
//!
//! The key is the exact input text: the text search configuration, the vector kind, and every
//! text the vector is built from, each with its byte length. A vector is a pure function of that
//! key, so a hit is always the vector a rebuild would give. No write needs to clear the cache, and
//! it is safe for a store bound to a transaction and across stores in one process. A rebuild that
//! fails (a vector over the size limit) is not cached and fails again on the next query.
//!
//! The cache keeps at most [`VECTOR_CACHE_BYTES`] of keys and vectors (an estimate of their heap
//! size). It keeps two generations: a hit in the older one moves to the newer one, and when the
//! newer one holds half the bound, the older one is dropped and the newer one takes its place. An
//! entry larger than half the bound is not cached.

use std::collections::HashMap;
use std::mem::size_of;
use std::sync::{Arc, Mutex, OnceLock};

use super::tsearch::{TsEntry, TsVector};
use crate::error::Result;

/// The cache bound in bytes: 64 MiB.
pub(super) const VECTOR_CACHE_BYTES: usize = 64 << 20;

/// The text search configuration the members build vectors with (they refuse every other one).
const CONFIG: &str = "english";

/// The fixed cost counted for one entry besides its key and vector (the map slot and the `Arc`).
const ENTRY_OVERHEAD: usize = 64;

/// What a cached vector is built from; part of the key.
#[derive(Debug, Clone, Copy)]
pub(super) enum VectorKind {
    /// `chunk_vector`: doc comment, qualified symbol name, chunk text.
    Chunk = 1,
    /// `page_vector`, sealed form: title, sealed timeline.
    PageSealed = 2,
    /// `page_vector`, trigger form: title, raw timeline (or lead), joined timeline entries.
    PageTrigger = 3,
}

type Key = Box<[u8]>;

struct Generations {
    budget: usize,
    hot: HashMap<Key, (Arc<TsVector>, usize)>,
    cold: HashMap<Key, (Arc<TsVector>, usize)>,
    hot_bytes: usize,
    cold_bytes: usize,
}

impl Generations {
    fn new(budget: usize) -> Self {
        Self {
            budget,
            hot: HashMap::new(),
            cold: HashMap::new(),
            hot_bytes: 0,
            cold_bytes: 0,
        }
    }

    fn get(&mut self, key: &[u8]) -> Option<Arc<TsVector>> {
        if let Some((vector, _)) = self.hot.get(key) {
            return Some(vector.clone());
        }
        let (key, (vector, bytes)) = self.cold.remove_entry(key)?;
        self.cold_bytes -= bytes;
        self.put(key, vector.clone(), bytes);
        Some(vector)
    }

    fn put(&mut self, key: Key, vector: Arc<TsVector>, bytes: usize) {
        if bytes > self.budget / 2 {
            return;
        }
        if self.hot_bytes + bytes > self.budget / 2 {
            self.cold = std::mem::take(&mut self.hot);
            self.cold_bytes = self.hot_bytes;
            self.hot_bytes = 0;
        }
        if let Some((_, old)) = self.hot.insert(key, (vector, bytes)) {
            self.hot_bytes -= old;
        }
        self.hot_bytes += bytes;
    }

    #[cfg(test)]
    fn bytes(&self) -> usize {
        self.hot_bytes + self.cold_bytes
    }
}

/// The key bytes: the configuration, the kind, then each part as its byte length and its bytes.
fn key(kind: VectorKind, parts: &[&str]) -> Key {
    let len = CONFIG.len() + 2 + parts.iter().map(|p| 8 + p.len()).sum::<usize>();
    let mut out = Vec::with_capacity(len);
    out.extend_from_slice(CONFIG.as_bytes());
    out.push(0);
    out.push(kind as u8);
    for part in parts {
        out.extend_from_slice(&(part.len() as u64).to_le_bytes());
        out.extend_from_slice(part.as_bytes());
    }
    out.into_boxed_slice()
}

/// An estimate of the heap bytes an entry holds.
fn entry_bytes(key: &[u8], vector: &TsVector) -> usize {
    let entries: usize = vector
        .entries
        .iter()
        .map(|e| size_of::<TsEntry>() + e.lexeme.capacity() + 2 * e.pos.capacity())
        .sum();
    ENTRY_OVERHEAD + key.len() + size_of::<TsVector>() + entries
}

fn cached_in(
    cache: &Mutex<Generations>,
    kind: VectorKind,
    parts: &[&str],
    build: impl FnOnce() -> Result<TsVector>,
) -> Result<Arc<TsVector>> {
    let key = key(kind, parts);
    // A poisoned lock only means another query panicked mid-update; the maps stay consistent.
    if let Some(hit) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return Ok(hit);
    }
    let vector = Arc::new(build()?);
    let bytes = entry_bytes(&key, &vector);
    cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .put(key, vector.clone(), bytes);
    Ok(vector)
}

fn global() -> &'static Mutex<Generations> {
    static CACHE: OnceLock<Mutex<Generations>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Generations::new(VECTOR_CACHE_BYTES)))
}

/// The vector of `kind` built from `parts`: the cached one, or `build()`'s, which is then cached.
/// `build` must depend only on `kind` and `parts`.
pub(super) fn cached(
    kind: VectorKind,
    parts: &[&str],
    build: impl FnOnce() -> Result<TsVector>,
) -> Result<Arc<TsVector>> {
    cached_in(global(), kind, parts, build)
}

#[cfg(test)]
mod tests {
    use super::super::tsearch::to_tsvector;
    use super::*;
    use crate::error::StoreError;

    fn build(text: &str) -> impl FnOnce() -> Result<TsVector> + '_ {
        move || to_tsvector(text)
    }

    #[test]
    fn a_hit_is_the_vector_a_rebuild_gives_and_the_key_splits_parts_and_kinds() {
        let cache = Mutex::new(Generations::new(1 << 20));
        let first = cached_in(
            &cache,
            VectorKind::Chunk,
            &["", "", "quasar orbits"],
            build("quasar orbits"),
        )
        .unwrap();
        let again = cached_in(
            &cache,
            VectorKind::Chunk,
            &["", "", "quasar orbits"],
            || panic!("rebuilt"),
        )
        .unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        assert_eq!(*again, to_tsvector("quasar orbits").unwrap());
        // The same bytes split into other parts, or another kind, are another key.
        let mut built = 0;
        for (kind, parts) in [
            (VectorKind::Chunk, ["", "quasar orbits", ""]),
            (VectorKind::PageSealed, ["", "", "quasar orbits"]),
            (VectorKind::Chunk, ["", "", "quasar orbit"]),
        ] {
            cached_in(&cache, kind, &parts, || {
                built += 1;
                to_tsvector("x")
            })
            .unwrap();
        }
        assert_eq!(built, 3);
    }

    #[test]
    fn a_failed_build_is_not_cached() {
        let cache = Mutex::new(Generations::new(1 << 20));
        let err = cached_in(&cache, VectorKind::Chunk, &["big"], || {
            Err(StoreError::invalid("too long"))
        });
        assert!(err.is_err());
        let ok = cached_in(&cache, VectorKind::Chunk, &["big"], build("big")).unwrap();
        assert_eq!(*ok, to_tsvector("big").unwrap());
    }

    #[test]
    fn the_cache_stays_within_its_bound_and_keeps_recent_hits() {
        let budget = 16 * 1024;
        let cache = Mutex::new(Generations::new(budget));
        let texts: Vec<String> = (0..400)
            .map(|i| format!("word{i} lexeme{i} token{i}"))
            .collect();
        for (i, text) in texts.iter().enumerate() {
            cached_in(&cache, VectorKind::Chunk, &[text], build(text)).unwrap();
            // Touch the first text every time, so it always stays in the newer generation or moves back.
            cached_in(&cache, VectorKind::Chunk, &[&texts[0]], build(&texts[0])).unwrap();
            assert!(
                cache.lock().unwrap().bytes() <= budget,
                "over the bound after {i}"
            );
        }
        cached_in(&cache, VectorKind::Chunk, &[&texts[0]], || {
            panic!("evicted a recent hit")
        })
        .unwrap();
        // An old entry that nobody read is gone.
        let mut rebuilt = false;
        cached_in(&cache, VectorKind::Chunk, &[&texts[1]], || {
            rebuilt = true;
            to_tsvector(&texts[1])
        })
        .unwrap();
        assert!(rebuilt);
        // An entry over half the bound is not cached.
        let huge = "lexeme ".repeat(4000);
        let small = Mutex::new(Generations::new(1024));
        cached_in(&small, VectorKind::Chunk, &[&huge], build(&huge)).unwrap();
        assert_eq!(small.lock().unwrap().bytes(), 0);
    }
}
