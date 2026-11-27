//! Property tests for concurrency and ordering (P-B to P-G of the design's "Concurrency and ordering property tests"). P-A and
//! P-H are in `multi_writer_sim.rs`.
//!
//! Run today, in the store modes where the property holds:
//! - P-C: commit positions strictly increase on any store, and grow by exactly one per commit only on the single-writer store
//!   (a group commit on the optimistic store shares one);
//! - P-F: admission never exceeds a cap under any generated arrival order;
//! - P-G: any number of replays of one request id, from any number of threads, leaves one row.
//!
//! Pending, each calling the frozen interfaces only through `common::mu` (so it fails, naming the owning lane, until that lane
//! lands): P-B (facts of one entity read back in commit order), P-D (after lease B is granted, a write under lease A's token is
//! refused in its own transaction), P-E (a read with a write's token sees that write). They are `#[ignore = "multi_writer"]`.
//!
//! Failure persistence is off and the generator seed is proptest's default, as in `store_props.rs`, so a failing case prints its
//! minimal input and a run writes no file.

mod common;

use common::mu::{CommitPosition, MuStore, TxnMode, TxnOptions, WriteOrigin};
use common::{StoreMode, TempDir, open_in, open_mu};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::journal::{JournalLimits, PageMutation, WriteAdmission};
use gbrain_store::pages::{PageInput, PutPageOptions, VersionsOptions};
use proptest::prelude::*;
use proptest::test_runner::TestRunner;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::sync::{Arc, Barrier};
use std::thread;

/// Every case opens a real store directory and starts threads, so the counts are small.
const CASES: u32 = 24;

fn config(cases: u32) -> ProptestConfig {
    ProptestConfig {
        cases,
        failure_persistence: None,
        ..ProptestConfig::default()
    }
}

