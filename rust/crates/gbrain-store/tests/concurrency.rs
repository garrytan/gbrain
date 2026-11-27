//! Many writers on one brain: what Postgres gives under row locks, the store gives under
//! optimistic transactions. Conflicting writes serialize (each one lands once, the last committer
//! wins, nothing is lost or mixed); disjoint writes do not wait for each other.
//!
//! Each test that holds in both store modes runs in both (`<name>_single`, `<name>_optimistic`, through
//! `common::open_in`). The `embedded_one_owner_` tests assert what holds while one explicit transaction owns
//! the writer; each has a `_multi_writer` twin for what holds once writers overlap, on a store opened with multi-user mode on.

mod common;

use common::mu::{MuStore, SingleFlightKey, TxnMode, TxnOptions, WriteOrigin};
use common::{StoreMode, TempDir, both_modes, open_in};
use gbrain_store::Store;
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::error::*;
use gbrain_store::journal::{JournalLimits, PageMutation, WriteAdmission};
use gbrain_store::links::LinkBatchInput;
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope, VersionsOptions};
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::sync::{Arc, Barrier};
use std::thread;

const WRITERS: usize = 16;

fn input(title: &str, body: &str) -> PageInput {
    serde_json::from_value(json!({"type": "note", "title": title, "compiled_truth": body})).unwrap()
}

fn put(store: &Store, slug: &str, body: &str) -> Value {
    store
        .put_page(slug, &input(slug, body), &PutPageOptions::default())
        .unwrap()
}

fn request_id(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn mutation(request: &str, principal: &str, slug: &str, body: &str) -> PageMutation {
    serde_json::from_value(json!({
        "principal": {"kind": "local_cli", "id": principal},
        "requestId": request,
        "slug": slug,
        "page": {"type": "note", "title": slug, "compiled_truth": body},
        "options": {},
    }))
    .unwrap()
}

/// Runs `f(i)` on `n` threads that start together.
fn together<T: Send + 'static>(n: usize, f: impl Fn(usize) -> T + Send + Sync + 'static) -> Vec<T> {
    let barrier = Arc::new(Barrier::new(n));
    let f = Arc::new(f);
    let handles: Vec<_> = (0..n)
        .map(|i| {
            let (barrier, f) = (barrier.clone(), f.clone());
            thread::spawn(move || {
                barrier.wait();
                f(i)
            })
        })
        .collect();
    handles.into_iter().map(|h| h.join().unwrap()).collect()
}

