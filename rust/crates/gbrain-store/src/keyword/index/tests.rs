//! The keyword index answers every member exactly as the scan does, and the postings a store
//! keeps in step with its writes equal the postings rebuilt from scratch.
//!
//! Each check runs a member twice on one store, once with the scan forced and once through the
//! postings, and compares the JSON text of the two answers (or the two errors).

use std::cell::Cell;
use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Value, json};

use super::{INDEX_VERSION, IndexState};
use crate::Store;
use crate::chunks::{ChunkInput, UpsertChunksOptions, read_chunks};
use crate::error::Result;
use crate::keys;
use crate::keyword::filters::KeywordOptions;
use crate::keyword::titles::{TitleAttempt, TitleAttemptKind};
use crate::kv::scan_prefix;
use crate::pages::{PageInput, PutPageOptions, all_pages, read_page, rename_page};
use crate::test_support::{occ_store, store};
use crate::timeline::{AddTimelineOptions, TimelineInput};

thread_local! {
    /// Forces every keyword member on this test thread to scan.
    pub(crate) static FORCE_SCAN: Cell<bool> = const { Cell::new(false) };
    /// How many member reads on this test thread the postings served.
    static SERVED: Cell<usize> = const { Cell::new(0) };
}

/// Counts a member read the postings served.
pub(crate) fn served_by_index() {
    SERVED.with(|s| s.set(s.get() + 1));
}

fn served() -> usize {
    SERVED.with(Cell::get)
}

fn write_state(store: &Store, state: &IndexState) {
    store
        .write(|w| crate::put_json(w, &keys::keyword_index_state(), state))
        .unwrap();
}

/// A fresh store whose index is complete from its first write, as a fresh store is seeded.
fn indexed(store: Store) -> Store {
    write_state(
        &store,
        &IndexState {
            version: INDEX_VERSION,
            complete: true,
            cursor: None,
        },
    );
    store
}

fn text<T: Serialize>(result: Result<T>) -> String {
    match result {
        Ok(v) => serde_json::to_string(&v).unwrap(),
        Err(e) => format!("error {}: {}", e.code, e.message),
    }
}

/// Runs `f` with the scan forced, then through the postings; asserts the two answers are the
/// same text and returns whether the postings served the second run.
pub(crate) fn same<T: Serialize>(label: &str, f: impl Fn() -> Result<T>) -> bool {
    FORCE_SCAN.with(|s| s.set(true));
    let scan_before = served();
    let scan = text(f());
    assert_eq!(
        served(),
        scan_before,
        "{label}: a forced scan used the postings"
    );
    FORCE_SCAN.with(|s| s.set(false));
    let before = served();
    let index = text(f());
    assert_eq!(index, scan, "{label}");
    served() > before
}

pub(crate) fn opts(v: Value) -> KeywordOptions {
    serde_json::from_value(v).unwrap()
}

pub(crate) fn put(
    store: &Store,
    slug: &str,
    title: &str,
    body: &str,
    timeline: &str,
    frontmatter: Value,
) {
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": title, "compiled_truth": body, "timeline": timeline,
        "frontmatter": frontmatter,
    }))
    .unwrap();
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
}

fn chunks(store: &Store, slug: &str, chunks: &[(&str, &str)]) {
    let inputs: Vec<ChunkInput> = chunks
        .iter()
        .enumerate()
        .map(|(i, (text, modality))| ChunkInput {
            chunk_index: i as u32,
            chunk_text: (*text).to_owned(),
            modality: Some((*modality).to_owned()),
            ..ChunkInput::default()
        })
        .collect();
    store
        .upsert_chunks(slug, &inputs, &UpsertChunksOptions::default())
        .unwrap();
}

fn seal(store: &Store, slug: &str, search_timeline: &str) {
    let options = UpsertChunksOptions {
        seal: true,
        search_timeline: Some(search_timeline.to_owned()),
        ..UpsertChunksOptions::default()
    };
    store.upsert_chunks(slug, &[], &options).unwrap();
}

fn timeline(store: &Store, slug: &str, summary: &str) {
    let entry = TimelineInput {
        date: Some("2026-01-01".into()),
        source: Some("note".into()),
        summary: Some(summary.into()),
        detail: Some("from the orchard".into()),
    };
    store
        .add_timeline_entry(slug, &entry, &AddTimelineOptions::default())
        .unwrap();
}

