//! The keyword index write handle: forwarding of the special primitives, tracking by key
//! family, preimages, and a fresh touched set for each OCC attempt and each bound statement.

use super::{IndexingWriter, Touched};
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::{Kv, KvRead, KvWrite, read_i64};
use crate::pages::{PageInput, PutPageOptions, read_page, rename_page};
use crate::test_support::{occ_kv, occ_store, store};
use crate::timeline::{AddTimelineOptions, TimelineInput};
use crate::{Store, write_chain};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

thread_local! {
    /// Every touched set a flush resolved on this test thread, in order.
    pub(crate) static FLUSHED: RefCell<Vec<Touched>> = const { RefCell::new(Vec::new()) };
}

/// A chunk record as `write_chunk` stores it, for the flush to reindex.
fn chunk_json(page_id: u64, index: u32) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "id": index + 1, "page_id": page_id, "chunk_index": index, "chunk_text": "kingfisher",
        "chunk_source": "compiled_truth", "modality": "text", "length": 1, "meta": {},
    }))
    .unwrap()
}

fn flushed() -> Vec<Touched> {
    FLUSHED.with(|f| f.borrow_mut().drain(..).collect())
}

/// Turns the index on: writes its state record.
fn index_on(store: &Store) {
    store
        .write(|w| w.put(&keys::keyword_index_state(), b"on"))
        .unwrap();
    flushed();
}

fn put(store: &Store, slug: &str, title: &str) -> u64 {
    let input = PageInput {
        page_type: "note".into(),
        title: title.into(),
        compiled_truth: "kingfishers nest in river banks".into(),
        ..PageInput::default()
    };
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
    read_page(&*store.read().unwrap(), "default", slug)
        .unwrap()
        .unwrap()
        .id
}

/// The union of several flushes.
fn union(sets: &[Touched]) -> Touched {
    let mut all = Touched::default();
    for t in sets {
        all.chunks.extend(t.chunks.iter().copied());
        all.pages.extend(t.pages.iter().copied());
        for (k, v) in &t.page_records {
            all.page_records
                .entry(k.clone())
                .or_insert_with(|| v.clone());
        }
    }
    all
}

/// An inner write handle that records which primitives reach it, and every read.
#[derive(Default)]
struct Spy {
    data: BTreeMap<Vec<u8>, Vec<u8>>,
    calls: Vec<&'static str>,
    reads: RefCell<Vec<Vec<u8>>>,
}

impl KvRead for Spy {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.reads.borrow_mut().push(key.to_vec());
        Ok(self.data.get(key).cloned())
    }

    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        let range = self.data.range(start.to_vec()..end.to_vec());
        let entries: Vec<_> = if reverse {
            range.rev().collect()
        } else {
            range.collect()
        };
        for (k, v) in entries {
            if !f(k, v) {
                break;
            }
        }
        Ok(())
    }
}

impl KvWrite for Spy {
    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()> {
        self.calls.push("put");
        self.data.insert(key.to_vec(), value.to_vec());
        Ok(())
    }

    fn delete(&mut self, key: &[u8]) -> Result<()> {
        self.calls.push("delete");
        self.data.remove(key);
        Ok(())
    }

    fn commit(self: Box<Self>) -> Result<u64> {
        Ok(0)
    }

    fn allocate(&mut self, _key: &[u8], _count: u64) -> Result<u64> {
        self.calls.push("allocate");
        Ok(7)
    }

    fn raise_counter(&mut self, _key: &[u8], _value: u64) -> Result<()> {
        self.calls.push("raise_counter");
        Ok(())
    }

    fn add_i64(&mut self, _key: &[u8], _delta: i64) -> Result<()> {
        self.calls.push("add_i64");
        Ok(())
    }

    fn counter_below(&mut self, _key: &[u8], _cap: i64) -> Result<Option<i64>> {
        self.calls.push("counter_below");
        Ok(None)
    }
}

/// Every wrapper of the write handle chain forwards the four special primitives to the inner
/// handle, with no read and no put of its own. This runs on the chain `Store::write` builds, so a
/// wrapper added inside it later (`IndexingWriter(FlaggingWriter(inner))`) must forward them too.
#[test]
fn the_write_chain_forwards_the_special_primitives() {
    let mut spy = Spy::default();
    write_chain(&mut spy, &mut |w: &mut dyn KvWrite| {
        assert_eq!(w.allocate(b"Cseq", 3)?, 7);
        w.raise_counter(b"Cseq", 9)?;
        w.add_i64(b"Ccount", 2)?;
        assert_eq!(w.counter_below(b"Ccount", 5)?, None);
        Ok(())
    })
    .unwrap();
    assert_eq!(
        spy.calls,
        ["allocate", "raise_counter", "add_i64", "counter_below"]
    );
    assert!(spy.reads.borrow().is_empty());
}

