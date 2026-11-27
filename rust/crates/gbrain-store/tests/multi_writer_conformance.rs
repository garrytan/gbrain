//! Multi-writer conformance suite C01..C22 (docs/designs/rust-engine/multi-user-server.md, "Tests to
//! write now", 1). Each case names a typed operation and an invariant, asserts the invariant inside
//! the scenario, and compares outcomes, never the order the store took.
//!
//! Every case has two parts:
//! - the runnable part, a plain test `cNN_<name>` that holds on today's store (it runs in both store
//!   modes: `GBRAIN_RUST_CONCURRENT_WRITES=1` puts `common::open` on the optimistic record file);
//! - the multi-writer part, `cNN_<name>_multi_writer`: the same rule with writers that are independent explicit
//!   transactions or hosts, on a store opened with multi-user mode on (asserted at every open). It calls the
//!   frozen interfaces I-1 to I-5 through `common::mu`. A part whose owning lane has not landed its member stays
//!   `#[ignore = "multi_writer"]` and fails loudly, naming the lane, when run with
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
    self, CommitPosition, L2_LOG, L3_SERVER, LEASE_LOST, LeaseToken, LostReason, MuStore, MuTxn,
    SingleFlightKey, TxnMode, TxnOptions, WriteOrigin,
};
use common::{StoreMode, TempDir, clock, open, open_in};
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::error::*;
use gbrain_store::facts::{FactQuery, InsertFactArgs};
use gbrain_store::generations::{ActivationInput, GenerationKey, LedgerItemInput};
use gbrain_store::jobs::{AdmitSpec, ClaimSpec, LockAcquire};
use gbrain_store::journal::{JournalLimits, PageMutation, WriteAdmission};
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope, VersionsOptions};
use gbrain_store::persistence::{
    ClaimStamp, ClaimableSpec, EffectClaim, EffectSettle, PublicationEffectsSpec, Settle,
    WriteCompletion, WriteRequestInsert,
};
use gbrain_store::{FORMAT_VERSION, Kv, OpenOptions, Store, StoreError};
use memory_env::{Brain, brain};
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
        fence: None,
    }
}

/// A store opened on the optimistic record file with the multi-user switch on, whatever the environment says (the multi-writer
/// parts: a fresh brain is never silently a plain one). Reopening a brain goes through here too.
fn open_optimistic(dir: &TempDir) -> Store {
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

/// `open_optimistic` with the commit log on as well (host `mu::TEST_HOST`), the resolved state asserted by `mu::open_dir_logged`:
/// for a twin that reads the log.
fn open_optimistic_logged(dir: &TempDir) -> Store {
    mu::open_dir_logged(&dir.path().join("brain"), true, mu::TEST_HOST).unwrap()
}

/// The identity of writer `i`, one host each (I-3).
fn origin(i: usize) -> WriteOrigin {
    WriteOrigin {
        host_id: format!("host-{i}"),
        incarnation: format!("incarnation-{i}"),
        writer_id: format!("writer-{i}"),
    }
}

/// The options of an explicit optimistic transaction for writer `i` (I-1), carrying that writer's origin.
fn host_options(i: usize) -> TxnOptions {
    TxnOptions {
        mode: TxnMode::Optimistic,
        deadline: None,
        origin: Some(origin(i)),
        ..TxnOptions::default()
    }
}

fn begin_host(store: &Store, i: usize) -> MuTxn {
    store
        .begin_with(host_options(i))
        .unwrap_or_else(|e| panic!("{e}"))
}

/// The store resolved multi-user mode on, and an explicit optimistic transaction opens on it and is abandoned.
fn require_transactions(store: &Store) {
    assert!(
        store.multiuser(),
        "the store did not resolve multi-user mode on"
    );
    drop(begin_host(store, 0));
}

fn commit_host(store: &Store, tx: MuTxn) -> CommitPosition {
    store.commit_position(tx).unwrap_or_else(|e| panic!("{e}"))
}

/// A typed `write_conflict` from a commit is the retryable answer of an optimistic transaction.
fn is_conflict(e: &StoreError) -> bool {
    e.code == WRITE_CONFLICT
}

/// A host's lease, taken through the landed I-5 member.
fn require_host_lease(store: &Store) -> LeaseToken {
    store
        .acquire_lease("conformance-host", &origin(0), 30_000)
        .unwrap_or_else(|e| panic!("{e}"))
        .expect("the first holder gets the lease")
}

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
                let expected = json!({"expectedRevision": revision(tx.store(), "doc")});
                let n = attempts.fetch_add(1, Ordering::SeqCst);
                let receipt = tx
                    .store()
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
        .store()
        .upsert_chunks("doc", &chunks, &with(&read_at))
        .unwrap();
    commit_host(&store, first);
    let stale = second
        .store()
        .upsert_chunks("doc", &chunks, &with(&read_at));
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
        .store()
        .upsert_chunks("doc", &chunks, &with(&revision(retry.store(), "doc")))
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
                    fence: None,
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
                fence: None,
            };
            store.renew_write_claim(&stamp).unwrap()
        })
        .collect();
    assert_eq!(renewing, vec![won.into_iter().flatten().next().unwrap()]);
}

/// C03, write claim: eight claimers, each its own optimistic transaction, claim one request once. A
/// claimer whose stamp loses the race is told so with a typed `write_conflict` at commit or sees nothing
/// claimable; never two acknowledged claims.
#[test]
fn c03_two_claimers_of_one_write_never_both_claim_multi_writer() {
    let dir = TempDir::new("c03m");
    let store = Arc::new(open_optimistic(&dir));
    let id = queued_write(&store, "b0000000-0000-4000-8000-0000000000b1");
    // Each claimer is its own host with its own lease; every protected step carries that host's fence.
    let fences: Arc<Vec<LeaseToken>> = Arc::new(
        (0..8)
            .map(|i| {
                store
                    .acquire_lease(&format!("claimer-{i}"), &origin(i), 60_000)
                    .unwrap()
                    .expect("a free lease")
            })
            .collect(),
    );
    let (s, f) = (store.clone(), fences.clone());
    let won = together(8, move |i| {
        let tx = begin_host(&s, i);
        let spec = ClaimableSpec {
            fence: Some(f[i].clone()),
            ..ClaimableSpec::default()
        };
        let row = tx.store().select_claimable_write(&spec).unwrap()?;
        let stamp = ClaimStamp {
            id: row["id"].as_str().unwrap().into(),
            token: format!("c0000000-0000-4000-8000-{i:012}"),
            lease_ms: 60_000.0,
            phase_json: None,
            fence: Some(f[i].clone()),
        };
        tx.store().stamp_write_claim(&stamp).unwrap()?;
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
                fence: Some(fences[i].clone()),
            };
            store.renew_write_claim(&stamp).unwrap_or(false)
        })
        .collect();
    assert_eq!(
        holds,
        vec![winner],
        "the claim is not held by its one winner"
    );
}