/// Pages for every shape the members admit or skip: filtered, hidden and boosted pages, a
/// person page a handle names, a non-text chunk, a timeline, a seal and a segmented lead.
pub(crate) fn corpus(store: &Store) {
    put(
        store,
        "notes/one",
        "One",
        "red apple",
        "",
        json!({ "status": "active" }),
    );
    put(
        store,
        "notes/two",
        "Two",
        "red apple red apple pie",
        "",
        json!({ "status": ["draft", "active"] }),
    );
    put(
        store,
        "people/apple-example",
        "Apple Example",
        "an unrelated body",
        "",
        json!({}),
    );
    put(store, "notes/three", "Three", "apple red", "", json!({}));
    put(
        store,
        "notes/hidden",
        "Hidden Apple",
        "red apple",
        "",
        json!({ "quarantine": true }),
    );
    put(
        store,
        "originals/boost",
        "Pie",
        "apple pie with cinnamon",
        "",
        json!({}),
    );
    put(
        store,
        "notes/log",
        "Orchard Log",
        "harvest notes",
        "apple harvest began",
        json!({}),
    );
    timeline(store, "notes/log", "apple cider pressed");
    put(store, "media/pic", "Picture", "placeholder", "", json!({}));
    chunks(
        store,
        "media/pic",
        &[("red apple image", "image"), ("pie crust", "text")],
    );
    put(
        store,
        "notes/sealed",
        "Sealed Apple",
        "sealed body",
        "raw timeline",
        json!({}),
    );
    seal(store, "notes/sealed", "sealed orchard pie");
    crate::keyword::titles::tests::segmented(store, "notes/seg", "Apple Segment", "orchard lead");
    put(store, "zz/empty", "Empty", "", "", json!({}));
    put(store, "notes/a", "a", "letter", "", json!({}));
    put(
        store,
        "notes/cafe",
        "Café Ünïcode 東京",
        "unicode",
        "",
        json!({}),
    );
}

/// `findByTitleFuzzy` names: near and far titles, the review's `a b c d e` case, a soft-deleted
/// page's title (`Three`), non-ASCII and empty names.
const FUZZY_NAMES: [&str; 9] = [
    "apple",
    "Apple Exampl",
    "orchrd log",
    "a b c d e",
    "Three",
    "cafe unicode 東京",
    "zzz",
    "",
    "!!",
];

/// `minSimilarity` values: the default, the `%` cut, the review's threshold, low, zero, negative,
/// not finite, one, and out of `real` range (refused before any read).
const FUZZY_MINS: [Option<f64>; 12] = [
    None,
    Some(0.3),
    Some(0.200000001),
    Some(0.1),
    Some(0.0),
    Some(-1.0),
    Some(f64::NAN),
    Some(f64::INFINITY),
    Some(1.0),
    Some(1e-50),
    Some(1e39),
    Some(0.05),
];

fn fuzzy_members(store: &Store) -> usize {
    let mut by_index = 0;
    for name in FUZZY_NAMES {
        for min in FUZZY_MINS {
            for (dir, source) in [(None, None), (Some("notes"), None), (None, Some("default"))] {
                let label = format!("fuzzy {name:?} {min:?} {dir:?} {source:?}");
                by_index += usize::from(same(&label, || {
                    store.find_by_title_fuzzy(name, dir, min, source)
                }));
            }
        }
    }
    by_index
}

const QUERIES: [&str; 14] = [
    "apple",
    "red apple",
    "\"red apple\"",
    "apple -red",
    "-apple",
    "apple or zebra",
    "apple or -pie",
    "zebra",
    "",
    "the",
    "apple-example",
    "red apple pie cinnamon",
    "orchard",
    "Pie",
];

fn attempts(q: &str) -> Vec<TitleAttempt> {
    [
        TitleAttemptKind::Whole,
        TitleAttemptKind::Title,
        TitleAttemptKind::Complete,
    ]
    .into_iter()
    .map(|kind| TitleAttempt {
        texts: vec![q.to_owned(), "orchard".to_owned()],
        kind,
        limit: 10.0,
        offset: 0.0,
    })
    .collect()
}

