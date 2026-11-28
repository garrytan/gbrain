//! The core term postings' doctor check and repair: the check counts missing, changed and orphan
//! postings, the repair restores them while writing nothing outside the `T` tag, a search during
//! the repair loses no posting it read right before, and a failed background build is reported.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{delete_batch, put_batch, repair_in};
use crate::keys;
use crate::keyword::index::tests::corpus;
use crate::keyword::index_health::IndexOnly;
use crate::kv::{Kv, scan_prefix};
use crate::search::SearchOptions;
use crate::test_support::mem_kv;
use crate::{OpenOptions, Store, SystemEnv};

/// Raw key-value pairs, in key order.
type Pairs = BTreeMap<Vec<u8>, Vec<u8>>;

fn open(kv: &Arc<dyn Kv>, builder: bool) -> Store {
    let options = OpenOptions {
        keyword_index_builder: builder,
        ..OpenOptions::default()
    };
    Store::open_kv(kv.clone(), Arc::new(SystemEnv), options).unwrap()
}

fn tagged(store: &Store, keep: impl Fn(u8) -> bool) -> Pairs {
    let mut out = BTreeMap::new();
    store
        .read()
        .unwrap()
        .scan(&[], &[0xff; 4], false, &mut |k, v| {
            if k.first().is_some_and(|t| keep(*t)) {
                out.insert(k.to_vec(), v.to_vec());
            }
            true
        })
        .unwrap();
    out
}

/// Every `T` posting.
fn terms(store: &Store) -> Pairs {
    tagged(store, |t| t == keys::POSTING)
}

/// Every record outside the two indexes.
fn records(store: &Store) -> Pairs {
    tagged(store, |t| t != keys::POSTING && t != keys::TRIGRAM)
}

fn search(store: &Store) -> Vec<Value> {
    ["apple", "red pie", "orchard", "widgets"]
        .iter()
        .flat_map(|q| store.search_keyword(q, &SearchOptions::default()).unwrap())
        .collect()
}

/// A built brain with the corpus, its term postings and its search results.
fn built() -> (Arc<dyn Kv>, Pairs, Vec<Value>) {
    let kv = mem_kv();
    let store = open(&kv, false);
    corpus(&store);
    let health = store.derived_index_check(None).unwrap();
    assert!(health.terms.ok, "{health:?}");
    let kept = terms(&store);
    assert!(kept.len() > 4, "{}", kept.len());
    assert_eq!(health.terms.expected, kept.len() as u64);
    assert_eq!(health.terms.orphan, Some(0));
    let found = search(&store);
    assert!(!found.is_empty());
    (kv, kept, found)
}

/// Deletes the first two postings, changes the third, and adds three no chunk holds: a term the
/// chunk lacks, a page that does not exist and a key of no posting layout.
fn damage(store: &Store, kept: &Pairs) -> Vec<Vec<u8>> {
    let first: Vec<Vec<u8>> = kept.keys().take(3).cloned().collect();
    let doc = first[0][first[0].len() - 12..].to_vec();
    let page = keys::be8(&doc[..8]).unwrap();
    let index = keys::be4(&doc[8..]).unwrap();
    let orphans = vec![
        keys::posting("zzorphan", page, index),
        keys::posting("apple", 999_999, 0),
        vec![keys::POSTING, b'x'],
    ];
    store
        .write(|w| {
            w.delete(&first[0])?;
            w.delete(&first[1])?;
            w.put(&first[2], &999u32.to_be_bytes())?;
            for key in &orphans {
                w.put(key, &1u32.to_be_bytes())?;
            }
            Ok(())
        })
        .unwrap();
    orphans
}

#[test]
fn damaged_term_postings_are_counted_and_the_rebuild_restores_them() {
    let (kv, kept, found) = built();
    let store = open(&kv, false);
    damage(&store, &kept);

    let health = store.derived_index_check(None).unwrap();
    // The keyword index itself is untouched.
    assert_eq!(health.status, "ok", "{health:?}");
    let t = &health.terms;
    assert_eq!(
        (t.missing, t.changed, t.orphan, t.ok),
        (2, 1, Some(3), false),
        "{t:?}"
    );
    // A bounded check walks fewer pages and counts no orphans.
    let sample = store.derived_index_check(Some(1)).unwrap();
    assert_eq!((sample.terms.pages, sample.terms.orphan), (1, None));

    let before = records(&store);
    let receipt = store.derived_index_rebuild().unwrap();
    assert_eq!(receipt.record_writes, 0);
    assert_eq!(
        (receipt.term_puts, receipt.term_deletes),
        (3, 3),
        "{receipt:?}"
    );
    // The keyword index matched its records, so the rebuild left it as it was.
    assert_eq!(
        (receipt.index_puts, receipt.index_deletes),
        (0, 0),
        "{receipt:?}"
    );
    assert!(receipt.state.complete);
    assert_eq!(
        records(&store),
        before,
        "the rebuild wrote only index postings"
    );
    assert_eq!(terms(&store), kept);
    assert_eq!(search(&store), found);
    let health = store.derived_index_check(None).unwrap();
    assert_eq!(health.status, "ok");
    assert!(
        health.terms.ok && health.terms.orphan == Some(0),
        "{health:?}"
    );
}

