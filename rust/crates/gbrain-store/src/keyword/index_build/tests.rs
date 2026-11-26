//! The keyword index build: batches, the cursor, resume after a reopen, the background thread,
//! the open checks, `verify` and `rebuild`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;

use super::{BATCH_PAGES, build_batch, reset};
use crate::error::{FORMAT_UNKNOWN, INVALID_STATE, StoreError};
use crate::keys;
use crate::keyword::index::tests::{members, opts, postings, put, same};
use crate::keyword::index::{INDEX_VERSION, IndexState, read_state};
use crate::kv::{Kv, KvRead};
use crate::pages::all_pages;
use crate::test_support::mem_kv;
use crate::{OpenOptions, Store, SystemEnv, get_json, put_json};

fn open(kv: &Arc<dyn Kv>, builder: bool) -> crate::error::Result<Store> {
    let options = OpenOptions {
        keyword_index_builder: builder,
        ..OpenOptions::default()
    };
    Store::open_kv(kv.clone(), Arc::new(SystemEnv), options)
}

/// The shared corpus with every pending record folded, so the stored postings are the ones a
/// build writes directly.
fn corpus(store: &Store) {
    crate::keyword::index::tests::corpus(store);
    store
        .write(|w| crate::keyword::pending::fold_all(w))
        .unwrap();
}

fn state(store: &Store) -> IndexState {
    read_state(&*store.read().unwrap()).unwrap().unwrap()
}

fn raw_state(kv: &Arc<dyn Kv>) -> Option<IndexState> {
    get_json(&*kv.snapshot().unwrap(), &keys::keyword_index_state()).unwrap()
}

fn set_raw_state(kv: &Arc<dyn Kv>, state: Option<&IndexState>) {
    let mut tx = kv.begin_write().unwrap();
    match state {
        Some(s) => put_json(&mut *tx, &keys::keyword_index_state(), s).unwrap(),
        None => tx.delete(&keys::keyword_index_state()).unwrap(),
    }
    tx.commit().unwrap();
}

/// A brain with the corpus and no postings, its index reset as the format upgrade leaves it.
fn unbuilt(kv: &Arc<dyn Kv>) -> Store {
    let store = open(kv, false).unwrap();
    corpus(&store);
    store.write(reset).unwrap();
    assert!(postings(&store).is_empty());
    store
}

fn page_count(store: &Store) -> usize {
    all_pages(&*store.read().unwrap()).unwrap().len()
}

/// Steps the build `max_pages` at a time until it is complete; returns the number of steps.
fn finish(store: &Store, max_pages: usize) -> usize {
    let mut steps = 0;
    loop {
        steps += 1;
        assert!(steps < 10_000, "the build does not end");
        if store
            .keyword_index_build_step(max_pages)
            .unwrap()
            .unwrap()
            .complete
        {
            return steps;
        }
    }
}

fn assert_built(store: &Store) {
    let report = store.keyword_index_verify(None).unwrap();
    assert!(report.ok, "{report:?}");
    assert_eq!(report.orphan, Some(0));
    assert!(report.expected > 0);
    let s = state(store);
    assert!(
        s.complete && s.cursor.is_none() && s.version == INDEX_VERSION,
        "{s:?}"
    );
    assert!(members(store) > 0, "a complete index serves");
}