/// Every member on every query: asserts each answer is the scan's and returns how many reads
/// the postings served.
pub(crate) fn members(store: &Store) -> usize {
    let mut by_index = 0;
    let mut check = |_: String, served: bool| by_index += usize::from(served);
    for q in QUERIES {
        for o in [
            json!({}),
            json!({ "limit": 2.0, "offset": 1.0 }),
            json!({ "hardExcludes": ["notes/"] }),
            json!({ "boosts": [["originals/", 3.0]] }),
        ] {
            let o = opts(o);
            let label = format!("chunks {q:?} {o:?}");
            check(
                label.clone(),
                same(&label, || store.search_keyword_chunks(q, &o)),
            );
        }
        for o in [
            json!({}),
            json!({ "phrase": true }),
            json!({ "handles": ["apple-example", "two"] }),
            json!({ "handles": ["two", "seg"], "handlesOnly": true }),
            json!({ "limit": 1.0 }),
            json!({ "type": "note" }),
        ] {
            let o = opts(o);
            let label = format!("pages {q:?} {o:?}");
            check(
                label.clone(),
                same(&label, || store.search_keyword_pages(q, &o)),
            );
            let label = format!("count {q:?} {o:?}");
            check(
                label.clone(),
                same(&label, || store.count_keyword_pages(q, &o)),
            );
        }
        for rank in [q, "pie", "cinnamon orchard"] {
            for o in [
                json!({ "limit": 20.0 }),
                json!({ "limit": 20.0, "phrase": true }),
                json!({ "limit": 1.0, "innerLimit": 2.0 }),
            ] {
                let o = opts(o);
                let label = format!("arm {q:?} {rank:?} {o:?}");
                check(
                    label.clone(),
                    same(&label, || store.search_keyword_arm(q, rank, &o)),
                );
            }
        }
        let terms: Vec<String> = q
            .split_whitespace()
            .map(str::to_owned)
            .chain(["apple".to_owned(), "zebra".to_owned()])
            .collect();
        for cap in [0.0, 1.0, 5.0] {
            let label = format!("rare {terms:?} {cap}");
            check(
                label.clone(),
                same(&label, || store.keyword_rare_term_pages(&terms, cap)),
            );
        }
        for cap in [2.0, 5000.0] {
            let label = format!("titles {q:?} {cap}");
            let a = attempts(q);
            check(
                label.clone(),
                same(&label, || {
                    store.search_titles_attempts(&a, &q.to_lowercase(), cap, &opts(json!({})))
                }),
            );
        }
    }
    by_index + fuzzy_members(store)
}

/// Every `R` record but the state.
pub(crate) fn postings(store: &Store) -> BTreeMap<Vec<u8>, Vec<u8>> {
    let read = store.read().unwrap();
    let mut out = BTreeMap::new();
    scan_prefix(&*read, &[keys::TRIGRAM], false, &mut |k, v| {
        if k != keys::keyword_index_state().as_slice() {
            out.insert(k.to_vec(), v.to_vec());
        }
        true
    })
    .unwrap();
    out
}

/// Asserts the postings the writes kept equal the postings rebuilt from every page and chunk.
fn assert_fresh(store: &Store) {
    let kept = postings(store);
    store
        .write(|w| {
            for key in kept.keys() {
                w.delete(key)?;
            }
            for page in all_pages(&*w)? {
                let prefix = keys::chunk_prefix(page.id);
                let mut indexes = Vec::new();
                scan_prefix(&*w, &prefix, false, &mut |k, _| {
                    if let Some(i) = keys::be4(&k[prefix.len()..]) {
                        indexes.push(i);
                    }
                    true
                })?;
                for index in indexes {
                    super::reindex_chunk(w, page.id, index)?;
                }
                super::reindex_page(w, page.id)?;
            }
            Ok(())
        })
        .unwrap();
    let rebuilt = postings(store);
    assert!(!rebuilt.is_empty());
    let stale: Vec<_> = kept.keys().filter(|k| !rebuilt.contains_key(*k)).collect();
    let missing: Vec<_> = rebuilt.keys().filter(|k| !kept.contains_key(*k)).collect();
    assert!(
        stale.is_empty() && missing.is_empty(),
        "stale {stale:?} missing {missing:?}"
    );
    assert_eq!(kept, rebuilt);
}

