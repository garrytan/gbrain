//! Multi-writer conformance suite C01..C22 (docs/designs/rust-engine/multi-user-server.md, "Tests to
//! write now", 1). Each case names a typed operation and an invariant, and asserts outcomes, never the
//! order the store took.
//!
//! A case that holds on today's single-writer store is a plain test. A case that needs a multi-writer
//! mode is `#[ignore = "multi_writer"]` with a real body; run them with
//! `cargo test -p gbrain-store --test multi_writer_conformance -- --ignored multi_writer`. Twins of a
//! partly-running case carry the `_multi_writer` suffix.

mod common;
mod memory_env;

use common::{TempDir, open, open_concurrent};
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
use gbrain_store::{OpenOptions, Store};
use memory_env::brain;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, mpsc};
use std::thread;
use std::time::Duration;

const WRITERS: usize = 16;
const MARK: &str = "watchdog_suspect";
type Opener = fn(&TempDir) -> Store;

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

/// C01, compare-and-set page write: every acknowledged write is in the history or the writer got a typed conflict.
#[test]
fn c01_same_page_writers_lose_no_update() {
    let dir = TempDir::new("c01");
    let store = Arc::new(open(&dir));
    submit(&store, 0, "doc", "body seed");
    let s = store.clone();
    let outcomes = together(WRITERS, move |i| {
        let mut acked = Vec::new();
        for round in 0..4 {
            let body = format!("body {i} {round}");
            let expected = json!({"expectedRevision": revision(&s, "doc")});
            let m = mutation_with(1 + i * 4 + round, "doc", &body, expected);
            let receipt = s.submit_page_mutation(&m, None).unwrap();
            match receipt["state"].as_str().unwrap() {
                "committed" => acked.push(body),
                _ => assert_eq!(receipt["write_error"], REVISION_CONFLICT, "{receipt}"),
            }
        }
        acked
    });
    let acked: Vec<String> = outcomes.into_iter().flatten().collect();
    assert!(!acked.is_empty(), "no writer won");
    let last = store
        .read_page_snapshot("doc", &ReadScope::default())
        .unwrap()
        .unwrap();
    let last = last["page"]["compiled_truth"].as_str().unwrap().to_string();
    let history = store
        .get_versions("doc", &VersionsOptions::default())
        .unwrap();
    let mut seen: BTreeSet<String> = history
        .iter()
        .map(|v| v["compiled_truth"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(seen.len(), history.len(), "a body is in the history twice");
    seen.insert(last);
    let mut expected: BTreeSet<String> = acked.iter().cloned().collect();
    expected.insert("body seed".into());
    assert_eq!(
        seen, expected,
        "an acknowledged write is missing or one never acknowledged landed"
    );
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
    store
        .upsert_chunks("doc", &chunks, &with(&revision(&store, "doc")))
        .unwrap();
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
                token: format!("c0000000-0000-4000-8000-{i:012}"),
                lease_ms: 1000.0,
                phase_json: None,
            };
            store.renew_write_claim(&stamp).unwrap()
        })
        .collect();
    assert_eq!(renewing, vec![won.into_iter().flatten().next().unwrap()]);
}

/// C03, write claim: managed and cross-host claimers; waits for `claim_next_writes` as one typed call (select then stamp is two calls).
#[test]
#[ignore = "multi_writer"]
fn c03_two_claimers_of_one_write_never_both_claim_multi_writer() {
    let dir = TempDir::new("c03m");
    let store = Arc::new(open_concurrent(&dir));
    let id = queued_write(&store, "b0000000-0000-4000-8000-0000000000b1");
    let s = store.clone();
    let won = together(8, move |i| {
        let row = s
            .select_claimable_write(&ClaimableSpec::default())
            .unwrap()?;
        let stamp = ClaimStamp {
            id: row["id"].as_str().unwrap().into(),
            token: format!("c0000000-0000-4000-8000-{i:012}"),
            lease_ms: 60_000.0,
            phase_json: None,
        };
        s.stamp_write_claim(&stamp).unwrap().map(|_| i)
    });
    assert_eq!(
        won.iter().flatten().count(),
        1,
        "request {id} was claimed more than once: {won:?}"
    );
}

