//! Pending keyword postings: reads answer as the scan while records are pending, a failed fold
//! keeps the store as it was, a format-8 brain opens as format 13 with the same answers, and a
//! damaged pending record is refused.

use std::sync::Arc;

use serde_json::json;

use super::super::index::tests::{corpus, members, put};
use super::{FOLD_AT_OVERRIDE, Overlay, decode, encode, pending_count};
use crate::error::{STORE_CORRUPT, STORE_IO};
use crate::keys;
use crate::kv::{Kv, scan_prefix};
use crate::test_support::{FaultOp, FaultyKv, mem_kv};
use crate::{FORMAT_VERSION, OpenOptions, Store, StoredFormat, SystemEnv, get_json, put_json};

fn open(kv: &Arc<dyn Kv>) -> crate::Result<Store> {
    Store::open_kv(kv.clone(), Arc::new(SystemEnv), OpenOptions::default())
}

fn with_fold_at<T>(n: i64, f: impl FnOnce() -> T) -> T {
    FOLD_AT_OVERRIDE.with(|c| c.set(Some(n)));
    let out = f();
    FOLD_AT_OVERRIDE.with(|c| c.set(None));
    out
}

/// The pending records as stored, in key order.
fn pending_keys(store: &Store) -> Vec<Vec<u8>> {
    let read = store.read().unwrap();
    let mut out = Vec::new();
    for kind in [keys::KW_CHUNK_PENDING, keys::KW_PAGE_PENDING] {
        scan_prefix(&*read, &[keys::TRIGRAM, kind], false, &mut |k, _| {
            out.push(k.to_vec());
            true
        })
        .unwrap();
    }
    out
}

#[test]
fn reads_answer_as_the_scan_while_records_are_pending() {
    let kv = mem_kv();
    let store = open(&kv).unwrap();
    with_fold_at(i64::MAX, || {
        corpus(&store);
        assert!(!pending_keys(&store).is_empty());
        assert_eq!(
            pending_count(&*store.read().unwrap()).unwrap(),
            pending_keys(&store).len() as i64
        );
        assert!(members(&store) > 0);
        let report = super::super::index_build::verify(&*store.read().unwrap(), None).unwrap();
        assert!(report.ok, "{report:?}");
    });
}

#[test]
fn the_write_that_reaches_the_threshold_folds_every_pending_record() {
    let kv = mem_kv();
    let store = open(&kv).unwrap();
    let count = |store: &Store| pending_count(&*store.read().unwrap()).unwrap();
    // A put stages its page and the chunks it writes: below the threshold they stay pending.
    let first = with_fold_at(i64::MAX, || {
        put(&store, "notes/a", "Alpha", "red apple", "", json!({}));
        count(&store)
    });
    assert!(first >= 1);
    assert_eq!(pending_keys(&store).len() as i64, first);
    // The next put brings the count to at least first + 1: that write folds every record.
    with_fold_at(first + 1, || {
        put(&store, "notes/b", "Beta", "green pear", "", json!({}));
        assert_eq!(count(&store), 0);
        assert!(pending_keys(&store).is_empty());
        assert!(members(&store) > 0);
    });
}