fn page_of(store: &Store, slug: &str) -> crate::pages::PageRecord {
    read_page(&*store.read().unwrap(), "default", slug)
        .unwrap()
        .unwrap()
}

/// Each write shape, each followed by every member and a freshness check.
fn exercise(store: &Store) {
    corpus(store);
    assert_fresh(store);
    assert!(members(store) > 0);

    let page = page_of(store, "notes/two");
    store
        .write(|tx| rename_page(tx, &*store.env, &page, "notes/renamed"))
        .unwrap();
    put(store, "notes/one", "One", "green pear", "", json!({}));
    store.soft_delete_page("notes/three", None).unwrap();
    store.delete_page("originals/boost", None).unwrap();
    timeline(store, "notes/log", "apple festival");
    seal(store, "notes/sealed", "sealed zebra");
    chunks(store, "media/pic", &[("red apple", "text")]);
    assert_fresh(store);
    assert!(members(store) > 0);

    store.restore_page("notes/three", None).unwrap();
    put(
        store,
        "notes/renamed",
        "Renamed Apple",
        "apple core",
        "",
        json!({}),
    );
    assert_fresh(store);
    assert!(members(store) > 0);
}

#[test]
fn every_member_answers_as_the_scan_across_writes() {
    exercise(&indexed(store()));
}

#[test]
fn every_member_answers_as_the_scan_on_the_occ_store() {
    exercise(&indexed(occ_store()));
}

/// A tree with no candidate bound scans; a bounded one reads the postings.
#[test]
fn a_query_without_a_candidate_bound_scans() {
    let store = indexed(store());
    corpus(&store);
    let o = opts(json!({}));
    for q in ["-apple", "apple or -pie", "zebra or -apple"] {
        assert!(!same(q, || store.search_keyword_chunks(q, &o)), "{q}");
        assert!(!same(q, || store.search_keyword_arm(q, q, &o)), "{q}");
    }
    for q in ["apple -red", "apple", "red <-> apple", "zebra", ""] {
        assert!(same(q, || store.search_keyword_chunks(q, &o)), "{q}");
    }
    // A handle too long for a basename posting scans.
    let long = opts(json!({ "handles": ["x".repeat(70_000)] }));
    assert!(!same("long handle", || store.search_keyword_pages("apple", &long)));
}

/// Only a complete state of this version serves; any other state scans and answers the same.
#[test]
fn an_incomplete_or_foreign_state_scans() {
    let store = indexed(store());
    corpus(&store);
    let o = opts(json!({}));
    assert!(same("complete", || store.search_keyword_chunks("apple", &o)));
    for state in [
        IndexState {
            version: INDEX_VERSION,
            complete: false,
            cursor: Some(3),
        },
        IndexState {
            version: INDEX_VERSION + 1,
            complete: true,
            cursor: None,
        },
    ] {
        write_state(&store, &state);
        assert!(!same("state", || store.search_keyword_chunks("apple", &o)));
        assert!(!same("state", || {
            store.search_titles_attempts(&attempts("apple"), "apple", 10.0, &o)
        }));
    }
    // Without a state the writes keep no postings.
    let bare = crate::test_support::store();
    bare.write(|w| w.delete(&keys::keyword_index_state()))
        .unwrap();
    put(&bare, "notes/a", "A", "apple", "", json!({}));
    assert!(postings(&bare).is_empty());
}