/// Runs `f(i)` on `n` threads that start together.
fn together<T: Send + 'static>(n: usize, f: impl Fn(usize) -> T + Send + Sync + 'static) -> Vec<T> {
    let (barrier, f) = (Arc::new(Barrier::new(n)), Arc::new(f));
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

fn request_id(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn page(body: &str) -> PageInput {
    serde_json::from_value(json!({"type": "note", "title": "t", "compiled_truth": body})).unwrap()
}

fn mode_strategy() -> impl Strategy<Value = StoreMode> {
    prop_oneof![Just(StoreMode::Single), Just(StoreMode::Optimistic)]
}

// ---- P-C: commit positions ----------------------------------------------------------------------------------------------

proptest! {
    #![proptest_config(config(CASES))]

    /// Concurrent single-page commits: the explicit transactions of one writer get strictly increasing sequences, and the
    /// store's commit version grows by exactly one per commit on the single-writer store, and by at least one and at most one
    /// per commit on the optimistic store (a batch shares one sequence).
    #[test]
    fn p_c_commit_positions_strictly_increase(
        mode in mode_strategy(),
        writers in 1usize..=4,
        commits in 1usize..=5,
    ) {
        let dir = TempDir::new("p-c");
        let store = Arc::new(open_in(&dir, mode));
        let start = store.commit_version().unwrap();
        let s = store.clone();
        let explicit = together(writers, move |i| {
            let mut mine = Vec::new();
            for n in 0..commits {
                // One explicit transaction, then one plain write: both are commits.
                let tx = s.begin_transaction(false).unwrap();
                tx.put_page(&format!("c/{i}-{n}-tx"), &page("in a transaction"), &PutPageOptions::default()).unwrap();
                mine.push(tx.commit_transaction().unwrap());
                s.put_page(&format!("c/{i}-{n}"), &page("plain"), &PutPageOptions::default()).unwrap();
            }
            mine
        });
        for mine in &explicit {
            prop_assert!(mine.windows(2).all(|w| w[0] < w[1]), "positions went back: {:?}", mine);
        }
        let total = (writers * commits * 2) as u64;
        let grown = store.commit_version().unwrap() - start;
        match mode {
            StoreMode::Single => prop_assert_eq!(grown, total, "one position per commit"),
            StoreMode::Optimistic => {
                prop_assert!(grown >= 1 && grown <= total, "grew by {} for {} commits", grown, total);
            }
        }
        let all: BTreeSet<u64> = explicit.iter().flatten().copied().collect();
        if mode == StoreMode::Single {
            prop_assert_eq!(all.len(), writers * commits, "two transactions share a position");
        }
        // Every acknowledged write is there.
        prop_assert_eq!(store.count_pages(None).unwrap(), total);
    }
}

// ---- P-F: admission never exceeds a cap ---------------------------------------------------------------------------------

proptest! {
    #![proptest_config(config(CASES))]

    /// Any arrival order of requests from any number of principals never admits more than the brain cap or a principal cap, the
    /// counters equal what was admitted, and a request is refused only when a cap is full.
    #[test]
    fn p_f_admission_never_exceeds_a_cap(
        mode in mode_strategy(),
        brain_cap in 1u64..=8,
        principal_cap in 1u64..=4,
        principals in 1usize..=4,
        requests in 1usize..=24,
        threads in 1usize..=8,
    ) {
        let dir = TempDir::new("p-f");
        let store = Arc::new(open_in(&dir, mode));
        let limits = JournalLimits { principal_outstanding: principal_cap, brain_outstanding: brain_cap };
        let s = store.clone();
        let results = together(threads, move |t| {
            let mut mine = Vec::new();
            for r in (t..requests).step_by(threads) {
                let admission: WriteAdmission = serde_json::from_value(json!({
                    "principal": {"kind": "local_cli", "id": format!("p{}", r % principals)},
                    "operation": "put_page", "requestId": request_id(r + 10), "slug": format!("s{r}"),
                    "callerIntent": {},
                })).unwrap();
                mine.push((r % principals, s.admit_write(&admission, Some(limits)).map(|_| ())));
            }
            mine
        });
        let all: Vec<_> = results.into_iter().flatten().collect();
        prop_assert_eq!(all.len(), requests);
        let admitted = all.iter().filter(|(_, r)| r.is_ok()).count() as u64;
        prop_assert!(admitted <= brain_cap, "{} admitted over a brain cap of {}", admitted, brain_cap);
        for (_, r) in &all {
            if let Err(e) = r {
                prop_assert_eq!(e.code, ADMISSION_REFUSED);
            }
        }
        let outstanding = store.journal_outstanding().unwrap();
        prop_assert_eq!(outstanding["brain"].as_u64().unwrap(), admitted, "the brain counter drifted");
        let per: Vec<u64> = outstanding["principals"].as_object().unwrap().values().map(|v| v.as_u64().unwrap()).collect();
        prop_assert!(per.iter().all(|&n| n <= principal_cap), "a principal is over its cap: {}", outstanding);
        prop_assert_eq!(per.iter().sum::<u64>(), admitted, "the principal counters drifted");
        // Below every cap nothing may be refused.
        let room = brain_cap.min(principal_cap * principals as u64);
        let largest_share = (0..principals).map(|p| (0..requests).filter(|r| r % principals == p).count() as u64).max().unwrap();
        if requests as u64 <= room && largest_share <= principal_cap {
            prop_assert_eq!(admitted, requests as u64, "a request was refused with room under every cap");
        }
    }
}

// ---- P-G: replays of one request id -------------------------------------------------------------------------------------

proptest! {
    #![proptest_config(config(CASES))]

    /// Any number of replays of one request id, from any number of threads, leaves one row, one receipt and no unfinished
    /// request.
    #[test]
    fn p_g_replays_of_one_request_id_leave_one_row(
        mode in mode_strategy(),
        threads in 1usize..=8,
        replays in 1usize..=6,
    ) {
        let dir = TempDir::new("p-g");
        let store = Arc::new(open_in(&dir, mode));
        let s = store.clone();
        let receipts = together(threads, move |_| {
            (0..replays).map(|_| {
                let m: PageMutation = serde_json::from_value(json!({
                    "principal": {"kind": "local_cli", "id": "w"}, "requestId": request_id(1), "slug": "doc",
                    "page": {"type": "note", "title": "doc", "compiled_truth": "only body"}, "options": {},
                })).unwrap();
                s.submit_page_mutation(&m, None).unwrap()
            }).collect::<Vec<Value>>()
        });
        let receipts: Vec<Value> = receipts.into_iter().flatten().collect();
        prop_assert_eq!(receipts.len(), threads * replays);
        prop_assert!(receipts.iter().all(|r| r["state"] == "committed"), "a replay was not committed");
        // A replay answers with the stored receipt of the first run: every one says the page was created.
        prop_assert!(receipts.iter().all(|r| r["status"] == "created"), "a replay was applied as a new request");
        let pages: BTreeSet<String> = receipts.iter().map(|r| r["page_id"].to_string()).collect();
        prop_assert_eq!(pages.len(), 1, "replays answered with different rows");
        prop_assert_eq!(store.count_pages(None).unwrap(), 1, "a replay added a row");
        prop_assert!(store.get_versions("doc", &VersionsOptions::default()).unwrap().is_empty(), "the request was applied twice");
        prop_assert_eq!(store.journal_outstanding().unwrap()["brain"].as_u64().unwrap(), 0);
    }
}

// ---- the properties that wait for the multi-user interfaces -------------------------------------------------------------

fn origin(i: usize) -> WriteOrigin {
    WriteOrigin {
        host_id: format!("host-{i}"),
        incarnation: format!("incarnation-{i}"),
        writer_id: format!("writer-{i}"),
    }
}

fn host(i: usize) -> TxnOptions {
    TxnOptions {
        mode: TxnMode::Optimistic,
        deadline: None,
        origin: Some(origin(i)),
        ..TxnOptions::default()
    }
}

/// Runs `body` over generated inputs; a failing case panics with its minimal input.
fn run_property<S: Strategy>(
    strategy: S,
    body: impl Fn(S::Value) -> std::result::Result<(), TestCaseError>,
) {
    let mut runner = TestRunner::new(config(CASES));
    if let Err(e) = runner.run(&strategy, body) {
        panic!("{e}");
    }
}

/// P-B: facts of one entity read back in commit order, whatever the writers and their counts. Stays ignored for this reason:
/// the read it compares with commit order lists facts by `created_at` (then id), and I-4.v2.1 says `created_at` is the
/// transaction's clock time, not the commit time, so a later commit can carry an earlier one. It waits for a read in commit-position
/// order (the per-entity fact sequence); the property then holds by position.
#[test]
#[ignore = "multi_writer: I-4.v2.1, created_at order is not commit order"]
fn p_b_facts_of_one_entity_read_back_in_commit_order_multi_writer() {
    run_property((1usize..=4, 1usize..=4), |(writers, per_writer)| {
        let dir = TempDir::new("p-b");
        let store = Arc::new(open_mu(&dir));
        let s = store.clone();
        let committed = together(writers, move |i| {
            (0..per_writer)
                .map(|n| {
                    let tx = s.begin_with(host(i)).unwrap_or_else(|e| panic!("{e}"));
                    let text = format!("fact {i} {n}");
                    let args = serde_json::from_value(json!({
                        "input": {"fact": text, "entity_slug": "people/alice", "source": "chat"}, "sourceId": "default",
                    }))
                    .unwrap();
                    tx.store().insert_fact(&args).unwrap();
                    (s.commit_position(tx).unwrap_or_else(|e| panic!("{e}")), text)
                })
                .collect::<Vec<(CommitPosition, String)>>()
        });
        let mut by_commit: Vec<_> = committed.into_iter().flatten().collect();
        by_commit.sort();
        let q = serde_json::from_value(json!({"sourceId": "default", "entitySlug": "people/alice", "activeOnly": true, "limit": 500})).unwrap();
        let mut read: Vec<String> = store
            .list_facts_by_entity(&q)
            .unwrap()
            .iter()
            .map(|r| r["fact"].as_str().unwrap().to_string())
            .collect();
        read.reverse();
        let expected: Vec<String> = by_commit.into_iter().map(|(_, t)| t).collect();
        prop_assert_eq!(read, expected);
        Ok(())
    });
}

/// P-D: after lease B is granted, any write with lease A's token is refused in its own transaction, whatever the number of
/// takeovers and stale writers.
#[test]
#[ignore = "multi_writer"]
fn p_d_a_write_with_a_replaced_leases_token_is_refused_multi_writer() {
    run_property((1usize..=3, 1usize..=4), |(takeovers, stale_writes)| {
        let dir = TempDir::new("p-d");
        let store = Arc::new(open_mu(&dir));
        let mut tokens = Vec::new();
        for holder in 0..=takeovers {
            thread::sleep(std::time::Duration::from_millis(2));
            let token = store
                .acquire_lease(
                    "cycle",
                    &origin(holder),
                    if holder == takeovers { 60_000 } else { 1 },
                )
                .unwrap_or_else(|e| panic!("{e}"))
                .expect("a takeover");
            tokens.push(token);
        }
        prop_assert!(
            tokens.windows(2).all(|w| w[0].epoch < w[1].epoch),
            "an epoch did not move"
        );
        for old in &tokens[..takeovers] {
            for _ in 0..stale_writes {
                let tx = store.begin_with(host(9)).unwrap_or_else(|e| panic!("{e}"));
                let refused = tx.assert_lease(old).is_err();
                prop_assert!(refused, "a replaced lease's token was accepted");
            }
        }
        Ok(())
    });
}

/// P-E: a read with a write's token sees that write, for any number of writes.
#[test]
#[ignore = "multi_writer"]
fn p_e_a_read_with_a_writes_token_sees_that_write_multi_writer() {
    run_property(1usize..=8, |writes| {
        let dir = TempDir::new("p-e");
        let store = open_mu(&dir);
        for n in 0..writes {
            let tx = store.begin_with(host(n)).unwrap_or_else(|e| panic!("{e}"));
            tx.store()
                .put_page(
                    &format!("e/{n}"),
                    &page("acknowledged"),
                    &PutPageOptions::default(),
                )
                .unwrap();
            let position = store.commit_position(tx).unwrap_or_else(|e| panic!("{e}"));
            let log = store
                .read_commit_log(None, 10_000)
                .unwrap_or_else(|e| panic!("{e}"));
            prop_assert!(
                log.newest >= Some(position),
                "the log is behind {}",
                position.token()
            );
            let seen = store
                .read_page_snapshot(&format!("e/{n}"), &Default::default())
                .unwrap()
                .is_some();
            prop_assert!(
                seen,
                "the write with token {} is not visible",
                position.token()
            );
        }
        Ok(())
    });
}

/// A smoke check that the property file's own pieces work: a store opens in both modes and the helpers agree with it.
#[test]
fn the_property_fixtures_open_both_modes() {
    for mode in StoreMode::ALL {
        let dir = TempDir::new("p-fixture");
        let store: Store = open_in(&dir, mode);
        store
            .put_page("x", &page("body"), &PutPageOptions::default())
            .unwrap();
        assert_eq!(store.count_pages(None).unwrap(), 1);
    }
}