/// A write whose fold fails keeps nothing: its page, its pending record and the fold's postings
/// are all absent, the earlier pending record and count are as they were, and reads still answer
/// as the scan.
#[test]
fn a_fold_that_fails_keeps_the_store_as_it_was() {
    fn is_pending(key: &[u8]) -> bool {
        key.len() >= 2
            && key[0] == keys::TRIGRAM
            && (key[1] == keys::KW_CHUNK_PENDING || key[1] == keys::KW_PAGE_PENDING)
    }
    let inner = mem_kv();
    let kv: Arc<dyn Kv> = Arc::new(FaultyKv {
        inner: inner.clone(),
        code: STORE_IO,
        ops: &[FaultOp::Delete],
        fail_on: is_pending,
    });
    let store = open(&kv).unwrap();
    let first = with_fold_at(i64::MAX, || {
        put(&store, "notes/a", "Alpha", "red apple", "", json!({}));
        pending_count(&*store.read().unwrap()).unwrap()
    });
    assert!(first >= 1);
    let before = pending_keys(&store);
    with_fold_at(first + 1, || {
        let input: crate::pages::PageInput = serde_json::from_value(json!({
            "type": "note", "title": "Beta", "compiled_truth": "green pear",
        }))
        .unwrap();
        let err = store
            .put_page("notes/b", &input, &Default::default())
            .unwrap_err();
        assert_eq!(err.code, STORE_IO);
        assert_eq!(pending_keys(&store), before);
        assert_eq!(pending_count(&*store.read().unwrap()).unwrap(), first);
        assert!(
            crate::pages::read_page(&*store.read().unwrap(), "default", "notes/b")
                .unwrap()
                .is_none()
        );
        assert!(members(&store) > 0);
    });
    drop(store);
    // The healthy record file folds on the next write that reaches the threshold.
    let store = open(&inner).unwrap();
    with_fold_at(first + 1, || {
        put(&store, "notes/b", "Beta", "green pear", "", json!({}));
        assert!(pending_keys(&store).is_empty());
        assert!(members(&store) > 0);
    });
}

/// A brain at every format this build opens from 8 on (8 here; 8, 9 and 12 once the trunk's
/// earlier formats are merged in) opens at this build's format with the same answers, and its next
/// writes stage pending records that every read applies.
#[test]
fn a_brain_at_each_earlier_format_from_8_opens_at_this_format_with_the_same_answers() {
    let earlier: Vec<u32> = crate::FORMAT_VERSIONS
        .iter()
        .copied()
        .filter(|v| *v >= 8 && *v < FORMAT_VERSION)
        .collect();
    assert!(earlier.contains(&8));
    for version in earlier {
        let kv = mem_kv();
        let store = open(&kv).unwrap();
        with_fold_at(1, || corpus(&store));
        assert!(pending_keys(&store).is_empty());
        store
            .write(|w| {
                let mut stored: StoredFormat = get_json(&*w, &keys::meta("format"))?.unwrap();
                stored.format_version = version;
                put_json(w, &keys::meta("format"), &stored)
            })
            .unwrap();
        drop(store);
        let store = open(&kv).unwrap();
        let stored: StoredFormat = get_json(&*store.read().unwrap(), &keys::meta("format"))
            .unwrap()
            .unwrap();
        assert_eq!(stored.format_version, FORMAT_VERSION, "from {version}");
        assert!(pending_keys(&store).is_empty(), "from {version}");
        assert!(members(&store) > 0);
        with_fold_at(i64::MAX, || {
            put(
                &store,
                "notes/after-upgrade",
                "After",
                "green pear",
                "",
                json!({}),
            );
            assert!(!pending_keys(&store).is_empty());
            assert!(members(&store) > 0);
        });
    }
}

/// A build that stops at format 8 (its list ends at 8) refuses a brain this build wrote, before it
/// changes anything.
#[test]
fn a_build_that_stops_at_format_8_refuses_a_brain_this_build_wrote() {
    let kv = mem_kv();
    let store = open(&kv).unwrap();
    with_fold_at(i64::MAX, || {
        put(&store, "notes/a", "Alpha", "red apple", "", json!({}))
    });
    drop(store);
    let before: Vec<(Vec<u8>, Vec<u8>)> = {
        let snap = kv.snapshot().unwrap();
        let mut out = Vec::new();
        scan_prefix(&*snap, &[], false, &mut |k, v| {
            out.push((k.to_vec(), v.to_vec()));
            true
        })
        .unwrap();
        out
    };
    let err = Store::open_kv_in(
        kv.clone(),
        Arc::new(SystemEnv),
        OpenOptions::default(),
        &[1, 2, 3, 4, 5, 6, 7, 8],
    )
    .err()
    .unwrap();
    assert_eq!(err.code, crate::error::FORMAT_UNKNOWN);
    let snap = kv.snapshot().unwrap();
    let mut after = Vec::new();
    scan_prefix(&*snap, &[], false, &mut |k, v| {
        after.push((k.to_vec(), v.to_vec()));
        true
    })
    .unwrap();
    assert_eq!(after, before);
}