/// The four counter calls reach the inner handle's own method, not the trait default: a
/// concurrent store (`occ_kv`) overrides them to add and raise without reading, so a wrapper that
/// falls back to get-then-put turns every counter bump into a read conflict. The same test as
/// `access_flag.rs` has for `FlaggingWriter`, on `IndexingWriter` alone.
#[test]
fn counter_calls_pass_through_to_the_inner_handle() {
    let mut inner = Spy::default();
    let mut writer = IndexingWriter::new(&mut inner);
    assert_eq!(writer.allocate(b"Cseq", 3).unwrap(), 7);
    writer.raise_counter(b"Cseq", 9).unwrap();
    writer.add_i64(b"Ccount", 2).unwrap();
    assert_eq!(writer.counter_below(b"Ccount", 5).unwrap(), None);
    drop(writer);
    assert_eq!(
        inner.calls,
        ["allocate", "raise_counter", "add_i64", "counter_below"]
    );
    assert!(inner.reads.borrow().is_empty());
}

/// Two concurrent writers that add to the same counter and take ids from the same sequence
/// through the chain both commit: the inner `OccTxn` forms stay in force.
#[test]
fn concurrent_counter_writes_through_the_chain_do_not_conflict() {
    let kv = occ_kv();
    let mut a = kv.begin_write().unwrap();
    let mut b = kv.begin_write().unwrap();
    let mut ids = Vec::new();
    for tx in [&mut a, &mut b] {
        let id = write_chain(&mut **tx, &mut |w: &mut dyn KvWrite| {
            w.add_i64(b"Ccount", 1)?;
            w.allocate(b"Cseq", 1)
        })
        .unwrap();
        ids.push(id);
    }
    a.commit().unwrap();
    b.commit().unwrap();
    assert_ne!(ids[0], ids[1]);
    assert_eq!(read_i64(&*kv.snapshot().unwrap(), b"Ccount").unwrap(), 2);
}

