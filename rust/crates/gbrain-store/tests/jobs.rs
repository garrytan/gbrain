//! Minion jobs: admission, claim, lease, finish and the stall sweep, matched to the PGLite engine.

mod memory_env;

use gbrain_store::error::{ADMISSION_REFUSED, INVALID_STATE};
use gbrain_store::jobs::{AdmitSpec, ClaimSpec, ListFilter, TokenDelta};
use memory_env::{Brain, brain};
use serde_json::{Value, json};
use std::collections::BTreeSet;

const MARK: &str = "watchdog_suspect";

fn insert(name: &str, extra: Value) -> Value {
    let mut base = json!({
        "name": name, "queue": "default", "status": "waiting", "priority": 0, "data": {},
        "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000,
        "backoff_jitter": 0.2, "on_child_fail": "fail_parent", "remove_on_complete": false,
        "remove_on_fail": false, "submission_authority": {"version": 1, "kind": "application"},
    });
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

fn admit(b: &Brain, spec: Value) -> gbrain_store::Result<gbrain_store::jobs::AdmitOutcome> {
    let mut spec = spec;
    if spec.get("maxSpawnDepth").is_none() {
        spec["maxSpawnDepth"] = json!(5);
    }
    let spec: AdmitSpec = serde_json::from_value(spec).unwrap();
    b.admit_job(&spec)
}

fn add(b: &Brain, name: &str, extra: Value) -> i64 {
    let out = admit(b, json!({ "insert": insert(name, extra) })).unwrap();
    assert_eq!(out.outcome, "inserted");
    out.row["id"].as_i64().unwrap()
}

fn claim_spec(token: &str, names: &[&str]) -> ClaimSpec {
    serde_json::from_value(json!({
        "lockToken": token, "lockDurationMs": 30000, "queue": "default", "names": names,
        "suspectMark": MARK, "handlerTimeouts": {}, "handlerLockDurations": {},
        "legacySpend": {"groupId": "00000000-0000-4000-8000-000000000001", "capUsd": 5},
    }))
    .unwrap()
}

fn claim(b: &Brain, token: &str) -> Option<Value> {
    b.claim_next_job(&claim_spec(token, &["work"])).unwrap()
}

fn job(b: &Brain, id: i64) -> Value {
    b.get_job(id).unwrap().expect("job exists")
}

/// Workers claim and complete while a submitter keeps adding jobs. With concurrent writes on, a
/// claim that loses a race to another claim, a completion or a submission runs again.
#[test]
fn many_workers_with_jobs_arriving_claim_and_complete_each_job_once() {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};
    for workers in [4usize, 16, 64] {
        let b = brain("jobs-arrivals");
        let first: Vec<i64> = (0..64)
            .map(|i| add(&b, "work", json!({ "priority": i % 3 })))
            .collect();
        let arrived = Mutex::new(Vec::new());
        let submitting = AtomicBool::new(true);
        let claimed: Vec<Vec<i64>> = std::thread::scope(|s| {
            s.spawn(|| {
                for i in 0..64 {
                    let id = add(&b, "work", json!({ "priority": i % 2 }));
                    arrived.lock().unwrap().push(id);
                }
                submitting.store(false, Ordering::SeqCst);
            });
            let handles: Vec<_> = (0..workers)
                .map(|w| {
                    let (b, submitting) = (&b, &submitting);
                    s.spawn(move || {
                        let token = format!("worker-{w}:token");
                        let spec = claim_spec(&token, &["work"]);
                        let mut mine = Vec::new();
                        loop {
                            // Read the flag first: a None after the last submission means done.
                            let more = submitting.load(Ordering::SeqCst);
                            match b.claim_next_job(&spec).unwrap() {
                                Some(row) => {
                                    let id = row["id"].as_i64().unwrap();
                                    let done = b.complete_job(id, &token, None).unwrap();
                                    assert!(
                                        done.is_some(),
                                        "the claimer could not complete job {id}"
                                    );
                                    mine.push(id);
                                }
                                // An empty claim is a write: back off so the submitter gets in.
                                None if more => {
                                    std::thread::sleep(std::time::Duration::from_millis(2))
                                }
                                None => return mine,
                            }
                        }
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let all: BTreeSet<i64> = first
            .into_iter()
            .chain(arrived.into_inner().unwrap())
            .collect();
        assert_eq!(all.len(), 128);
        let mut union = BTreeSet::new();
        for id in claimed.iter().flatten() {
            assert!(
                union.insert(*id),
                "{workers} workers: job {id} was claimed twice"
            );
        }
        assert_eq!(
            union, all,
            "{workers} workers: every job is claimed exactly once"
        );
        for id in &all {
            let row = job(&b, *id);
            assert_eq!(row["status"], "completed");
            assert_eq!(row["claim_generation"], 1);
            assert_eq!(row["attempts_started"], 1);
        }
    }
}

#[test]
fn two_workers_claiming_at_once_never_get_the_same_job() {
    let b = brain("jobs-race");
    let all: BTreeSet<i64> = (0..64).map(|_| add(&b, "work", json!({}))).collect();
    let store = &b.store;
    let claimed: Vec<Vec<i64>> = std::thread::scope(|s| {
        let workers: Vec<_> = (0..4)
            .map(|w| {
                s.spawn(move || {
                    let spec = claim_spec(&format!("worker-{w}:token"), &["work"]);
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
    for ids in &claimed {
        for id in ids {
            assert!(union.insert(*id), "job {id} was claimed twice");
        }
    }
    assert_eq!(union, all, "every job is claimed exactly once");
    for id in &all {
        let row = job(&b, *id);
        assert_eq!(row["status"], "active");
        assert_eq!(row["claim_generation"], 1);
        assert_eq!(row["attempts_started"], 1);
    }
}

#[test]
fn an_idempotency_key_coalesces_and_a_dead_holder_releases_it() {
    let b = brain("jobs-key");
    let first = add(&b, "work", json!({"idempotency_key": "k1"}));
    let again = admit(
        &b,
        json!({"insert": insert("work", json!({"idempotency_key": "k1"}))}),
    )
    .unwrap();
    assert_eq!(
        (again.outcome, again.row["id"].as_i64()),
        ("coalesced", Some(first))
    );

    let other = json!({"version": 1, "kind": "remote", "client": "c"});
    let conflict = admit(
        &b,
        json!({"insert": insert("work", json!({"idempotency_key": "k1", "submission_authority": other}))}),
    )
    .unwrap();
    assert_eq!(
        (conflict.outcome, conflict.row["id"].as_i64()),
        ("conflict", Some(first))
    );

    let row = claim(&b, "w:1").unwrap();
    assert_eq!(row["id"].as_i64(), Some(first));
    b.fail_job(first, "w:1", "boom", "dead", None, None)
        .unwrap()
        .unwrap();
    let second = add(&b, "work", json!({"idempotency_key": "k1"}));
    assert_ne!(second, first);
    let freed = job(&b, first);
    assert_eq!(freed["idempotency_key"], Value::Null);
    assert_eq!(freed["data"]["__released_idempotency_key"], "k1");
}

#[test]
fn quota_backpressure_and_parent_checks_refuse_or_coalesce() {
    let b = brain("jobs-admit");
    add(&b, "work", json!({"data": {"sourceId": "s1"}}));
    let err = admit(
        &b,
        json!({"insert": insert("work", json!({})), "quotaMaxWaiting": 1}),
    )
    .unwrap_err();
    assert_eq!(err.code, ADMISSION_REFUSED);
    assert_eq!(err.message, "queue_quota_exceeded:work:1:1");

    let capped = admit(
        &b,
        json!({"insert": insert("work", json!({"data": {"sourceId": "s1"}})),
               "backpressure": {"sourceId": "s1", "maxWaiting": 1}}),
    )
    .unwrap();
    assert_eq!(capped.outcome, "coalesced");
    assert_eq!(capped.audit.unwrap()["waiting_count"], 1);

    let err = admit(
        &b,
        json!({"insert": insert("work", json!({"parent_job_id": 999}))}),
    )
    .unwrap_err();
    assert_eq!(err.code, INVALID_STATE);
}

#[test]
fn completing_the_last_child_rolls_tokens_up_and_wakes_the_parent() {
    let b = brain("jobs-parent");
    let parent = add(&b, "parent", json!({}));
    let child = add(&b, "work", json!({"parent_job_id": parent}));
    assert_eq!(job(&b, parent)["status"], "waiting-children");
    assert_eq!(job(&b, child)["depth"], 1);
    assert!(claim(&b, "w:1").is_some());
    assert!(
        b.complete_job(child, "w:other", None).unwrap().is_none(),
        "a stale token completes nothing"
    );
    let done = b
        .complete_job(child, "w:1", Some(&json!({"ok": true})))
        .unwrap()
        .unwrap();
    assert_eq!(done["status"], "completed");
    assert_eq!(done["result"], json!({"ok": true}));
    assert_eq!(job(&b, parent)["status"], "waiting");
}

#[test]
fn a_lease_renews_only_for_its_token_and_an_expired_one_is_reclaimed() {
    let b = brain("jobs-lease");
    let id = add(&b, "work", json!({"max_stalled": 2}));
    assert!(claim(&b, "w:1").is_some());
    assert!(b.renew_job_lease(id, "w:1", 1000.0).unwrap());
    assert!(!b.renew_job_lease(id, "w:2", 1000.0).unwrap());
    b.clock.advance(2_000_000);
    let swept = b.reclaim_stalled_jobs(0.0, MARK).unwrap();
    assert_eq!(swept["requeued"].as_array().unwrap().len(), 1);
    assert_eq!(job(&b, id)["stalled_counter"], 1);
    assert!(claim(&b, "w:1").is_some());
    b.clock.advance(60_000_000);
    let swept = b.reclaim_stalled_jobs(0.0, MARK).unwrap();
    assert_eq!(swept["dead"].as_array().unwrap().len(), 1);
    assert_eq!(job(&b, id)["status"], "dead");
}

#[test]
fn list_jobs_filters_and_orders_newest_first() {
    let b = brain("jobs-list");
    let a = add(&b, "work", json!({}));
    b.clock.advance(1);
    let c = add(&b, "other", json!({}));
    let ids = |f: Value| -> Vec<i64> {
        let f: ListFilter = serde_json::from_value(f).unwrap();
        b.list_jobs(&f)
            .unwrap()
            .iter()
            .map(|r| r["id"].as_i64().unwrap())
            .collect()
    };
    assert_eq!(ids(json!({})), vec![c, a]);
    assert_eq!(ids(json!({"name": "work"})), vec![a]);
    assert_eq!(ids(json!({"limit": 1, "offset": 1})), vec![a]);
}

/// Postgres refuses a NUL byte in text, and the claim index uses it as the queue separator: a queue named
/// `default\0private` must not be admitted, or a worker on `default` would claim its job.
#[test]
fn a_queue_name_with_a_nul_byte_is_refused_and_never_claimed_by_another_queue() {
    let b = brain("jobs-queue-nul");
    let err = admit(
        &b,
        json!({ "insert": insert("work", json!({ "queue": "default\u{0}private" })) }),
    )
    .expect_err("a NUL in the queue name refuses");
    assert_eq!(err.code, "constraint_violation");
    assert!(claim(&b, "w:1").is_none(), "nothing was admitted to claim");
    let id = add(&b, "work", json!({}));
    assert_eq!(claim(&b, "w:2").unwrap()["id"], id);
}

/// `tokens_input` is an `INTEGER`: a roll-up that overflows it fails the completion (as the SQL `+` does)
/// rather than wrapping to a negative count in a release build.
#[test]
fn a_token_roll_up_that_overflows_an_integer_refuses_the_completion() {
    let b = brain("jobs-token-overflow");
    let parent = add(&b, "parent", json!({}));
    let kids: Vec<i64> = (0..2)
        .map(|_| add(&b, "work", json!({ "parent_job_id": parent })))
        .collect();
    for (n, kid) in kids.iter().enumerate() {
        let token = format!("w:{n}");
        assert!(claim(&b, &token).is_some());
        let delta = TokenDelta {
            input: 1_500_000_000,
            output: 0,
            cache_read: 0,
        };
        assert!(b.add_job_tokens(*kid, &token, &delta).unwrap());
    }
    assert!(b.complete_job(kids[0], "w:0", None).unwrap().is_some());
    assert_eq!(job(&b, parent)["tokens_input"], 1_500_000_000);
    let err = b
        .complete_job(kids[1], "w:1", None)
        .expect_err("the roll-up overflows");
    assert_eq!(err.code, "invalid_argument");
    assert_eq!(
        job(&b, kids[1])["status"],
        "active",
        "the refused completion wrote nothing"
    );
    assert_eq!(job(&b, parent)["tokens_input"], 1_500_000_000);
}
