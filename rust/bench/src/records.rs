//! The typed, gbrain-like record layer: pages, chunks (text + vector in the record) and counters,
//! expressed only as ordered keys and values over the optimistic layer.

use crate::keys::*;
use crate::kv::*;
use crate::occ::{Db, Txn};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

pub const DIMS: usize = 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct Page {
    pub id: u64,
    pub source_id: String,
    pub slug: String,
    pub page_type: String,
    pub title: String,
    /// Frontmatter as a JSON string.
    pub frontmatter: String,
    pub body: String,
    pub chunk_count: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Chunk {
    pub idx: u32,
    pub text: String,
    pub vector: Vec<f32>,
}

// ---- codec -----------------------------------------------------------------------------------

fn put_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let s = self
            .buf
            .get(self.pos..self.pos + n)
            .ok_or_else(|| Error::Corrupt("record truncated".into()))?;
        self.pos += n;
        Ok(s)
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn string(&mut self) -> Result<String> {
        let n = self.u32()? as usize;
        String::from_utf8(self.take(n)?.to_vec())
            .map_err(|_| Error::Corrupt("record is not utf-8".into()))
    }
}

pub fn encode_page(p: &Page) -> Vec<u8> {
    let mut out = Vec::with_capacity(64 + p.body.len() + p.frontmatter.len());
    out.extend_from_slice(&p.id.to_le_bytes());
    put_str(&mut out, &p.source_id);
    put_str(&mut out, &p.slug);
    put_str(&mut out, &p.page_type);
    put_str(&mut out, &p.title);
    put_str(&mut out, &p.frontmatter);
    put_str(&mut out, &p.body);
    out.extend_from_slice(&p.chunk_count.to_le_bytes());
    out
}

pub fn decode_page(buf: &[u8]) -> Result<Page> {
    let mut r = Reader { buf, pos: 0 };
    Ok(Page {
        id: r.u64()?,
        source_id: r.string()?,
        slug: r.string()?,
        page_type: r.string()?,
        title: r.string()?,
        frontmatter: r.string()?,
        body: r.string()?,
        chunk_count: r.u32()?,
    })
}

/// Chunk value: dims (u32), the vector as little-endian f32, then the text.
pub fn encode_chunk(c: &Chunk) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + c.vector.len() * 4 + c.text.len());
    out.extend_from_slice(&(c.vector.len() as u32).to_le_bytes());
    for f in &c.vector {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out.extend_from_slice(c.text.as_bytes());
    out
}

/// Split a chunk value into (vector bytes, text bytes) without copying.
pub fn chunk_parts(buf: &[u8]) -> Result<(&[u8], &[u8])> {
    let dims = u32::from_le_bytes(
        buf.get(0..4)
            .ok_or_else(|| Error::Corrupt("chunk truncated".into()))?
            .try_into()
            .unwrap(),
    ) as usize;
    let end = 4 + dims * 4;
    if buf.len() < end {
        return Err(Error::Corrupt("chunk vector truncated".into()));
    }
    Ok((&buf[4..end], &buf[end..]))
}

pub fn decode_chunk(idx: u32, buf: &[u8]) -> Result<Chunk> {
    let (vb, tb) = chunk_parts(buf)?;
    let vector = vb
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    let text = String::from_utf8(tb.to_vec())
        .map_err(|_| Error::Corrupt("chunk text is not utf-8".into()))?;
    Ok(Chunk { idx, text, vector })
}

fn encode_page_id_value(source: &str, slug: &str) -> Vec<u8> {
    let mut out = Vec::new();
    put_str(&mut out, source);
    put_str(&mut out, slug);
    out
}

pub fn decode_page_id_value(buf: &[u8]) -> Result<(String, String)> {
    let mut r = Reader { buf, pos: 0 };
    Ok((r.string()?, r.string()?))
}

// ---- the record layer ------------------------------------------------------------------------

pub struct Records {
    db: Arc<Db>,
    next_page_id: AtomicU64,
}

impl Records {
    pub fn open(db: Arc<Db>) -> Result<Self> {
        // Highest page id = last key of the page-id index (a reverse scan of one entry).
        let (s, e) = page_id_range();
        let mut max = 0u64;
        db.read(|snap| {
            snap.scan(Table::Data, &s, &e, true, &mut |k, _| {
                max = parse_page_id_key(k).unwrap_or(0);
                false
            })
        })?;
        Ok(Self {
            db,
            next_page_id: AtomicU64::new(max + 1),
        })
    }

    pub fn db(&self) -> &Arc<Db> {
        &self.db
    }

