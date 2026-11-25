//! Multi-writer conformance suite C01..C22 (docs/designs/rust-engine/multi-user-server.md, "Tests to
//! write now", 1). Each case names a typed operation and an invariant, asserts the invariant inside
//! the scenario, and compares outcomes, never the order the store took.
//!
//! Every case has two parts:
//! - the runnable part, a plain test `cNN_<name>` that holds on today's store (it runs in both store
//!   modes: `GBRAIN_RUST_CONCURRENT_WRITES=1` puts `common::open` on the optimistic record file);
//! - the multi-writer part, `cNN_<name>_multi_writer`, `#[ignore = "multi_writer"]`: the same rule with
//!   writers that are independent explicit transactions or hosts. Its body compiles today and calls the
//!   frozen interfaces I-1 to I-5 only through `common::mu`, whose stubs return a typed pending error
//!   naming the owning lane. Run them with
//!   `cargo test -p gbrain-store --test multi_writer_conformance -- --ignored multi_writer`.
//!
//! Un-pending a case is a one-line edit: the owning lane replaces its stub in `common/mu.rs`, and the
//! twin starts passing. `mu_adapter_stubs_are_still_pending` lists the stubs so that edit is visible.
//!
//! C16 and C19 are real: C16 upgrades an old-format brain with one owner open, exactly once; C19 kills
//! a child process (SIGKILL) while it admits writes and checks every acknowledged request id after a
//! reopen. The graceful-drop reopen tests (`..._clean_reopen`) are not C19 coverage.

mod common;
mod memory_env;

use common::mu::{
    self, CommitPosition, L1_TXN, L2_LOG, L3_SERVER, L5_HOSTS, LeaseToken, MuStore, MuTxn,
    SingleFlightKey, TxnMode, TxnOptions, WriteOrigin,
};
use common::{StoreMode, TempDir, open, open_in};
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::error::*;
use gbrain_store::facts::{FactQuery, InsertFactArgs};
use gbrain_store::generations::{ActivationInput, GenerationKey, LedgerItemInput};
use gbrain_store::jobs::{AdmitSpec, ClaimSpec, LockAcquire};
use gbrain_store::journal::{JournalLimits, PageMutation, WriteAdmission};
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope, VersionsOptions};
use gbrain_store::persistence::{
    ClaimStamp, ClaimableSpec, EffectClaim, EffectSettle, PublicationEffectsSpec, Settle,
    WriteRequestInsert,
};
use gbrain_store::{FORMAT_VERSION, OpenOptions, Store};
use memory_env::{Brain, brain, brain_in};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

const WRITERS: usize = 16;
const MARK: &str = "watchdog_suspect";

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

fn page(body: &str) -> PageInput {
    serde_json::from_value(json!({"type": "note", "title": "t", "compiled_truth": body})).unwrap()
}

fn put(s: &Store, slug: &str, body: &str) -> Value {
    s.put_page(slug, &page(body), &PutPageOptions::default())
        .unwrap()
}

fn revision(s: &Store, slug: &str) -> String {
    let snap = s.read_page_snapshot(slug, &ReadScope::default()).unwrap();
    snap.unwrap()["revision"].as_str().unwrap().to_string()
}

fn exists(s: &Store, slug: &str) -> bool {
    let snap = s.read_page_snapshot(slug, &ReadScope::default()).unwrap();
    snap.is_some()
}

