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

#[test]
fn a_format_8_brain_opens_as_format_13_with_the_same_answers() {
    let kv = mem_kv();
    let store = open(&kv).unwrap();
    with_fold_at(1, || corpus(&store));
    assert!(pending_keys(&store).is_empty());
    store
        .write(|w| {
            let mut stored: StoredFormat = get_json(&*w, &keys::meta("format"))?.unwrap();
            stored.format_version = 8;
            put_json(w, &keys::meta("format"), &stored)
        })
        .unwrap();
    drop(store);
    let store = open(&kv).unwrap();
    let stored: StoredFormat = get_json(&*store.read().unwrap(), &keys::meta("format"))
        .unwrap()
        .unwrap();
    assert_eq!(stored.format_version, FORMAT_VERSION);
    assert!(pending_keys(&store).is_empty());
    assert!(members(&store) > 0);
    // Writes after the upgrade stage pending records, and reads still answer as the scan.
    with_fold_at(i64::MAX, || {
        put(&store, "notes/one", "One", "green pear", "", json!({}));
        assert!(!pending_keys(&store).is_empty());
        assert!(members(&store) > 0);
    });
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