/// C04, `claim_next_job`: eight workers claim each job once, none lost.
#[test]
fn c04_eight_workers_claim_each_job_once() {
    let b = brain("c04");
    let all: BTreeSet<i64> = (0..64).map(|_| add_job(&b, json!({}))).collect();
    let store: &Store = &b;
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

/// C05, `reclaim_stalled_jobs`: concurrent sweeps reclaim an expired claim once in total.
#[test]
#[ignore = "multi_writer"]
fn c05_expired_claim_is_reclaimed_once_multi_writer() {
    let dir = TempDir::new("c05m");
    let store = Arc::new(open_concurrent(&dir));
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
    let snap = b
        .read_page_snapshot("protected", &ReadScope::default())
        .unwrap()
        .unwrap();
    assert_eq!(snap["page"]["compiled_truth"], "from the new holder");
}

/// C07, `claim_effects`: one claimant; a crashed owner's effect is claimed again; no duplicate row.
#[test]
#[ignore = "multi_writer"]
fn c07_effect_claimed_once_rerun_after_owner_crash_multi_writer() {
    const HOST: &str = "d0000000-0000-4000-8000-0000000000d1";
    let dir = TempDir::new("c07");
    let store = Arc::new(open_concurrent(&dir));
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
    // The owner dies after the action and before it records: the effect is claimable again and runs again.
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

/// C08, `reserve_capacity` (admission counters): no over-admission, no lost update.
#[test]
fn c08_counter_never_over_admits() {
    let dir = TempDir::new("c08");
    let store = Arc::new(open(&dir));
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

/// C09, `admit_job`: concurrent submits of one idempotency key give one row.
#[test]
fn c09_idempotency_key_maps_to_one_row() {
    let b = brain("c09");
    let store: &Store = &b;
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

/// C10, `append_fact`: the facts of one entity form one stable order and none is lost.
#[test]
#[ignore = "multi_writer"]
fn c10_facts_of_one_entity_form_one_total_order_multi_writer() {
    let dir = TempDir::new("c10");
    let store = Arc::new(open_concurrent(&dir));
    let s = store.clone();
    let ids = together(WRITERS, move |i| {
        (0..4)
            .map(|n| fact(&s, &format!("fact {i} {n}")))
            .collect::<Vec<u64>>()
    });
    let ids: BTreeSet<u64> = ids.into_iter().flatten().collect();
    assert_eq!(ids.len(), WRITERS * 4, "a fact id was handed out twice");
    let (first, second) = (facts_read(&store), facts_read(&store));
    assert_eq!(first, second, "the order changed between reads");
    let unique: BTreeSet<&String> = first.iter().collect();
    assert_eq!(
        (first.len(), unique.len()),
        (WRITERS * 4, WRITERS * 4),
        "a fact was lost or repeated"
    );
}

/// C11, `append_fact` with a sequence assigned at commit: the order a reader sees is commit order.
/// New rule: waits for facts to carry the commit sequence; today's body compares the read order with the sequence `commit_transaction` returns.
#[test]
#[ignore = "multi_writer"]
fn c11_per_entity_order_equals_commit_order_multi_writer() {
    let dir = TempDir::new("c11");
    let store = Arc::new(open_concurrent(&dir));
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

/// C12, `transaction(fn)`: each of two transactions reads its own uncommitted writes and never the other's.
#[test]
fn c12_two_transactions_read_only_their_own_writes() {
    let openers: [(&str, Opener); 2] = [("single", open), ("optimistic", open_concurrent)];
    for (label, opener) in openers {
        let dir = TempDir::new("c12");
        let store = Arc::new(opener(&dir));
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

/// C13, `transaction(fn)`: a commit on another key lands while a transaction is open.
/// Pending: today the open transaction holds the writer (`concurrency.rs:349`).
#[test]
#[ignore = "multi_writer"]
fn c13_transactions_on_different_keys_do_not_wait_multi_writer() {
    let dir = TempDir::new("c13");
    let store = Arc::new(open_concurrent(&dir));
    put(&store, "notes/a", "before");
    let tx = store.begin_transaction(false).unwrap();
    put(&tx, "notes/a", "from the transaction");
    let (done, landed) = mpsc::channel();
    let s = store.clone();
    let other = thread::spawn(move || {
        put(&s, "notes/b", "another key");
        done.send(()).unwrap();
    });
    let waited = landed.recv_timeout(Duration::from_secs(2)).is_err();
    tx.commit_transaction().unwrap();
    other.join().unwrap();
    assert!(
        !waited,
        "a commit on another key waited for the open transaction"
    );
}

/// C14, `publish_generation` (`activate_generation_rows`): generations are monotonic and never two winners.
#[test]
#[ignore = "multi_writer"]
fn c14_concurrent_publishers_one_winner_multi_writer() {
    let dir = TempDir::new("c14");
    let store = Arc::new(open_concurrent(&dir));
    let key = GenerationKey {
        source_id: "default".into(),
        kind: "managed_walk".into(),
        owner_key: "input:c14".into(),
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

/// C15, `single_flight(keys)`: different keys fly together, one key never has two holders. Waits for `single_flight(keys)`; today one transaction holds every key.
#[test]
#[ignore = "multi_writer"]
fn c15_single_flight_holds_only_its_keys_multi_writer() {
    let dir = TempDir::new("c15m");
    let store = Arc::new(open_concurrent(&dir));
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
    together(8, move |i| {
        let key = i % 4;
        let tx = s.begin_transaction(false).unwrap();
        mk.fetch_max(p[key].fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
        mt.fetch_max(i2.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
        put(&tx, &format!("key/{key}"), "held");
        thread::sleep(Duration::from_millis(20));
        p[key].fetch_sub(1, Ordering::SeqCst);
        i2.fetch_sub(1, Ordering::SeqCst);
        tx.commit_transaction().unwrap();
    });
    assert_eq!(most_key.load(Ordering::SeqCst), 1, "two holders of one key");
    assert!(
        most_total.load(Ordering::SeqCst) > 1,
        "different keys never flew together"
    );
}

/// C16, `upgrade_format`: callers of a concurrent open see the whole brain or `store_locked`, never a partial one.
/// The format-1 downgrade helper is private to `lifecycle.rs`, so the exactly-one-upgrade count waits for a shared helper.
#[test]
fn c16_format_upgrade_runs_once_under_concurrent_openers() {
    let dir = TempDir::new("c16");
    let path = dir.path().join("brain");
    let (id, pages) = {
        let store = open(&dir);
        put(&store, "notes/a", "kept");
        let id = store.brain_id().to_string();
        store.close();
        (id, 1)
    };
    let p = path.clone();
    let opened = together(4, move |_| Store::open_dir(&p, OpenOptions::default()));
    let mut live = Vec::new();
    for outcome in opened {
        match outcome {
            Ok(store) => live.push(store),
            Err(e) => assert_eq!(e.code, STORE_LOCKED, "a partial open: {e:?}"),
        }
    }
    assert_eq!(live.len(), 1, "one opener wins a single-writer brain");
    assert_eq!(
        (live[0].brain_id(), live[0].count_pages(None).unwrap()),
        (id.clone(), pages)
    );
}

/// C16, `upgrade_format`: every concurrent opener of an older brain gets a working store and the upgrade runs once.
#[test]
#[ignore = "multi_writer"]
fn c16_format_upgrade_runs_once_under_concurrent_openers_multi_writer() {
    let dir = TempDir::new("c16m");
    drop(open_concurrent(&dir));
    let path = dir.path().join("brain");
    let opened = together(4, move |_| {
        Store::open_dir(
            &path,
            OpenOptions {
                concurrent_writes: true,
                ..OpenOptions::default()
            },
        )
    });
    let errors: Vec<String> = opened
        .iter()
        .filter_map(|r| r.as_ref().err())
        .map(|e| e.code.to_string())
        .collect();
    assert!(
        errors.is_empty(),
        "a concurrent opener was refused: {errors:?}"
    );
    let ids: BTreeSet<String> = opened.iter().flatten().map(|s| s.brain_id()).collect();
    assert_eq!(ids.len(), 1);
}

/// C17, `open_brain`: a second opener becomes a client, never an error.
/// Client behavior (calls in flight retry by request id) is owner-process behavior in TypeScript, so it stays pending at store level.
/// Only the store half is checked: a second open of a live brain is not `store_locked`.
#[test]
#[ignore = "multi_writer"]
fn c17_second_opener_becomes_a_client_never_an_error_multi_writer() {
    let dir = TempDir::new("c17");
    let first = open_concurrent(&dir);
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

/// C18, all rows from 64 writers: no lost update, no double claim, no busy error. Today's body is 64 threads in one process;
/// the eight-process half waits for an opener that is not `store_locked` (C17).
#[test]
#[ignore = "multi_writer"]
fn c18_sixty_four_writers_no_busy_error_multi_writer() {
    let dir = TempDir::new("c18");
    let store = Arc::new(open_concurrent(&dir));
    let s = store.clone();
    together(64, move |i| {
        for round in 0..4 {
            submit(&s, i * 100 + round, &format!("p/{i}-{round}"), "body text");
        }
    });
    assert_eq!(store.count_pages(None).unwrap(), 256);
    assert_eq!(store.journal_outstanding().unwrap()["brain"], 0);
}

/// C19, crash robot: acknowledged writes are present after a restart and none is duplicated.
/// A drop without `close` stands in for the kill; the kill itself is `occ_history.rs:595` and `sim.rs`.
#[test]
fn c19_crash_after_commit_keeps_acknowledged_writes() {
    let dir = TempDir::new("c19");
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
    assert!(
        store
            .get_versions("notes/3", &VersionsOptions::default())
            .unwrap()
            .is_empty()
    );
}

/// C19, crash robot: acknowledged writes of concurrent writers survive a restart exactly once (the in-process half of the kill).
#[test]
#[ignore = "multi_writer"]
fn c19_crash_after_commit_keeps_acknowledged_writes_multi_writer() {
    let dir = TempDir::new("c19m");
    let acked = {
        let store = Arc::new(open_concurrent(&dir));
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
    let store = open_concurrent(&dir);
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
        together(8, move |i| {
            for round in 0..4 {
                let tx = s.begin_transaction(false).unwrap();
                let order = if i % 2 == 0 {
                    ["pair/a", "pair/b"]
                } else {
                    ["pair/b", "pair/a"]
                };
                for slug in order {
                    put(&tx, slug, &format!("{i} {round}"));
                }
                tx.commit_transaction().unwrap();
            }
        });
        done.send(()).unwrap();
    });
    finished
        .recv_timeout(Duration::from_secs(60))
        .expect("writers in opposite orders deadlocked");
    assert!(exists(&store, "pair/a") && exists(&store, "pair/b"));
}

/// C20, compare-and-set on two pages written in both orders, with no lock to order them: no deadlock, every writer's update lands.
#[test]
#[ignore = "multi_writer"]
fn c20_no_deadlock_across_two_pages_in_both_orders_multi_writer() {
    let dir = TempDir::new("c20m");
    let store = Arc::new(open_concurrent(&dir));
    let (s, attempts) = (store.clone(), Arc::new(AtomicUsize::new(1)));
    let (done, finished) = mpsc::channel();
    thread::spawn(move || {
        let acked = together(8, move |i| {
            let order = if i % 2 == 0 {
                ["pair/a", "pair/b"]
            } else {
                ["pair/b", "pair/a"]
            };
            for slug in order {
                loop {
                    let expected = if exists(&s, slug) {
                        json!({"expectedRevision": revision(&s, slug)})
                    } else {
                        json!({"expectedRevision": null})
                    };
                    let n = attempts.fetch_add(1, Ordering::SeqCst);
                    let m = mutation_with(n, slug, &format!("writer {i}"), expected);
                    let receipt = s.submit_page_mutation(&m, None).unwrap();
                    if receipt["state"] == "committed" {
                        break;
                    }
                    assert_eq!(receipt["write_error"], REVISION_CONFLICT, "{receipt}");
                }
            }
        });
        done.send(acked.len()).unwrap();
    });
    let writers = finished
        .recv_timeout(Duration::from_secs(60))
        .expect("writers in opposite orders deadlocked");
    assert_eq!(writers, 8);
    for slug in ["pair/a", "pair/b"] {
        assert_eq!(
            store
                .get_versions(slug, &VersionsOptions::default())
                .unwrap()
                .len(),
            7,
            "{slug}: an update was lost"
        );
    }
}

/// C21, commit position as a token: a write acknowledged on one connection is seen by another given the token.
/// New rule. Waits for a token-taking read (G5 or G7): today the token is `commit_transaction`'s return and the second connection is a clone of the handle.
#[test]
#[ignore = "multi_writer"]
fn c21_read_your_writes_token_on_a_second_connection_multi_writer() {
    let dir = TempDir::new("c21");
    let store = Arc::new(open_concurrent(&dir));
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

/// C22, commit log: concurrent writes with no transaction take one distinct position each. A batch shares one today (audit row A6).
#[test]
#[ignore = "multi_writer"]
fn c22_commit_position_strictly_increases_multi_writer() {
    let dir = TempDir::new("c22m");
    let store = Arc::new(open_concurrent(&dir));
    let start = store.commit_version().unwrap();
    let s = store.clone();
    together(WRITERS, move |i| {
        put(&s, &format!("c22m/{i}"), "one commit");
    });
    assert_eq!(
        store.commit_version().unwrap(),
        start + WRITERS as u64,
        "two commits share a position"
    );
}