/// C04 scenario: eight workers claim every job once and none is lost.
fn eight_workers_claim_each_job_once(b: &Brain, fenced: bool) {
    // On a multi-user brain every protected claim carries its worker host's fence.
    let fences: Vec<Option<LeaseToken>> = (0..8)
        .map(|w| {
            fenced.then(|| {
                b.acquire_lease(&format!("worker-{w}"), &origin(w), 60_000)
                    .unwrap()
                    .expect("a free lease")
            })
        })
        .collect();
    let fences = &fences;
    let all: BTreeSet<i64> = (0..64).map(|_| add_job(b, json!({}))).collect();
    let store: &Store = b;
    let claimed: Vec<Vec<i64>> = thread::scope(|s| {
        let workers: Vec<_> = (0..8)
            .map(|w| {
                s.spawn(move || {
                    let mut spec = claim_spec(&format!("worker-{w}:token"), 30_000.0);
                    spec.fence = fences[w].clone();
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
    eight_workers_claim_each_job_once(&brain("c04"), false);
}

/// C04, `claim_next_job`: the same claim, with every worker a host that carries its origin.
#[test]
fn c04_eight_workers_claim_each_job_once_multi_writer() {
    let b = memory_env::brain_mu("c04m");
    require_transactions(&b);
    eight_workers_claim_each_job_once(&b, true);
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

/// C05, `reclaim_stalled_jobs` and `renew_job_lease`: concurrent sweeps from several hosts, each under its own fence, reclaim an
/// expired claim once in total, and the old claimant's renewal (its lease moved, then expired) is refused. Real members, fenced.
#[test]
fn c05_expired_claim_is_reclaimed_once_multi_writer() {
    const TTL_MS: u64 = 60_000;
    let b = Arc::new(memory_env::brain_mu("c05m"));
    assert!(
        b.multiuser(),
        "C05: the store did not resolve multi-user mode on"
    );
    let a_lease = b
        .acquire_lease("claimant", &origin(1), TTL_MS)
        .unwrap()
        .expect("host A's lease");
    let id = add_job(&b, json!({"max_stalled": 2}));
    let mut spec = claim_spec("w:1", 1.0);
    spec.fence = Some(a_lease.clone());
    assert!(b.claim_next_job(&spec).unwrap().is_some());
    // Eight sweeping hosts, each with its own lease.
    let sweepers: Arc<Vec<LeaseToken>> = Arc::new(
        (0..8)
            .map(|i| {
                b.acquire_lease(&format!("sweeper-{i}"), &origin(10 + i), TTL_MS)
                    .unwrap()
                    .expect("a free lease")
            })
            .collect(),
    );
    b.clock.advance(5_000);
    let (s, sw) = (b.clone(), sweepers.clone());
    let swept = together(8, move |i| {
        s.reclaim_stalled_jobs_fenced(0.0, MARK, Some(&sw[i]))
            .unwrap()["requeued"]
            .as_array()
            .unwrap()
            .len()
    });
    assert_eq!(swept.iter().sum::<usize>(), 1, "{swept:?}");
    assert_eq!(b.get_job(id).unwrap().unwrap()["stalled_counter"], 1);
    // A's renewal with the old token is refused (the claim is no longer A's), and its fence is its own lease.
    assert!(
        !b.renew_job_lease_fenced(id, "w:1", 1000.0, Some(&a_lease))
            .unwrap(),
        "the old token renewed"
    );
    // A sweeper with no fence on a multi-user store is no longer refused for lacking one (design note rule 7, the
    // implicit lease, L5): it runs, finds nothing stalled after the reclaim above, and changes nothing. The reclaim
    // still happened exactly once.
    let before = b.get_job(id).unwrap();
    let unfenced = b.reclaim_stalled_jobs_fenced(0.0, MARK, None).unwrap();
    assert_eq!(
        unfenced["requeued"].as_array().unwrap().len(),
        0,
        "{unfenced}"
    );
    assert_eq!(
        b.get_job(id).unwrap(),
        before,
        "an unfenced sweep changed the job"
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

/// Asserts `e` is a `lease_lost` with exactly this reason (the message carries it as JSON).
fn assert_lost(e: &StoreError, reason: LostReason, what: &str) {
    assert_eq!(e.code, LEASE_LOST, "{what}: {e}");
    assert_eq!(
        mu::lost_reason(e).as_deref(),
        Some(reason.as_str()),
        "{what}: {e}"
    );
}

/// C06, the token-fenced cycle lock (today's `acquire_lease`): after a takeover the old holder cannot refresh the lock, release it, or write
/// protected data under it, and the new holder can. (An expired but untaken cycle lock still refreshes today; that an expired
/// lease cannot be renewed is the multi-writer part.)
#[test]
fn c06_old_holder_cannot_refresh_release_or_write_after_a_takeover() {
    let b = brain("c06-old-holder");
    let (a, c) = (
        "00000000-0000-4000-8000-0000000000a1",
        "00000000-0000-4000-8000-0000000000b2",
    );
    b.acquire_cycle_lock("src", &lock(1, a, 1.0))
        .unwrap()
        .unwrap();
    let holder = |pid: i64, token: &str| -> gbrain_store::jobs::LockHolder {
        serde_json::from_value(
            json!({"holderPid": pid, "acquisitionToken": token, "ttlMinutes": 1.0}),
        )
        .unwrap()
    };
    // The live lock is not taken by a second holder.
    assert!(
        b.acquire_cycle_lock("src", &lock(2, c, 1.0))
            .unwrap()
            .is_none()
    );
    b.clock.advance(120_000_000);
    b.acquire_cycle_lock("src", &lock(2, c, 1.0))
        .unwrap()
        .expect("the takeover after expiry");
    assert!(
        !b.refresh_cycle_lock("src", &holder(1, a)).unwrap(),
        "the old holder refreshed"
    );
    assert!(
        !b.release_cycle_lock("src", &holder(1, a)).unwrap(),
        "the old holder released"
    );
    let tx = b.begin_transaction(false).unwrap();
    assert!(
        !tx.assert_cycle_lease("src", a).unwrap(),
        "the old token still holds"
    );
    tx.rollback_transaction().unwrap();
    assert!(!exists(&b, "protected"));
    // The new holder still holds, refreshes and writes.
    assert!(b.refresh_cycle_lock("src", &holder(2, c)).unwrap());
    let tx = b.begin_transaction(false).unwrap();
    assert!(tx.assert_cycle_lease("src", c).unwrap());
    put(&tx, "protected", "from the new holder");
    tx.commit_transaction().unwrap();
    assert_eq!(current_body(&b, "protected"), "from the new holder");
}

/// C06, `acquire_lease` and `assert_lease`: a holder that paused after taking its lease cannot write protected data
/// after a takeover, whether it asserts its token before or after the takeover. Every takeover moves the epoch.
#[test]
fn c06_stale_holder_data_write_refused_by_its_token_multi_writer() {
    let b = memory_env::brain_mu("c06m");
    let first = b
        .acquire_lease("cycle", &origin(1), 50)
        .unwrap_or_else(|e| panic!("{e}"))
        .expect("the first holder");
    // The paused holder asserts its lease, writes and then pauses before its commit.
    let paused = begin_host(&b, 1);
    paused.assert_lease(&first).unwrap();
    put(paused.store(), "protected", "from the paused holder");
    b.clock.advance(120_000);
    let second = b
        .acquire_lease("cycle", &origin(2), 60_000)
        .unwrap_or_else(|e| panic!("{e}"))
        .expect("the takeover");
    assert!(
        second.epoch > first.epoch,
        "a takeover did not move the epoch"
    );
    let refused = b.commit_position(paused).unwrap_err();
    assert!(
        refused.code == LEASE_LOST || is_conflict(&refused),
        "the paused holder's commit was not refused: {refused}"
    );
    assert!(!exists(&b, "protected"), "the stale write landed");
    // A holder that asserts its old token after the takeover is refused in its own transaction.
    let late = begin_host(&b, 1);
    assert_lost(
        &late.assert_lease(&first).unwrap_err(),
        LostReason::EpochMoved,
        "the old token inside a transaction",
    );
    drop(late);
    let holder = begin_host(&b, 2);
    holder.assert_lease(&second).unwrap();
    put(holder.store(), "protected", "from the new holder");
    commit_host(&b, holder);
    assert_eq!(current_body(&b, "protected"), "from the new holder");
}

/// A completion of write request `id` (a terminal committed result), optionally under a fence.
fn write_completion(id: &str, fence: Option<&LeaseToken>) -> WriteCompletion {
    let mut c: WriteCompletion = serde_json::from_value(json!({
        "id": id, "state": "committed", "outcome": {"slug": "notes/a"}, "errorCode": null, "errorMessage": null,
        "consumerVersion": "v-consumer", "consumerHostId": EFFECT_HOST, "errorDetail": null, "resultBytes": 100,
        "counterKeys": ["principal:local_cli:parity-writer", "brain"], "intentBytes": 10, "retainedBytes": 512,
        "terminalReservation": 4096, "probePurges": false,
    }))
    .unwrap();
    c.fence = fence.cloned();
    c
}

fn fenced_stamp(id: &str, token: &str, fence: Option<&LeaseToken>) -> ClaimStamp {
    ClaimStamp {
        id: id.into(),
        token: token.into(),
        lease_ms: 30_000.0,
        phase_json: None,
        fence: fence.cloned(),
    }
}

/// C06, a partitioned host, through the landed members (a multi-user brain on the injected clock): host A takes a lease with a short
/// ttl and claims a write under it; the clock passes the expiry and A's renewal is refused `expired`; host B takes the lease under
/// epoch + 1; A's old-epoch finish is refused `epoch_moved` and writes nothing, B's fence cannot finish A's claim
/// (`claim_epoch_mismatch`), an unfenced protected call on a claim a live registered lease covers is `held_by_another`, a released lease is `released` and a lease nobody took is
/// `not_found`. Every `lease_lost` reason is asserted. This part holds today because an explicit transaction on the current store
/// holds the writer; the in-flight old-epoch transaction is the multi_writer twin.
#[test]
fn c06_partitioned_host_claims_and_leases_are_refused_by_reason() {
    const TTL_MS: u64 = 1_000;
    const NAME: &str = "protected-writer";
    let b = memory_env::brain_mu("c06-partition");
    let past_expiry = || b.clock.advance((TTL_MS as i64 + 1) * 1000);
    let id = queued_write(&b, "b0000000-0000-4000-8000-0000000000b1");
    let request = |b: &Brain| {
        b.read_write_request_by_id(&id)
            .unwrap()
            .expect("the request")
    };

    let a = b
        .acquire_lease(NAME, &origin(1), TTL_MS)
        .unwrap()
        .expect("host A takes the lease");
    assert_eq!(a.epoch, 1);
    assert!(
        b.acquire_lease(NAME, &origin(2), TTL_MS).unwrap().is_none(),
        "a live lease was taken by a second holder"
    );
    assert!(b.read_lease(NAME).unwrap().expect("the record").live);
    b.stamp_write_claim(&fenced_stamp(
        &id,
        "c0000000-0000-4000-8000-0000000000c1",
        Some(&a),
    ))
    .unwrap()
    .expect("host A claims the write");
    let held = request(&b);

    // The partition: the clock passes the expiry. A cannot renew; its token no longer holds; nobody took over yet.
    past_expiry();
    assert!(!b.read_lease(NAME).unwrap().expect("the record").live);
    assert_lost(
        &b.renew_lease(&a, TTL_MS).unwrap_err(),
        LostReason::Expired,
        "renew after expiry",
    );
    assert_lost(
        &b.assert_lease(&a).unwrap_err(),
        LostReason::Expired,
        "assert after expiry",
    );
    assert_lost(
        &b.complete_write_row(&write_completion(&id, Some(&a)))
            .unwrap_err(),
        LostReason::Expired,
        "A finishes after its lease expired",
    );
    assert_eq!(request(&b), held, "the expired finish wrote something");

    // Host B takes the lease under epoch + 1.
    let taken = b
        .acquire_lease(NAME, &origin(2), TTL_MS)
        .unwrap()
        .expect("host B takes the expired lease");
    assert_eq!(
        taken.epoch,
        a.epoch + 1,
        "a takeover raises the epoch by one"
    );
    assert_lost(
        &b.assert_lease(&a).unwrap_err(),
        LostReason::EpochMoved,
        "the old token outside a transaction",
    );
    assert_lost(
        &b.renew_lease(&a, TTL_MS).unwrap_err(),
        LostReason::EpochMoved,
        "renew with the old token",
    );
    assert_lost(
        &b.complete_write_row(&write_completion(&id, Some(&a)))
            .unwrap_err(),
        LostReason::EpochMoved,
        "A finishes after the takeover",
    );
    assert_eq!(
        request(&b),
        held,
        "the old-epoch finish wrote protected data"
    );
    b.release_lease(&a).unwrap(); // a stale release changes nothing
    b.assert_lease(&taken).unwrap();
    // The claim A stamped finishes only under A's epoch: B's fence is refused claim_epoch_mismatch, and nothing is written.
    assert_lost(
        &b.complete_write_row(&write_completion(&id, Some(&taken)))
            .unwrap_err(),
        LostReason::ClaimEpochMismatch,
        "B finishes A's claim",
    );
    assert_eq!(request(&b), held, "a claim of the old epoch was finished");
    // A protected entry point with no fence on a multi-user store, on a claim a registered holder's live lease covers:
    // refused `held_by_another` (design note rule 7, L5), and nothing is written.
    assert_lost(
        &b.complete_write_row(&write_completion(&id, None))
            .unwrap_err(),
        LostReason::HeldByAnother,
        "no fence, on a claim another holder's live lease covers",
    );
    assert_eq!(request(&b), held);

    // A release ends the lease: assert and renew are `released`; the holder that comes back takes epoch + 1 again.
    b.release_lease(&taken).unwrap();
    assert_lost(
        &b.assert_lease(&taken).unwrap_err(),
        LostReason::Released,
        "assert after release",
    );
    assert_lost(
        &b.renew_lease(&taken, TTL_MS).unwrap_err(),
        LostReason::Released,
        "renew after release",
    );
    let a_again = b
        .acquire_lease(NAME, &origin(1), TTL_MS)
        .unwrap()
        .expect("host A takes the released lease");
    assert_eq!(a_again.epoch, taken.epoch + 1);
    b.assert_lease(&a_again).unwrap();
    assert_lost(
        &b.assert_lease(&a).unwrap_err(),
        LostReason::EpochMoved,
        "epoch 1 after epoch 3",
    );

    // A name nobody took.
    let stranger = LeaseToken {
        name: "never-taken".into(),
        epoch: 1,
        token: "x".into(),
    };
    assert_lost(
        &b.assert_lease(&stranger).unwrap_err(),
        LostReason::NotFound,
        "a lease that does not exist",
    );
    assert_lost(
        &b.renew_lease(&stranger, TTL_MS).unwrap_err(),
        LostReason::NotFound,
        "renew of a lease that does not exist",
    );
}

/// C06, a partitioned host, the in-flight half: A asserts its lease and stages a protected write in an optimistic transaction, the
/// clock passes the expiry, A's renewal is refused `expired`, host B takes the lease under epoch + 1, and only then A's old-epoch
/// transaction commits. It must be refused (`lease_lost`, or a retryable `write_conflict` whose fresh run is refused `epoch_moved`)
/// and no protected data is written. Needs two transactions open at once (`begin_with`).
#[test]
fn c06_partitioned_host_old_epoch_work_refused_multi_writer() {
    const TTL_MS: u64 = 1_000;
    const NAME: &str = "protected-writer";
    let b = memory_env::brain_mu("c06-partition-tx");
    let a = b
        .acquire_lease(NAME, &origin(1), TTL_MS)
        .unwrap()
        .expect("host A takes the lease");
    let tx = begin_host(&b, 1);
    tx.assert_lease(&a).unwrap();
    put(tx.store(), "protected", "from the partitioned host");
    b.clock.advance((TTL_MS as i64 + 1) * 1000);
    assert_lost(
        &b.renew_lease(&a, TTL_MS).unwrap_err(),
        LostReason::Expired,
        "renew after expiry",
    );
    let taken = b
        .acquire_lease(NAME, &origin(2), TTL_MS)
        .unwrap()
        .expect("host B takes the expired lease");
    assert_eq!(taken.epoch, a.epoch + 1);
    let refused = b.commit_position(tx).unwrap_err();
    assert!(
        refused.code == LEASE_LOST || is_conflict(&refused),
        "the old-epoch commit was not refused: {refused}"
    );
    if refused.code == LEASE_LOST {
        let reason = mu::lost_reason(&refused).unwrap_or_default();
        assert!(
            reason == LostReason::EpochMoved.as_str() || reason == LostReason::Expired.as_str(),
            "{refused}"
        );
    }
    assert!(
        !exists(&b, "protected"),
        "protected data was written under the old epoch"
    );
    let again = begin_host(&b, 1);
    assert_lost(
        &again.assert_lease(&a).unwrap_err(),
        LostReason::EpochMoved,
        "the old token in a fresh transaction",
    );
    drop(again);
    let holder = begin_host(&b, 2);
    holder.assert_lease(&taken).unwrap();
    put(holder.store(), "protected", "from the current holder");
    commit_host(&b, holder);
    assert_eq!(current_body(&b, "protected"), "from the current holder");
}

/// The reasons the adapter names are the six the store's `lease_lost` carries, each round-tripping through the error message.
#[test]
fn the_lease_lost_reasons_round_trip_through_the_error_message() {
    let named: Vec<&str> = mu::LOST_REASONS.iter().map(|r| r.as_str()).collect();
    assert_eq!(
        named,
        [
            "not_found",
            "epoch_moved",
            "released",
            "expired",
            "claim_epoch_mismatch",
            "held_by_another"
        ]
    );
    for reason in mu::LOST_REASONS {
        let e = mu::lease_lost(reason, "n", 3, Some(4));
        assert_lost(&e, reason, "round trip");
    }
    assert_eq!(mu::lost_reason(&StoreError::new(WRITE_CONFLICT, "x")), None);
}

/// C07 scenario: one effect, eight claimants; the owner dies after the action and before it records, and the
/// effect is claimed again; no duplicate row.
const EFFECT_HOST: &str = "d0000000-0000-4000-8000-0000000000d1";

/// A queued write with one embedding effect; returns the request id.
fn queued_effect(store: &Store) -> String {
    let id = queued_write(store, "b0000000-0000-4000-8000-0000000000b1");
    let incarnation =
        store.read_source_membership("default").unwrap().unwrap()["incarnation"].clone();
    let effects: PublicationEffectsSpec = serde_json::from_value(json!({
        "requestId": id, "revision": "e0000000-0000-4000-8000-0000000000e1", "sourceId": "default",
        "sourceIncarnation": incarnation, "worktreeId": null,
        "effects": [{"kind": "embedding", "data": {"slug": "notes/a", "page_id": 1}}],
    }))
    .unwrap();
    store.insert_publication_effects(&effects).unwrap();
    id
}

fn effect_claimed_once_then_rerun(store: Arc<Store>) {
    const HOST: &str = EFFECT_HOST;
    let id = queued_effect(&store);
    let claim = |s: &Store, token: &str, dead: &[String]| -> Option<Value> {
        let tx = s.begin_transaction(false).unwrap();
        let next = tx.select_claimable_effect(HOST, dead).unwrap();
        let owner = json!({"token": token, "owner": {"pid": 7, "nonce": "n", "start": "s"}});
        let claimed = next.get("id").and_then(Value::as_str).and_then(|effect| {
            let claim = EffectClaim {
                id: effect.into(),
                token: token.into(),
                owner_json: owner.to_string(),
                fence: None,
                dead_owners: Vec::new(),
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
        fence: None,
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

/// C07, `claim_effects`: a host's death is its lease expiring (I-5), through the landed fenced members. The effect is claimed under
/// host A's lease, the lease expires on the injected clock, host B takes it under epoch + 1 and claims the effect again, and A's
/// stale fence cannot settle it (`lease_lost`: `expired` before the takeover, `epoch_moved` after). One effect row, once.
#[test]
fn c07_effect_claimed_once_rerun_after_host_lease_expiry() {
    const TTL_MS: u64 = 1_000;
    const NAME: &str = "effects-host";
    const TOKEN_A: &str = "f0000000-0000-4000-8000-0000000000a1";
    const TOKEN_A2: &str = "f0000000-0000-4000-8000-0000000000a2";
    const TOKEN_B: &str = "f0000000-0000-4000-8000-0000000000b1";
    let b = memory_env::brain_mu("c07m");
    let id = queued_effect(&b);
    let claim = |token: &str, fence: &LeaseToken| -> StoreResultOpt {
        let candidate = b.select_claimable_effect(EFFECT_HOST, &[]).unwrap();
        if candidate.is_null() {
            return Ok(None);
        }
        let owner = json!({"token": token, "owner": {"pid": 7, "nonce": "n", "start": "s"}});
        b.stamp_effect_claim(&EffectClaim {
            id: candidate["id"].as_str().unwrap().into(),
            token: token.into(),
            owner_json: owner.to_string(),
            fence: Some(fence.clone()),
            dead_owners: Vec::new(),
        })
    };
    let settle = |token: &str, effect: &Value, fence: &LeaseToken| EffectSettle {
        id: effect["id"].as_str().unwrap().into(),
        token: Some(token.into()),
        slug: None,
        outcome_json: Some("{}".into()),
        data_json: None,
        reason: Some("x".into()),
        delay_ms: Some(0.0),
        fence: Some(fence.clone()),
    };
    let a = b
        .acquire_lease(NAME, &origin(1), TTL_MS)
        .unwrap()
        .expect("host A takes the lease");
    let effect = claim(TOKEN_A, &a)
        .unwrap()
        .expect("host A claims the effect");
    assert!(
        claim(TOKEN_A2, &a).unwrap().is_none(),
        "one effect was claimed twice under a live lease"
    );
    let rows = b.read_request_effects(&id).unwrap();
    // A pauses: its lease expires on the injected clock. It cannot settle (expired), though nobody took the lease yet.
    b.clock.advance((TTL_MS as i64 + 1) * 1000);
    assert_lost(
        &b.settle_effect(Settle::Complete, &settle(TOKEN_A, &effect, &a))
            .unwrap_err(),
        LostReason::Expired,
        "A settles after its lease expired",
    );
    // Host B takes the lease under epoch + 1 and claims the effect again (its claimant is dead: the old owner is listed).
    let taken = b
        .acquire_lease(NAME, &origin(2), TTL_MS)
        .unwrap()
        .expect("host B takes the expired lease");
    assert_eq!(taken.epoch, a.epoch + 1);
    let candidate = b
        .select_claimable_effect(EFFECT_HOST, &["7:n:s".to_string()])
        .unwrap();
    assert_eq!(
        candidate["id"], effect["id"],
        "the dead host's effect is not claimable again"
    );
    let owner = json!({"token": TOKEN_B, "owner": {"pid": 8, "nonce": "m", "start": "t"}});
    let again = b
        .stamp_effect_claim(&EffectClaim {
            id: effect["id"].as_str().unwrap().into(),
            token: TOKEN_B.into(),
            owner_json: owner.to_string(),
            fence: Some(taken.clone()),
            // The stamp takes the same proven-dead owner the selection above was given (G6: a multi-user stamp takes a
            // running effect only when its claim lapsed or its owner is proven dead).
            dead_owners: vec!["7:n:s".to_string()],
        })
        .unwrap()
        .expect("B claims the effect again");
    assert_eq!(again["id"], effect["id"]);
    // A's stale fence can no longer settle: the lease moved and the claim is B's. Nothing was recorded.
    let held = b.read_request_effects(&id).unwrap();
    assert_ne!(held, rows, "B's claim changed nothing observable");
    assert_lost(
        &b.settle_effect(Settle::Complete, &settle(TOKEN_A, &effect, &a))
            .unwrap_err(),
        LostReason::EpochMoved,
        "A settles after the takeover",
    );
    assert_eq!(
        b.read_request_effects(&id).unwrap(),
        held,
        "the stale settle recorded something"
    );
    assert!(
        b.settle_effect(Settle::Complete, &settle(TOKEN_B, &again, &taken))
            .unwrap(),
        "B could not settle its own claim"
    );
    let rows = b.read_request_effects(&id).unwrap();
    assert_eq!(rows.len(), 1, "a duplicate effect row");
    assert_eq!(rows[0]["state"], "committed");
}

type StoreResultOpt = gbrain_store::Result<Option<Value>>;

/// C07, `claim_effects`: the same rule when eight claimant hosts race, each under its own fence, on an optimistic store with
/// explicit transactions (the select and the stamp are one transaction each).
#[test]
fn c07_effect_claimed_once_by_racing_hosts_multi_writer() {
    let b = Arc::new(memory_env::brain_mu("c07r"));
    let id = queued_effect(&b);
    let fences: Arc<Vec<LeaseToken>> = Arc::new(
        (0..8)
            .map(|i| {
                b.acquire_lease(&format!("claimant-{i}"), &origin(i), 60_000)
                    .unwrap()
                    .expect("a free lease")
            })
            .collect(),
    );
    let (s, f) = (b.clone(), fences.clone());
    let won = together(8, move |i| {
        let tx = begin_host(&s, i);
        let candidate = tx
            .store()
            .select_claimable_effect(EFFECT_HOST, &[])
            .unwrap();
        let claimed = candidate
            .get("id")
            .and_then(Value::as_str)
            .and_then(|effect| {
                tx.store()
                    .stamp_effect_claim(&EffectClaim {
                        id: effect.into(),
                        token: format!("f0000000-0000-4000-8000-{i:012}"),
                        owner_json:
                            json!({"token": i, "owner": {"pid": 7, "nonce": "n", "start": "s"}})
                                .to_string(),
                        fence: Some(f[i].clone()),
                        dead_owners: Vec::new(),
                    })
                    .unwrap()
            });
        match s.commit_position(tx) {
            Ok(_) => claimed.map(|_| i),
            Err(e) => {
                assert!(is_conflict(&e), "an untyped refusal: {e}");
                None
            }
        }
    });
    assert_eq!(
        won.iter().flatten().count(),
        1,
        "one effect, several claimants: {won:?}"
    );
    assert_eq!(
        b.read_request_effects(&id).unwrap().len(),
        1,
        "a duplicate effect row"
    );
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
fn c09_idempotency_key_maps_to_one_row_multi_writer() {
    let b = memory_env::brain_mu("c09m");
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

/// C10, `append_fact`: the same on a multi-user optimistic store whose writer holds a host lease (I-5).
#[test]
fn c10_facts_of_one_entity_form_one_total_order_multi_writer() {
    let dir = TempDir::new("c10m");
    let store = Arc::new(open_optimistic(&dir));
    assert!(
        store.multiuser(),
        "C10: the store did not resolve multi-user mode on"
    );
    require_host_lease(&store);
    facts_of_one_entity_form_one_total_order(store);
}

/// C11, runnable part: explicit transactions appending to one entity each get their own commit sequence, rising with the order
/// they committed in, and every fact is read back. It does not compare the reader's order with commit order: readers list facts
/// by `created_at` (then id), which is not commit order (I-4.v2.1).
#[test]
fn c11_per_entity_commit_sequences_are_distinct_and_no_fact_is_lost() {
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
    let wrote: BTreeSet<String> = committed.into_iter().map(|(_, text)| text).collect();
    let read: BTreeSet<String> = facts_read(&store).into_iter().collect();
    assert_eq!(
        read, wrote,
        "a fact was lost or one never committed was read"
    );
}

/// C11, `append_fact` with a sequence assigned at commit: the order a reader sees is commit order. Stays ignored, with this reason:
/// the test compares the reader's order, which is `created_at` then id, with the order of the commits; I-4.v2.1 says a row's
/// `created_at` is the transaction's clock time, so a later commit can carry an earlier one and `created_at` order is not commit
/// order. The multi-user rule compares commit positions (the multi-writer twin).
#[test]
#[ignore = "I-4.v2.1: created_at order is not commit order; the check is by commit position (see the multi_writer twin)"]
fn c11_per_entity_order_equals_commit_order() {
    let dir = TempDir::new("c11-created-at");
    let store = Arc::new(open(&dir));
    let s = store.clone();
    let committed = together(WRITERS, move |i| {
        let tx = s.begin_transaction(false).unwrap();
        fact(&tx, &format!("fact {i}"));
        (tx.commit_transaction().unwrap(), format!("fact {i}"))
    });
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
/// entity, on a multi-user optimistic store with the commit log on; the order a reader sees by the entity's own sequence is the
/// order of the commit positions they were acknowledged with.
#[test]
fn c11_per_entity_order_equals_commit_order_multi_writer() {
    let dir = TempDir::new("c11m");
    let store = Arc::new(open_optimistic_logged(&dir));
    require_host_lease(&store);
    let (s, gate) = (store.clone(), Arc::new(Barrier::new(WRITERS)));
    let committed = together(WRITERS, move |i| {
        let text = format!("fact {i}");
        let mut first_try = true;
        loop {
            let tx = begin_host(&s, i);
            let id = fact(tx.store(), &text);
            if first_try {
                // Every transaction is open before the first one commits.
                gate.wait();
                first_try = false;
            }
            match s.commit_position(tx) {
                Ok(position) => return (position, id, text),
                Err(e) => assert!(is_conflict(&e), "an untyped refusal: {e}"),
            }
        }
    });
    let positions: BTreeSet<CommitPosition> = committed.iter().map(|(p, _, _)| *p).collect();
    assert_eq!(positions.len(), WRITERS, "two commits share a position");
    // The commit times in the log rise in position order (I-4.v2).
    let log = store
        .read_commit_log(None, 10_000)
        .unwrap_or_else(|e| panic!("{e}"));
    clock::commit_times_rise(&log.records).unwrap_or_else(|e| panic!("{e}"));
    // The order a reader sees is the commit-position order. Not `created_at` order (I-4.v2.1): that is the transaction's
    // clock time, and a later commit can carry an earlier one. The by-sequence read is the entity's own commit order.
    let by_id: BTreeMap<u64, String> = committed
        .iter()
        .map(|(_, id, text)| (*id, text.clone()))
        .collect();
    assert_eq!(by_id.len(), WRITERS, "two facts share a row id");
    let mut by_commit = committed;
    by_commit.sort();
    let commit_order: Vec<String> = by_commit.into_iter().map(|(_, _, text)| text).collect();
    let read_order: Vec<String> = store
        .list_entity_facts_in_commit_order("default", "people/alice", None, 1_000)
        .unwrap()
        .into_iter()
        .map(|p| by_id[&p.fact_id].clone())
        .collect();
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
fn c12_two_transactions_read_only_their_own_writes_multi_writer() {
    let dir = TempDir::new("c12m");
    let store = Arc::new(open_optimistic(&dir));
    require_transactions(&store);
    let (s, gate) = (store.clone(), Arc::new(Barrier::new(2)));
    together(2, move |i| {
        let (mine, theirs) = (format!("tx/{i}"), format!("tx/{}", 1 - i));
        let tx = begin_host(&s, i);
        put(tx.store(), &mine, "uncommitted");
        gate.wait();
        assert!(
            exists(tx.store(), &mine),
            "a transaction cannot read its own write"
        );
        assert!(
            !exists(tx.store(), &theirs),
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

/// C13, `transaction(fn)`: a commit on another key lands while a transaction is open. (Plain store: the open transaction holds
/// the writer, `embedded_one_owner_an_open_transaction_holds_off_other_commits`.)
#[test]
fn c13_transactions_on_different_keys_do_not_wait_multi_writer() {
    let dir = TempDir::new("c13m");
    let store = Arc::new(open_optimistic(&dir));
    put(&store, "notes/a", "before");
    let tx = begin_host(&store, 1);
    put(tx.store(), "notes/a", "from the transaction");
    let (done, landed) = mpsc::channel();
    let s = store.clone();
    let other = thread::spawn(move || {
        let tx = begin_host(&s, 2);
        put(tx.store(), "notes/b", "another key");
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
        put(tx.store(), &format!("key/{key}"), "held");
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
/// Stays ignored on purpose: a raw `Store` has no client path (a second raw open is `store_locked`, the permanent invariant of
/// `c17_a_second_raw_opener_is_refused_with_a_typed_store_locked`), so openers that become clients of the upgrading owner exist only
/// in the TypeScript owner socket. It is proven at the engine level by engine C16 (test/engine-parity/multi-writer-conformance.test.ts,
/// `rust-mu`, both routes): five engines open an older brain at once, one owns and upgrades it, four are clients, and its commit log
/// start and newest commit equal those of a brain a lone opener upgraded.
#[test]
#[ignore = "multi_writer"]
fn c16_format_upgrade_runs_once_under_concurrent_openers_multi_writer() {
    mu::pending_member::<()>(
        L3_SERVER,
        "a raw Store has no client path; proven at the engine level by engine C16 (rust-mu)",
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
/// Stays ignored on purpose: the client, and the retry of calls in flight by request id across an owner handover, are owner-socket
/// behavior in TypeScript; a raw `Store` never serves a second opener (`store_locked` is permanent). Proven at the engine level by
/// engine C17 (test/engine-parity/multi-writer-conformance.test.ts, `rust-mu`): the second opener is a client of the owner, and 48
/// calls in flight when the owner exits all succeed (plain Rust ends them `owner_unavailable`).
#[test]
#[ignore = "multi_writer"]
fn c17_second_opener_becomes_a_client_never_an_error_multi_writer() {
    mu::pending_member::<()>(
        L3_SERVER,
        "a raw Store has no client path; proven at the engine level by engine C17 (rust-mu)",
    )
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

/// C18, all rows from 64 writers in 8 processes. PARTIAL: after its pending probe this runs the one-process 64-thread helper
/// (so it does not by itself show the eight-process rule). The eight-process half (8 children of this test binary, one store
/// handle each, as C19 does) is not written because a second open of a live brain is `store_locked` until C17 lands, so there is
/// nothing to run it against at store level. Stays ignored: the eight-process stress is an engine case (engine C18, writer processes
/// that are owner-socket clients), and its Rust cell is pending: a client process's `admitJob` is refused `engine_capability_missing`
/// (capability `minion_queue`), because its policy argument carries functions that do not cross the owner socket.
#[test]
#[ignore = "multi_writer"]
fn c18_sixty_four_writers_no_busy_error_multi_writer() {
    mu::pending_member::<()>(
        L3_SERVER,
        "eight processes: engine C18 on Rust is pending, a client process's admitJob is refused (minion_queue)",
    )
        .unwrap_or_else(|e| panic!("{e}"));
    let dir = TempDir::new("c18m");
    sixty_four_writers_no_busy_error(Arc::new(open_optimistic(&dir)));
}

// ---- C19: a real crash -------------------------------------------------------------------------------------------------

const C19_DIR: &str = "GBRAIN_C19_DIR";
const C19_WRITERS: &str = "GBRAIN_C19_WRITERS";
const C19_OPTIMISTIC: &str = "GBRAIN_C19_OPTIMISTIC";
const C19_EXPLICIT_TXN: &str = "GBRAIN_C19_EXPLICIT_TXN";
const C19_LOGGED: &str = "GBRAIN_C19_LOGGED";
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
    let logged = std::env::var(C19_LOGGED).is_ok_and(|v| v == "1");
    let brain = Path::new(&dir).join("brain");
    let store = if logged {
        // Multi-user mode and the commit log on, in this process, and asserted: a child that lost the switch exits and the parent fails.
        mu::open_dir_logged(&brain, optimistic, mu::TEST_HOST).unwrap()
    } else {
        Store::open_dir(
            &brain,
            OpenOptions {
                concurrent_writes: optimistic,
                ..OpenOptions::default()
            },
        )
        .unwrap()
    };
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
                    // A writer that fails says so (and stops): the parent must not mistake the survivors' progress for the
                    // writer's. A line the kill cuts in half has no newline and is dropped by the parent.
                    let outcome: std::result::Result<Value, String> = if explicit {
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            // Optimistic needs multi-user mode on the concurrent store; any other brain runs the
                            // explicit transaction serialized (optimistic mode is refused there, never faked).
                            let tx = if logged && optimistic {
                                begin_host(store, w)
                            } else {
                                store
                                    .begin_with(TxnOptions {
                                        origin: Some(origin(w)),
                                        ..TxnOptions::default()
                                    })
                                    .unwrap_or_else(|e| panic!("{e}"))
                            };
                            let receipt = tx.store().submit_page_mutation(&m, None).unwrap();
                            commit_host(store, tx);
                            receipt
                        }))
                        .map_err(|_| "a panic in the explicit transaction".to_string())
                    } else {
                        store
                            .submit_page_mutation(&m, None)
                            .map_err(|e| e.to_string())
                    };
                    match outcome {
                        Ok(receipt) if receipt["state"] == "committed" => {
                            // The original receipt, whole, on one line: the parent compares it with the stored one.
                            say(format!("ACK {n} {receipt}\n"));
                        }
                        Ok(receipt) => {
                            say(format!("ERR {w} not committed: {receipt}\n"));
                            return;
                        }
                        Err(e) => {
                            say(format!("ERR {w} {e}\n"));
                            return;
                        }
                    }
                }
            });
        }
    });
}

/// What the parent learned from a killed child: every request it sent, every acknowledged one with the ORIGINAL receipt the store
/// gave it, the writers' progress and errors, and how the child ended.
struct Killed {
    sent: BTreeSet<usize>,
    acked: BTreeMap<usize, Value>,
    /// Acknowledged writes per writer (`n / 1_000_000`).
    progress: BTreeMap<usize, usize>,
    /// Lines a writer printed when it failed (`ERR <writer> <message>`).
    errors: Vec<String>,
    /// The signal that ended the child (9 for the kill), `None` when it exited by itself.
    signal: Option<i32>,
    /// What the child wrote on its error stream.
    stderr: String,
}

/// Runs the child of this test binary, kills it with SIGKILL once it has acknowledged `min_acks` writes AND every requested writer
/// has acknowledged at least three (or after 60 s), and collects what it printed. A writer error line, a child that was not ended by
/// the kill, and a requested writer with no progress each fail with the child's error stream.
fn kill_child_writer(
    dir: &TempDir,
    writers: usize,
    optimistic: bool,
    explicit: bool,
    logged: bool,
    min_acks: usize,
) -> Killed {
    use std::os::unix::process::ExitStatusExt;
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([C19_CHILD, "--exact", "--ignored", "--nocapture"])
        .args(["--test-threads=1", "-q"])
        .env(C19_DIR, dir.path())
        .env(C19_WRITERS, writers.to_string())
        .env(C19_OPTIMISTIC, if optimistic { "1" } else { "0" })
        .env(C19_EXPLICIT_TXN, if explicit { "1" } else { "0" })
        .env(C19_LOGGED, if logged { "1" } else { "0" })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let stderr_reader = thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::Read::read_to_string(&mut stderr, &mut text);
        text
    });
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
    let mut progress: BTreeMap<usize, usize> = BTreeMap::new();
    let mut seen = Vec::new();
    let enough = |progress: &BTreeMap<usize, usize>| {
        progress.values().sum::<usize>() >= min_acks
            && (0..writers).all(|w| progress.get(&w).copied().unwrap_or(0) >= 3)
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    while !enough(&progress) && Instant::now() < deadline {
        if let Ok(line) = heard.recv_timeout(Duration::from_millis(100)) {
            if let Some(rest) = line.strip_prefix("ACK ") {
                let n: usize = rest.split(' ').next().unwrap().parse().unwrap();
                *progress.entry(n / 1_000_000).or_default() += 1;
            }
            seen.push(line);
        }
        // A child that ended by itself before the kill is a failure, not a quiet success.
        if child.try_wait().unwrap().is_some() {
            break;
        }
    }
    let _ = child.kill(); // SIGKILL
    let status = child.wait().unwrap();
    reader.join().unwrap();
    let stderr = stderr_reader.join().unwrap();
    seen.extend(heard.try_iter());
    let mut killed = Killed {
        sent: BTreeSet::new(),
        acked: BTreeMap::new(),
        progress: BTreeMap::new(),
        errors: Vec::new(),
        signal: status.signal(),
        stderr,
    };
    for line in seen {
        if let Some(rest) = line.strip_prefix("ACK ") {
            let (n, receipt) = rest
                .split_once(' ')
                .expect("an ACK line carries its receipt");
            let n: usize = n.parse().unwrap();
            let receipt: Value = serde_json::from_str(receipt.trim_end())
                .unwrap_or_else(|e| panic!("an ACK receipt that is not JSON ({e}): {receipt}"));
            killed.acked.insert(n, receipt);
            *killed.progress.entry(n / 1_000_000).or_default() += 1;
        } else if let Some(n) = line.strip_prefix("SENT ") {
            killed.sent.insert(n.trim().parse().unwrap());
        } else if line.starts_with("ERR ") {
            killed.errors.push(line.trim_end().to_string());
        }
    }
    assert!(
        killed.errors.is_empty(),
        "a writer failed before the kill: {:?}\nchild stderr: {}",
        killed.errors,
        killed.stderr
    );
    assert_eq!(
        killed.signal,
        Some(9),
        "the child was not ended by the SIGKILL ({status:?}); stderr: {}",
        killed.stderr
    );
    for w in 0..writers {
        assert!(
            killed.progress.get(&w).copied().unwrap_or(0) >= 3,
            "writer {w} made no progress before the kill: {:?}; stderr: {}",
            killed.progress,
            killed.stderr
        );
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

/// The stored receipt of every acknowledged request, read BEFORE any replay, is exactly the one the child was given.
fn check_receipts_preserved(
    acked: &BTreeMap<usize, Value>,
    stored: &BTreeMap<usize, Option<Value>>,
) -> std::result::Result<(), String> {
    for (n, original) in acked {
        match stored.get(n) {
            Some(Some(now)) if now == original => {}
            Some(Some(now)) => {
                return Err(format!(
                    "request {n}: the stored receipt {now} is not the acknowledged {original}"
                ));
            }
            _ => {
                return Err(format!(
                    "request {n}: its receipt is gone after the reopen (a replay would recreate it)"
                ));
            }
        }
    }
    Ok(())
}

fn principal_of(n: usize) -> gbrain_store::journal::Principal {
    serde_json::from_value(json!({"kind": "local_cli", "id": format!("w{}", n % 8)})).unwrap()
}

/// The kill, the reopen and the checks. Before any replay: every acknowledged page is present with its body, and `get_write_receipt`
/// returns exactly the receipt the child was given. Then a replay of each request id returns that same receipt, adds no row and leaves
/// every page's history as it was. Controls: a hidden acknowledged write, an added row, a lost receipt with every page present, and
/// a different stored receipt must all fail.
fn crash_keeps_acknowledged_writes(
    dir: &TempDir,
    mode: StoreMode,
    logged: bool,
    killed: Killed,
    writers: usize,
) {
    assert!(!killed.acked.is_empty());
    // A logged run reopens multi-user with the log on, the resolved state asserted by the open.
    let store = if logged {
        mu::open_dir_logged(&dir.path().join("brain"), mode.optimistic(), mu::TEST_HOST).unwrap()
    } else {
        open_in(dir, mode)
    };
    let view = reopened_view(&store, &killed);
    check_acknowledged_survive(&view, &killed, writers).unwrap_or_else(|e| panic!("{e}"));
    let stored: BTreeMap<usize, Option<Value>> = killed
        .acked
        .keys()
        .map(|&n| {
            (
                n,
                store
                    .get_write_receipt(&principal_of(n), &request_id(n))
                    .unwrap(),
            )
        })
        .collect();
    check_receipts_preserved(&killed.acked, &stored).unwrap_or_else(|e| panic!("{e}"));
    for n in killed.acked.keys() {
        assert_eq!(
            current_body(&store, &format!("notes/{n}")),
            "acknowledged",
            "request {n}: the body is not the acknowledged one"
        );
    }
    let histories = |s: &Store| -> BTreeMap<usize, Vec<Value>> {
        killed
            .acked
            .keys()
            .map(|&n| {
                (
                    n,
                    s.get_versions(&format!("notes/{n}"), &VersionsOptions::default())
                        .unwrap(),
                )
            })
            .collect()
    };
    let (before_count, before_histories) = (store.count_pages(None).unwrap(), histories(&store));
    for (n, original) in &killed.acked {
        let replay = store
            .submit_page_mutation(&mutation(*n, &format!("notes/{n}"), "acknowledged"), None)
            .unwrap();
        assert_eq!(
            &replay, original,
            "request {n} replayed to a different receipt"
        );
    }
    assert_eq!(
        store.count_pages(None).unwrap(),
        before_count,
        "a replay duplicated a write"
    );
    assert_eq!(
        histories(&store),
        before_histories,
        "a replay changed a page's history"
    );
    // The controls: the checkers are not blind.
    let victim = *killed.acked.keys().nth(killed.acked.len() / 2).unwrap();
    let mut lost = reopened_view(&store, &killed);
    lost.present.remove(&victim);
    lost.count -= 1;
    let err = check_acknowledged_survive(&lost, &killed, writers).unwrap_err();
    assert!(err.contains("is missing"), "{err}");
    let mut duplicated = reopened_view(&store, &killed);
    duplicated.count += 1;
    assert!(check_acknowledged_survive(&duplicated, &killed, writers).is_err());
    // A receipt lost with every page still present: the presence check accepts it (it never looked at receipts), the receipt check
    // does not; and a stored receipt that differs from the acknowledged one fails too.
    let mut receipt_lost = stored.clone();
    receipt_lost.insert(victim, None);
    check_acknowledged_survive(&reopened_view(&store, &killed), &killed, writers).unwrap();
    let err = check_receipts_preserved(&killed.acked, &receipt_lost).unwrap_err();
    assert!(err.contains("is gone"), "{err}");
    let mut changed = stored;
    changed.insert(victim, Some(json!({"state": "committed", "page_id": 0})));
    assert!(
        check_receipts_preserved(&killed.acked, &changed)
            .unwrap_err()
            .contains("not the acknowledged")
    );
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
    let killed = kill_child_writer(&dir, 1, optimistic, false, false, 40);
    crash_keeps_acknowledged_writes(&dir, mode, false, killed, 1);
}

/// C19, crash robot: eight writers, each an explicit optimistic transaction with its origin, on a multi-user store with the commit
/// log on (in the child and in the parent, asserted at every open), killed mid-stream; every acknowledged write is present exactly
/// once after the reopen, its stored receipt is the acknowledged one, and each acknowledged request id is in the write ids of
/// exactly one commit record.
#[test]
fn c19_crash_after_commit_keeps_acknowledged_writes_multi_writer() {
    let dir = TempDir::new("c19m");
    let brain = dir.path().join("brain");
    // The cursor before the child writes anything: open-time upkeep and the activation commit are behind it.
    let start = {
        let probe = mu::open_dir_logged(&brain, true, mu::TEST_HOST).unwrap();
        require_transactions(&probe);
        probe
            .read_commit_log(None, 1)
            .unwrap_or_else(|e| panic!("{e}"))
            .newest
    };
    let killed = kill_child_writer(&dir, 8, true, true, true, 80);
    let ids: Vec<String> = killed.acked.keys().map(|&n| request_id(n)).collect();
    crash_keeps_acknowledged_writes(&dir, StoreMode::Optimistic, true, killed, 8);
    let store = mu::open_dir_logged(&brain, true, mu::TEST_HOST).unwrap();
    let log = store
        .read_commit_log(start, usize::MAX)
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(!log.snapshot_required);
    clock::request_ids_match_records(&ids, &log.records).unwrap_or_else(|e| panic!("{e}"));
}

/// C19, I-4.v2 clocks, against the commit-log lane's real code: eight plain writers on the optimistic store, multi-user mode and the
/// log on in the child and in the parent (asserted at every open), SIGKILL, reopen. The records after the pre-write cursor are the
/// child's commits, in position order, with strictly rising commit times; the newest equals `last_commit_time()`; and every
/// acknowledged request id is in the write ids of exactly one record, so an upkeep or in-flight record cannot stand in for a lost
/// acknowledged one. (The explicit-transaction variant is `c19_crash_after_commit_keeps_acknowledged_writes_multi_writer`.)
#[test]
fn c19_crash_keeps_commit_times_rising_and_equal_to_last_commit_time() {
    let dir = TempDir::new("c19-clock");
    let brain = dir.path().join("brain");
    // The cursor before the child writes anything: open-time upkeep and the activation commit are behind it.
    let start = {
        let probe = mu::open_dir_logged(&brain, true, mu::TEST_HOST).unwrap();
        probe
            .read_commit_log(None, 1)
            .unwrap_or_else(|e| panic!("{e}"))
            .newest
    };
    let killed = kill_child_writer(&dir, 8, true, false, true, 80);
    let store = mu::open_dir_logged(&brain, true, mu::TEST_HOST).unwrap();
    let log = store
        .read_commit_log(start, usize::MAX)
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(!log.snapshot_required);
    let last = store.last_commit_time().unwrap_or_else(|e| panic!("{e}"));
    clock::commit_times_rise(&log.records).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        log.records.last().map(|r| r.commit_time),
        last,
        "last_commit_time is not the newest record's commit time"
    );
    let ids: Vec<String> = killed.acked.keys().map(|&n| request_id(n)).collect();
    clock::request_ids_match_records(&ids, &log.records).unwrap_or_else(|e| panic!("{e}"));
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
fn c20_no_deadlock_across_two_pages_in_both_orders_multi_writer() {
    let dir = TempDir::new("c20m");
    let store = Arc::new(open_optimistic(&dir));
    require_transactions(&store);
    let s = store.clone();
    let (done, finished) = mpsc::channel();
    thread::spawn(move || {
        let positions = together(8, move |i| {
            let order = if i % 2 == 0 {
                ["pair/a", "pair/b"]
            } else {
                ["pair/b", "pair/a"]
            };
            // The keys are named in each writer's own order: the store takes them sorted, so opposite orders cannot wait on each other.
            let keys: Vec<SingleFlightKey> = order
                .iter()
                .map(|slug| SingleFlightKey {
                    source_id: "default".into(),
                    slug: slug.to_string(),
                })
                .collect();
            let mut mine = Vec::new();
            for round in 0..3 {
                loop {
                    let tx = begin_host(&s, i);
                    s.single_flight(&tx, &keys).unwrap();
                    for slug in order {
                        put(tx.store(), slug, &format!("writer {i} {round}"));
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
    // The token on a connection that is another process: the v3 wire has `min_position`, but no typed engine member or client option
    // sends it (engine C21 is pending on that missing member), so this stays ignored.
    mu::pending_member::<()>(
        L3_SERVER,
        "a read token on a second connection: no typed read-with-position member (engine C21)",
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let tx = begin_host(&store, 1);
    put(tx.store(), "notes/a", "acknowledged on A");
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

/// C22, commit log, single-writer store only: no two commits share a position and positions only grow. An explicit transaction
/// holds the writer, so this is the `store-single` cell. It opens the single-writer store whatever the environment says: on the
/// optimistic store an explicit transaction is exclusive too and would hide a group commit sharing one position, so the optimistic
/// cell is the `_multi_writer` twin, which forces a real group commit.
#[test]
fn c22_commit_position_strictly_increases() {
    let dir = TempDir::new("c22");
    let store = Arc::new(open_in(&dir, StoreMode::Single));
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

/// C22, commit log, optimistic store, against the commit-log lane's real code (multi-user mode and the log on in the run, asserted):
/// every transaction commits at its own `CommitPosition` even when a group commit batches several. The pipeline is held with an
/// exclusive write (the test waits on `OccKv::queued_commits` until all sixteen are queued), eight store writers (each a `submit_page_mutation` with its own request id) and eight raw writes queue behind it,
/// and releasing it lets them go as group commits. The test requires at least one group of two or more, and then checks: every raw
/// write's returned `(sequence, index)` is a record that holds that write's key; the members of each sequence have indices 0..k each
/// once; no two commits share a position; every acknowledged request id is in the write ids of exactly one record; commit times
/// strictly rise and the newest equals `last_commit_time()`. (The explicit-transaction variant that needs `begin_with` is L1's.)
#[test]
fn c22_commit_position_strictly_increases_multi_writer() {
    let dir = TempDir::new("c22m");
    let (kv, store) = mu::open_logged_occ(
        &dir.path().join("records.redb"),
        Arc::new(gbrain_store::SystemEnv),
        mu::TEST_HOST,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let store = Arc::new(store);
    let start = store
        .read_commit_log(None, 1)
        .unwrap_or_else(|e| panic!("{e}"))
        .newest;
    let raw_key = |i: usize| gbrain_store::keys::meta(&format!("c22/raw/{i}"));
    // Hold the pipeline: everything below queues until the exclusive write is dropped.
    let hold = kv.begin_write_exclusive().unwrap();
    let mut store_writers = Vec::new();
    for i in 0..8usize {
        let s = store.clone();
        store_writers.push(thread::spawn(move || {
            submit(&s, 700 + i, &format!("c22m/{i}"), "one commit");
            request_id(700 + i)
        }));
    }
    let mut raw_writers = Vec::new();
    for i in 0..8usize {
        let mut tx = kv.begin_write().unwrap();
        tx.put(&raw_key(i), format!("raw {i}").as_bytes()).unwrap();
        raw_writers.push(thread::spawn(move || (i, tx.commit_position())));
    }
    // Wait until all sixteen first commits are queued behind the held pipeline, so they go as group commits.
    let queued_by = Instant::now() + Duration::from_secs(20);
    while kv.queued_commits() < 16 {
        assert!(
            Instant::now() < queued_by,
            "only {} of 16 commits queued behind the held pipeline",
            kv.queued_commits()
        );
        thread::sleep(Duration::from_millis(5));
    }
    drop(hold);
    let acked: Vec<String> = store_writers
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect();
    let raw: Vec<(usize, CommitPosition)> = raw_writers
        .into_iter()
        .map(|h| {
            let (i, r) = h.join().unwrap();
            (i, r.unwrap_or_else(|e| panic!("raw write {i}: {e}")))
        })
        .collect();
    let log = store
        .read_commit_log(start, usize::MAX)
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(!log.snapshot_required);
    // Positions: unique, and every returned raw position is a record that holds that write.
    let positions: BTreeSet<CommitPosition> = raw.iter().map(|(_, p)| *p).collect();
    assert_eq!(
        positions.len(),
        raw.len(),
        "two raw commits share a position"
    );
    for (i, position) in &raw {
        let record = log
            .records
            .iter()
            .find(|r| r.position == *position)
            .unwrap_or_else(|| panic!("returned position {position:?} has no record"));
        assert!(
            record.ops.iter().any(|(k, _)| *k == raw_key(*i)),
            "the record at {position:?} does not hold raw write {i}"
        );
    }
    // A forced group of at least two: members of one sequence have indices 0..k, each once.
    let mut groups: BTreeMap<u64, Vec<u32>> = BTreeMap::new();
    for r in &log.records {
        groups
            .entry(r.position.sequence)
            .or_default()
            .push(r.position.index);
    }
    assert!(
        groups.values().any(|g| g.len() >= 2),
        "no group commit of two or more was formed, so the test did not exercise per-member positions: {groups:?}"
    );
    for (sequence, indices) in &mut groups {
        indices.sort_unstable();
        let want: Vec<u32> = (0..indices.len() as u32).collect();
        assert_eq!(
            *indices, want,
            "group {sequence}: indices are not 0..k each once"
        );
    }
    let all: BTreeSet<CommitPosition> = log.records.iter().map(|r| r.position).collect();
    assert_eq!(all.len(), log.records.len(), "two records share a position");
    clock::request_ids_match_records(&acked, &log.records).unwrap_or_else(|e| panic!("{e}"));
    clock::commit_times_rise(&log.records).unwrap_or_else(|e| panic!("{e}"));
    let last = store.last_commit_time().unwrap_or_else(|e| panic!("{e}"));
    clock::last_commit_time_matches(&log.records, last).unwrap_or_else(|e| panic!("{e}"));
}

/// C22, commit log, single-writer store, against the real log (multi-user mode and the log on, asserted): explicit transactions
/// return `(sequence, 0)`, strictly rising per writer, no two the same, and each returned position is the record that holds that
/// transaction's page; commit times rise and the newest equals `last_commit_time()`.
#[test]
fn c22_logged_single_writer_positions_have_index_zero_and_each_matches_a_record() {
    let dir = TempDir::new("c22s");
    let store = Arc::new(
        mu::open_dir_logged(&dir.path().join("brain"), false, mu::TEST_HOST)
            .unwrap_or_else(|e| panic!("{e}")),
    );
    let start = store
        .read_commit_log(None, 1)
        .unwrap_or_else(|e| panic!("{e}"))
        .newest;
    let s = store.clone();
    let positions = together(8, move |i| {
        (0..4)
            .map(|n| {
                let tx = s.begin_transaction(false).unwrap();
                put(&tx, &format!("c22s/{i}-{n}"), "one commit");
                (format!("c22s/{i}-{n}"), tx.commit_transaction_at().unwrap())
            })
            .collect::<Vec<_>>()
    });
    for mine in &positions {
        assert!(
            mine.windows(2).all(|w| w[0].1 < w[1].1),
            "positions went back: {mine:?}"
        );
        assert!(
            mine.iter().all(|(_, p)| p.index == 0),
            "a single-writer index is not 0: {mine:?}"
        );
    }
    let returned: Vec<CommitPosition> = positions.iter().flatten().map(|(_, p)| *p).collect();
    let log = store
        .read_commit_log(start, usize::MAX)
        .unwrap_or_else(|e| panic!("{e}"));
    clock::positions_match_records(&returned, &log.records, 0).unwrap_or_else(|e| panic!("{e}"));
    for (slug, position) in positions.iter().flatten() {
        let record = log
            .records
            .iter()
            .find(|r| r.position == *position)
            .unwrap();
        let key_has_slug = record
            .ops
            .iter()
            .any(|(k, _)| String::from_utf8_lossy(k).contains(slug.as_str()));
        assert!(
            key_has_slug,
            "the record at {position:?} does not hold {slug}"
        );
    }
    clock::commit_times_rise(&log.records).unwrap_or_else(|e| panic!("{e}"));
    let last = store.last_commit_time().unwrap_or_else(|e| panic!("{e}"));
    clock::last_commit_time_matches(&log.records, last).unwrap_or_else(|e| panic!("{e}"));
}

/// The resolved state is asserted, so a run with the mode off fails: a store opened plain reports no multi-user mode and no log, and
/// `assert_logged` panics on it; the logged open passes.
#[test]
fn a_plain_open_fails_the_resolved_state_assertion_and_the_logged_open_passes() {
    let dir = TempDir::new("resolved");
    let plain = open_in(&dir, StoreMode::Optimistic);
    assert!(!plain.multiuser() && !plain.info().commit_log);
    let refused =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| mu::assert_logged(&plain)));
    assert!(
        refused.is_err(),
        "a plain open passed the resolved-state assertion"
    );
    drop(plain);
    let other = TempDir::new("resolved-logged");
    let logged = mu::open_dir_logged(&other.path().join("brain"), true, mu::TEST_HOST).unwrap();
    assert!(logged.multiuser() && logged.info().commit_log);
}

/// The creation time of a page row, in microseconds.
fn page_created_us(s: &Store, slug: &str) -> i64 {
    let snap = s
        .read_page_snapshot(slug, &ReadScope::default())
        .unwrap()
        .unwrap();
    gbrain_store::env::parse_iso(snap["page"]["created_at"].as_str().unwrap()).unwrap()
}

/// PENDING ON L5 hosts (the follower row-time floor is the hosts lane's: the ruling is that the promoted primary's clock floor and
/// its fence arrive with the host lane) and on a public follower-apply member (`apply_log` stays a stub: L2 has only
/// `commit_log::apply_record` over a raw write handle). Not a C22 failure.
/// C22, log replay by a follower (I-4.v2, I-4.v2.1): the log's commit times strictly rise in position order and the newest equals
/// `last_commit_time()`. The primary reopens on a clock BELOW its persisted floor and every row time it then writes is at or above
/// that floor. A follower is given the log's actual records (not just its newest position), on a clock below the applied floor, and
/// is promoted: its floor is `max(its M\0ctime, the last applied commit_time)` and every row time it writes is at or above it. Row
/// times are compared with the floor only, never with each other as commit order.
#[test]
#[ignore = "multi_writer"]
fn c22_follower_replay_keeps_commit_times_rising_and_row_times_above_the_floor_multi_writer() {
    use memory_env::{Clock, T0};
    const PRIMARY_HOST: &str = "a0000000-0000-4000-8000-0000000000a1";
    const FOLLOWER_HOST: &str = "b0000000-0000-4000-8000-0000000000b1";
    let (primary_dir, follower_dir) = (TempDir::new("c22-primary"), TempDir::new("c22-follower"));
    let (primary_at, follower_at) = (
        primary_dir.path().join("brain"),
        follower_dir.path().join("brain"),
    );
    // Every open below goes through `open_at`: multi-user mode and the commit log both on, asserted by the adapter's open (a replay
    // needs the log, and the log is what `read_commit_log` and `last_commit_time` answer from). Row times are compared with a floor only, and each batch writes FRESH slugs: a page that
    // already exists keeps its old `created_at`, which would say nothing about the clock at this open.
    let open_at = |dir: &Path, clock: Arc<Clock>, host: &str| -> Store {
        std::fs::create_dir_all(dir).unwrap();
        mu::open_logged(&dir.join("records.redb"), true, clock, host)
            .unwrap_or_else(|e| panic!("{e}"))
            .store
    };
    let write_fresh = |s: &Store, prefix: &str| -> Vec<i64> {
        for n in 0..4 {
            put(s, &format!("{prefix}/{n}"), "a row written after open");
        }
        (0..4)
            .map(|n| page_created_us(s, &format!("{prefix}/{n}")))
            .collect()
    };

    // The primary commits through explicit optimistic transactions; the log it keeps is the replay input.
    let primary = open_at(&primary_at, Clock::at(T0), PRIMARY_HOST);
    primary
        .read_commit_log(None, 1)
        .unwrap_or_else(|e| panic!("{e}"));
    for i in 0..8 {
        let tx = begin_host(&primary, i);
        put(tx.store(), &format!("c22f/{i}"), "primary commit");
        commit_host(&primary, tx);
    }
    let log = primary
        .read_commit_log(None, 10_000)
        .unwrap_or_else(|e| panic!("{e}"));
    let last = primary.last_commit_time().unwrap_or_else(|e| panic!("{e}"));
    clock::replay_clock_checks(&log.records, last, None, &[]).unwrap_or_else(|e| panic!("{e}"));
    let floor = last.expect("a commit time after commits");

    // Reopen the primary on a clock below the persisted floor: the floor read at open is the persisted one, and fresh rows written
    // after the open sit at or above it.
    drop(primary);
    let reopened = open_at(&primary_at, Clock::at(floor - 5_000_000), PRIMARY_HOST);
    assert_eq!(
        reopened
            .last_commit_time()
            .unwrap_or_else(|e| panic!("{e}")),
        Some(floor),
        "the floor at open is not the persisted commit time"
    );
    clock::row_times_at_or_above_floor(floor, &write_fresh(&reopened, "primary-after-open"))
        .unwrap_or_else(|e| panic!("{e}"));

    // The follower: its clock reads far below the applied floor. It is given every record, applies them in order, and is promoted.
    let follower = open_at(&follower_at, Clock::at(floor - 10_000_000), FOLLOWER_HOST);
    let applied = follower
        .apply_log(&log.records)
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        applied, log.newest,
        "the follower did not apply the whole log"
    );
    let own = follower
        .last_commit_time()
        .unwrap_or_else(|e| panic!("{e}"));
    let promoted_floor = follower
        .promote_from_log(applied)
        .unwrap_or_else(|e| panic!("{e}"))
        .expect("a floor after a promotion from a non-empty log");
    assert_eq!(
        Some(promoted_floor),
        clock::floor_of(own, log.records.last()),
        "the floor is not max(local M\\0ctime, last applied commit_time)"
    );
    assert!(
        promoted_floor >= floor,
        "the promoted floor is below the applied commit time"
    );
    clock::row_times_at_or_above_floor(promoted_floor, &write_fresh(&follower, "promoted"))
        .unwrap_or_else(|e| panic!("{e}"));
    // The follower commits more after the promotion; its latest commit time (not the promotion floor) is the floor a reopen must keep.
    for i in 0..4 {
        let tx = begin_host(&follower, 20 + i);
        put(
            tx.store(),
            &format!("after-promotion/{i}"),
            "committed on the follower",
        );
        commit_host(&follower, tx);
    }
    let latest = follower
        .last_commit_time()
        .unwrap_or_else(|e| panic!("{e}"))
        .expect("the follower's latest commit time");
    assert!(
        latest > promoted_floor,
        "the follower's commits did not move its commit time"
    );

    // Close the follower and reopen it with the clock BEHIND its latest commit time. Fresh slugs written now must still sit at or
    // above that latest commit time: a store that forgot its floor would stamp them from the lagging clock.
    drop(follower);
    let behind = latest - 10_000_000;
    let again = open_at(&follower_at, Clock::at(behind), FOLLOWER_HOST);
    assert_eq!(
        again.last_commit_time().unwrap_or_else(|e| panic!("{e}")),
        Some(latest),
        "the reopened follower lost its commit time"
    );
    let fresh = write_fresh(&again, "reopened-fresh");
    clock::row_times_at_or_above_floor(latest, &fresh).unwrap_or_else(|e| panic!("{e}"));
    assert!(
        fresh.iter().all(|&t| t >= latest) && behind < latest,
        "the control clock was not behind the floor"
    );
}

/// The identity and exact-time checks fail what they claim to. Each control is a history the old count-based or monotonic-only check
/// accepts: a missing intermediate position made up by another record, an acknowledged id replaced by an in-flight record, and times
/// `1, 2, 3` that rise but ignore the store clock.
#[test]
fn the_identity_and_exact_time_checks_reject_what_counts_and_monotonic_checks_accept() {
    let rec = |seq: u64, idx: u32, t: i64, ids: &[&str]| mu::CommitRecord {
        write_ids: ids.iter().map(|s| s.to_string()).collect(),
        ..clock::record(seq, idx, t)
    };
    let p = |sequence, index| CommitPosition { sequence, index };
    // Positions: 4 returned, the log holds 4 records, but (2,1) is missing and an unrelated (9,0) fills the count.
    let records = vec![
        rec(1, 0, 10, &[]),
        rec(2, 0, 11, &[]),
        rec(3, 0, 12, &[]),
        rec(9, 0, 13, &[]),
    ];
    let returned = [p(1, 0), p(2, 0), p(2, 1), p(3, 0)];
    assert_eq!(
        records.len(),
        returned.len(),
        "the count matches, as the old check needed"
    );
    assert!(clock::positions_match_records(&returned, &records, 0).is_err());
    let whole = vec![
        rec(1, 0, 10, &[]),
        rec(2, 0, 11, &[]),
        rec(2, 1, 12, &[]),
        rec(3, 0, 13, &[]),
    ];
    clock::positions_match_records(&returned, &whole, 0).unwrap();
    // One extra record (open-time upkeep) is allowed only when the test says so.
    let mut with_upkeep = whole.clone();
    with_upkeep.push(rec(4, 0, 14, &[]));
    assert!(clock::positions_match_records(&returned, &with_upkeep, 0).is_err());
    clock::positions_match_records(&returned, &with_upkeep, 1).unwrap();
    // A position returned twice, or a record position twice, fails.
    assert!(clock::positions_match_records(&[p(1, 0), p(1, 0)], &whole, 3).is_err());
    let twice = vec![rec(1, 0, 10, &[]), rec(1, 0, 11, &[])];
    assert!(clock::positions_match_records(&[p(1, 0)], &twice, 1).is_err());
    // Request ids: three acknowledged, three records, but one acknowledged id is replaced by an in-flight one.
    let by_id = vec![
        rec(1, 0, 10, &["a"]),
        rec(2, 0, 11, &["b"]),
        rec(3, 0, 12, &["in-flight"]),
    ];
    let acked = ["a".to_string(), "b".to_string(), "c".to_string()];
    assert_eq!(by_id.len(), acked.len());
    assert!(clock::request_ids_match_records(&acked, &by_id).is_err());
    let by_id_whole = vec![
        rec(1, 0, 10, &["a"]),
        rec(2, 0, 11, &["b"]),
        rec(3, 0, 12, &["c", "in-flight"]),
    ];
    clock::request_ids_match_records(&acked, &by_id_whole).unwrap();
    let doubled = vec![rec(1, 0, 10, &["a", "b", "c"]), rec(2, 0, 11, &["a"])];
    assert!(clock::request_ids_match_records(&acked, &doubled).is_err());
    // Exact times: the clock held at 100 for three commits, then advanced to 500, then moved back to 50.
    let clocks = [100, 100, 100, 500, 50];
    assert_eq!(
        clock::exact_commit_times(None, &clocks),
        vec![100, 101, 102, 500, 501]
    );
    assert_eq!(clock::exact_commit_times(Some(200), &[100]), vec![201]);
    let exact: Vec<mu::CommitRecord> = clock::exact_commit_times(None, &clocks)
        .into_iter()
        .enumerate()
        .map(|(i, t)| clock::record(1 + i as u64, 0, t))
        .collect();
    clock::commit_times_are_exact(&exact, None, &clocks).unwrap();
    // 1, 2, 3, ... rises and equals `last_commit_time`, so the old checks pass; the exact check fails it.
    let counter: Vec<mu::CommitRecord> = (1..=5).map(|t| clock::record(t as u64, 0, t)).collect();
    clock::replay_clock_checks(&counter, Some(5), None, &[]).unwrap();
    assert!(clock::commit_times_are_exact(&counter, None, &clocks).is_err());
}

/// The clock checks fail what they claim to: a repeated or falling commit time, records out of position order, a stale
/// `last_commit_time`, a row time below the floor, and a floor below the last applied commit time. They pass a rising log.
#[test]
fn the_clock_checks_pass_a_rising_log_and_fail_each_violation() {
    let rising = vec![
        clock::record(1, 0, 1_000),
        clock::record(1, 1, 1_001),
        clock::record(2, 0, 5_000),
    ];
    clock::replay_clock_checks(&rising, Some(5_000), Some(5_000), &[5_000, 5_100]).unwrap();
    // Within one group commit each transaction still has its own time: a repeat fails.
    let repeated = vec![clock::record(1, 0, 1_000), clock::record(1, 1, 1_000)];
    assert!(
        clock::commit_times_rise(&repeated)
            .unwrap_err()
            .contains("does not rise")
    );
    // A falling time fails.
    let falling = vec![clock::record(1, 0, 2_000), clock::record(2, 0, 1_500)];
    assert!(clock::commit_times_rise(&falling).is_err());
    // Records out of position order fail.
    let unordered = vec![clock::record(2, 0, 1_000), clock::record(1, 0, 2_000)];
    assert!(
        clock::commit_times_rise(&unordered)
            .unwrap_err()
            .contains("position order")
    );
    // A last_commit_time that is not the newest record's time fails, and so does one reported for an empty log.
    assert!(clock::last_commit_time_matches(&rising, Some(4_999)).is_err());
    assert!(clock::last_commit_time_matches(&[], Some(1)).is_err());
    assert!(clock::last_commit_time_matches(&[], None).is_ok());
    // A row time below the floor fails.
    assert!(clock::row_times_at_or_above_floor(5_000, &[5_000, 4_999]).is_err());
    assert!(clock::replay_clock_checks(&rising, Some(5_000), Some(5_000), &[100]).is_err());
    // The promoted floor is the larger of the local time and the last applied record's time.
    let last = clock::record(3, 0, 7_000);
    assert_eq!(clock::floor_of(Some(9_000), Some(&last)), Some(9_000));
    assert_eq!(clock::floor_of(Some(6_000), Some(&last)), Some(7_000));
    assert_eq!(clock::floor_of(None, Some(&last)), Some(7_000));
    assert_eq!(clock::floor_of(None, None), None);
    assert_eq!(mu::clock_floor(Some(6_000), Some(&last)), Some(7_000));
}

/// The lease members the hosts lane landed are the real ones: acquiring, asserting, renewing, reading and releasing a lease works
/// through `common::mu`'s re-exports, with no stub in the way, and the stubs left in the adapter are only the members no lane has landed.
#[test]
fn the_landed_lease_members_are_real_and_the_adapter_names_no_stub_for_them() {
    let dir = TempDir::new("mu-leases");
    let store = open(&dir);
    let token: LeaseToken = store
        .acquire_lease("n", &origin(1), 1_000)
        .unwrap()
        .expect("a free lease");
    store.assert_lease(&token).unwrap();
    store.renew_lease(&token, 1_000).unwrap();
    assert!(store.read_lease("n").unwrap().expect("the record").live);
    store.release_lease(&token).unwrap();
    assert_lost(
        &store.assert_lease(&token).unwrap_err(),
        LostReason::Released,
        "assert after release",
    );
}

/// The adapter's stubs are still stubs, each naming its owner. Landing a member means editing `common/mu.rs` and this list
/// together, so an un-pend never happens by accident.
#[test]
fn mu_adapter_stubs_are_still_pending() {
    fn owner<T>(call: &str, result: mu::MuResult<T>) -> String {
        match result {
            Err(e) => match mu::pending_owner(&e) {
                Some(owner) => owner.to_string(),
                None => panic!("{call} failed for another reason: {e}"),
            },
            Ok(_) => panic!("{call} is no longer pending: edit this test with its stub"),
        }
    }
    let dir = TempDir::new("mu");
    let store = open(&dir);
    // Landed members (I-1 `begin_with`, `single_flight`, `Transaction::commit`) are asserted in
    // `mu_adapter_landed_members_behave` below; this test lists only the stubs.
    assert_eq!(
        owner("apply_log", store.apply_log(&[])),
        L2_LOG,
        "no Store member applies commit records: a public follower-apply path is still missing"
    );
    assert_eq!(
        owner("promote_from_log", store.promote_from_log(None)),
        L2_LOG
    );
    // Landed with the commit-log lane, so no longer stubs: on a store with the switch off, the clock floor is unset and the
    // log read is refused as a brain that keeps no log (never a pending error).
    assert_eq!(store.last_commit_time().unwrap(), None);
    let refused = store.read_commit_log(None, 10).unwrap_err();
    assert!(
        mu::pending_owner(&refused).is_none(),
        "read_commit_log is real: {refused}"
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

/// The I-1 members the adapter re-exports since they landed (lane L1), asserted against their contract instead of
/// listed as stubs: optimistic mode needs a multi-user brain (`invalid_state` otherwise, never a quiet serialized run);
/// `single_flight` holds its keys until the transaction ends (a second holder waits to its deadline, then `key_wait`);
/// `Transaction::commit` answers rising commit positions; the bound store cannot end a `Transaction` behind its back.
#[test]
fn mu_adapter_landed_members_behave() {
    let off_dir = TempDir::new("mu-landed-off");
    let off = open(&off_dir);
    let refused = off
        .begin_with(host_options(0))
        .err()
        .expect("an optimistic transaction began without multi-user mode");
    assert_eq!(refused.code, INVALID_STATE, "{refused}");

    let dir = TempDir::new("mu-landed");
    let store = open_optimistic(&dir);
    let key = SingleFlightKey {
        source_id: "default".into(),
        slug: "landed/a".into(),
    };
    let holder = begin_host(&store, 1);
    assert!(holder.store().transaction_optimistic());
    store
        .single_flight(&holder, std::slice::from_ref(&key))
        .unwrap();
    put(holder.store(), "landed/a", "held");
    let waiter = store
        .begin_with(TxnOptions {
            deadline: Some(Instant::now() + Duration::from_millis(50)),
            ..host_options(2)
        })
        .unwrap();
    let wait = store
        .single_flight(&waiter, std::slice::from_ref(&key))
        .unwrap_err();
    assert_eq!(wait.code, TIMEOUT, "{wait}");
    assert!(wait.message.starts_with("key_wait: "), "{wait}");
    waiter.rollback().unwrap();
    assert_eq!(
        holder.store().commit_transaction().unwrap_err().code,
        INVALID_STATE
    );
    let first = holder.commit().unwrap();
    let next = begin_host(&store, 3);
    store
        .single_flight(&next, std::slice::from_ref(&key))
        .unwrap();
    put(next.store(), "landed/a", "after the holder");
    let second = commit_host(&store, next);
    assert!(second > first, "{second:?} after {first:?}");
}