/// With the index off, the wrapper reads only the state record, once, and tracks nothing.
#[test]
fn an_index_that_is_off_tracks_nothing() {
    let mut spy = Spy::default();
    let mut w = IndexingWriter::new(&mut spy);
    w.put(&keys::chunk(1, 0), &chunk_json(1, 0)).unwrap();
    w.put(&keys::page("default", "a"), br#"{"id":1}"#).unwrap();
    w.delete(&keys::page("default", "a")).unwrap();
    assert_eq!(w.resolve().unwrap(), None);
    w.flush().unwrap();
    assert_eq!(*spy.reads.borrow(), vec![keys::keyword_index_state()]);
    assert!(flushed().is_empty());
}

/// Each tracked family marks its document; every other key, the access flag keys and the
/// index's own records included, marks nothing.
#[test]
fn the_wrapper_tracks_by_key_family() {
    let mut spy = Spy::default();
    spy.data.insert(keys::keyword_index_state(), b"on".to_vec());
    spy.data
        .insert(keys::page("default", "old"), br#"{"id":4}"#.to_vec());
    let mut w = IndexingWriter::new(&mut spy);
    w.put(&keys::chunk(1, 2), &chunk_json(1, 2)).unwrap();
    w.delete(&keys::chunk(3, 0)).unwrap();
    w.put(&keys::meta("page_search_timeline/5"), b"{}").unwrap();
    w.put(
        &[
            keys::PAGE_BODY,
            crate::page_body::BODY,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            6,
        ],
        b"{}",
    )
    .unwrap();
    w.put(&keys::timeline(7, "2026-01-01", 1), b"{}").unwrap();
    // A rename: the old key goes, the new key comes; the preimage keeps the old record.
    w.delete(&keys::page("default", "old")).unwrap();
    w.put(&keys::page("default", "new"), br#"{"id":4}"#)
        .unwrap();
    // A second write of a key keeps its first preimage.
    w.put(&keys::page("default", "new"), br#"{"id":4,"x":1}"#)
        .unwrap();
    // Ignored: the access flag, its scan record, a page id record, a timeline dedup key, a
    // body record of another kind, other meta keys, and the index's own keys.
    w.put(
        &keys::text(keys::CONFIG, &["access.restrictions_present"]),
        b"1",
    )
    .unwrap();
    w.put(&keys::meta("access_flag_scan"), b"{}").unwrap();
    w.put(&keys::page_id(9), b"P").unwrap();
    w.put(&keys::timeline_dedup(9, "2026-01-01", &[0; 32], "s"), b"1")
        .unwrap();
    w.put(&[keys::PAGE_BODY, 0x01, 0, 0, 0, 0, 0, 0, 0, 9], b"{}")
        .unwrap();
    w.put(&keys::meta("page_search_timelines/9"), b"{}")
        .unwrap();
    w.put(&[keys::TRIGRAM, 0x01, 1], b"").unwrap();
    let touched = w.resolve().unwrap().unwrap();
    assert_eq!(touched.chunks, BTreeSet::from([(1, 2), (3, 0)]));
    assert_eq!(touched.pages, BTreeSet::from([4, 5, 6, 7]));
    assert_eq!(
        touched.page_records,
        BTreeMap::from([
            (keys::page("default", "new"), None),
            (keys::page("default", "old"), Some(br#"{"id":4}"#.to_vec())),
        ])
    );
}

/// A page write marks the page and its chunks, and the first write of a new page has no
/// preimage. A rename keeps the old key's preimage, and a raw hard delete of the record still
/// names the page by its preimage.
#[test]
fn page_writes_mark_the_page_with_its_preimage() {
    let store = store();
    index_on(&store);
    let id = put(&store, "a", "Kingfisher");
    let all = union(&flushed());
    assert!(all.pages.contains(&id));
    assert!(all.chunks.contains(&(id, 0)));
    assert_eq!(all.page_records[&keys::page("default", "a")], None);

    let page = read_page(&*store.read().unwrap(), "default", "a")
        .unwrap()
        .unwrap();
    store
        .write(|tx| rename_page(tx, &*store.env, &page, "b"))
        .unwrap();
    let all = union(&flushed());
    assert_eq!(all.pages, BTreeSet::from([id]));
    assert!(all.page_records[&keys::page("default", "a")].is_some());
    assert_eq!(all.page_records[&keys::page("default", "b")], None);

    store
        .write(|w| w.delete(&keys::page("default", "b")))
        .unwrap();
    let after_delete = flushed();
    assert_eq!(after_delete.len(), 1);
    assert_eq!(after_delete[0].pages, BTreeSet::from([id]));
    let preimage = after_delete[0].page_records[&keys::page("default", "b")]
        .as_deref()
        .expect("the deleted record's preimage");
    assert_eq!(super::page_id_of(preimage).unwrap(), id);
}

/// A timeline entry marks its page.
#[test]
fn a_timeline_entry_marks_its_page() {
    let store = store();
    index_on(&store);
    let id = put(&store, "a", "Kingfisher");
    flushed();
    let entry = TimelineInput {
        date: Some("2026-01-01".into()),
        source: Some("note".into()),
        summary: Some("nested".into()),
        detail: Some("in the bank".into()),
    };
    assert!(
        store
            .add_timeline_entry("a", &entry, &AddTimelineOptions::default())
            .unwrap()
    );
    let all = union(&flushed());
    assert!(all.pages.contains(&id));
}

/// A bound statement that fails keeps nothing and flushes nothing; the next one starts with an
/// empty touched set.
#[test]
fn a_failed_bound_statement_flushes_nothing() {
    let store = store();
    index_on(&store);
    let t = store.begin_transaction(false).unwrap();
    let failed: Result<()> = t.write(|w| {
        w.put(&keys::chunk(1, 0), &chunk_json(1, 0))?;
        Err(StoreError::invalid("the statement fails"))
    });
    assert!(failed.is_err());
    assert!(flushed().is_empty());
    t.write(|w| w.put(&keys::chunk(1, 1), &chunk_json(1, 1)))
        .unwrap();
    assert_eq!(
        flushed(),
        vec![Touched {
            chunks: BTreeSet::from([(1, 1)]),
            ..Touched::default()
        }]
    );
    t.commit_transaction().unwrap();
}

/// A write that loses an OCC conflict runs again with a fresh touched set: the second flush
/// holds only what the second run wrote.
#[test]
fn each_occ_attempt_tracks_afresh() {
    let store = occ_store();
    index_on(&store);
    let mut attempt = 0;
    store
        .write(|w| {
            attempt += 1;
            if attempt == 1 {
                w.get(b"Cprobe")?;
                std::thread::scope(|s| {
                    s.spawn(|| store.write(|o| o.put(b"Cprobe", b"1")).unwrap())
                        .join()
                        .unwrap();
                });
                w.put(&keys::chunk(1, 0), &chunk_json(1, 0))
            } else {
                w.put(&keys::chunk(1, 1), &chunk_json(1, 1))
            }
        })
        .unwrap();
    assert_eq!(attempt, 2);
    let chunks: Vec<_> = flushed().into_iter().map(|t| t.chunks).collect();
    assert_eq!(
        chunks,
        vec![BTreeSet::from([(1, 0)]), BTreeSet::from([(1, 1)])]
    );
}