#[test]
fn a_damaged_pending_record_is_refused() {
    let posting = super::Posting {
        kind: keys::KW_PAGE_POSTING,
        term: b"apple".to_vec(),
        value: vec![0, 1],
    };
    let bytes = encode(std::slice::from_ref(&posting));
    assert_eq!(decode(&bytes).unwrap(), vec![posting]);
    for cut in 1..bytes.len() {
        let err = decode(&bytes[..cut]).unwrap_err();
        assert_eq!(err.code, STORE_CORRUPT, "cut at {cut}");
    }
    let kv = mem_kv();
    let store = open(&kv).unwrap();
    with_fold_at(i64::MAX, || {
        put(&store, "notes/a", "Alpha", "red apple", "", json!({}));
    });
    let key = pending_keys(&store)
        .into_iter()
        .find(|k| k[1] == keys::KW_PAGE_PENDING)
        .unwrap();
    store.write(|w| w.put(&key, &bytes[..3])).unwrap();
    let err = Overlay::read(&*store.read().unwrap(), false).err().unwrap();
    assert_eq!(err.code, STORE_CORRUPT);
}

/// A hard delete leaves no posting, forward or pending record of the page or its chunks, even
/// while other records are pending, so none of its text stays in the record file.
#[test]
fn a_deleted_page_leaves_no_keyword_record_behind() {
    let kv = mem_kv();
    let store = open(&kv).unwrap();
    with_fold_at(i64::MAX, || {
        corpus(&store);
        put(
            &store,
            "notes/secret",
            "Secret",
            "zebra quokka",
            "",
            json!({}),
        );
        let page = crate::pages::read_page(&*store.read().unwrap(), "default", "notes/secret")
            .unwrap()
            .unwrap();
        // Fold once so the page has stored postings, then edit it so it is pending again.
        store.write(|w| super::fold_all(w)).unwrap();
        put(
            &store,
            "notes/secret",
            "Secret",
            "zebra quokka walrus",
            "",
            json!({}),
        );
        assert!(!pending_keys(&store).is_empty());
        store.delete_page("notes/secret", None).unwrap();
        let read = store.read().unwrap();
        let mut left = Vec::new();
        scan_prefix(&*read, &[keys::TRIGRAM], false, &mut |k, _| {
            let pending_doc = matches!(
                k.get(1),
                Some(&(keys::KW_CHUNK_PENDING | keys::KW_PAGE_PENDING))
            ) && keys::be8(&k[2..10]) == Some(page.id);
            if super::super::index::record_doc(k).is_some_and(|(_, doc)| doc.0 == page.id)
                || pending_doc
            {
                left.push(k.to_vec());
            }
            true
        })
        .unwrap();
        assert!(
            left.is_empty(),
            "records left for the deleted page: {left:?}"
        );
        drop(read);
        assert!(members(&store) > 0);
    });
}

/// Every page-document keyword record (page posting, title trigram, basename, page forward, page
/// pending) whose bytes hold `needle`. Chunk records are left out: a purge rewrites a page's
/// chunks in its own later write (`upsertChunks`), as before this format.
fn records_holding(store: &Store, needle: &[u8]) -> Vec<Vec<u8>> {
    let read = store.read().unwrap();
    let mut out = Vec::new();
    scan_prefix(&*read, &[keys::TRIGRAM], false, &mut |k, v| {
        let hit = |b: &[u8]| b.windows(needle.len()).any(|w| w == needle);
        let page_doc = matches!(
            k.get(1),
            Some(
                &(keys::KW_PAGE_POSTING
                    | keys::KW_TITLE_TRIGRAM
                    | keys::KW_BASENAME
                    | keys::KW_PAGE_FORWARD
                    | keys::KW_PAGE_PENDING)
            )
        );
        if page_doc && (hit(k) || hit(v)) {
            out.push(k.to_vec());
        }
        true
    })
    .unwrap();
    out
}