/// A chunk stored past the tsvector size cap has no postings and matches nothing either way.
#[test]
fn a_chunk_past_the_size_cap_has_no_postings() {
    let store = indexed(store());
    put(&store, "notes/ok", "Ok", "heron wades", "", json!({}));
    put(&store, "notes/bad", "Bad", "heron stalks", "", json!({}));
    let big: String = (0..200_000)
        .map(|i| format!("token{i:x}"))
        .collect::<Vec<_>>()
        .join(" ");
    store
        .write(|tx| {
            let page = read_page(&*tx, "default", "notes/bad")?.unwrap();
            for mut chunk in read_chunks(&*tx, page.id)? {
                chunk.chunk_text = format!("heron {big}");
                crate::put_json(tx, &keys::chunk(page.id, chunk.chunk_index), &chunk)?;
            }
            Ok(())
        })
        .unwrap();
    let id = page_of(&store, "notes/bad").id;
    assert!(
        postings(&store)
            .keys()
            .all(|k| k != &keys::chunk_forward(id, 0))
    );
    let o = opts(json!({ "limit": 20.0 }));
    assert!(same("chunks", || store.search_keyword_chunks("heron", &o)));
    assert!(same("arm", || store.search_keyword_arm("heron", "heron", &o)));
    assert!(same("rare", || {
        store.keyword_rare_term_pages(&["heron".to_owned()], 10.0)
    }));
}

/// The sparse vector of a candidate ranks to the same bits as its full vector, for `ts_rank`
/// and `ts_rank_cd`, with weights, positions and repeated lexemes.
#[test]
fn sparse_vectors_rank_to_the_same_bits() {
    use crate::keyword::rank::{ts_rank, ts_rank_cd};
    use crate::keyword::tsearch::websearch_to_tsquery;
    let store = indexed(store());
    let body = "apple pie apple tart, the red apple and a green pear; apple apple pie";
    put(
        &store,
        "notes/a",
        "Apple Pie",
        body,
        "pie timeline apple",
        json!({}),
    );
    let page = page_of(&store, "notes/a");
    let read = store.read().unwrap();
    let full = crate::keyword::titles::readable_page_vector(&*read, &page)
        .unwrap()
        .unwrap();
    for q in [
        "apple",
        "apple pie",
        "\"apple pie\"",
        "pear or tart",
        "apple -zebra",
        "red green apple",
    ] {
        let query = websearch_to_tsquery(q).unwrap();
        let page_postings =
            super::Postings::read(&*read, keys::KW_PAGE_POSTING, &[&query]).unwrap();
        let sparse = page_postings.sparse((page.id, 0));
        assert_eq!(
            ts_rank(&sparse, &query).to_bits(),
            ts_rank(&full, &query).to_bits(),
            "{q}"
        );
        assert_eq!(
            ts_rank_cd(&sparse, &query).to_bits(),
            ts_rank_cd(&full, &query).to_bits(),
            "{q}"
        );
        let chunk_postings =
            super::Postings::read(&*read, keys::KW_CHUNK_POSTING, &[&query]).unwrap();
        let sparse = chunk_postings.sparse((page.id, 0));
        let chunk = &read_chunks(&*read, page.id).unwrap()[0];
        let chunk_vector = crate::keyword::filters::readable_chunk_vector(chunk).unwrap();
        assert_eq!(
            ts_rank(&sparse, &query).to_bits(),
            ts_rank(&chunk_vector, &query).to_bits(),
            "{q}"
        );
    }
}

/// The fuzzy read reads the trigram postings when it has a bound, keeps soft-deleted pages for
/// the unscoped call and finds a score equal to the rounded threshold.
#[test]
fn the_fuzzy_read_uses_the_trigram_bound() {
    let store = indexed(store());
    corpus(&store);
    store.soft_delete_page("notes/three", None).unwrap();
    for min in [None, Some(0.3), Some(0.05)] {
        assert!(same("fuzzy", || store
            .find_by_title_fuzzy("Three", None, min, None)));
    }
    for min in [Some(0.0), Some(-1.0), Some(f64::NAN)] {
        assert!(!same("fuzzy", || store
            .find_by_title_fuzzy("Three", None, min, None)));
    }
    let unscoped = store
        .find_by_title_fuzzy("Three", None, None, None)
        .unwrap();
    assert_eq!(unscoped["slug"], "notes/three");
    let scoped = store
        .find_by_title_fuzzy("Three", None, None, Some("default"))
        .unwrap();
    assert_ne!(scoped["slug"], "notes/three");
    let edge = store
        .find_by_title_fuzzy("a b c d e", None, Some(0.200000001), None)
        .unwrap();
    assert_eq!(edge["slug"], "notes/a");
    assert!(same("edge", || {
        store.find_by_title_fuzzy("a b c d e", None, Some(0.200000001), None)
    }));
}