fn request_id(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn mutation(n: usize, slug: &str, body: &str) -> PageMutation {
    mutation_with(n, slug, body, json!({}))
}

fn mutation_with(n: usize, slug: &str, body: &str, options: Value) -> PageMutation {
    serde_json::from_value(json!({
        "principal": {"kind": "local_cli", "id": format!("w{}", n % 8)}, "requestId": request_id(n),
        "slug": slug, "page": {"type": "note", "title": slug, "compiled_truth": body}, "options": options,
    }))
    .unwrap()
}

fn submit(s: &Store, n: usize, slug: &str, body: &str) -> Value {
    let r = s
        .submit_page_mutation(&mutation(n, slug, body), None)
        .unwrap();
    assert_eq!(r["state"], "committed", "{r}");
    r
}

fn job_spec(name: &str, extra: Value) -> AdmitSpec {
    let mut row = json!({
        "name": name, "queue": "default", "status": "waiting", "priority": 0, "data": {},
        "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000,
        "backoff_jitter": 0.2, "on_child_fail": "fail_parent", "remove_on_complete": false,
        "remove_on_fail": false, "submission_authority": {"version": 1, "kind": "application"},
    });
    for (k, v) in extra.as_object().unwrap() {
        row[k] = v.clone();
    }
    serde_json::from_value(json!({"insert": row, "maxSpawnDepth": 5})).unwrap()
}

fn add_job(s: &Store, extra: Value) -> i64 {
    let out = s.admit_job(&job_spec("work", extra)).unwrap();
    assert_eq!(out.outcome, "inserted");
    out.row["id"].as_i64().unwrap()
}

fn claim_spec(token: &str, lock_ms: f64) -> ClaimSpec {
    serde_json::from_value(json!({
        "lockToken": token, "lockDurationMs": lock_ms, "queue": "default", "names": ["work"],
        "suspectMark": MARK, "handlerTimeouts": {}, "handlerLockDurations": {},
        "legacySpend": {"groupId": "00000000-0000-4000-8000-000000000001", "capUsd": 5},
    }))
    .unwrap()
}

fn queued_write(s: &Store, request: &str) -> String {
    let incarnation = s.read_source_membership("default").unwrap().unwrap()["incarnation"].clone();
    let keys = ["principal:local_cli:parity-writer", "brain"];
    let insert: WriteRequestInsert = serde_json::from_value(json!({
        "principalKind": "local_cli", "principalId": "parity-writer", "requestId": request,
        "operation": "put_page", "sourceId": "default", "sourceIncarnation": incarnation,
        "pageId": null, "slug": "notes/a", "worktreeId": null, "topologyGeneration": null,
        "digest": "digest", "intent": {"kind": "put_page"}, "authority": {}, "intentBytes": 10,
        "terminalReservation": 4096, "targetKind": "page", "protocolVersion": 1,
        "admitterVersion": "v-test", "admitterHostId": null, "counterKeys": keys,
        "clientRequestId": null, "state": "queued", "deferredRefreshId": null,
    }))
    .unwrap();
    s.lock_persistence_counters(&keys.map(String::from))
        .unwrap();
    s.insert_write_request(&insert).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

fn fact(s: &Store, text: &str) -> u64 {
    let args: InsertFactArgs = serde_json::from_value(json!({
        "input": {"fact": text, "entity_slug": "people/alice", "source": "chat"}, "sourceId": "default",
    }))
    .unwrap();
    s.insert_fact(&args).unwrap()["id"].as_u64().unwrap()
}

/// The fact texts of one entity as a reader sees them, newest first.
fn facts_read(s: &Store) -> Vec<String> {
    let q: FactQuery = serde_json::from_value(
        json!({"sourceId": "default", "entitySlug": "people/alice", "activeOnly": true, "limit": 500}),
    )
    .unwrap();
    let rows = s.list_facts_by_entity(&q).unwrap();
    rows.iter()
        .map(|r| r["fact"].as_str().unwrap().to_string())
        .collect()
}

fn publish(
    s: &Store,
    key: &GenerationKey,
    live: Option<f64>,
    generation: f64,
    who: usize,
) -> gbrain_store::Result<u64> {
    let row = ActivationInput {
        generation,
        run_id: None,
        operation_id: format!("op-{who}"),
        input_pin: None,
        input_size: None,
        completeness: "{}".into(),
        set_hash: "h".into(),
        restore_of: None,
        activation_id: None,
        locator: None,
    };
    let item = LedgerItemInput {
        item_key: "atoms/x".into(),
        identity_hash: "x".into(),
        action: "published".into(),
        preimage: None,
        preimage_bytes: None,
        pending: false,
    };
    s.activate_generation_rows(key, live, &row, &[item])
}

fn lock(pid: i64, token: &str, ttl_minutes: f64) -> LockAcquire {
    LockAcquire {
        holder_pid: pid,
        holder_host: Some(format!("host-{pid}")),
        acquisition_token: token.into(),
        ttl_minutes,
        steal_grace_seconds: 0.0,
    }
}

/// A store opened in optimistic mode, whatever the environment says (the multi-writer parts).
fn open_optimistic(dir: &TempDir) -> Store {
    open_in(dir, StoreMode::Optimistic)
}

/// The identity of writer `i`, one host each (I-3).
fn origin(i: usize) -> WriteOrigin {
    WriteOrigin {
        host_id: format!("host-{i}"),
        incarnation: format!("incarnation-{i}"),
        writer_id: format!("writer-{i}"),
    }
}

/// An explicit optimistic transaction for writer `i` (I-1). Pending until the transaction lane lands.
fn host_options(i: usize) -> TxnOptions {
    TxnOptions {
        mode: TxnMode::Optimistic,
        deadline: None,
        origin: Some(origin(i)),
    }
}

fn begin_host(store: &Store, i: usize) -> MuTxn {
    store
        .begin_with(host_options(i))
        .unwrap_or_else(|e| panic!("{e}"))
}

/// Fails, naming the owning lane, until explicit optimistic transactions exist.
fn require_transactions(store: &Store) {
    drop(begin_host(store, 0));
}

fn commit_host(store: &Store, tx: MuTxn) -> CommitPosition {
    store.commit_position(tx).unwrap_or_else(|e| panic!("{e}"))
}

/// A typed `write_conflict` from a commit is the retryable answer of an optimistic transaction.
fn is_conflict(e: &mu::MuError) -> bool {
    e.code() == Some(WRITE_CONFLICT)
}

/// A host's lease, taken through I-5 (pending until the hosts lane lands it).
fn require_host_lease(store: &Store) -> LeaseToken {
    store
        .acquire_lease("conformance-host", &origin(0), 30_000)
        .unwrap_or_else(|e| panic!("{e}"))
        .expect("the first holder gets the lease")
}

/// The typed refusal of a write whose lease was taken over (I-1).
const LEASE_LOST: &str = "lease_lost";

fn current_body(s: &Store, slug: &str) -> String {
    let snap = s
        .read_page_snapshot(slug, &ReadScope::default())
        .unwrap()
        .unwrap();
    snap["page"]["compiled_truth"].as_str().unwrap().to_string()
}

fn has_chunk(s: &Store, slug: &str, text: &str) -> bool {
    s.get_chunks(slug, &ReadScope::default())
        .unwrap()
        .iter()
        .any(|c| c["chunk_text"] == text)
}

/// Every body in `acked` (and the seed) is in the page's history, none twice, and nothing else is.
fn assert_history_is_exactly(store: &Store, slug: &str, acked: &[String], seed: &str) {
    let history = store
        .get_versions(slug, &VersionsOptions::default())
        .unwrap();
    let mut seen: BTreeSet<String> = history
        .iter()
        .map(|v| v["compiled_truth"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(seen.len(), history.len(), "a body is in the history twice");
    seen.insert(current_body(store, slug));
    let mut expected: BTreeSet<String> = acked.iter().cloned().collect();
    expected.insert(seed.into());
    assert_eq!(
        seen, expected,
        "an acknowledged write is missing or one never acknowledged landed"
    );
}

/// C01, compare-and-set page write: every acknowledged write is in the history or the writer got a typed conflict.
#[test]
fn c01_same_page_writers_lose_no_update() {
    let dir = TempDir::new("c01");
    let store = Arc::new(open(&dir));
    submit(&store, 0, "doc", "body seed");
    let s = store.clone();
    let outcomes = together(WRITERS, move |i| {
        let mut acked = Vec::new();
        let mut conflicts = 0;
        for round in 0..4 {
            let body = format!("body {i} {round}");
            let expected = json!({"expectedRevision": revision(&s, "doc")});
            let m = mutation_with(1 + i * 4 + round, "doc", &body, expected);
            let receipt = s.submit_page_mutation(&m, None).unwrap();
            match receipt["state"].as_str().unwrap() {
                "committed" => acked.push(body),
                _ => {
                    assert_eq!(receipt["write_error"], REVISION_CONFLICT, "{receipt}");
                    conflicts += 1;
                }
            }
        }
        (acked, conflicts)
    });
    let acked: Vec<String> = outcomes.into_iter().flat_map(|(a, _)| a).collect();
    assert!(!acked.is_empty(), "no writer won");
    assert_history_is_exactly(&store, "doc", &acked, "body seed");
}

/// C01, compare-and-set page write: writers in independent optimistic transactions read the page and
/// replace it; each commit is acknowledged with its own position or is a typed, retryable `write_conflict`.
#[test]
#[ignore = "multi_writer"]
fn c01_same_page_writers_lose_no_update_multi_writer() {
    let dir = TempDir::new("c01m");
    let store = Arc::new(open_optimistic(&dir));
    require_transactions(&store);
    submit(&store, 0, "doc", "body seed");
    let (s, attempts) = (store.clone(), Arc::new(AtomicUsize::new(1)));
    let outcomes = together(WRITERS, move |i| {
        let mut acked = Vec::new();
        for round in 0..3 {
            let body = format!("body {i} {round}");
            loop {
                let tx = begin_host(&s, i);
                let expected = json!({"expectedRevision": revision(&tx, "doc")});
                let n = attempts.fetch_add(1, Ordering::SeqCst);
                let receipt = tx
                    .submit_page_mutation(&mutation_with(n, "doc", &body, expected), None)
                    .unwrap();
                if receipt["state"] != "committed" {
                    assert_eq!(receipt["write_error"], REVISION_CONFLICT, "{receipt}");
                    continue;
                }
                match s.commit_position(tx) {
                    Ok(position) => {
                        acked.push((body.clone(), position));
                        break;
                    }
                    Err(e) => assert!(is_conflict(&e), "an untyped refusal: {e}"),
                }
            }
        }
        acked
    });
    let acked: Vec<_> = outcomes.into_iter().flatten().collect();
    let positions: BTreeSet<CommitPosition> = acked.iter().map(|(_, p)| *p).collect();
    assert_eq!(positions.len(), acked.len(), "two commits share a position");
    let bodies: Vec<String> = acked.into_iter().map(|(b, _)| b).collect();
    assert_eq!(bodies.len(), WRITERS * 3, "a writer gave up");
    assert_history_is_exactly(&store, "doc", &bodies, "body seed");
}

/// C02, `upsert_chunks` with an expected revision: a stale writer gets `revision_conflict`, a re-read succeeds.
#[test]
fn c02_stale_revision_gets_a_typed_conflict() {
    let dir = TempDir::new("c02");
    let store = open(&dir);
    put(&store, "doc", "one");
    let stale = revision(&store, "doc");
    put(&store, "doc", "two");
    let chunks: Vec<ChunkInput> =
        vec![serde_json::from_value(json!({"chunk_index": 0, "chunk_text": "part"})).unwrap()];
    let with = |r: &str| UpsertChunksOptions {
        expected_revision: Some(r.into()),
        ..Default::default()
    };
    let refused = store
        .upsert_chunks("doc", &chunks, &with(&stale))
        .unwrap_err();
    assert_eq!(refused.code, REVISION_CONFLICT, "{refused:?}");
    assert!(
        !has_chunk(&store, "doc", "part"),
        "the refused write left its chunk"
    );
    store
        .upsert_chunks("doc", &chunks, &with(&revision(&store, "doc")))
        .unwrap();
    assert!(
        has_chunk(&store, "doc", "part"),
        "the re-read write is missing"
    );
}

/// C02, `upsert_chunks` with an expected revision: of two optimistic transactions that read the same
/// revision, the second to commit gets `revision_conflict` (or a typed `write_conflict` at commit), and a
/// re-read succeeds.
#[test]
#[ignore = "multi_writer"]
fn c02_stale_revision_gets_a_typed_conflict_multi_writer() {
    let dir = TempDir::new("c02m");
    let store = Arc::new(open_optimistic(&dir));
    put(&store, "doc", "one");
    let read_at = revision(&store, "doc");
    let (first, second) = (begin_host(&store, 1), begin_host(&store, 2));
    let chunks: Vec<ChunkInput> =
        vec![serde_json::from_value(json!({"chunk_index": 0, "chunk_text": "part"})).unwrap()];
    let with = |r: &str| UpsertChunksOptions {
        expected_revision: Some(r.into()),
        ..Default::default()
    };
    first
        .upsert_chunks("doc", &chunks, &with(&read_at))
        .unwrap();
    commit_host(&store, first);
    let stale = second.upsert_chunks("doc", &chunks, &with(&read_at));
    let refused = match stale {
        Err(e) => Some(e.code.to_string()),
        Ok(_) => store.commit_position(second).err().map(|e| {
            assert!(is_conflict(&e), "an untyped refusal: {e}");
            WRITE_CONFLICT.to_string()
        }),
    };
    let refused = refused.expect("the stale writer was acknowledged");
    assert!(
        refused == REVISION_CONFLICT || refused == WRITE_CONFLICT,
        "{refused}"
    );
    let retry = begin_host(&store, 2);
    retry
        .upsert_chunks("doc", &chunks, &with(&revision(&retry, "doc")))
        .unwrap();
    commit_host(&store, retry);
    assert!(
        has_chunk(&store, "doc", "part"),
        "the re-read write is missing"
    );
}

/// C03, write claim (select then stamp in one transaction): one claimant per request at a time.
#[test]
fn c03_two_claimers_of_one_write_never_both_claim() {
    let dir = TempDir::new("c03");
    let store = Arc::new(open(&dir));
    let id = queued_write(&store, "b0000000-0000-4000-8000-0000000000b1");
    let token = |i: usize| format!("c0000000-0000-4000-8000-{i:012}");
    let s = store.clone();
    let won = together(8, move |i| {
        let tx = s.begin_transaction(false).unwrap();
        let claimed = match tx
            .select_claimable_write(&ClaimableSpec::default())
            .unwrap()
        {
            Some(row) => {
                let stamp = ClaimStamp {
                    id: row["id"].as_str().unwrap().into(),
                    token: token(i),
                    lease_ms: 60_000.0,
                    phase_json: None,
                };
                tx.stamp_write_claim(&stamp).unwrap().map(|_| i)
            }
            None => None,
        };
        tx.commit_transaction().unwrap();
        claimed
    });
    assert_eq!(won.iter().flatten().count(), 1, "{won:?}");
    let renewing: Vec<usize> = (0..8)
        .filter(|&i| {
            let stamp = ClaimStamp {
                id: id.clone(),
                token: token(i),
                lease_ms: 1000.0,
                phase_json: None,
            };
            store.renew_write_claim(&stamp).unwrap()
        })
        .collect();
    assert_eq!(renewing, vec![won.into_iter().flatten().next().unwrap()]);
}

/// C03, write claim: eight claimers, each its own optimistic transaction, claim one request once. A
/// claimer whose stamp loses the race is told so with a typed `write_conflict` at commit or sees nothing
/// claimable; never two acknowledged claims. Cross-host claimers wait for the transaction lane.
#[test]
#[ignore = "multi_writer"]
fn c03_two_claimers_of_one_write_never_both_claim_multi_writer() {
    let dir = TempDir::new("c03m");
    let store = Arc::new(open_optimistic(&dir));
    require_transactions(&store);
    let id = queued_write(&store, "b0000000-0000-4000-8000-0000000000b1");
    let s = store.clone();
    let won = together(8, move |i| {
        let tx = begin_host(&s, i);
        let row = tx
            .select_claimable_write(&ClaimableSpec::default())
            .unwrap()?;
        let stamp = ClaimStamp {
            id: row["id"].as_str().unwrap().into(),
            token: format!("c0000000-0000-4000-8000-{i:012}"),
            lease_ms: 60_000.0,
            phase_json: None,
        };
        tx.stamp_write_claim(&stamp).unwrap()?;
        match s.commit_position(tx) {
            Ok(_) => Some(i),
            Err(e) => {
                assert!(is_conflict(&e), "an untyped refusal: {e}");
                None
            }
        }
    });
    assert_eq!(
        won.iter().flatten().count(),
        1,
        "request {id} was claimed more than once: {won:?}"
    );
    let winner = won.into_iter().flatten().next().unwrap();
    let holds: Vec<usize> = (0..8)
        .filter(|&i| {
            let stamp = ClaimStamp {
                id: id.clone(),
                token: format!("c0000000-0000-4000-8000-{i:012}"),
                lease_ms: 1000.0,
                phase_json: None,
            };
            store.renew_write_claim(&stamp).unwrap()
        })
        .collect();
    assert_eq!(
        holds,
        vec![winner],
        "the claim is not held by its one winner"
    );
}

/// C04 scenario: eight workers claim every job once and none is lost.
fn eight_workers_claim_each_job_once(b: &Brain) {
    let all: BTreeSet<i64> = (0..64).map(|_| add_job(b, json!({}))).collect();
    let store: &Store = b;
    let claimed: Vec<Vec<i64>> = thread::scope(|s| {
        let workers: Vec<_> = (0..8)
            .map(|w| {
                s.spawn(move || {
                    let spec = claim_spec(&format!("worker-{w}:token"), 30_000.0);
                    let mut mine = Vec::new();
                    while let Some(row) = store.claim_next_job(&spec).unwrap() {
                        mine.push(row["id"].as_i64().unwrap());
                    }
                    mine
                })
            })
            .collect();
        workers.into_iter().map(|w| w.join().unwrap()).collect()
    });
    let mut union = BTreeSet::new();
    for id in claimed.iter().flatten() {
        assert!(union.insert(*id), "job {id} was claimed twice");
    }
    assert_eq!(union, all, "a job was never claimed");
    for id in &all {
        assert_eq!(b.get_job(*id).unwrap().unwrap()["claim_generation"], 1);
    }
}

/// C04, `claim_next_job`: eight workers claim each job once, none lost.
#[test]
fn c04_eight_workers_claim_each_job_once() {
    eight_workers_claim_each_job_once(&brain("c04"));
}

/// C04, `claim_next_job`: the same claim, with every worker a host that carries its origin.
#[test]
#[ignore = "multi_writer"]
fn c04_eight_workers_claim_each_job_once_multi_writer() {
    let b = brain_in("c04m", memory_env::StoreMode::Optimistic);
    require_transactions(&b);
    eight_workers_claim_each_job_once(&b);
}

/// C05, `reclaim_stalled_jobs` and `renew_job_lease`: an expired claim is reclaimed once, and renewal with the old token is refused.
#[test]
fn c05_expired_claim_is_reclaimed_once() {
    let b = brain("c05");
    let id = add_job(&b, json!({"max_stalled": 2}));
    assert!(
        b.claim_next_job(&claim_spec("w:1", 30_000.0))
            .unwrap()
            .is_some()
    );
    b.clock.advance(60_000_000);
    assert_eq!(
        b.reclaim_stalled_jobs(0.0, MARK).unwrap()["requeued"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let again = b.reclaim_stalled_jobs(0.0, MARK).unwrap();
    assert!(
        again["requeued"].as_array().unwrap().is_empty()
            && again["dead"].as_array().unwrap().is_empty()
    );
    assert!(
        !b.renew_job_lease(id, "w:1", 1000.0).unwrap(),
        "the old token renewed"
    );
    assert_eq!(b.get_job(id).unwrap().unwrap()["stalled_counter"], 1);
}

/// C05, `reclaim_stalled_jobs`: concurrent sweeps from several hosts reclaim an expired claim once in total, and
/// the old token's renewal is refused. Cross-host sweeps wait for the host lease (I-5).
#[test]
#[ignore = "multi_writer"]
fn c05_expired_claim_is_reclaimed_once_multi_writer() {
    let dir = TempDir::new("c05m");
    let store = Arc::new(open_optimistic(&dir));
    require_host_lease(&store);
    let id = add_job(&store, json!({"max_stalled": 2}));
    assert!(
        store
            .claim_next_job(&claim_spec("w:1", 1.0))
            .unwrap()
            .is_some()
    );
    thread::sleep(Duration::from_millis(50));
    let s = store.clone();
    let swept = together(8, move |_| {
        s.reclaim_stalled_jobs(0.0, MARK).unwrap()["requeued"]
            .as_array()
            .unwrap()
            .len()
    });
    assert_eq!(swept.iter().sum::<usize>(), 1, "{swept:?}");
    assert_eq!(store.get_job(id).unwrap().unwrap()["stalled_counter"], 1);
    assert!(
        !store.renew_job_lease(id, "w:1", 1000.0).unwrap(),
        "the old token renewed"
    );
}

/// C06, `acquire_lease` and `assert_lease` in the writing transaction: a paused holder cannot write protected data after a takeover.
/// Today the check is the caller's: `assert_cycle_lease` in the transaction, then write or roll back. The store itself refuses no unguarded write.
#[test]
fn c06_stale_holder_data_write_refused_by_its_token() {
    let b = brain("c06");
    let (a, c) = (
        "00000000-0000-4000-8000-0000000000a1",
        "00000000-0000-4000-8000-0000000000b2",
    );
    b.acquire_cycle_lock("src", &lock(1, a, 1.0))
        .unwrap()
        .unwrap();
    b.clock.advance(120_000_000);
    b.acquire_cycle_lock("src", &lock(2, c, 1.0))
        .unwrap()
        .expect("the takeover");
    let guarded_write = |token: &str, body: &str| {
        let tx = b.begin_transaction(false).unwrap();
        let held = tx.assert_cycle_lease("src", token).unwrap();
        if held {
            put(&tx, "protected", body);
            tx.commit_transaction().unwrap();
        } else {
            tx.rollback_transaction().unwrap();
        }
        held
    };
    assert!(
        !guarded_write(a, "from the paused holder"),
        "the paused holder kept its lease"
    );
    assert!(!exists(&b, "protected"));
    assert!(guarded_write(c, "from the new holder"));
    assert_eq!(current_body(&b, "protected"), "from the new holder");
}

/// C06, `acquire_lease` and `assert_lease`: a holder that paused after taking its lease cannot write protected data
/// after a takeover, whether it asserts its token before or after the takeover. Every takeover moves the epoch.
#[test]
#[ignore = "multi_writer"]
fn c06_stale_holder_data_write_refused_by_its_token_multi_writer() {
    let dir = TempDir::new("c06m");
    let store = Arc::new(open_optimistic(&dir));
    let first = store
        .acquire_lease("cycle", &origin(1), 50)
        .unwrap_or_else(|e| panic!("{e}"))
        .expect("the first holder");
    // The paused holder asserts its lease, writes and then pauses before its commit.
    let paused = begin_host(&store, 1);
    store.assert_lease(&paused, &first).unwrap();
    put(&paused, "protected", "from the paused holder");
    thread::sleep(Duration::from_millis(120));
    let second = store
        .acquire_lease("cycle", &origin(2), 60_000)
        .unwrap_or_else(|e| panic!("{e}"))
        .expect("the takeover");
    assert!(
        second.epoch > first.epoch,
        "a takeover did not move the epoch"
    );
    let refused = store.commit_position(paused).unwrap_err();
    assert!(
        refused.code() == Some(LEASE_LOST) || is_conflict(&refused),
        "the paused holder's commit was not refused: {refused}"
    );
    assert!(!exists(&store, "protected"), "the stale write landed");
    // A holder that asserts its old token after the takeover is refused in its own transaction.
    let late = begin_host(&store, 1);
    let late_refusal = store.assert_lease(&late, &first).unwrap_err();
    assert_eq!(late_refusal.code(), Some(LEASE_LOST), "{late_refusal}");
    drop(late);
    let holder = begin_host(&store, 2);
    store.assert_lease(&holder, &second).unwrap();
    put(&holder, "protected", "from the new holder");
    commit_host(&store, holder);
    assert_eq!(current_body(&store, "protected"), "from the new holder");
}

/// C07 scenario: one effect, eight claimants; the owner dies after the action and before it records, and the
/// effect is claimed again; no duplicate row.
fn effect_claimed_once_then_rerun(store: Arc<Store>) {
    const HOST: &str = "d0000000-0000-4000-8000-0000000000d1";
    let id = queued_write(&store, "b0000000-0000-4000-8000-0000000000b1");
    let incarnation =
        store.read_source_membership("default").unwrap().unwrap()["incarnation"].clone();
    let effects: PublicationEffectsSpec = serde_json::from_value(json!({
        "requestId": id, "revision": "e0000000-0000-4000-8000-0000000000e1", "sourceId": "default",
        "sourceIncarnation": incarnation, "worktreeId": null,
        "effects": [{"kind": "embedding", "data": {"slug": "notes/a", "page_id": 1}}],
    }))
    .unwrap();
    store.insert_publication_effects(&effects).unwrap();
    let claim = |s: &Store, token: &str, dead: &[String]| -> Option<Value> {
        let tx = s.begin_transaction(false).unwrap();
        let next = tx.select_claimable_effect(HOST, dead).unwrap();
        let owner = json!({"token": token, "owner": {"pid": 7, "nonce": "n", "start": "s"}});
        let claimed = next.get("id").and_then(Value::as_str).and_then(|effect| {
            let claim = EffectClaim {
                id: effect.into(),
                token: token.into(),
                owner_json: owner.to_string(),
            };
            tx.stamp_effect_claim(&claim).unwrap()
        });
        tx.commit_transaction().unwrap();
        claimed
    };
    let s = store.clone();
    let token = |i: usize| format!("f0000000-0000-4000-8000-{i:012}");
    let won = together(8, move |i| claim(&s, &token(i), &[]).map(|e| (i, e)));
    let winners: Vec<_> = won.iter().flatten().collect();
    assert_eq!(winners.len(), 1, "one effect, several claimants: {won:?}");
    let (first, effect) = (token(winners[0].0), winners[0].1.clone());
    let settle = |t: &str| EffectSettle {
        id: effect["id"].as_str().unwrap().into(),
        token: Some(t.into()),
        slug: None,
        outcome_json: Some("{}".into()),
        data_json: None,
        reason: None,
        delay_ms: None,
    };
    let rerun = claim(&store, &token(99), &["7:n:s".to_string()])
        .expect("a dead owner's effect runs again");
    assert_eq!(rerun["id"], effect["id"]);
    assert!(
        !store
            .settle_effect(Settle::Complete, &settle(&first))
            .unwrap(),
        "the dead owner recorded"
    );
    assert!(
        store
            .settle_effect(Settle::Complete, &settle(&token(99)))
            .unwrap()
    );
    assert_eq!(
        store.read_request_effects(&id).unwrap().len(),
        1,
        "a duplicate effect row"
    );
}

/// C07, `claim_effects`: one claimant; a crashed owner's effect is claimed again; no duplicate row (unbound effects, served by the store today).
#[test]
fn c07_effect_claimed_once_rerun_after_owner_crash() {
    let dir = TempDir::new("c07");
    effect_claimed_once_then_rerun(Arc::new(open(&dir)));
}

/// C07, `claim_effects`: the same rule when the crashed owner and the claimants are different hosts; a host's death is its lease
/// expiring (I-5).
#[test]
#[ignore = "multi_writer"]
fn c07_effect_claimed_once_rerun_after_owner_crash_multi_writer() {
    let dir = TempDir::new("c07m");
    let store = Arc::new(open_optimistic(&dir));
    require_host_lease(&store);
    effect_claimed_once_then_rerun(store);
}

/// C08 scenario: `reserve_capacity` (admission counters) never over-admits and loses no update.
fn counter_never_over_admits(store: Arc<Store>) {
    let limits = JournalLimits {
        principal_outstanding: 3,
        brain_outstanding: 5,
    };
    let s = store.clone();
    let results = together(WRITERS * 2, move |i| {
        let admission: WriteAdmission = serde_json::from_value(json!({
            "principal": {"kind": "local_cli", "id": format!("p{}", i % 2)}, "operation": "put_page",
            "requestId": request_id(i + 10), "slug": format!("s{i}"), "callerIntent": {},
        }))
        .unwrap();
        s.admit_write(&admission, Some(limits)).map(|_| ())
    });
    assert_eq!(
        results.iter().filter(|r| r.is_ok()).count(),
        5,
        "the brain limit did not hold"
    );
    for e in results.iter().filter_map(|r| r.as_ref().err()) {
        assert_eq!(e.code, ADMISSION_REFUSED, "{e:?}");
    }
    let outstanding = store.journal_outstanding().unwrap();
    assert_eq!(outstanding["brain"], 5);
    let per: Vec<u64> = outstanding["principals"]
        .as_object()
        .unwrap()
        .values()
        .map(|v| v.as_u64().unwrap())
        .collect();
    assert!(
        per.iter().all(|&n| n <= 3) && per.iter().sum::<u64>() == 5,
        "{outstanding}"
    );
}

/// C08, `reserve_capacity` (admission counters): no over-admission, no lost update.
#[test]
fn c08_counter_never_over_admits() {
    let dir = TempDir::new("c08");
    counter_never_over_admits(Arc::new(open(&dir)));
}

/// C08, `reserve_capacity`: the same cap, with every admitter a host that carries its origin.
#[test]
#[ignore = "multi_writer"]
fn c08_counter_never_over_admits_multi_writer() {
    let dir = TempDir::new("c08m");
    let store = Arc::new(open_optimistic(&dir));
    require_transactions(&store);
    counter_never_over_admits(store);
}

/// C09 scenario: concurrent submits of one idempotency key give one row.
fn idempotency_key_maps_to_one_row(store: &Store) {
    let outcomes: Vec<(String, i64)> = thread::scope(|s| {
        let callers: Vec<_> = (0..8)
            .map(|_| {
                s.spawn(move || {
                    let out = store
                        .admit_job(&job_spec("work", json!({"idempotency_key": "k1"})))
                        .unwrap();
                    (out.outcome.to_string(), out.row["id"].as_i64().unwrap())
                })
            })
            .collect();
        callers.into_iter().map(|c| c.join().unwrap()).collect()
    });
    let ids: BTreeSet<i64> = outcomes.iter().map(|(_, id)| *id).collect();
    assert_eq!(ids.len(), 1, "{outcomes:?}");
    assert_eq!(
        outcomes.iter().filter(|(o, _)| o == "inserted").count(),
        1,
        "{outcomes:?}"
    );
    assert!(
        outcomes
            .iter()
            .all(|(o, _)| o == "inserted" || o == "coalesced"),
        "{outcomes:?}"
    );
    assert_eq!(
        store
            .list_jobs(&serde_json::from_value(json!({})).unwrap())
            .unwrap()
            .len(),
        1
    );
}

/// C09, `admit_job`: concurrent submits of one idempotency key give one row.
#[test]
fn c09_idempotency_key_maps_to_one_row() {
    idempotency_key_maps_to_one_row(&brain("c09"));
}

/// C09, `admit_job`: the same key submitted by several hosts gives one row.
#[test]
#[ignore = "multi_writer"]
fn c09_idempotency_key_maps_to_one_row_multi_writer() {
    let b = brain_in("c09m", memory_env::StoreMode::Optimistic);
    require_transactions(&b);
    idempotency_key_maps_to_one_row(&b);
}

/// C10 scenario: the facts of one entity form one stable order and none is lost. (The order readers see is by creation
/// time, then id; that it is commit order is the stronger rule C11.)
fn facts_of_one_entity_form_one_total_order(store: Arc<Store>) {
    let s = store.clone();
    let made = together(WRITERS, move |i| {
        (0..4)
            .map(|n| {
                let text = format!("fact {i} {n}");
                (fact(&s, &text), text)
            })
            .collect::<Vec<_>>()
    });
    let made: BTreeMap<u64, String> = made.into_iter().flatten().collect();
    assert_eq!(made.len(), WRITERS * 4, "a fact id was handed out twice");
    let (first, second) = (facts_read(&store), facts_read(&store));
    assert_eq!(first, second, "the order changed between reads");
    let unique: BTreeSet<&String> = first.iter().collect();
    assert_eq!(
        (first.len(), unique.len()),
        (WRITERS * 4, WRITERS * 4),
        "a fact was lost or repeated"
    );
    let texts: BTreeSet<&String> = made.values().collect();
    assert_eq!(
        unique, texts,
        "a fact read back is not one that was written"
    );
}

/// C10, `append_fact`: the facts of one entity form one stable order and none is lost (the single-entity append order).
#[test]
fn c10_facts_of_one_entity_form_one_total_order() {
    let dir = TempDir::new("c10");
    facts_of_one_entity_form_one_total_order(Arc::new(open(&dir)));
}

/// C10, `append_fact`: the same, with the appenders on different hosts; per-entity order across hosts waits for the
/// host lane (I-5).
#[test]
#[ignore = "multi_writer"]
fn c10_facts_of_one_entity_form_one_total_order_multi_writer() {
    let dir = TempDir::new("c10m");
    let store = Arc::new(open_optimistic(&dir));
    require_host_lease(&store);
    facts_of_one_entity_form_one_total_order(store);
}

/// C11, `append_fact` with a sequence assigned at commit: the order a reader sees is commit order.
/// New rule. The runnable part is the single-owner case: explicit transactions commit one at a time, and the reader's
/// order (newest first) is the reverse of the order their commits returned.
#[test]
fn c11_per_entity_order_equals_commit_order() {
    let dir = TempDir::new("c11");
    let store = Arc::new(open(&dir));
    let s = store.clone();
    let committed = together(WRITERS, move |i| {
        let tx = s.begin_transaction(false).unwrap();
        fact(&tx, &format!("fact {i}"));
        (tx.commit_transaction().unwrap(), format!("fact {i}"))
    });
    let sequences: BTreeSet<u64> = committed.iter().map(|(seq, _)| *seq).collect();
    assert_eq!(sequences.len(), WRITERS, "two commits share a sequence");
    let mut by_commit = committed;
    by_commit.sort();
    let commit_order: Vec<String> = by_commit.into_iter().map(|(_, text)| text).collect();
    let mut read_order = facts_read(&store);
    read_order.reverse();
    assert_eq!(
        read_order, commit_order,
        "the reader's order is not commit order"
    );
}

/// C11, `append_fact` with a sequence assigned at commit: transactions that are open at the same time append to one
/// entity; the order a reader sees is the order of the commit positions they were acknowledged with.
#[test]
#[ignore = "multi_writer"]
fn c11_per_entity_order_equals_commit_order_multi_writer() {
    let dir = TempDir::new("c11m");
    let store = Arc::new(open_optimistic(&dir));
    require_transactions(&store);
    let (s, gate) = (store.clone(), Arc::new(Barrier::new(WRITERS)));
    let committed = together(WRITERS, move |i| {
        let text = format!("fact {i}");
        let mut first_try = true;
        loop {
            let tx = begin_host(&s, i);
            fact(&tx, &text);
            if first_try {
                // Every transaction is open before the first one commits.
                gate.wait();
                first_try = false;
            }
            match s.commit_position(tx) {
                Ok(position) => return (position, text),
                Err(e) => assert!(is_conflict(&e), "an untyped refusal: {e}"),
            }
        }
    });
    let positions: BTreeSet<CommitPosition> = committed.iter().map(|(p, _)| *p).collect();
    assert_eq!(positions.len(), WRITERS, "two commits share a position");
    let mut by_commit = committed;
    by_commit.sort();
    let commit_order: Vec<String> = by_commit.into_iter().map(|(_, text)| text).collect();
    let mut read_order = facts_read(&store);
    read_order.reverse();
    assert_eq!(
        read_order, commit_order,
        "the reader's order is not commit order"
    );
}

/// C12, `transaction(fn)`: each of two transactions reads its own uncommitted writes and never the other's.
/// The runnable part holds in both store modes: an explicit transaction is exclusive today, so two never overlap.
#[test]
fn c12_two_transactions_read_only_their_own_writes() {
    for mode in StoreMode::ALL {
        let label = mode.label();
        let dir = TempDir::new("c12");
        let store = Arc::new(open_in(&dir, mode));
        let s = store.clone();
        together(2, move |i| {
            let mine = format!("tx/{i}");
            let tx = s.begin_transaction(false).unwrap();
            put(&tx, &mine, "uncommitted");
            assert!(
                exists(&tx, &mine),
                "a transaction cannot read its own write"
            );
            assert!(
                !exists(&s, &mine),
                "an uncommitted write is visible outside its transaction"
            );
            if i == 0 {
                tx.commit_transaction().unwrap();
            } else {
                tx.rollback_transaction().unwrap();
            }
        });
        assert!(
            exists(&store, "tx/0") && !exists(&store, "tx/1"),
            "{label}: only the commit survives"
        );
    }
}

/// C12, `transaction(fn)`: two transactions that are open at the same time each read their own uncommitted writes and never
/// the other's.
#[test]
#[ignore = "multi_writer"]
fn c12_two_transactions_read_only_their_own_writes_multi_writer() {
    let dir = TempDir::new("c12m");
    let store = Arc::new(open_optimistic(&dir));
    require_transactions(&store);
    let (s, gate) = (store.clone(), Arc::new(Barrier::new(2)));
    together(2, move |i| {
        let (mine, theirs) = (format!("tx/{i}"), format!("tx/{}", 1 - i));
        let tx = begin_host(&s, i);
        put(&tx, &mine, "uncommitted");
        gate.wait();
        assert!(
            exists(&tx, &mine),
            "a transaction cannot read its own write"
        );
        assert!(
            !exists(&tx, &theirs),
            "a transaction read the other's uncommitted write"
        );
        assert!(
            !exists(&s, &mine),
            "an uncommitted write is visible outside its transaction"
        );
        gate.wait();
        if i == 0 {
            commit_host(&s, tx);
        } else {
            drop(tx);
        }
    });
    assert!(
        exists(&store, "tx/0") && !exists(&store, "tx/1"),
        "only the commit survives"
    );
}

/// C13, `transaction(fn)`: the writer on another key is never lost. The runnable part: while a transaction is open
/// today the other commit waits, then lands; both writes are there once it ends. That it does not wait at all is the
/// multi-writer part.
#[test]
fn c13_transactions_on_different_keys_both_land() {
    let dir = TempDir::new("c13");
    let store = Arc::new(open(&dir));
    put(&store, "notes/a", "before");
    let tx = store.begin_transaction(false).unwrap();
    put(&tx, "notes/a", "from the transaction");
    let s = store.clone();
    let other = thread::spawn(move || put(&s, "notes/b", "another key"));
    tx.commit_transaction().unwrap();
    other.join().unwrap();
    assert_eq!(current_body(&store, "notes/a"), "from the transaction");
    assert_eq!(current_body(&store, "notes/b"), "another key");
}

/// C13, `transaction(fn)`: a commit on another key lands while a transaction is open.
/// Pending: today the open transaction holds the writer (`embedded_one_owner_an_open_transaction_holds_off_other_commits`).
#[test]
#[ignore = "multi_writer"]
fn c13_transactions_on_different_keys_do_not_wait_multi_writer() {
    let dir = TempDir::new("c13m");
    let store = Arc::new(open_optimistic(&dir));
    put(&store, "notes/a", "before");
    let tx = begin_host(&store, 1);
    put(&tx, "notes/a", "from the transaction");
    let (done, landed) = mpsc::channel();
    let s = store.clone();
    let other = thread::spawn(move || {
        let tx = begin_host(&s, 2);
        put(&tx, "notes/b", "another key");
        commit_host(&s, tx);
        done.send(()).unwrap();
    });
    let waited = landed.recv_timeout(Duration::from_secs(2)).is_err();
    commit_host(&store, tx);
    other.join().unwrap();
    assert!(
        !waited,
        "a commit on another key waited for the open transaction"
    );
    assert_eq!(current_body(&store, "notes/a"), "from the transaction");
    assert_eq!(current_body(&store, "notes/b"), "another key");
}

/// C14 scenario: of eight publishers of the next generation exactly one wins, and the live generation is the winner's.
fn concurrent_publishers_one_winner(store: Arc<Store>, name: &str) {
    let key = GenerationKey {
        source_id: "default".into(),
        kind: "managed_walk".into(),
        owner_key: format!("input:{name}"),
    };
    let first = publish(&store, &key, None, 1.0, 0).unwrap();
    let (s, k) = (store.clone(), key.clone());
    let results = together(8, move |i| {
        publish(&s, &k, Some(first as f64), 2.0, i + 1).map(|_| ())
    });
    assert_eq!(
        results.iter().filter(|r| r.is_ok()).count(),
        1,
        "{results:?}"
    );
    let live = store.read_live_generation_row(&key).unwrap();
    assert_eq!(
        live["generation"], 2,
        "the live generation is not the winner's"
    );
}

/// C14, `publish_generation` (`activate_generation_rows`): generations are monotonic and never two winners.
#[test]
fn c14_concurrent_publishers_one_winner() {
    let dir = TempDir::new("c14");
    concurrent_publishers_one_winner(Arc::new(open(&dir)), "c14");
}

/// C14, `publish_generation`: the same, with the publishers on different hosts.
#[test]
#[ignore = "multi_writer"]
fn c14_concurrent_publishers_one_winner_multi_writer() {
    let dir = TempDir::new("c14m");
    let store = Arc::new(open_optimistic(&dir));
    require_transactions(&store);
    concurrent_publishers_one_winner(store, "c14m");
}

/// C15, `single_flight(keys)` (today the one explicit transaction): never two holders; released at commit or abort.
#[test]
fn c15_single_flight_holds_only_its_keys() {
    let dir = TempDir::new("c15");
    let store = Arc::new(open(&dir));
    let (inside, most) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let (s, i2, m2) = (store.clone(), inside.clone(), most.clone());
    together(8, move |i| {
        for round in 0..3 {
            let tx = s.begin_transaction(false).unwrap();
            m2.fetch_max(i2.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
            put(&tx, "shared/hot", &format!("{i} {round}"));
            thread::sleep(Duration::from_millis(1));
            i2.fetch_sub(1, Ordering::SeqCst);
            // A commit and an abort both release the holder.
            if round == 1 {
                drop(tx)
            } else {
                tx.commit_transaction().unwrap();
            }
        }
    });
    assert_eq!(most.load(Ordering::SeqCst), 1, "two holders at once");
    store
        .begin_transaction(false)
        .unwrap()
        .rollback_transaction()
        .unwrap();
}

/// C15, `single_flight(keys)`: different keys fly together, one key never has two holders, and a key is free again after
/// a commit and after an abort.
#[test]
#[ignore = "multi_writer"]
fn c15_single_flight_holds_only_its_keys_multi_writer() {
    let dir = TempDir::new("c15m");
    let store = Arc::new(open_optimistic(&dir));
    require_transactions(&store);
    let per_key: Arc<Vec<AtomicUsize>> = Arc::new((0..4).map(|_| AtomicUsize::new(0)).collect());
    let (inside, most_total, most_key) = (
        Arc::new(AtomicUsize::new(0)),
        Arc::new(AtomicUsize::new(0)),
        Arc::new(AtomicUsize::new(0)),
    );
    let (s, p, i2, mt, mk) = (
        store.clone(),
        per_key,
        inside,
        most_total.clone(),
        most_key.clone(),
    );
    let flight = |key: usize| SingleFlightKey {
        source_id: "default".into(),
        slug: format!("key/{key}"),
    };
    together(8, move |i| {
        let key = i % 4;
        let tx = begin_host(&s, i);
        s.single_flight(&tx, &[flight(key)]).unwrap();
        mk.fetch_max(p[key].fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
        mt.fetch_max(i2.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
        put(&tx, &format!("key/{key}"), "held");
        thread::sleep(Duration::from_millis(20));
        p[key].fetch_sub(1, Ordering::SeqCst);
        i2.fetch_sub(1, Ordering::SeqCst);
        commit_host(&s, tx);
    });
    assert_eq!(most_key.load(Ordering::SeqCst), 1, "two holders of one key");
    assert!(
        most_total.load(Ordering::SeqCst) > 1,
        "different keys never flew together"
    );
    // Released at abort, then at commit: the same keys are free for the next holder.
    for end_by_commit in [false, true] {
        let tx = begin_host(&store, 9);
        let keys: Vec<SingleFlightKey> = (0..4).map(flight).collect();
        store.single_flight(&tx, &keys).unwrap();
        if end_by_commit {
            commit_host(&store, tx);
        } else {
            drop(tx);
        }
    }
}

/// An old-format brain on disk: a closed format-1 brain with pages, chunks and unfinished requests.
struct OldBrain {
    path: std::path::PathBuf,
    id: String,
    pages: Vec<(String, String)>,
    chunks: u64,
    outstanding: Value,
    version: u64,
}

fn seeded_old_brain(dir: &TempDir) -> OldBrain {
    use gbrain_store::Kv;
    let path = dir.path().join("brain");
    let store = open(dir);
    let pages: Vec<(String, String)> = (0..3)
        .map(|i| {
            (
                format!("notes/p{i}"),
                format!("body number {i} with some words in it"),
            )
        })
        .collect();
    for (slug, body) in &pages {
        put(&store, slug, body);
    }
    store
        .admit_write(&common::format::admission(1), None)
        .unwrap();
    store
        .admit_write(&common::format::admission(2), None)
        .unwrap();
    let old = (
        store.brain_id().to_string(),
        store.count_chunks().unwrap(),
        store.journal_outstanding().unwrap(),
    );
    store.close();
    common::format::downgrade_to_format_1(&path);
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(path.join("FORMAT")).unwrap()).unwrap();
    assert_eq!(file["format_version"], 1, "the fixture is not format 1");
    let version = gbrain_store::redb_kv::RedbKv::open_path(&path.join("records.redb"))
        .unwrap()
        .version()
        .unwrap();
    OldBrain {
        path,
        id: old.0,
        pages,
        chunks: old.1,
        outstanding: old.2,
        version,
    }
}

/// The opens in this case leave the keyword index to its background builder out of the count: only the format upgrade
/// writes during the open.
fn upgrade_options(concurrent: bool) -> OpenOptions {
    OpenOptions {
        concurrent_writes: concurrent,
        keyword_index_builder: false,
        ..OpenOptions::default()
    }
}

/// The new format, every seeded record intact, and the legacy counter records gone.
fn assert_upgraded_and_intact(store: &Store, old: &OldBrain) {
    assert_eq!(store.info().format_version, FORMAT_VERSION);
    assert_eq!(store.brain_id(), old.id, "the brain changed identity");
    for (slug, body) in &old.pages {
        assert_eq!(&current_body(store, slug), body, "{slug} changed");
    }
    assert_eq!(store.count_pages(None).unwrap(), old.pages.len() as u64);
    assert_eq!(store.count_chunks().unwrap(), old.chunks);
    assert_eq!(store.journal_outstanding().unwrap(), old.outstanding);
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(old.path.join("FORMAT")).unwrap()).unwrap();
    assert_eq!(file["format_version"], FORMAT_VERSION);
}

/// The upgrade ran once: the legacy counter records are gone and the brain is at its new format.
fn legacy_records_gone(old: &OldBrain) -> bool {
    use gbrain_store::{Kv, keys};
    let kv = gbrain_store::redb_kv::RedbKv::open_path(&old.path.join("records.redb")).unwrap();
    let read = kv.snapshot().unwrap();
    read.get(&keys::meta("chunk_stats")).unwrap().is_none()
        && read.get(&keys::meta("journal_counters")).unwrap().is_none()
}

/// C16, `upgrade_format`: an old-format brain is upgraded by one owner open, exactly once; callers of a concurrent raw open see
/// the whole upgraded brain or a typed `store_locked`, never a partial one; a second open does not upgrade again.
#[test]
fn c16_format_upgrade_runs_once_under_concurrent_openers() {
    let dir = TempDir::new("c16");
    let old = seeded_old_brain(&dir);
    let concurrent = std::env::var("GBRAIN_RUST_CONCURRENT_WRITES").is_ok_and(|v| v == "1");
    let (p, o) = (old.path.clone(), upgrade_options(concurrent));
    let opened = together(4, move |_| Store::open_dir(&p, o.clone()));
    let mut live = Vec::new();
    for outcome in opened {
        match outcome {
            Ok(store) => live.push(store),
            Err(e) => assert_eq!(e.code, STORE_LOCKED, "a partial open: {e:?}"),
        }
    }
    assert_eq!(live.len(), 1, "one opener wins a single-owner brain");
    let owner = live.pop().unwrap();
    assert_upgraded_and_intact(&owner, &old);
    let after_upgrade = owner.commit_version().unwrap();
    assert_eq!(after_upgrade, old.version + 1, "the upgrade is one commit");
    owner.close();
    assert!(legacy_records_gone(&old), "the upgrade did not run");
    // A second open finds nothing to upgrade: no commit, same records.
    let again = Store::open_dir(&old.path, upgrade_options(concurrent)).unwrap();
    assert_eq!(
        again.commit_version().unwrap(),
        after_upgrade,
        "the upgrade ran a second time"
    );
    assert_upgraded_and_intact(&again, &old);
}

/// C16, `upgrade_format`: concurrent openers of an old-format brain all get a working store, and the upgrade runs once.
/// The extra openers are clients of the one owner (C17), so this waits for the server lane.
#[test]
#[ignore = "multi_writer"]
fn c16_format_upgrade_runs_once_under_concurrent_openers_multi_writer() {
    mu::pending_member::<()>(
        L3_SERVER,
        "a second opener becomes a client of the upgrading owner",
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let dir = TempDir::new("c16m");
    let old = seeded_old_brain(&dir);
    let (p, o) = (old.path.clone(), upgrade_options(true));
    let opened = together(4, move |_| Store::open_dir(&p, o.clone()));
    let errors: Vec<String> = opened
        .iter()
        .filter_map(|r| r.as_ref().err())
        .map(|e| e.code.to_string())
        .collect();
    assert!(
        errors.is_empty(),
        "a concurrent opener was refused: {errors:?}"
    );
    for store in opened.iter().flatten() {
        assert_upgraded_and_intact(store, &old);
    }
    let versions: BTreeSet<u64> = opened
        .iter()
        .flatten()
        .map(|s| s.commit_version().unwrap())
        .collect();
    assert_eq!(
        versions,
        BTreeSet::from([old.version + 1]),
        "more than one upgrade"
    );
    assert!(legacy_records_gone(&old));
}

/// C17, `open_brain`: a second raw opener of a live brain is refused with a typed `store_locked` and the first keeps
/// working. A permanent invariant of the raw store: a second opener that is a client is the owner process's job, tested
/// in TypeScript (`rust-engine-store`, `rust-owner-ipc`).
#[test]
fn c17_a_second_raw_opener_is_refused_with_a_typed_store_locked() {
    let dir = TempDir::new("c17");
    let first = open(&dir);
    put(&first, "notes/a", "kept");
    let path = dir.path().join("brain");
    let refused = Store::open_dir(&path, OpenOptions::default())
        .err()
        .expect("a second raw open must fail");
    assert_eq!(refused.code, STORE_LOCKED, "{refused}");
    let also = Store::open_dir(
        &path,
        OpenOptions {
            concurrent_writes: true,
            ..OpenOptions::default()
        },
    )
    .err()
    .expect("a second raw open in the other mode must fail");
    assert_eq!(also.code, STORE_LOCKED, "{also}");
    assert!(exists(&first, "notes/a"));
    put(&first, "notes/b", "still writable");
    first.close();
    let reopened = Store::open_dir(&path, OpenOptions::default()).unwrap();
    assert!(exists(&reopened, "notes/a") && exists(&reopened, "notes/b"));
}

/// C17, `open_brain`: a second opener becomes a client, never an error.
/// Client behavior (calls in flight retry by request id) is owner-process behavior in TypeScript; the store half is that a
/// second open of a live brain is not `store_locked`.
#[test]
#[ignore = "multi_writer"]
fn c17_second_opener_becomes_a_client_never_an_error_multi_writer() {
    mu::pending_member::<()>(L3_SERVER, "a second opener becomes a client")
        .unwrap_or_else(|e| panic!("{e}"));
    let dir = TempDir::new("c17m");
    let first = open_optimistic(&dir);
    put(&first, "notes/a", "kept");
    let second = Store::open_dir(
        &dir.path().join("brain"),
        OpenOptions {
            concurrent_writes: true,
            ..OpenOptions::default()
        },
    );
    assert!(
        second.is_ok(),
        "the second opener got {:?}",
        second.err().map(|e| e.code)
    );
}

/// C18 scenario: 64 writers, 256 rows, no busy error, no lost update.
fn sixty_four_writers_no_busy_error(store: Arc<Store>) {
    let s = store.clone();
    together(64, move |i| {
        for round in 0..4 {
            submit(&s, i * 100 + round, &format!("p/{i}-{round}"), "body text");
        }
    });
    assert_eq!(store.count_pages(None).unwrap(), 256);
    assert_eq!(store.count_chunks().unwrap(), 256);
    assert_eq!(store.journal_outstanding().unwrap()["brain"], 0);
}

/// C18, all rows from 64 writers: no lost update, no double claim, no busy error (64 threads of one process).
#[test]
fn c18_sixty_four_writers_no_busy_error() {
    let dir = TempDir::new("c18");
    sixty_four_writers_no_busy_error(Arc::new(open(&dir)));
}

/// C18, all rows from 64 writers in 8 processes: the same, with one store handle per process. Waits for an opener that is
/// not `store_locked` (C17).
#[test]
#[ignore = "multi_writer"]
fn c18_sixty_four_writers_no_busy_error_multi_writer() {
    mu::pending_member::<()>(L3_SERVER, "eight processes, one store handle each")
        .unwrap_or_else(|e| panic!("{e}"));
    let dir = TempDir::new("c18m");
    sixty_four_writers_no_busy_error(Arc::new(open_optimistic(&dir)));
}

// ---- C19: a real crash -------------------------------------------------------------------------------------------------

const C19_DIR: &str = "GBRAIN_C19_DIR";
const C19_WRITERS: &str = "GBRAIN_C19_WRITERS";
const C19_OPTIMISTIC: &str = "GBRAIN_C19_OPTIMISTIC";
const C19_EXPLICIT_TXN: &str = "GBRAIN_C19_EXPLICIT_TXN";
const C19_CHILD: &str = "c19_child_writer";

/// The child of a C19 run, started by the tests below (ignored in a normal run; with no `GBRAIN_C19_DIR` it does
/// nothing). Its writers admit page writes until the parent kills the process. Before each write a writer prints
/// `SENT <n>`, after the store acknowledged it `ACK <n> <page id>`.
#[test]
#[ignore = "c19_child"]
fn c19_child_writer() {
    let Some(dir) = std::env::var_os(C19_DIR) else {
        return;
    };
    let writers: usize = std::env::var(C19_WRITERS).unwrap().parse().unwrap();
    let optimistic = std::env::var(C19_OPTIMISTIC).is_ok_and(|v| v == "1");
    let explicit = std::env::var(C19_EXPLICIT_TXN).is_ok_and(|v| v == "1");
    let store = Store::open_dir(
        &Path::new(&dir).join("brain"),
        OpenOptions {
            concurrent_writes: optimistic,
            ..OpenOptions::default()
        },
    )
    .unwrap();
    let out = Mutex::new(std::io::stdout());
    let say = |line: String| {
        let mut o = out.lock().unwrap();
        o.write_all(line.as_bytes()).unwrap();
        o.flush().unwrap();
    };
    thread::scope(|scope| {
        for w in 0..writers {
            let (store, say) = (&store, &say);
            scope.spawn(move || {
                for k in 0usize.. {
                    let n = w * 1_000_000 + k;
                    say(format!("SENT {n}\n"));
                    let m = mutation(n, &format!("notes/{n}"), "acknowledged");
                    let receipt = if explicit {
                        let tx = begin_host(store, w);
                        let receipt = tx.submit_page_mutation(&m, None).unwrap();
                        commit_host(store, tx);
                        receipt
                    } else {
                        store.submit_page_mutation(&m, None).unwrap()
                    };
                    assert_eq!(receipt["state"], "committed", "{receipt}");
                    say(format!("ACK {n} {}\n", receipt["page_id"]));
                }
            });
        }
    });
}

/// What the parent learned from a killed child: every request it sent and every acknowledged one with its page id.
struct Killed {
    sent: BTreeSet<usize>,
    acked: BTreeMap<usize, String>,
}

/// Runs the child of this test binary, kills it with SIGKILL once it has acknowledged `min_acks` writes (or after 60 s),
/// and collects what it printed.
fn kill_child_writer(
    dir: &TempDir,
    writers: usize,
    optimistic: bool,
    explicit: bool,
    min_acks: usize,
) -> Killed {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([C19_CHILD, "--exact", "--ignored", "--nocapture"])
        .args(["--test-threads=1", "-q"])
        .env(C19_DIR, dir.path())
        .env(C19_WRITERS, writers.to_string())
        .env(C19_OPTIMISTIC, if optimistic { "1" } else { "0" })
        .env(C19_EXPLICIT_TXN, if explicit { "1" } else { "0" })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (lines, heard) = mpsc::channel::<String>();
    let reader = thread::spawn(move || {
        let mut r = std::io::BufReader::new(stdout);
        let mut buf = String::new();
        while r.read_line(&mut buf).unwrap_or(0) > 0 {
            // A line the kill cut in half has no newline and is dropped.
            if buf.ends_with('\n') {
                let _ = lines.send(std::mem::take(&mut buf));
            }
            buf.clear();
        }
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut seen = Vec::new();
    let mut acks = 0;
    while acks < min_acks && Instant::now() < deadline {
        if let Ok(line) = heard.recv_timeout(Duration::from_millis(100)) {
            acks += usize::from(line.starts_with("ACK "));
            seen.push(line);
        }
    }
    child.kill().unwrap(); // SIGKILL
    child.wait().unwrap();
    reader.join().unwrap();
    seen.extend(heard.try_iter());
    let mut killed = Killed {
        sent: BTreeSet::new(),
        acked: BTreeMap::new(),
    };
    for line in seen {
        let f: Vec<&str> = line.split_whitespace().collect();
        match f.as_slice() {
            ["SENT", n] => {
                killed.sent.insert(n.parse().unwrap());
            }
            ["ACK", n, page] => {
                killed.acked.insert(n.parse().unwrap(), page.to_string());
            }
            _ => {}
        }
    }
    assert!(
        killed.acked.len() >= min_acks,
        "the child acknowledged only {} writes before the kill",
        killed.acked.len()
    );
    killed
}

/// The reopened brain as the checker sees it.
struct Reopened {
    count: u64,
    present: BTreeSet<usize>,
}

fn reopened_view(store: &Store, killed: &Killed) -> Reopened {
    Reopened {
        count: store.count_pages(None).unwrap(),
        present: killed
            .sent
            .iter()
            .copied()
            .filter(|n| exists(store, &format!("notes/{n}")))
            .collect(),
    }
}

/// Every acknowledged write is present, no row exists that was never sent, and at most one write per writer that was sent but
/// not acknowledged is present.
fn check_acknowledged_survive(
    view: &Reopened,
    killed: &Killed,
    writers: usize,
) -> std::result::Result<(), String> {
    for n in killed.acked.keys() {
        if !view.present.contains(n) {
            return Err(format!(
                "acknowledged write {n} is missing after the reopen"
            ));
        }
    }
    if view.count != view.present.len() as u64 {
        return Err(format!(
            "{} rows, but only {} are writes the child sent",
            view.count,
            view.present.len()
        ));
    }
    let in_flight = view.present.len() - killed.acked.len();
    if in_flight > writers {
        return Err(format!(
            "{in_flight} unacknowledged writes landed for {writers} writers"
        ));
    }
    Ok(())
}

/// The kill, the reopen and the checks: every acknowledged request id is present and replays to its stored receipt with no
/// duplicate row. A control that hides one acknowledged write, and one that adds a row, must fail the checker.
fn crash_keeps_acknowledged_writes(dir: &TempDir, mode: StoreMode, killed: Killed, writers: usize) {
    assert!(!killed.acked.is_empty());
    let store = open_in(dir, mode);
    let view = reopened_view(&store, &killed);
    check_acknowledged_survive(&view, &killed, writers).unwrap_or_else(|e| panic!("{e}"));
    let before = store.count_pages(None).unwrap();
    for (n, page) in &killed.acked {
        let replay = store
            .submit_page_mutation(&mutation(*n, &format!("notes/{n}"), "acknowledged"), None)
            .unwrap();
        assert_eq!(replay["state"], "committed", "{replay}");
        assert_eq!(
            replay["page_id"].to_string(),
            *page,
            "request {n} replayed to a different receipt"
        );
    }
    assert_eq!(
        store.count_pages(None).unwrap(),
        before,
        "a replay duplicated a write"
    );
    assert!(
        store
            .get_versions("notes/3", &VersionsOptions::default())
            .unwrap()
            .is_empty()
            || !killed.acked.contains_key(&3),
        "an acknowledged write was applied twice"
    );
    // The controls: the checker is not blind.
    let victim = *killed.acked.keys().nth(killed.acked.len() / 2).unwrap();
    let mut lost = reopened_view(&store, &killed);
    lost.present.remove(&victim);
    lost.count -= 1;
    let err = check_acknowledged_survive(&lost, &killed, writers).unwrap_err();
    assert!(err.contains("is missing"), "{err}");
    let mut duplicated = reopened_view(&store, &killed);
    duplicated.count += 1;
    assert!(check_acknowledged_survive(&duplicated, &killed, writers).is_err());
}

/// C19, crash robot: a child process admits writes and prints each acknowledged request id; the parent kills it with SIGKILL mid-stream,
/// reopens the brain, and every acknowledged write is present, replays to its stored receipt, and none is duplicated.
#[test]
fn c19_crash_after_commit_keeps_acknowledged_writes() {
    let dir = TempDir::new("c19");
    let optimistic = std::env::var("GBRAIN_RUST_CONCURRENT_WRITES").is_ok_and(|v| v == "1");
    let mode = if optimistic {
        StoreMode::Optimistic
    } else {
        StoreMode::Single
    };
    let killed = kill_child_writer(&dir, 1, optimistic, false, 40);
    crash_keeps_acknowledged_writes(&dir, mode, killed, 1);
}

/// C19, crash robot: eight writers, each an explicit optimistic transaction with its origin, killed mid-stream; every acknowledged
/// write is present exactly once after the reopen.
#[test]
#[ignore = "multi_writer"]
fn c19_crash_after_commit_keeps_acknowledged_writes_multi_writer() {
    let dir = TempDir::new("c19m");
    require_transactions(&open_optimistic(&dir));
    let killed = kill_child_writer(&dir, 8, true, true, 80);
    crash_keeps_acknowledged_writes(&dir, StoreMode::Optimistic, killed, 8);
}

/// Not C19: a store handle dropped without `close` and opened again keeps every acknowledged write. The kill is C19.
#[test]
fn acknowledged_writes_survive_a_dropped_handle_clean_reopen() {
    let dir = TempDir::new("clean-reopen");
    {
        let store = open(&dir);
        for n in 0..20 {
            submit(&store, n, &format!("notes/{n}"), "acknowledged");
        }
    }
    let store = open(&dir);
    assert_eq!(
        store.count_pages(None).unwrap(),
        20,
        "an acknowledged write is missing"
    );
    for n in 0..20 {
        let replay = store
            .submit_page_mutation(&mutation(n, &format!("notes/{n}"), "acknowledged"), None)
            .unwrap();
        assert_eq!(replay["state"], "committed");
    }
    assert_eq!(
        store.count_pages(None).unwrap(),
        20,
        "a replay duplicated a write"
    );
}

/// Not C19: the acknowledged writes of concurrent writers survive a dropped handle and a reopen exactly once.
#[test]
fn concurrent_acknowledged_writes_survive_a_dropped_handle_clean_reopen() {
    let dir = TempDir::new("clean-reopen-m");
    let acked = {
        let store = Arc::new(open_optimistic(&dir));
        let s = store.clone();
        together(WRITERS, move |i| {
            (0..4)
                .map(|r| i * 10 + r)
                .filter(|&n| {
                    s.submit_page_mutation(&mutation(n, &format!("notes/{n}"), "body"), None)
                        .is_ok_and(|r| r["state"] == "committed")
                })
                .collect::<Vec<_>>()
        })
    };
    let acked: Vec<usize> = acked.into_iter().flatten().collect();
    let store = open_optimistic(&dir);
    assert_eq!(
        store.count_pages(None).unwrap(),
        acked.len() as u64,
        "an acknowledged write is missing or duplicated"
    );
    assert!(acked.iter().all(|n| exists(&store, &format!("notes/{n}"))));
}

/// C20, sorted keys and compare-and-set: no deadlock across two pages written in both orders.
#[test]
fn c20_no_deadlock_across_two_pages_in_both_orders() {
    let dir = TempDir::new("c20");
    let store = Arc::new(open(&dir));
    let s = store.clone();
    let (done, finished) = mpsc::channel();
    thread::spawn(move || {
        let commits = together(8, move |i| {
            (0..4)
                .map(|round| {
                    let tx = s.begin_transaction(false).unwrap();
                    let order = if i % 2 == 0 {
                        ["pair/a", "pair/b"]
                    } else {
                        ["pair/b", "pair/a"]
                    };
                    for slug in order {
                        put(&tx, slug, &format!("{i} {round}"));
                    }
                    tx.commit_transaction().unwrap()
                })
                .collect::<Vec<u64>>()
        });
        done.send(commits).unwrap();
    });
    let commits = finished
        .recv_timeout(Duration::from_secs(60))
        .expect("writers in opposite orders deadlocked");
    let distinct: BTreeSet<u64> = commits.iter().flatten().copied().collect();
    assert_eq!(
        distinct.len(),
        8 * 4,
        "an update was lost or two share a commit"
    );
    // Each transaction wrote both pages: the last committer's body is on both, never a mix.
    assert_eq!(
        current_body(&store, "pair/a"),
        current_body(&store, "pair/b")
    );
}

/// C20, sorted keys and compare-and-set on two pages written in both orders: no deadlock, and every writer's update lands once
/// its retry on a typed `write_conflict` succeeds.
#[test]
#[ignore = "multi_writer"]
fn c20_no_deadlock_across_two_pages_in_both_orders_multi_writer() {
    let dir = TempDir::new("c20m");
    let store = Arc::new(open_optimistic(&dir));
    require_transactions(&store);
    let s = store.clone();
    let (done, finished) = mpsc::channel();
    thread::spawn(move || {
        let positions = together(8, move |i| {
            let keys: Vec<SingleFlightKey> = ["pair/a", "pair/b"]
                .iter()
                .map(|slug| SingleFlightKey {
                    source_id: "default".into(),
                    slug: slug.to_string(),
                })
                .collect();
            let order = if i % 2 == 0 {
                ["pair/a", "pair/b"]
            } else {
                ["pair/b", "pair/a"]
            };
            let mut mine = Vec::new();
            for round in 0..3 {
                loop {
                    let tx = begin_host(&s, i);
                    s.single_flight(&tx, &keys).unwrap();
                    for slug in order {
                        put(&tx, slug, &format!("writer {i} {round}"));
                    }
                    match s.commit_position(tx) {
                        Ok(position) => {
                            mine.push(position);
                            break;
                        }
                        Err(e) => assert!(is_conflict(&e), "an untyped refusal: {e}"),
                    }
                }
            }
            mine
        });
        done.send(positions).unwrap();
    });
    let positions = finished
        .recv_timeout(Duration::from_secs(60))
        .expect("writers in opposite orders deadlocked");
    let distinct: BTreeSet<CommitPosition> = positions.iter().flatten().copied().collect();
    assert_eq!(
        distinct.len(),
        8 * 3,
        "an update was lost or two share a position"
    );
    assert_eq!(
        current_body(&store, "pair/a"),
        current_body(&store, "pair/b")
    );
}

/// C21, commit position as a token: a write acknowledged on one connection is seen by another given the token.
/// New rule. The runnable part is the single-owner token: `commit_transaction`'s return, and a reader holding it sees the write.
/// A second connection that is a different process, and the token on the wire, belong to the server lane.
#[test]
fn c21_read_your_writes_token_on_a_second_connection() {
    let dir = TempDir::new("c21");
    let store = Arc::new(open(&dir));
    let tx = store.begin_transaction(false).unwrap();
    put(&tx, "notes/a", "acknowledged on A");
    let token = tx.commit_transaction().unwrap();
    let second = store.clone();
    let seen =
        thread::spawn(move || (second.commit_version().unwrap(), exists(&second, "notes/a")))
            .join()
            .unwrap();
    assert!(seen.0 >= token, "the second connection is behind the token");
    assert!(
        seen.1,
        "the second connection does not see the acknowledged write"
    );
}

/// C21, commit position as a token: a write acknowledged on one connection is seen by another given the token, which is the
/// commit position as `cp1:<sequence>.<index>`; the commit log reaches it.
#[test]
#[ignore = "multi_writer"]
fn c21_read_your_writes_token_on_a_second_connection_multi_writer() {
    let dir = TempDir::new("c21m");
    let store = Arc::new(open_optimistic(&dir));
    let tx = begin_host(&store, 1);
    put(&tx, "notes/a", "acknowledged on A");
    let position = commit_host(&store, tx);
    let token = position.token();
    assert!(token.starts_with("cp1:"), "{token}");
    let second = store.clone();
    let (behind, saw, newest) = thread::spawn(move || {
        let page = second
            .read_commit_log(None, 1000)
            .unwrap_or_else(|e| panic!("{e}"));
        (
            second.commit_version().unwrap() < position.sequence,
            exists(&second, "notes/a"),
            page.newest,
        )
    })
    .join()
    .unwrap();
    assert!(!behind, "the second connection is behind the token {token}");
    assert!(
        saw,
        "the second connection does not see the acknowledged write"
    );
    assert!(newest >= Some(position), "the log does not reach {token}");
}

/// C22, commit log: no two commits share a position and positions only grow.
#[test]
fn c22_commit_position_strictly_increases() {
    let dir = TempDir::new("c22");
    let store = Arc::new(open(&dir));
    let s = store.clone();
    let positions = together(8, move |i| {
        (0..4)
            .map(|n| {
                let tx = s.begin_transaction(false).unwrap();
                put(&tx, &format!("c22/{i}-{n}"), "one commit");
                tx.commit_transaction().unwrap()
            })
            .collect::<Vec<u64>>()
    });
    for mine in &positions {
        assert!(
            mine.windows(2).all(|w| w[0] < w[1]),
            "positions went back: {mine:?}"
        );
    }
    let all: BTreeSet<u64> = positions.iter().flatten().copied().collect();
    assert_eq!(all.len(), 32, "two commits share a position");
    assert!(store.commit_version().unwrap() >= *all.iter().next_back().unwrap());
}

/// C22, commit log: every transaction commits at its own `CommitPosition`, even when a group commit batches several, so
/// positions strictly grow per writer, no two share one, and the commit log lists each once in order. Per-transaction positions
/// wait for the commit-log lane (a batch shares one sequence today).
#[test]
#[ignore = "multi_writer"]
fn c22_commit_position_strictly_increases_multi_writer() {
    let dir = TempDir::new("c22m");
    let store = Arc::new(open_optimistic(&dir));
    require_transactions(&store);
    let s = store.clone();
    let positions = together(WRITERS, move |i| {
        (0..4)
            .map(|n| {
                let tx = begin_host(&s, i);
                put(&tx, &format!("c22m/{i}-{n}"), "one commit");
                commit_host(&s, tx)
            })
            .collect::<Vec<CommitPosition>>()
    });
    for mine in &positions {
        assert!(
            mine.windows(2).all(|w| w[0] < w[1]),
            "positions went back: {mine:?}"
        );
    }
    let all: BTreeSet<CommitPosition> = positions.iter().flatten().copied().collect();
    assert_eq!(all.len(), WRITERS * 4, "two commits share a position");
    let log = store
        .read_commit_log(None, 10_000)
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(log.newest, all.iter().next_back().copied());
    assert!(!log.snapshot_required);
    assert!(log.records.len() >= WRITERS * 4, "the log lost a commit");
}

/// The adapter's stubs are still stubs, each naming its owner. Landing a member means editing `common/mu.rs` and this list
/// together, so an un-pend never happens by accident.
#[test]
fn mu_adapter_stubs_are_still_pending() {
    fn owner<T>(call: &str, result: mu::MuResult<T>) -> &'static str {
        match result {
            Err(mu::MuError::Pending(p)) => p.owner,
            Err(e) => panic!("{call} failed for another reason: {e}"),
            Ok(_) => panic!("{call} is no longer pending: edit this test with its stub"),
        }
    }
    let (dir, other) = (TempDir::new("mu"), TempDir::new("mu-tx"));
    let (store, holder) = (open(&dir), open(&other));
    let txn = || MuTxn::from_store(holder.begin_transaction(false).unwrap());
    let token = LeaseToken {
        name: "n".into(),
        epoch: 1,
        token: "t".into(),
    };
    let key = SingleFlightKey {
        source_id: "default".into(),
        slug: "a".into(),
    };
    assert_eq!(
        owner("begin_with", store.begin_with(TxnOptions::default())),
        L1_TXN
    );
    assert_eq!(
        owner("single_flight", store.single_flight(&txn(), &[key])),
        L1_TXN
    );
    assert_eq!(
        owner("commit_position", store.commit_position(txn())),
        L2_LOG
    );
    assert_eq!(
        owner("assert_lease", store.assert_lease(&txn(), &token)),
        L5_HOSTS
    );
    assert_eq!(
        owner("acquire_lease", store.acquire_lease("n", &origin(1), 1000)),
        L5_HOSTS
    );
    assert_eq!(
        owner("renew_lease", store.renew_lease(&token, 1000)),
        L5_HOSTS
    );
    assert_eq!(
        owner("release_lease", store.release_lease(&token)),
        L5_HOSTS
    );
    assert_eq!(
        owner("read_commit_log", store.read_commit_log(None, 10)),
        L2_LOG
    );
    assert_eq!(
        owner("pending_member", mu::pending_member::<()>(L3_SERVER, "x")),
        L3_SERVER
    );
    // I-1: the default options are a serialized transaction with no deadline and no origin.
    let defaults = TxnOptions::default();
    assert_eq!(defaults.mode, TxnMode::Serialized);
    assert!(defaults.deadline.is_none() && defaults.origin.is_none());
    // I-2: positions order by (sequence, index) and the token is `cp1:<sequence>.<index>`.
    let at = |sequence, index| CommitPosition { sequence, index };
    assert!(at(1, 5) < at(2, 0) && at(2, 0) < at(2, 1));
    assert_eq!(at(2, 1).token(), "cp1:2.1");
}