#[test]
fn the_rebuild_of_healthy_postings_writes_none() {
    let (kv, kept, _) = built();
    let store = open(&kv, false);
    let receipt = store.derived_index_rebuild().unwrap();
    assert_eq!(
        (receipt.term_puts, receipt.term_deletes),
        (0, 0),
        "{receipt:?}"
    );
    assert_eq!(
        (receipt.index_puts, receipt.index_deletes),
        (0, 0),
        "{receipt:?}"
    );
    // One put batch and one delete batch over the small corpus.
    assert_eq!(receipt.transactions, 2, "{receipt:?}");
    assert_eq!(terms(&store), kept);
}

#[test]
fn every_repair_batch_keeps_each_right_posting_and_adds_no_wrong_one() {
    let (kv, kept, _) = built();
    let store = open(&kv, false);
    let orphans = damage(&store, &kept);
    let damaged = terms(&store);
    let right: BTreeSet<(Vec<u8>, Vec<u8>)> = kept.clone().into_iter().collect();
    let allowed: BTreeSet<(Vec<u8>, Vec<u8>)> =
        right.iter().cloned().chain(damaged.clone()).collect();
    // What a search reads after each batch: every posting it read right before the repair is
    // still there, and nothing but right postings and the damage it has not reached yet.
    let check = |label: &str| {
        let now: BTreeSet<(Vec<u8>, Vec<u8>)> = terms(&store).into_iter().collect();
        let held_right: BTreeSet<_> = damaged
            .iter()
            .filter(|(k, v)| kept.get(*k) == Some(*v))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        assert!(
            held_right.is_subset(&now),
            "{label}: a right posting went missing"
        );
        assert!(now.is_subset(&allowed), "{label}: a wrong posting appeared");
    };
    let mut batches = 0;
    let mut cursor = Some(0u64);
    while let Some(from) = cursor {
        cursor = store
            .write(|w| put_batch(&mut IndexOnly::new(w, keys::POSTING), from, 1))
            .unwrap();
        batches += 1;
        check("put");
    }
    let mut start = Some(vec![keys::POSTING]);
    while let Some(from) = start {
        start = store
            .write(|w| delete_batch(&mut IndexOnly::new(w, keys::POSTING), &from, 2))
            .unwrap();
        batches += 1;
        check("delete");
    }
    assert!(batches > 4, "{batches}");
    assert_eq!(terms(&store), kept);
    for key in orphans {
        assert!(!terms(&store).contains_key(&key));
    }
    // The batched form with the smallest batches gives the same postings as one pass.
    damage(&store, &kept);
    let receipt = repair_in(&store, 1, 1).unwrap();
    assert_eq!((receipt.puts, receipt.deletes), (3, 3));
    assert!(receipt.transactions > kept.len() as u64);
    assert_eq!(terms(&store), kept);
}

#[test]
fn the_repair_handle_refuses_a_write_outside_the_term_postings() {
    let (kv, _, _) = built();
    let store = open(&kv, false);
    let refused = store
        .write(|w| {
            let mut only = IndexOnly::new(w, keys::POSTING);
            crate::kv::KvWrite::put(&mut only, &keys::keyword_index_state(), b"{}")
        })
        .unwrap_err();
    assert_eq!(refused.code, crate::error::INVALID_STATE);
}

#[test]
fn a_failed_background_build_is_reported_with_its_error() {
    let (kv, kept, _) = built();
    {
        let store = open(&kv, false);
        let mut page = None;
        scan_prefix(
            &*store.read().unwrap(),
            &[keys::PAGE_ID],
            false,
            &mut |k, _| {
                page = keys::be8(&k[1..]);
                false
            },
        )
        .unwrap();
        let page = page.unwrap();
        drop(store);
        // Under no `Store`: a store write would reindex the page and meet the damage itself.
        let mut tx = kv.begin_write().unwrap();
        tx.put(&keys::timeline(page, "0000-00-00", u64::MAX), b"{not json")
            .unwrap();
        tx.put(
            &keys::keyword_index_state(),
            br#"{"version":1,"complete":false,"cursor":0}"#,
        )
        .unwrap();
        tx.commit().unwrap();
    }
    let store = open(&kv, true);
    let deadline = Instant::now() + Duration::from_secs(30);
    let health = loop {
        let health = store.derived_index_check(None).unwrap();
        if health.builder != "running" || Instant::now() > deadline {
            break health;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(
        (health.status, health.served, health.builder),
        ("stalled", false, "failed"),
        "{health:?}"
    );
    let error = health.builder_error.unwrap();
    assert!(!error.is_empty());
    assert_eq!(health.state.unwrap().cursor, Some(0));
    // The term postings do not read timelines, so their check still answers.
    assert!(health.terms.ok, "{:?}", health.terms);
    assert_eq!(terms(&store), kept);
    // The rebuild meets the same damaged record and stops with the same error.
    let failed = store.derived_index_rebuild().unwrap_err();
    assert_eq!(format!("{}: {}", failed.code, failed.message), error);
}
