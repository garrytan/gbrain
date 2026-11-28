//! The keyword index's doctor check and rebuild: an unreadable state no longer stops the open,
//! the check names each state, and the rebuild restores the postings while writing nothing
//! outside the index.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::json;

use super::IndexOnly;
use crate::error::INVALID_STATE;
use crate::keys;
use crate::keyword::index::tests::{corpus, members, postings, put};
use crate::keyword::index_build::reset;
use crate::kv::{Kv, KvWrite};
use crate::test_support::mem_kv;
use crate::{OpenOptions, Store, SystemEnv};

fn open(kv: &Arc<dyn Kv>, builder: bool) -> crate::error::Result<Store> {
    let options = OpenOptions {
        keyword_index_builder: builder,
        ..OpenOptions::default()
    };
    Store::open_kv(kv.clone(), Arc::new(SystemEnv), options)
}

fn put_raw(kv: &Arc<dyn Kv>, key: &[u8], value: &[u8]) {
    let mut tx = kv.begin_write().unwrap();
    tx.put(key, value).unwrap();
    tx.commit().unwrap();
}

fn raw(kv: &Arc<dyn Kv>, key: &[u8]) -> Option<Vec<u8>> {
    kv.snapshot().unwrap().get(key).unwrap()
}

/// Every record outside the keyword index.
fn records(kv: &Arc<dyn Kv>) -> BTreeMap<Vec<u8>, Vec<u8>> {
    let mut out = BTreeMap::new();
    kv.snapshot()
        .unwrap()
        .scan(&[], &[0xff; 4], false, &mut |k, v| {
            if k.first() != Some(&keys::TRIGRAM) {
                out.insert(k.to_vec(), v.to_vec());
            }
            true
        })
        .unwrap();
    out
}

/// A built brain with the corpus: its kv, its postings and its records.
fn built() -> (Arc<dyn Kv>, BTreeMap<Vec<u8>, Vec<u8>>) {
    let kv = mem_kv();
    let store = open(&kv, false).unwrap();
    corpus(&store);
    let health = store.derived_index_check(None).unwrap();
    assert_eq!(health.status, "ok", "{health:?}");
    assert!(health.served);
    let kept = postings(&store);
    assert!(!kept.is_empty());
    (kv, kept)
}

#[test]
fn an_unreadable_state_opens_scans_reports_and_the_rebuild_repairs_it() {
    let (kv, kept) = built();
    let state_key = keys::keyword_index_state();
    put_raw(&kv, &state_key, b"{garbage");

    // The open goes on, writes nothing to the state and starts no build.
    let store = open(&kv, true).unwrap();
    assert_eq!(raw(&kv, &state_key).as_deref(), Some(&b"{garbage"[..]));
    // Every member scans and answers what the scan answers (`members` compares both).
    assert_eq!(members(&store), 0);
    let health = store.derived_index_check(None).unwrap();
    assert_eq!(
        (health.status, health.served, health.builder),
        ("unreadable", false, "none"),
        "{health:?}"
    );
    assert!(health.state_error.is_some() && health.state.is_none());
    // The store verify reports it instead of failing.
    let report = store.keyword_index_verify(None).unwrap();
    assert!(report.state.is_none() && report.ok, "{report:?}");

    // A write while the state is unreadable still goes through.
    put(&store, "notes/late", "Late", "pear orchard", "", json!({}));

    let before = records(&kv);
    let receipt = store.derived_index_rebuild().unwrap();
    assert_eq!(receipt.record_writes, 0);
    assert!(receipt.state.complete && receipt.state.cursor.is_none());
    assert!(receipt.index_puts > kept.len() as u64, "{receipt:?}");
    assert!(receipt.transactions >= 2);
    assert_eq!(records(&kv), before, "the rebuild wrote only index records");

    let health = store.derived_index_check(None).unwrap();
    assert_eq!((health.status, health.served), ("ok", true), "{health:?}");
    assert!(members(&store) > 0);
    let rebuilt = postings(&store);
    for (key, value) in &kept {
        assert_eq!(rebuilt.get(key), Some(value));
    }
    assert!(rebuilt.len() > kept.len(), "the late page has postings");
}

#[test]
fn dropped_chunk_postings_report_a_mismatch_and_the_rebuild_restores_them() {
    let (kv, kept) = built();
    let dropped: Vec<Vec<u8>> = kept
        .keys()
        .filter(|k| k[1] == keys::KW_CHUNK_POSTING)
        .take(5)
        .cloned()
        .collect();
    assert_eq!(dropped.len(), 5);
    let mut tx = kv.begin_write().unwrap();
    for key in &dropped {
        tx.delete(key).unwrap();
    }
    tx.commit().unwrap();

    let store = open(&kv, true).unwrap();
    let health = store.derived_index_check(None).unwrap();
    assert_eq!(health.status, "mismatch", "{health:?}");
    let report = health.verify.unwrap();
    assert_eq!((report.missing, report.ok), (5, false), "{report:?}");
    // A bounded check walks fewer pages and counts no orphans.
    let sample = store.derived_index_check(Some(1)).unwrap();
    assert_eq!(sample.verify.unwrap().orphan, None);

    let before = records(&kv);
    let receipt = store.derived_index_rebuild().unwrap();
    assert_eq!(receipt.record_writes, 0);
    assert_eq!(records(&kv), before);
    assert_eq!(postings(&store), kept);
    let health = store.derived_index_check(None).unwrap();
    assert_eq!(health.status, "ok", "{health:?}");
    assert_eq!(health.verify.unwrap().orphan, Some(0));
}

#[test]
fn an_incomplete_index_with_no_build_running_is_stalled() {
    let (kv, _) = built();
    let store = open(&kv, false).unwrap();
    store.write(reset).unwrap();
    let health = store.derived_index_check(None).unwrap();
    assert_eq!(
        (health.status, health.served, health.builder),
        ("stalled", false, "none"),
        "{health:?}"
    );
    assert_eq!(health.state.unwrap().cursor, Some(0));
    assert!(health.verify.is_none());
    store.derived_index_rebuild().unwrap();
    assert_eq!(store.derived_index_check(None).unwrap().status, "ok");
}

#[test]
fn an_absent_state_is_reported() {
    let (kv, _) = built();
    let store = open(&kv, false).unwrap();
    store
        .write(|w| w.delete(&keys::keyword_index_state()))
        .unwrap();
    let health = store.derived_index_check(None).unwrap();
    assert_eq!((health.status, health.served), ("absent", false));
}

#[test]
fn the_rebuild_handle_refuses_a_write_outside_the_index() {
    let kv = mem_kv();
    let mut tx = kv.begin_write().unwrap();
    let mut only = IndexOnly::new(&mut *tx);
    let refused = only.put(&keys::meta("format"), b"{}").unwrap_err();
    assert_eq!(refused.code, INVALID_STATE);
    let refused = only.delete(&keys::page_id(1)).unwrap_err();
    assert_eq!(refused.code, INVALID_STATE);
    let refused = only.allocate(&keys::page_id(2), 1).unwrap_err();
    assert_eq!(refused.code, INVALID_STATE);
    only.put(&keys::keyword_index_state(), b"{}").unwrap();
    assert_eq!((only.puts, only.deletes), (1, 0));
}
