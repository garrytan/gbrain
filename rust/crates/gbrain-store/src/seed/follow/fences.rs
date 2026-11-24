//! The generation fence of deleted keys: tombstones and interval fences.
//!
//! A digest entry carries the generation of the call that wrote it, and an older call never
//! overwrites it. A delete removes the entry, and with it the generation, so two more records keep
//! the fence where no entry is left:
//!
//! - a tombstone, `M shadow_tomb/<relation>/<sort>`, value `generation(u64 big-endian)`: a key a
//!   `replaceRelationRows` call deleted. It holds no digest and is not an entry, so `relationDigest`
//!   and `relationEntries` never see it;
//! - an interval fence, `M shadow_fence/<relation>/<lo>`, value
//!   `generation(u64) || hi flag(u8) || hi`: a `replaceInterval` call read `[lo, hi)` at that
//!   generation. The fences of a relation are disjoint pieces of one function from sort key to
//!   generation (the highest generation that read the key), so a full pass leaves one fence per
//!   interval it read, however often it ran.
//!
//! A write at generation `g` to a sort key with no live entry is skipped when a tombstone or a
//! fence above `g` covers it. `replaceInterval` at `g` drops the tombstones inside its interval
//! with a generation up to `g`, which its own fence supersedes.

use crate::error::{Result, STORE_CORRUPT, StoreError};
use crate::keys;
use crate::kv::{KvRead, KvWrite, prefix_end};

fn tomb_prefix(relation: &str) -> Vec<u8> {
    keys::meta(&format!("shadow_tomb/{relation}/"))
}

fn fence_prefix(relation: &str) -> Vec<u8> {
    keys::meta(&format!("shadow_fence/{relation}/"))
}

fn corrupt() -> StoreError {
    StoreError::new(STORE_CORRUPT, "bad shadow tombstone or fence")
}

/// The generation of the tombstone of `sort`, `0` when it has none.
pub(super) fn tombstone(read: &dyn KvRead, relation: &str, sort: &[u8]) -> Result<u64> {
    let mut key = tomb_prefix(relation);
    key.extend_from_slice(sort);
    read.get(&key)?
        .map(|v| keys::be8(&v).ok_or_else(corrupt))
        .transpose()
        .map(Option::unwrap_or_default)
}

/// Records a tombstone of `generation` for `sort`; one of a higher generation stays.
pub(super) fn bury(
    tx: &mut dyn KvWrite,
    relation: &str,
    sort: &[u8],
    generation: u64,
) -> Result<()> {
    if tombstone(&*tx, relation, sort)? >= generation {
        return Ok(());
    }
    let mut key = tomb_prefix(relation);
    key.extend_from_slice(sort);
    tx.put(&key, &generation.to_be_bytes())
}

/// Removes the tombstone of `sort` when its generation is up to `generation`.
pub(super) fn lift(
    tx: &mut dyn KvWrite,
    relation: &str,
    sort: &[u8],
    generation: u64,
) -> Result<()> {
    let found = tombstone(&*tx, relation, sort)?;
    if found != 0 && found <= generation {
        let mut key = tomb_prefix(relation);
        key.extend_from_slice(sort);
        tx.delete(&key)?;
    }
    Ok(())
}

/// Removes the tombstones in `[lo, hi)` of a generation up to `generation`.
pub(super) fn lift_in(
    tx: &mut dyn KvWrite,
    relation: &str,
    lo: Option<&[u8]>,
    hi: Option<&[u8]>,
    generation: u64,
) -> Result<()> {
    let prefix = tomb_prefix(relation);
    let mut start = prefix.clone();
    start.extend_from_slice(lo.unwrap_or_default());
    let end = match hi {
        Some(hi) => {
            let mut end = prefix.clone();
            end.extend_from_slice(hi);
            end
        }
        None => prefix_end(&prefix).unwrap_or_else(|| vec![0xFF; 64]),
    };
    let mut doomed = Vec::new();
    if start < end {
        tx.scan(&start, &end, false, &mut |k, v| {
            if keys::be8(v).is_some_and(|g| g <= generation) {
                doomed.push(k.to_vec());
            }
            true
        })?;
    }
    for key in doomed {
        tx.delete(&key)?;
    }
    Ok(())
}

/// A position on the sort axis: bytes, or past every byte string (`true`).
type Pos = (bool, Vec<u8>);

fn lo_pos(lo: Option<&[u8]>) -> Pos {
    (false, lo.unwrap_or_default().to_vec())
}

fn hi_pos(hi: Option<&[u8]>) -> Pos {
    hi.map_or((true, Vec::new()), |hi| (false, hi.to_vec()))
}