/// A fact purge that rewrites a surviving page's timeline, with fewer records pending than the
/// fold threshold, leaves no page keyword record holding the purged text.
#[test]
fn a_purge_of_part_of_a_page_leaves_no_keyword_record_of_the_purged_text() {
    let kv = mem_kv();
    let store = open(&kv).unwrap();
    with_fold_at(i64::MAX, || {
        corpus(&store);
        put(
            &store,
            "notes/secret",
            "Secret",
            "zebra walrus",
            "met quokkasecret at noon",
            json!({}),
        );
        store.write(|w| super::fold_all(w)).unwrap();
        assert!(!records_holding(&store, b"quokkasecret").is_empty());
        let page = crate::pages::read_page(&*store.read().unwrap(), "default", "notes/secret")
            .unwrap()
            .unwrap();
        store
            .update_page_body_for_purge(
                "default",
                page.id as i64,
                "zebra walrus",
                "met at noon",
                "h",
            )
            .unwrap();
        assert_eq!(
            records_holding(&store, b"quokkasecret"),
            Vec::<Vec<u8>>::new(),
            "a purge left the purged text in a live keyword record"
        );
        assert!(members(&store) > 0);
    });
}

/// An edit that removes a word writes the postings at once; an edit that only adds words stages.
#[test]
fn an_edit_that_removes_a_word_writes_at_once_and_an_addition_stages() {
    let kv = mem_kv();
    let store = open(&kv).unwrap();
    with_fold_at(i64::MAX, || {
        put(&store, "notes/a", "Alpha", "body", "red apple", json!({}));
        store.write(|w| super::fold_all(w)).unwrap();
        assert!(!records_holding(&store, b"red").is_empty());
        put(
            &store,
            "notes/a",
            "Alpha",
            "body",
            "red apple pear",
            json!({}),
        );
        assert!(!pending_keys(&store).is_empty());
        put(&store, "notes/a", "Alpha", "body", "apple pear", json!({}));
        assert!(records_holding(&store, b"red").is_empty());
        assert!(members(&store) > 0);
    });
}

/// A wide query over the widest pending set a store can hold (60 pending pages, each past the
/// staging cap; written here directly) stays a lookup per term. A write never stages a document
/// above `STAGE_MAX_POSTINGS`, checked below.
#[test]
fn a_wide_query_over_wide_pending_documents_is_a_lookup_per_term() {
    let mut postings: Vec<super::Posting> = (0..5_000)
        .map(|i| super::Posting {
            kind: keys::KW_PAGE_POSTING,
            term: format!("w{i:05}").into_bytes(),
            value: vec![0, 1],
        })
        .collect();
    postings.reverse();
    let bytes = encode(&postings);
    let kv = mem_kv();
    let store = open(&kv).unwrap();
    store
        .write(|w| {
            for page in 1..=60u64 {
                w.put(&keys::page_pending(page), &bytes)?;
            }
            Ok(())
        })
        .unwrap();
    let start = std::time::Instant::now();
    let overlay = Overlay::read(&*store.read().unwrap(), false).unwrap();
    let mut hits = 0;
    for i in (0..5_000).step_by(20).take(256) {
        hits += overlay
            .entries(keys::KW_PAGE_POSTING, format!("w{i:05}").as_bytes())
            .count();
    }
    let lookups = start.elapsed();
    assert_eq!(hits, 250 * 60);
    eprintln!("overlay read + 256 lookups over 60 x 5,000 pending postings: {lookups:?}");
}

#[test]
fn a_document_past_the_staging_cap_writes_its_postings_at_once() {
    let kv = mem_kv();
    let store = open(&kv).unwrap();
    let timeline: String = (0..(super::STAGE_MAX_POSTINGS + 50))
        .map(|i| format!("word{i} "))
        .collect();
    with_fold_at(i64::MAX, || {
        put(&store, "notes/wide", "Wide", "body", &timeline, json!({}));
        assert!(
            pending_keys(&store)
                .iter()
                .all(|k| k[1] != keys::KW_PAGE_PENDING),
            "a document past the staging cap was staged"
        );
        put(
            &store,
            "notes/narrow",
            "Narrow",
            "body",
            "word1 word2",
            json!({}),
        );
        assert!(
            pending_keys(&store)
                .iter()
                .any(|k| k[1] == keys::KW_PAGE_PENDING)
        );
        assert!(members(&store) > 0);
    });
}
