//! Many writers on one brain: what Postgres gives under row locks, the store gives under
//! optimistic transactions. Conflicting writes serialize (each one lands once, the last committer
//! wins, nothing is lost or mixed); disjoint writes do not wait for each other.

mod common;

use common::{TempDir, open_concurrent as open};
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

#[test]
fn writers_of_one_page_serialize_and_each_update_lands_once() {
    let dir = TempDir::new("conc-same-page");
    let store = Arc::new(open(&dir));
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

#[test]
fn concurrent_tags_links_and_timeline_entries_are_all_kept() {
    let dir = TempDir::new("conc-children");
    let store = Arc::new(open(&dir));
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

#[test]
fn concurrent_chunk_writes_to_one_page_are_never_mixed() {
    let dir = TempDir::new("conc-chunks");
    let store = Arc::new(open(&dir));
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

#[test]
fn the_same_request_submitted_concurrently_is_applied_once() {
    let dir = TempDir::new("conc-idempotent");
    let store = Arc::new(open(&dir));
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

#[test]
fn admission_limits_hold_under_concurrency() {
    let dir = TempDir::new("conc-admission");
    let store = Arc::new(open(&dir));
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

#[test]
fn concurrent_submissions_to_disjoint_pages_all_commit() {
    let dir = TempDir::new("conc-disjoint");
    let store = Arc::new(open(&dir));
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

#[test]
fn explicit_transactions_commit_beside_concurrent_writers_and_ids_stay_unique() {
    let dir = TempDir::new("conc-tx");
    let store = Arc::new(open(&dir));
    let s = store.clone();
    let ids = together(WRITERS, move |i| {
        let mut ids = Vec::new();
        for round in 0..6 {
            let slug = format!("p/{i}-{round}");
            if i % 2 == 0 {
                // An explicit transaction holds the writer: it must never fail with a
                // conflict, because the caller cannot run it again.
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

#[test]
fn an_open_transaction_holds_off_other_commits_until_it_ends() {
    let dir = TempDir::new("conc-tx-exclusive");
    let store = Arc::new(open(&dir));
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

#[test]
fn a_dropped_transaction_lets_the_other_writers_go_on() {
    let dir = TempDir::new("conc-tx-drop");
    let store = Arc::new(open(&dir));
    let tx = store.begin_transaction(false).unwrap();
    put(&tx, "notes/a", "never committed");
    let s = store.clone();
    let other = thread::spawn(move || put(&s, "notes/b", "after the drop"));
    drop(tx);
    other.join().unwrap();
    assert_eq!(store.count_pages(None).unwrap(), 1);
}