fn wait_complete(store: &Store) {
    let deadline = Instant::now() + Duration::from_secs(60);
    while !state(store).complete {
        assert!(
            Instant::now() < deadline,
            "the background build did not finish"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn a_fresh_store_starts_with_a_complete_empty_index() {
    let store = open(&mem_kv(), false).unwrap();
    let s = state(&store);
    assert_eq!(
        s,
        IndexState {
            version: INDEX_VERSION,
            complete: true,
            cursor: None
        }
    );
    assert!(postings(&store).is_empty());
    let report = store.keyword_index_verify(None).unwrap();
    assert!(report.ok && report.expected == 0, "{report:?}");
}

#[test]
fn batches_build_the_index_and_only_the_last_one_completes_it() {
    let kv = mem_kv();
    let store = unbuilt(&kv);
    assert_eq!(state(&store).cursor, Some(0));
    assert_eq!(members(&store), 0, "an incomplete index never serves");
    let report = store.keyword_index_verify(None).unwrap();
    assert!(!report.ok && report.missing == report.expected && report.orphan == Some(0));

    let pages = page_count(&store);
    assert!(pages > 4, "{pages}");
    let mut cursors = vec![0];
    let mut steps = 0;
    loop {
        steps += 1;
        let s = store.keyword_index_build_step(2).unwrap().unwrap();
        if s.complete {
            break;
        }
        let cursor = s.cursor.unwrap();
        assert!(cursor > *cursors.last().unwrap());
        cursors.push(cursor);
        assert_eq!(members(&store), 0, "step {steps}");
        if steps == 1 {
            // A write behind the cursor and one ahead of it, mid-build.
            put(
                &store,
                "notes/one",
                "One Pear",
                "green pear tart",
                "",
                json!({}),
            );
            put(
                &store,
                "notes/late",
                "Late Apple",
                "apple late page",
                "",
                json!({}),
            );
        }
    }
    assert_eq!(steps, page_count(&store).div_ceil(2));
    assert_built(&store);
    // A complete index stays as it is.
    let kept = postings(&store);
    assert!(store.keyword_index_build_step(2).unwrap().unwrap().complete);
    assert_eq!(postings(&store), kept);
}

#[test]
fn a_batch_that_does_not_commit_leaves_the_cursor_and_the_build_resumes_after_a_reopen() {
    let kv = mem_kv();
    let store = unbuilt(&kv);
    store.keyword_index_build_step(2).unwrap().unwrap();
    let first = state(&store);
    let kept = postings(&store);
    assert!(!kept.is_empty());
    // A crash inside a batch: its transaction never commits.
    let crashed = store.write(|w| {
        build_batch(w, 2)?;
        Err::<(), _>(StoreError::new(INVALID_STATE, "crash"))
    });
    assert!(crashed.is_err());
    assert_eq!(state(&store), first);
    assert_eq!(postings(&store), kept);
    drop(store);

    let store = open(&kv, false).unwrap();
    assert_eq!(state(&store), first, "a reopen resumes; it does not reset");
    assert_eq!(postings(&store), kept);
    finish(&store, 3);
    assert_built(&store);
}

#[test]
fn the_background_build_completes_the_index_and_stops_with_the_store() {
    let kv = mem_kv();
    drop(unbuilt(&kv));
    let store = open(&kv, true).unwrap();
    wait_complete(&store);
    assert_built(&store);
    drop(store);

    // Dropping the store mid-build stops the thread; the next open goes on from the cursor.
    let store = open(&kv, true).unwrap();
    store.keyword_index_rebuild().unwrap();
    drop(store);
    let store = open(&kv, false).unwrap();
    if !state(&store).complete {
        finish(&store, 2);
    }
    assert_built(&store);
}

#[test]
fn the_background_build_and_concurrent_writes_end_with_fresh_postings() {
    let kv: Arc<dyn Kv> = Arc::new(crate::test_support::occ_kv());
    let store = Arc::new(open(&kv, true).unwrap());
    for i in 0..(BATCH_PAGES + 40) {
        put(
            &store,
            &format!("bulk/p{i}"),
            &format!("Bulk {i}"),
            "apple bulk body",
            "",
            json!({}),
        );
    }
    corpus(&store);
    store.keyword_index_rebuild().unwrap();
    for i in (0..(BATCH_PAGES + 40)).step_by(7) {
        put(
            &store,
            &format!("bulk/p{i}"),
            "Rewritten Pear",
            "pear rewritten body",
            "",
            json!({}),
        );
    }
    wait_complete(&store);
    assert_built(&store);
    let o = opts(json!({}));
    assert!(same("pear", || store.search_keyword_chunks("pear", &o)));
}

#[test]
fn an_index_of_a_newer_layout_is_refused_on_open_and_an_older_or_missing_one_is_rebuilt() {
    let kv = mem_kv();
    let store = open(&kv, false).unwrap();
    corpus(&store);
    let kept = postings(&store);
    drop(store);

    let newer = IndexState {
        version: INDEX_VERSION + 1,
        complete: true,
        cursor: None,
    };
    set_raw_state(&kv, Some(&newer));
    let version = kv.version().unwrap();
    let refused = open(&kv, true).err().expect("refused");
    assert_eq!(refused.code, FORMAT_UNKNOWN, "{refused}");
    assert_eq!(raw_state(&kv), Some(newer));
    assert_eq!(kv.version().unwrap(), version, "nothing was written");

    for older in [
        Some(IndexState {
            version: INDEX_VERSION - 1,
            complete: true,
            cursor: None,
        }),
        None,
    ] {
        set_raw_state(&kv, older.as_ref());
        let store = open(&kv, false).unwrap();
        assert_eq!(
            state(&store),
            IndexState {
                version: INDEX_VERSION,
                complete: false,
                cursor: Some(0)
            },
            "{older:?}"
        );
        assert!(postings(&store).is_empty());
        finish(&store, BATCH_PAGES);
        assert_built(&store);
        assert_eq!(postings(&store), kept);
    }
}

#[test]
fn verify_finds_missing_changed_and_orphan_records_and_rebuild_repairs_them() {
    let kv = mem_kv();
    let store = open(&kv, false).unwrap();
    corpus(&store);
    assert_built(&store);
    let kept = postings(&store);
    let posting = kept
        .keys()
        .find(|k| k[1] == keys::KW_CHUNK_POSTING)
        .unwrap()
        .clone();
    let forward = kept
        .keys()
        .find(|k| k[1] == keys::KW_PAGE_FORWARD)
        .unwrap()
        .clone();
    let page = kept.keys().find(|k| k[1] == keys::KW_PAGE_POSTING).unwrap();
    let mut orphan = page[..page.len() - 8].to_vec();
    orphan.extend_from_slice(&999_999u64.to_be_bytes());
    store
        .write(|w| {
            w.delete(&posting)?;
            w.put(&forward, b"x")?;
            w.put(&orphan, b"")
        })
        .unwrap();

    let report = store.keyword_index_verify(None).unwrap();
    assert_eq!(
        (report.missing, report.changed, report.orphan, report.ok),
        (1, 1, Some(1), false),
        "{report:?}"
    );
    let sample = store.keyword_index_verify(Some(1)).unwrap();
    assert_eq!((sample.pages, sample.orphan), (1, None));

    store.keyword_index_rebuild().unwrap();
    assert!(postings(&store).is_empty());
    assert!(!state(&store).complete);
    assert_eq!(members(&store), 0);
    finish(&store, BATCH_PAGES);
    assert_built(&store);
    assert_eq!(postings(&store), kept);
}

#[test]
fn a_state_without_the_build_has_nothing_to_do() {
    let store = open(&mem_kv(), false).unwrap();
    store
        .write(|w| w.delete(&keys::keyword_index_state()))
        .unwrap();
    assert_eq!(store.keyword_index_build_step(2).unwrap(), None);
    assert_eq!(store.keyword_index_state().unwrap(), None);
    let read: Box<dyn KvRead> = store.read().unwrap();
    assert!(read_state(&*read).unwrap().is_none());
}

#[test]
fn verify_finds_a_wrong_pending_set_and_a_drifted_pending_count() {
    let kv = mem_kv();
    let store = open(&kv, false).unwrap();
    crate::keyword::index::tests::corpus(&store);
    let read = || store.read().unwrap();
    let report = super::verify(&*read(), None).unwrap();
    assert!(report.ok, "{report:?}");
    // A pending count that no longer matches the records.
    store
        .write(|w| w.add_i64(&keys::keyword_pending_count(), 1))
        .unwrap();
    let report = super::verify(&*read(), None).unwrap();
    assert!(!report.ok && report.changed > 0, "{report:?}");
    store
        .write(|w| w.add_i64(&keys::keyword_pending_count(), -1))
        .unwrap();
    // A pending set that is well formed but not the document's postings.
    let key = {
        let mut found = None;
        crate::kv::scan_prefix(
            &*read(),
            &[keys::TRIGRAM, keys::KW_PAGE_PENDING],
            false,
            &mut |k, _| {
                found = Some(k.to_vec());
                false
            },
        )
        .unwrap();
        found.expect("the corpus leaves a page pending")
    };
    let wrong = crate::keyword::pending::encode(&[crate::keyword::index::Posting {
        kind: keys::KW_PAGE_POSTING,
        term: b"notaword".to_vec(),
        value: vec![0, 1],
    }]);
    store.write(|w| w.put(&key, &wrong)).unwrap();
    let report = super::verify(&*read(), None).unwrap();
    assert!(!report.ok && report.changed > 0, "{report:?}");
}