/// One piece of the fence function: `generation` over `[lo, hi)`, `hi` unbounded when `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Piece {
    lo: Vec<u8>,
    hi: Option<Vec<u8>>,
    generation: u64,
}

impl Piece {
    fn start(&self) -> Pos {
        (false, self.lo.clone())
    }

    fn end(&self) -> Pos {
        hi_pos(self.hi.as_deref())
    }
}

/// The fences of one relation, loaded once per call.
pub(super) struct Fences {
    relation: String,
    /// Disjoint, in sort order, none of generation 0, adjacent ones of equal generation merged.
    pieces: Vec<Piece>,
}

impl Fences {
    pub(super) fn empty(relation: &str) -> Fences {
        Fences {
            relation: relation.to_owned(),
            pieces: Vec::new(),
        }
    }

    pub(super) fn load(read: &dyn KvRead, relation: &str) -> Result<Fences> {
        let prefix = fence_prefix(relation);
        let end = prefix_end(&prefix).unwrap_or_else(|| vec![0xFF; 64]);
        let mut pieces = Vec::new();
        let mut bad = false;
        read.scan(&prefix, &end, false, &mut |k, v| {
            match decode(&k[prefix.len()..], v) {
                Some(piece) => pieces.push(piece),
                None => bad = true,
            }
            !bad
        })?;
        if bad {
            return Err(corrupt());
        }
        Ok(Fences {
            relation: relation.to_owned(),
            pieces,
        })
    }

    /// The highest generation that read `sort` as absent or present: `0` when no fence covers it.
    pub(super) fn covering(&self, sort: &[u8]) -> u64 {
        let at = self.pieces.partition_point(|p| p.lo.as_slice() <= sort);
        at.checked_sub(1)
            .map(|i| &self.pieces[i])
            .filter(|p| p.hi.as_deref().is_none_or(|hi| sort < hi))
            .map_or(0, |p| p.generation)
    }

    /// Raises the fence over `[lo, hi)` to at least `generation` and stores the result.
    pub(super) fn raise(
        &mut self,
        tx: &mut dyn KvWrite,
        lo: Option<&[u8]>,
        hi: Option<&[u8]>,
        generation: u64,
    ) -> Result<()> {
        let (from, to) = (lo_pos(lo), hi_pos(hi));
        if generation == 0 || from >= to {
            return Ok(());
        }
        let mut points: Vec<Pos> = vec![from.clone(), to.clone()];
        for p in &self.pieces {
            points.push(p.start());
            points.push(p.end());
        }
        points.sort();
        points.dedup();
        let mut merged: Vec<Piece> = Vec::new();
        for pair in points.windows(2) {
            let (a, b) = (&pair[0], &pair[1]);
            let old = self
                .pieces
                .iter()
                .find(|p| p.start() <= *a && *a < p.end())
                .map_or(0, |p| p.generation);
            let inside = from <= *a && *b <= to;
            let generation = old.max(if inside { generation } else { 0 });
            if generation == 0 {
                continue;
            }
            let piece = Piece {
                lo: a.1.clone(),
                hi: if b.0 { None } else { Some(b.1.clone()) },
                generation,
            };
            match merged.last_mut() {
                Some(last)
                    if last.generation == generation
                        && last.hi.as_deref() == Some(piece.lo.as_slice()) =>
                {
                    last.hi = piece.hi;
                }
                _ => merged.push(piece),
            }
        }
        self.pieces = merged;
        self.store(tx)
    }

    fn store(&self, tx: &mut dyn KvWrite) -> Result<()> {
        let prefix = fence_prefix(&self.relation);
        let end = prefix_end(&prefix).unwrap_or_else(|| vec![0xFF; 64]);
        let mut old = Vec::new();
        tx.scan(&prefix, &end, false, &mut |k, _| {
            old.push(k.to_vec());
            true
        })?;
        for key in old {
            tx.delete(&key)?;
        }
        for piece in &self.pieces {
            let mut key = prefix.clone();
            key.extend_from_slice(&piece.lo);
            tx.put(&key, &encode(piece))?;
        }
        Ok(())
    }
}

fn encode(piece: &Piece) -> Vec<u8> {
    let mut out = piece.generation.to_be_bytes().to_vec();
    match &piece.hi {
        Some(hi) => {
            out.push(1);
            out.extend_from_slice(hi);
        }
        None => out.push(0),
    }
    out
}

fn decode(lo: &[u8], value: &[u8]) -> Option<Piece> {
    let generation = keys::be8(value.get(..8)?)?;
    let hi = match *value.get(8)? {
        0 => None,
        1 => Some(value[9..].to_vec()),
        _ => return None,
    };
    Some(Piece {
        lo: lo.to_vec(),
        hi,
        generation,
    })
}