    /// Allocate a page id outside any transaction (so allocation never conflicts).
    pub fn alloc_page_id(&self) -> u64 {
        self.next_page_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Reserve ids up to and including `id` (the importer picks its own ids).
    pub fn bump_page_id_floor(&self, id: u64) {
        self.next_page_id.fetch_max(id + 1, Ordering::Relaxed);
    }

    fn write_page(txn: &mut Txn, page: &Page, chunks: &[Chunk]) {
        let mut p = page.clone();
        p.chunk_count = chunks.len() as u32;
        txn.put(page_key(&p.source_id, &p.slug), encode_page(&p));
        txn.put(
            page_id_key(p.id),
            encode_page_id_value(&p.source_id, &p.slug),
        );
        for c in chunks {
            txn.put(chunk_key(p.id, c.idx), encode_chunk(c));
        }
    }

    /// Upsert one page and replace its chunks, in one transaction. Returns the commit version.
    /// An existing page keeps its id (the id in `page` is only used for a new page).
    pub fn put_page_with_chunks(&self, page: &Page, chunks: &[Chunk]) -> Result<u64> {
        self.db
            .run_versioned(|txn| {
                let mut page = page.clone();
                if let Some(old) = txn.get(&page_key(&page.source_id, &page.slug))? {
                    let old = decode_page(&old)?;
                    page.id = old.id;
                    // Remove chunks the new version no longer has.
                    let (s, e) = page_chunks_range(old.id);
                    for (k, _) in txn.range(&s, &e, usize::MAX)? {
                        if let Some((_, idx)) = parse_chunk_key(&k) {
                            if !chunks.iter().any(|c| c.idx == idx) {
                                txn.delete(k);
                            }
                        }
                    }
                }
                Self::write_page(txn, &page, chunks);
                Ok(())
            })
            .map(|(_, v)| v)
    }

    /// Bulk load into an empty store: blind writes of many pages in one transaction. No reads,
    /// so it can never conflict.
    pub fn import_batch(&self, items: &[(Page, Vec<Chunk>)]) -> Result<()> {
        self.db.run(|txn| {
            for (page, chunks) in items {
                Self::write_page(txn, page, chunks);
            }
            Ok(())
        })?;
        if let Some((p, _)) = items.last() {
            self.bump_page_id_floor(p.id);
        }
        Ok(())
    }

    pub fn get_page(&self, source: &str, slug: &str) -> Result<Option<Page>> {
        self.db.read(
            |snap| match snap.get(Table::Data, &page_key(source, slug))? {
                Some(v) => Ok(Some(decode_page(&v)?)),
                None => Ok(None),
            },
        )
    }

    pub fn get_page_by_id(&self, id: u64) -> Result<Option<Page>> {
        self.db.read(|snap| {
            let Some(v) = snap.get(Table::Data, &page_id_key(id))? else {
                return Ok(None);
            };
            let (source, slug) = decode_page_id_value(&v)?;
            match snap.get(Table::Data, &page_key(&source, &slug))? {
                Some(v) => Ok(Some(decode_page(&v)?)),
                None => Ok(None),
            }
        })
    }

    /// `limit` pages of one source in slug order, starting at `from_slug` (inclusive).
    pub fn list_pages(&self, source: &str, from_slug: &str, limit: usize) -> Result<Vec<Page>> {
        let start = page_key(source, from_slug);
        let (_, end) = source_range(source);
        self.db.read(|snap| {
            let mut out = Vec::with_capacity(limit);
            let mut err = None;
            snap.scan(
                Table::Data,
                &start,
                &end,
                false,
                &mut |_, v| match decode_page(v) {
                    Ok(p) => {
                        out.push(p);
                        out.len() < limit
                    }
                    Err(e) => {
                        err = Some(e);
                        false
                    }
                },
            )?;
            match err {
                Some(e) => Err(e),
                None => Ok(out),
            }
        })
    }

    pub fn get_chunks(&self, page_id: u64) -> Result<Vec<Chunk>> {
        let (s, e) = page_chunks_range(page_id);
        self.db.read(|snap| {
            let mut out = Vec::new();
            let mut err = None;
            snap.scan(Table::Data, &s, &e, false, &mut |k, v| {
                let idx = parse_chunk_key(k).map(|x| x.1).unwrap_or(0);
                match decode_chunk(idx, v) {
                    Ok(c) => {
                        out.push(c);
                        true
                    }
                    Err(x) => {
                        err = Some(x);
                        false
                    }
                }
            })?;
            match err {
                Some(e) => Err(e),
                None => Ok(out),
            }
        })
    }

    /// Read-modify-write increment: the transaction reads the counter, so concurrent increments
    /// conflict and retry. Returns the new value.
    pub fn increment_counter(&self, name: &str, delta: i64) -> Result<i64> {
        let key = counter_key(name);
        self.db.run(|txn| {
            let cur = decode_counter(txn.get(&key)?)?;
            let next = cur + delta;
            txn.put(key.clone(), next.to_le_bytes().to_vec());
            Ok(next)
        })
    }

    /// Conflict-free increment (atomic add applied in commit order). Returns nothing: the
    /// resulting value is only known at commit.
    pub fn add_counter(&self, name: &str, delta: i64) -> Result<()> {
        let key = counter_key(name);
        self.db.run(|txn| txn.add_i64(key.clone(), delta))
    }

    pub fn counter(&self, name: &str) -> Result<i64> {
        self.db
            .read(|snap| decode_counter(snap.get(Table::Data, &counter_key(name))?))
    }

    /// (page id, source, slug) of every page, in page-id order.
    pub fn all_page_keys(&self) -> Result<Vec<(u64, String, String)>> {
        let (s, e) = page_id_range();
        self.db.read(|snap| {
            let mut out = Vec::new();
            let mut err = None;
            snap.scan(Table::Data, &s, &e, false, &mut |k, v| match (
                parse_page_id_key(k),
                decode_page_id_value(v),
            ) {
                (Some(id), Ok((src, slug))) => {
                    out.push((id, src, slug));
                    true
                }
                (_, Err(x)) => {
                    err = Some(x);
                    false
                }
                _ => true,
            })?;
            match err {
                Some(e) => Err(e),
                None => Ok(out),
            }
        })
    }
}

fn decode_counter(v: Option<Vec<u8>>) -> Result<i64> {
    match v {
        None => Ok(0),
        Some(v) if v.len() == 8 => Ok(i64::from_le_bytes(v.try_into().unwrap())),
        Some(_) => Err(Error::Corrupt("counter".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mem_store::MemStore;
    use crate::occ::Options;

    fn records() -> Records {
        let db = Db::open(Arc::new(MemStore::new()), Options::default()).unwrap();
        Records::open(Arc::new(db)).unwrap()
    }

    fn page(id: u64, source: &str, slug: &str) -> Page {
        Page {
            id,
            source_id: source.into(),
            slug: slug.into(),
            page_type: "note".into(),
            title: slug.into(),
            frontmatter: "{}".into(),
            body: "body".into(),
            chunk_count: 0,
        }
    }

    fn chunks(n: u32) -> Vec<Chunk> {
        (0..n)
            .map(|i| Chunk {
                idx: i,
                text: format!("chunk {i}"),
                vector: vec![i as f32; 4],
            })
            .collect()
    }

    #[test]
    fn record_round_trip_and_replace() {
        let r = records();
        let id = r.alloc_page_id();
        r.put_page_with_chunks(&page(id, "default", "wiki/a"), &chunks(4))
            .unwrap();
        let got = r.get_page("default", "wiki/a").unwrap().unwrap();
        assert_eq!((got.id, got.chunk_count), (id, 4));
        assert_eq!(r.get_page_by_id(id).unwrap().unwrap().slug, "wiki/a");
        assert_eq!(r.get_chunks(id).unwrap(), chunks(4));
        // Replace with fewer chunks: the extras disappear.
        r.put_page_with_chunks(&page(id, "default", "wiki/a"), &chunks(2))
            .unwrap();
        assert_eq!(r.get_chunks(id).unwrap().len(), 2);
        assert_eq!(
            r.get_page("default", "wiki/a")
                .unwrap()
                .unwrap()
                .chunk_count,
            2
        );
    }

    #[test]
    fn list_pages_is_a_slug_ordered_range_inside_one_source() {
        let r = records();
        for (i, (s, slug)) in [
            ("a", "x/3"),
            ("a", "x/1"),
            ("a", "x/2"),
            ("ab", "x/0"),
            ("b", "x/9"),
        ]
        .iter()
        .enumerate()
        {
            r.put_page_with_chunks(&page(i as u64 + 1, s, slug), &chunks(1))
                .unwrap();
        }
        let l = r.list_pages("a", "x/2", 10).unwrap();
        assert_eq!(
            l.iter().map(|p| p.slug.as_str()).collect::<Vec<_>>(),
            ["x/2", "x/3"]
        );
        assert_eq!(r.list_pages("a", "", 2).unwrap().len(), 2);
    }

    #[test]
    fn counters_do_not_lose_updates() {
        let r = Arc::new(records());
        let mut hs = vec![];
        for _ in 0..8 {
            let r = r.clone();
            hs.push(std::thread::spawn(move || {
                for _ in 0..50 {
                    r.increment_counter("hot", 1).unwrap();
                    r.add_counter("hot_atomic", 1).unwrap();
                }
            }));
        }
        for h in hs {
            h.join().unwrap();
        }
        assert_eq!(r.counter("hot").unwrap(), 400);
        assert_eq!(r.counter("hot_atomic").unwrap(), 400);
    }

    #[test]
    fn page_id_allocator_resumes_after_reopen() {
        let store: Arc<dyn BaseStore> = Arc::new(MemStore::new());
        {
            let r = Records::open(Arc::new(
                Db::open(store.clone(), Options::default()).unwrap(),
            ))
            .unwrap();
            r.put_page_with_chunks(&page(41, "s", "p"), &chunks(1))
                .unwrap();
        }
        let r = Records::open(Arc::new(Db::open(store, Options::default()).unwrap())).unwrap();
        assert_eq!(r.alloc_page_id(), 42);
    }
}