fn writers_of_one_page_serialize_and_each_update_lands_once(mode: StoreMode) {
    let dir = TempDir::new("conc-same-page");
    let store = Arc::new(open_in(&dir, mode));
    let submit = |s: &Store, n: usize, body: &str| {
        let r = s
            .submit_page_mutation(&mutation(&request_id(n), "w", "doc", body), None)
            .unwrap();
        assert_eq!(r["state"], "committed", "{r}");
    };
    submit(&store, 0, "body seed");
    let s = store.clone();
    together(WRITERS, move |i| {
        for round in 0..4 {
            submit(&s, 1 + i * 4 + round, &format!("body {i} {round}"));
        }
    });
    let page = store
        .read_page_snapshot("doc", &ReadScope::default())
        .unwrap()
        .unwrap();
    let last = page["page"]["compiled_truth"].as_str().unwrap().to_string();
    let versions = store
        .get_versions("doc", &VersionsOptions::default())
        .unwrap();
    // Postgres keeps one version per replaced body: the seed and every update but the last.
    assert_eq!(versions.len(), WRITERS * 4, "{versions:#?}");
    // getVersions lists newest first; `seen` is the history oldest first.
    let mut seen: Vec<String> = versions
        .iter()
        .rev()
        .map(|v| v["compiled_truth"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(seen[0], "body seed");
    seen.push(last.clone());
    let unique: BTreeSet<_> = seen.iter().cloned().collect();
    assert_eq!(unique.len(), seen.len(), "an update landed twice");
    let mut expected: BTreeSet<String> = (0..WRITERS)
        .flat_map(|i| (0..4).map(move |r| format!("body {i} {r}")))
        .collect();
    expected.insert("body seed".into());
    assert_eq!(unique, expected, "an update was lost");
    // The surviving body is the last one committed: no version replaced it.
    assert!(
        !versions
            .iter()
            .any(|v| v["compiled_truth"] == last.as_str())
    );
    // Each writer's rounds are in commit order in the history.
    for i in 0..WRITERS {
        let order: Vec<usize> = seen
            .iter()
            .enumerate()
            .filter(|(_, b)| b.starts_with(&format!("body {i} ")))
            .map(|(n, _)| n)
            .collect();
        let rounds: Vec<String> = order.iter().map(|&n| seen[n].clone()).collect();
        let mut sorted = rounds.clone();
        sorted.sort();
        assert_eq!(rounds, sorted, "writer {i}'s rounds are out of order");
    }
}

fn concurrent_tags_links_and_timeline_entries_are_all_kept(mode: StoreMode) {
    let dir = TempDir::new("conc-children");
    let store = Arc::new(open_in(&dir, mode));
    put(&store, "hub", "hub body");
    for i in 0..WRITERS {
        put(&store, &format!("t/{i}"), "target");
    }
    let s = store.clone();
    let added = together(WRITERS, move |i| {
        s.add_tag("hub", &format!("tag-{i}"), None).unwrap();
        let link: LinkBatchInput = serde_json::from_value(
            json!({"from_slug": "hub", "to_slug": format!("t/{i}"), "link_type": "cites"}),
        )
        .unwrap();
        let links = s.add_links_batch(&[link]).unwrap();
        let entry: TimelineInput =
            serde_json::from_value(json!({"date": "2026-01-02", "summary": format!("event {i}")}))
                .unwrap();
        let entries = s
            .add_timeline_entry("hub", &entry, &AddTimelineOptions::default())
            .unwrap();
        (links, entries)
    });
    assert!(added.iter().all(|&(l, e)| l == 1 && e));
    let tags = store.get_tags("hub", &ReadScope::default()).unwrap();
    assert_eq!(tags.len(), WRITERS, "{tags:?}");
    let links = store.get_links("hub", &Default::default()).unwrap();
    assert_eq!(links.len(), WRITERS);
    let timeline = store.get_timeline("hub", &Default::default()).unwrap();
    assert_eq!(timeline.len(), WRITERS);
    // Ids handed out concurrently are distinct.
    let ids: BTreeSet<_> = timeline.iter().map(|e| e["id"].to_string()).collect();
    assert_eq!(ids.len(), WRITERS);
}

fn concurrent_chunk_writes_to_one_page_are_never_mixed(mode: StoreMode) {
    let dir = TempDir::new("conc-chunks");
    let store = Arc::new(open_in(&dir, mode));
    put(&store, "doc", "body");
    let revision = store
        .read_page_snapshot("doc", &ReadScope::default())
        .unwrap()
        .unwrap()["revision"]
        .as_str()
        .map(String::from);
    let s = store.clone();
    together(WRITERS, move |i| {
        let chunks: Vec<ChunkInput> = (0..4)
            .map(|j| {
                serde_json::from_value(
                    json!({"chunk_index": j, "chunk_text": format!("writer{i} part{j}")}),
                )
                .unwrap()
            })
            .collect();
        let options = UpsertChunksOptions {
            expected_revision: revision.clone(),
            seal: true,
            ..Default::default()
        };
        s.upsert_chunks("doc", &chunks, &options).unwrap();
    });
    let chunks = store.get_chunks("doc", &ReadScope::default()).unwrap();
    assert_eq!(chunks.len(), 4);
    let writers: BTreeSet<_> = chunks
        .iter()
        .map(|c| {
            c["chunk_text"]
                .as_str()
                .unwrap()
                .split(' ')
                .next()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(writers.len(), 1, "chunks from two writers: {chunks:#?}");
    assert_eq!(store.count_chunks().unwrap(), 4, "the chunk totals drifted");
}

fn the_same_request_submitted_concurrently_is_applied_once(mode: StoreMode) {
    let dir = TempDir::new("conc-idempotent");
    let store = Arc::new(open_in(&dir, mode));
    let s = store.clone();
    let receipts = together(WRITERS, move |_| {
        s.submit_page_mutation(&mutation(&request_id(1), "w", "doc", "only body"), None)
            .unwrap()
    });
    assert!(receipts.iter().all(|r| r["state"] == "committed"));
    let created = receipts.iter().filter(|r| r["status"] == "created").count();
    assert!(created >= 1);
    let pages: BTreeSet<_> = receipts.iter().map(|r| r["page_id"].to_string()).collect();
    assert_eq!(pages.len(), 1);
    assert!(
        store
            .get_versions("doc", &VersionsOptions::default())
            .unwrap()
            .is_empty(),
        "the request was applied twice"
    );
    assert_eq!(store.journal_outstanding().unwrap()["brain"], 0);
}

fn admission_limits_hold_under_concurrency(mode: StoreMode) {
    let dir = TempDir::new("conc-admission");
    let store = Arc::new(open_in(&dir, mode));
    let limits = JournalLimits {
        principal_outstanding: 3,
        brain_outstanding: 5,
    };
    let s = store.clone();
    let results = together(WRITERS * 2, move |i| {
        // two principals; each request is new and left unfinished
        let admission: WriteAdmission = serde_json::from_value(json!({
            "principal": {"kind": "local_cli", "id": format!("p{}", i % 2)},
            "operation": "put_page",
            "requestId": request_id(i + 10),
            "slug": format!("s{i}"),
            "callerIntent": {},
        }))
        .unwrap();
        s.admit_write(&admission, Some(limits)).map(|_| ())
    });
    let admitted = results.iter().filter(|r| r.is_ok()).count();
    assert_eq!(admitted, 5, "the brain limit did not hold");
    for r in &results {
        if let Err(e) = r {
            assert_eq!(e.code, ADMISSION_REFUSED, "{e:?}");
        }
    }
    let outstanding = store.journal_outstanding().unwrap();
    assert_eq!(outstanding["brain"], 5);
    let per: Vec<u64> = outstanding["principals"]
        .as_object()
        .unwrap()
        .values()
        .map(|v| v.as_u64().unwrap())
        .collect();
    assert!(per.iter().all(|&n| n <= 3), "{outstanding}");
    assert_eq!(per.iter().sum::<u64>(), 5);
}

fn concurrent_submissions_to_disjoint_pages_all_commit(mode: StoreMode) {
    let dir = TempDir::new("conc-disjoint");
    let store = Arc::new(open_in(&dir, mode));
    let s = store.clone();
    together(WRITERS, move |i| {
        for round in 0..8 {
            let n = i * 100 + round;
            let r = s
                .submit_page_mutation(
                    &mutation(
                        &request_id(n),
                        &format!("w{i}"),
                        &format!("p/{n}"),
                        "body text",
                    ),
                    None,
                )
                .unwrap();
            assert_eq!(r["state"], "committed");
        }
    });
    assert_eq!(store.count_pages(None).unwrap(), (WRITERS * 8) as u64);
    assert_eq!(store.count_chunks().unwrap(), (WRITERS * 8) as u64);
    assert_eq!(store.journal_outstanding().unwrap()["brain"], 0);
}

fn page_id(page: &Value) -> u64 {
    page["id"].as_u64().unwrap()
}

fn embedded_one_owner_explicit_transactions_never_conflict_and_ids_stay_unique(mode: StoreMode) {
    let dir = TempDir::new("conc-tx");
    let store = Arc::new(open_in(&dir, mode));
    let s = store.clone();
    let ids = together(WRITERS, move |i| {
        let mut ids = Vec::new();
        for round in 0..6 {
            let slug = format!("p/{i}-{round}");
            if i % 2 == 0 {
                // An explicit transaction holds the writer: it must never fail with a
                // conflict, because the caller cannot run it again. (Embedded, one owner: with
                // several writers a conflict is typed and visible; see the multi_writer twin.)
                let tx = s.begin_transaction(false).unwrap();
                ids.push(page_id(&put(&tx, &slug, "inside a transaction")));
                // Read-modify-write of a page another writer also updates.
                put(&tx, "shared/hot", &format!("tx {i} {round}"));
                if round % 3 == 2 {
                    tx.rollback_transaction().unwrap();
                    ids.pop();
                } else {
                    tx.commit_transaction().unwrap();
                }
            } else {
                ids.push(page_id(&put(&s, &slug, "outside a transaction")));
                put(&s, "shared/hot", &format!("plain {i} {round}"));
            }
        }
        ids
    });
    let all: Vec<u64> = ids.into_iter().flatten().collect();
    let unique: BTreeSet<u64> = all.iter().copied().collect();
    assert_eq!(
        unique.len(),
        all.len(),
        "an id was handed out twice: {all:?}"
    );
    // 8 transaction writers commit 4 of 6 rounds; 8 plain writers commit all 6; plus shared/hot.
    assert_eq!(store.count_pages(None).unwrap(), (8 * 4 + 8 * 6 + 1) as u64);
    // An id a rolled-back transaction took is not reused by the next writer.
    let next = page_id(&put(&store, "p/after", "after"));
    assert!(
        unique.iter().all(|id| *id < next),
        "{next} is not past {unique:?}"
    );
}

fn embedded_one_owner_an_open_transaction_holds_off_other_commits_until_it_ends(mode: StoreMode) {
    let dir = TempDir::new("conc-tx-exclusive");
    let store = Arc::new(open_in(&dir, mode));
    put(&store, "notes/a", "before");
    let tx = store.begin_transaction(false).unwrap();
    put(&tx, "notes/a", "from the transaction");
    let s = store.clone();
    let other = thread::spawn(move || put(&s, "notes/b", "from another writer"));
    thread::sleep(std::time::Duration::from_millis(100));
    assert!(
        !other.is_finished(),
        "a commit landed while a transaction was open"
    );
    tx.commit_transaction().unwrap();
    other.join().unwrap();
    let page = store
        .read_page_snapshot("notes/a", &ReadScope::default())
        .unwrap()
        .unwrap();
    assert!(page.to_string().contains("from the transaction"), "{page}");
}

fn a_dropped_transaction_lets_the_other_writers_go_on(mode: StoreMode) {
    let dir = TempDir::new("conc-tx-drop");
    let store = Arc::new(open_in(&dir, mode));
    let tx = store.begin_transaction(false).unwrap();
    put(&tx, "notes/a", "never committed");
    let s = store.clone();
    let other = thread::spawn(move || put(&s, "notes/b", "after the drop"));
    drop(tx);
    other.join().unwrap();
    assert_eq!(store.count_pages(None).unwrap(), 1);
}

both_modes!(writers_of_one_page_serialize_and_each_update_lands_once => writers_of_one_page_serialize_and_each_update_lands_once_single, writers_of_one_page_serialize_and_each_update_lands_once_optimistic);
both_modes!(concurrent_tags_links_and_timeline_entries_are_all_kept => concurrent_tags_links_and_timeline_entries_are_all_kept_single, concurrent_tags_links_and_timeline_entries_are_all_kept_optimistic);
both_modes!(concurrent_chunk_writes_to_one_page_are_never_mixed => concurrent_chunk_writes_to_one_page_are_never_mixed_single, concurrent_chunk_writes_to_one_page_are_never_mixed_optimistic);
both_modes!(the_same_request_submitted_concurrently_is_applied_once => the_same_request_submitted_concurrently_is_applied_once_single, the_same_request_submitted_concurrently_is_applied_once_optimistic);
both_modes!(admission_limits_hold_under_concurrency => admission_limits_hold_under_concurrency_single, admission_limits_hold_under_concurrency_optimistic);
both_modes!(concurrent_submissions_to_disjoint_pages_all_commit => concurrent_submissions_to_disjoint_pages_all_commit_single, concurrent_submissions_to_disjoint_pages_all_commit_optimistic);
both_modes!(embedded_one_owner_explicit_transactions_never_conflict_and_ids_stay_unique => embedded_one_owner_explicit_transactions_never_conflict_and_ids_stay_unique_single, embedded_one_owner_explicit_transactions_never_conflict_and_ids_stay_unique_optimistic);
both_modes!(embedded_one_owner_an_open_transaction_holds_off_other_commits_until_it_ends => embedded_one_owner_an_open_transaction_holds_off_other_commits_until_it_ends_single, embedded_one_owner_an_open_transaction_holds_off_other_commits_until_it_ends_optimistic);
both_modes!(a_dropped_transaction_lets_the_other_writers_go_on => a_dropped_transaction_lets_the_other_writers_go_on_single, a_dropped_transaction_lets_the_other_writers_go_on_optimistic);

// ---- the multi-writer twins of the two embedded, one-owner tests above -----------------------------------------------------
//
// Each opens the optimistic store with multi-user mode on (asserted), calls the new interfaces through `common::mu`, and names
// the conformance case it belongs to (tests/multi_writer_conformance.rs).

/// The optimistic store with the multi-user switch on in the run, never from the environment; the resolved state is asserted.
fn open_mu(dir: &TempDir) -> Store {
    let store = Store::open_dir(
        &dir.path().join("brain"),
        common::mode::open_options_mu(StoreMode::Optimistic),
    )
    .unwrap();
    assert!(
        store.multiuser(),
        "the store did not resolve multi-user mode on"
    );
    store
}

fn optimistic_options(i: usize) -> TxnOptions {
    TxnOptions {
        mode: TxnMode::Optimistic,
        deadline: None,
        origin: Some(WriteOrigin {
            host_id: format!("host-{i}"),
            incarnation: format!("incarnation-{i}"),
            writer_id: format!("writer-{i}"),
        }),
        ..TxnOptions::default()
    }
}

/// C01: with several writers a conflict is typed and visible (`write_conflict`), the transaction runs again, and ids
/// stay unique. Twin of `embedded_one_owner_explicit_transactions_never_conflict_and_ids_stay_unique`.
#[test]
fn explicit_transactions_conflict_with_a_typed_error_and_ids_stay_unique_multi_writer() {
    let dir = TempDir::new("conc-tx-typed");
    let store = Arc::new(open_mu(&dir));
    drop(
        store
            .begin_with(optimistic_options(0))
            .unwrap_or_else(|e| panic!("{e}")),
    );
    let s = store.clone();
    let ids = together(WRITERS, move |i| {
        let mut ids = Vec::new();
        for round in 0..6 {
            loop {
                let tx = s
                    .begin_with(optimistic_options(i))
                    .unwrap_or_else(|e| panic!("{e}"));
                let id = page_id(&put(
                    tx.store(),
                    &format!("p/{i}-{round}"),
                    "inside a transaction",
                ));
                put(tx.store(), "shared/hot", &format!("tx {i} {round}"));
                match s.commit_position(tx) {
                    Ok(_) => {
                        ids.push(id);
                        break;
                    }
                    Err(e) => assert_eq!(e.code, WRITE_CONFLICT, "an untyped refusal: {e}"),
                }
            }
        }
        ids
    });
    let all: Vec<u64> = ids.into_iter().flatten().collect();
    let unique: BTreeSet<u64> = all.iter().copied().collect();
    assert_eq!(
        unique.len(),
        all.len(),
        "an id was handed out twice: {all:?}"
    );
    assert_eq!(store.count_pages(None).unwrap(), (WRITERS * 6 + 1) as u64);
}

/// C15 (I-1: `single_flight` orders transactions only): a plain write on a key an open optimistic transaction has read and written
/// is not held off, and there is no store-wide key gate: it lands while the transaction is still open. The transaction's commit is
/// then refused with a typed `write_conflict` (the plain write changed what it read), nothing is lost (the plain write's value is
/// stored and the transaction's write is absent), and the same transaction run again from a fresh read commits and its value lands.
/// Twin of the same-key half of `embedded_one_owner_an_open_transaction_holds_off_other_commits_until_it_ends`, where the one
/// writer gate holds the plain write off until the transaction ends.
#[test]
fn a_plain_write_on_the_same_key_as_an_open_transaction_goes_through_and_the_commit_conflicts_multi_writer()
 {
    let dir = TempDir::new("conc-tx-same-key");
    let store = Arc::new(open_mu(&dir));
    put(&store, "notes/a", "before");
    let key = || SingleFlightKey {
        source_id: "default".into(),
        slug: "notes/a".into(),
    };
    let body_of = |s: &Store| {
        s.read_page_snapshot("notes/a", &ReadScope::default())
            .unwrap()
            .unwrap()["page"]["compiled_truth"]
            .clone()
    };
    // One run of the transaction: it names the key, reads the page (the read set), and writes over it.
    let run = || {
        let tx = store
            .begin_with(optimistic_options(1))
            .unwrap_or_else(|e| panic!("{e}"));
        store
            .single_flight(&tx, &[key()])
            .unwrap_or_else(|e| panic!("{e}"));
        let seen = body_of(tx.store());
        put(tx.store(), "notes/a", "from the transaction");
        (tx, seen)
    };
    let (tx, seen) = run();
    assert_eq!(
        seen, "before",
        "the transaction did not read the stored page"
    );
    // A plain write on the held key: it is not a transaction, so the flight does not hold it.
    let s = store.clone();
    let plain = thread::spawn(move || put(&s, "notes/a", "from a plain write"));
    thread::sleep(std::time::Duration::from_millis(100));
    assert!(
        plain.is_finished(),
        "a plain write waited for a key an open transaction named: a store-wide key gate"
    );
    plain.join().unwrap();
    // The commit is refused, typed and retryable.
    let refused = store
        .commit_position(tx)
        .expect_err("the transaction committed over a write it had not read");
    assert_eq!(refused.code, WRITE_CONFLICT, "{refused}");
    // Nothing is lost: the plain write's value is stored and the transaction's write is absent.
    assert_eq!(
        body_of(&store),
        "from a plain write",
        "the refused transaction left its write, or the plain write was lost"
    );
    // The rerun, from a fresh read, commits and its value lands.
    let (rerun, seen) = run();
    assert_eq!(
        seen, "from a plain write",
        "the rerun did not read the plain write"
    );
    store
        .commit_position(rerun)
        .unwrap_or_else(|e| panic!("the rerun was refused: {e}"));
    assert_eq!(
        body_of(&store),
        "from the transaction",
        "the rerun's value did not land"
    );
}

/// C15: single flight orders transactions: a second transaction that names the key an open one holds waits at its own single flight
/// (it is not refused and not lost), then lands after it.
#[test]
fn a_second_transaction_naming_a_held_key_waits_for_the_holder_multi_writer() {
    let dir = TempDir::new("conc-tx-flight-order");
    let store = Arc::new(open_mu(&dir));
    put(&store, "notes/a", "before");
    let key = || SingleFlightKey {
        source_id: "default".into(),
        slug: "notes/a".into(),
    };
    let tx = store
        .begin_with(optimistic_options(1))
        .unwrap_or_else(|e| panic!("{e}"));
    store
        .single_flight(&tx, &[key()])
        .unwrap_or_else(|e| panic!("{e}"));
    put(tx.store(), "notes/a", "from the transaction");
    let s = store.clone();
    let other = thread::spawn(move || {
        // The younger transaction waits at its single flight until the holder ends; a commit refused as stale runs again.
        loop {
            let tx = s
                .begin_with(optimistic_options(2))
                .unwrap_or_else(|e| panic!("{e}"));
            s.single_flight(&tx, &[key()])
                .unwrap_or_else(|e| panic!("{e}"));
            put(tx.store(), "notes/a", "from another writer");
            match s.commit_position(tx) {
                Ok(position) => return position,
                Err(e) => assert_eq!(e.code, WRITE_CONFLICT, "an untyped refusal: {e}"),
            }
        }
    });
    thread::sleep(std::time::Duration::from_millis(100));
    assert!(
        !other.is_finished(),
        "a transaction on the held key landed while the holder's single flight was open"
    );
    let first = store.commit_position(tx).unwrap_or_else(|e| panic!("{e}"));
    let second = other.join().unwrap();
    assert!(
        first < second,
        "the waiting transaction did not commit after the holder: {first:?}, {second:?}"
    );
    let page = store
        .read_page_snapshot("notes/a", &ReadScope::default())
        .unwrap()
        .unwrap();
    assert!(page.to_string().contains("from another writer"), "{page}");
}

/// C13: a commit on another key lands while a transaction is open. Twin of the other-keys half of
/// `embedded_one_owner_an_open_transaction_holds_off_other_commits_until_it_ends`.
#[test]
fn a_commit_on_another_key_lands_while_a_transaction_is_open_multi_writer() {
    let dir = TempDir::new("conc-tx-other-key");
    let store = Arc::new(open_mu(&dir));
    put(&store, "notes/a", "before");
    let tx = store
        .begin_with(optimistic_options(1))
        .unwrap_or_else(|e| panic!("{e}"));
    put(tx.store(), "notes/a", "from the transaction");
    let s = store.clone();
    let other = thread::spawn(move || put(&s, "notes/b", "from another writer"));
    thread::sleep(std::time::Duration::from_millis(100));
    assert!(
        other.is_finished(),
        "a commit on another key waited for the open transaction"
    );
    other.join().unwrap();
    store.commit_position(tx).unwrap_or_else(|e| panic!("{e}"));
}
