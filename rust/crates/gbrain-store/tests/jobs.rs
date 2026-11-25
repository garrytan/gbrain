//! Minion jobs: admission, claim, lease, finish and the stall sweep, matched to the PGLite engine.
//!
//! Every test holds in both store modes and runs in both: `<name>_single` on one writer at a time,
//! `<name>_optimistic` on optimistic transactions (`memory_env::brain_in`, which keeps the injected clock).

mod memory_env;

use gbrain_store::error::{ADMISSION_REFUSED, INVALID_STATE};
use gbrain_store::jobs::{AdmitSpec, ClaimSpec, ListFilter, TokenDelta};
use memory_env::{Brain, StoreMode, both_modes, brain_in};
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

fn admit(
    b: &gbrain_store::Store,
    spec: Value,
) -> gbrain_store::Result<gbrain_store::jobs::AdmitOutcome> {
    let mut spec = spec;
    if spec.get("maxSpawnDepth").is_none() {
        spec["maxSpawnDepth"] = json!(5);
    }
    let spec: AdmitSpec = serde_json::from_value(spec).unwrap();
    b.admit_job(&spec)
}

fn add(b: &gbrain_store::Store, name: &str, extra: Value) -> i64 {
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
fn many_workers_with_jobs_arriving_claim_and_complete_each_job_once(mode: StoreMode) {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};
    for workers in [4usize, 16, 64] {
        let b = brain_in("jobs-arrivals", mode);
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
        if let Some(stats) = b.occ_stats() {
            eprintln!(
                "{workers} workers: {} commits, {} conflicts, hot keys {:?}",
                stats.commits,
                stats.conflicts,
                stats.hot_keys.iter().take(3).collect::<Vec<_>>()
            );
        }
    }
}

fn two_workers_claiming_at_once_never_get_the_same_job(mode: StoreMode) {
    let b = brain_in("jobs-race", mode);
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

fn an_idempotency_key_coalesces_and_a_dead_holder_releases_it(mode: StoreMode) {
    let b = brain_in("jobs-key", mode);
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
    assert_eq!(
        b.job_data_by_idempotency_key("k1").unwrap(),
        Some(json!({"data": {}})),
        "a dead row still holds its key until a new admission releases it"
    );
    let second = add(
        &b,
        "work",
        json!({"idempotency_key": "k1", "data": {"slug": "a/b"}}),
    );
    assert_ne!(second, first);
    assert_eq!(
        b.job_data_by_idempotency_key("k1").unwrap(),
        Some(json!({"data": {"slug": "a/b"}}))
    );
    assert_eq!(b.job_data_by_idempotency_key("k2").unwrap(), None);
    let freed = job(&b, first);
    assert_eq!(freed["idempotency_key"], Value::Null);
    assert_eq!(freed["data"]["__released_idempotency_key"], "k1");
}

fn quota_backpressure_and_parent_checks_refuse_or_coalesce(mode: StoreMode) {
    let b = brain_in("jobs-admit", mode);
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

fn completing_the_last_child_rolls_tokens_up_and_wakes_the_parent(mode: StoreMode) {
    let b = brain_in("jobs-parent", mode);
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

fn a_lease_renews_only_for_its_token_and_an_expired_one_is_reclaimed(mode: StoreMode) {
    let b = brain_in("jobs-lease", mode);
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

fn list_jobs_filters_and_orders_newest_first(mode: StoreMode) {
    let b = brain_in("jobs-list", mode);
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

fn a_capacity_probe_answers_a_coalesce_or_capacity_and_writes_nothing(mode: StoreMode) {
    let b = brain_in("jobs-capacity-probe", mode);
    let probe = |extra: Value, more: Value| {
        let mut spec = json!({"insert": insert("work", extra), "capacityCheck": true});
        for (k, v) in more.as_object().unwrap() {
            spec[k] = v.clone();
        }
        admit(&b, spec).unwrap()
    };
    // No row yet: the probe stops where the capacity check runs, before the quota, and inserts nothing.
    let fresh = probe(
        json!({"idempotency_key": "k1"}),
        json!({"quotaMaxWaiting": 0}),
    );
    assert_eq!(
        (fresh.outcome, fresh.row.clone()),
        ("capacity", Value::Null)
    );
    assert!(b.list_jobs(&ListFilter::default()).unwrap().is_empty());

    // A live row under the key coalesces exactly as a full admission does.
    let first = add(&b, "work", json!({"idempotency_key": "k1"}));
    let again = probe(json!({"idempotency_key": "k1"}), json!({}));
    assert_eq!(
        (again.outcome, again.row["id"].as_i64()),
        ("coalesced", Some(first))
    );

    // A dead holder is released by a full admission; the probe answers capacity and keeps no release.
    claim(&b, "w:1").unwrap();
    b.fail_job(first, "w:1", "boom", "dead", None, None)
        .unwrap()
        .unwrap();
    let released = probe(json!({"idempotency_key": "k1"}), json!({}));
    assert_eq!(released.outcome, "capacity");
    assert_eq!(job(&b, first)["idempotency_key"], "k1");
    assert_eq!(b.list_jobs(&ListFilter::default()).unwrap().len(), 1);
}

fn admit_job_runs_as_a_statement_of_an_open_transaction(mode: StoreMode) {
    let b = brain_in("jobs-admit-in-transaction", mode);
    let tx = b.begin_transaction(false).unwrap();
    // The probe and the admission run on the bound store; the probe keeps nothing.
    let probe = admit(
        &tx,
        json!({"insert": insert("work", json!({})), "capacityCheck": true}),
    )
    .unwrap();
    assert_eq!(probe.outcome, "capacity");
    let out = admit(&tx, json!({"insert": insert("work", json!({}))})).unwrap();
    assert_eq!(out.outcome, "inserted");
    let id = out.row["id"].as_i64().unwrap();
    assert_eq!(tx.list_jobs(&ListFilter::default()).unwrap().len(), 1);
    tx.commit_transaction().unwrap();
    assert_eq!(job(&b, id)["status"], "waiting");

    // A transaction that rolls back keeps no admitted job.
    let tx = b.begin_transaction(false).unwrap();
    add(&tx, "work", json!({}));
    tx.rollback_transaction().unwrap();
    assert_eq!(b.list_jobs(&ListFilter::default()).unwrap().len(), 1);
}

fn the_idempotency_key_step_alone_coalesces_frees_or_hands_back_a_conflict(mode: StoreMode) {
    let b = brain_in("jobs-key-alone", mode);
    let app = json!({"version": 1, "kind": "application"});
    let other = json!({"version": 1, "kind": "remote", "client": "c"});
    assert_eq!(
        b.coalesce_on_idempotency_key("k1", Some(&app)).unwrap(),
        json!({"outcome": "none"})
    );
    let first = add(&b, "work", json!({"idempotency_key": "k1"}));
    let out = b.coalesce_on_idempotency_key("k1", Some(&app)).unwrap();
    assert_eq!(
        (out["outcome"].as_str(), out["row"]["id"].as_i64()),
        (Some("coalesced"), Some(first))
    );
    // Another authority: handed back, nothing written; the key stays held.
    let out = b.coalesce_on_idempotency_key("k1", Some(&other)).unwrap();
    assert_eq!(
        (out["outcome"].as_str(), out["row"]["id"].as_i64()),
        (Some("conflict"), Some(first))
    );
    assert_eq!(job(&b, first)["idempotency_key"], "k1");
    // A dead holder frees its key, keeping it in its data, and the next read finds no row.
    claim(&b, "w:1").unwrap();
    b.fail_job(first, "w:1", "boom", "dead", None, None)
        .unwrap()
        .unwrap();
    assert_eq!(
        b.coalesce_on_idempotency_key("k1", Some(&app)).unwrap(),
        json!({"outcome": "released"})
    );
    let freed = job(&b, first);
    assert_eq!(freed["idempotency_key"], Value::Null);
    assert_eq!(freed["data"]["__released_idempotency_key"], "k1");
    assert_eq!(
        b.coalesce_on_idempotency_key("k1", Some(&app)).unwrap(),
        json!({"outcome": "none"})
    );
    let second = add(&b, "work", json!({"idempotency_key": "k1"}));
    assert_ne!(second, first);
}

fn a_released_key_is_kept_in_non_object_data_as_jsonb_concatenation_keeps_it(mode: StoreMode) {
    let b = brain_in("jobs-key-release-shapes", mode);
    let app = json!({"version": 1, "kind": "application"});
    for (n, data, want) in [
        (1, json!([]), json!([{"__released_idempotency_key": "a1"}])),
        (
            2,
            json!("text"),
            json!(["text", {"__released_idempotency_key": "a2"}]),
        ),
    ] {
        let key = format!("a{n}");
        let id = add(&b, "work", json!({"idempotency_key": key, "data": data}));
        claim(&b, &format!("w:{n}")).unwrap();
        b.fail_job(id, &format!("w:{n}"), "boom", "dead", None, None)
            .unwrap()
            .unwrap();
        assert_eq!(
            b.coalesce_on_idempotency_key(&key, Some(&app)).unwrap(),
            json!({"outcome": "released"})
        );
        assert_eq!(job(&b, id)["data"], want, "{key}");
    }
}

/// Postgres refuses a NUL byte in text, and the claim index uses it as the queue separator: a queue named
/// `default\0private` must not be admitted, or a worker on `default` would claim its job.
fn a_queue_name_with_a_nul_byte_is_refused_and_never_claimed_by_another_queue(mode: StoreMode) {
    let b = brain_in("jobs-queue-nul", mode);
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
fn a_token_roll_up_that_overflows_an_integer_refuses_the_completion(mode: StoreMode) {
    let b = brain_in("jobs-token-overflow", mode);
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

/// A job admitted on a store bound to a transaction is one statement of it (the facts backstop
/// effect queues its facts-absorb job inside the effect's transaction): it does not wait for a
/// second writer, it is seen inside the transaction, and a rollback keeps no row.
fn admit_inside_a_transaction_is_one_statement(mode: StoreMode) {
    let b = brain_in("jobs-in-tx", mode);
    let spec: AdmitSpec =
        serde_json::from_value(json!({ "insert": insert("work", json!({})), "maxSpawnDepth": 5 }))
            .unwrap();
    let tx = b.begin_transaction(false).unwrap();
    let out = tx.admit_job(&spec).unwrap();
    assert_eq!(out.outcome, "inserted");
    let id = out.row["id"].as_i64().unwrap();
    assert!(tx.get_job(id).unwrap().is_some());
    tx.rollback_transaction().unwrap();
    assert!(b.get_job(id).unwrap().is_none());

    let tx = b.begin_transaction(false).unwrap();
    let kept = tx.admit_job(&spec).unwrap().row["id"].as_i64().unwrap();
    // A rolled-back admission's id is not handed out again, as Postgres `nextval` never is.
    assert_ne!(kept, id);
    let depth = tx.savepoint().unwrap();
    let dropped = tx.admit_job(&spec).unwrap().row["id"].as_i64().unwrap();
    tx.rollback_savepoint(depth).unwrap();
    assert!(tx.get_job(dropped).unwrap().is_none());
    let after = tx.admit_job(&spec).unwrap().row["id"].as_i64().unwrap();
    assert!(after > dropped, "{after} after the dropped {dropped}");
    tx.commit_transaction().unwrap();
    assert_eq!(job(&b, kept)["status"], "waiting");
    assert_eq!(job(&b, after)["status"], "waiting");
    // Outside a transaction the sequence continues past every id handed out.
    assert!(add(&b, "work", json!({})) > after);
}

both_modes!(many_workers_with_jobs_arriving_claim_and_complete_each_job_once => many_workers_with_jobs_arriving_claim_and_complete_each_job_once_single, many_workers_with_jobs_arriving_claim_and_complete_each_job_once_optimistic);
both_modes!(two_workers_claiming_at_once_never_get_the_same_job => two_workers_claiming_at_once_never_get_the_same_job_single, two_workers_claiming_at_once_never_get_the_same_job_optimistic);
both_modes!(an_idempotency_key_coalesces_and_a_dead_holder_releases_it => an_idempotency_key_coalesces_and_a_dead_holder_releases_it_single, an_idempotency_key_coalesces_and_a_dead_holder_releases_it_optimistic);
both_modes!(quota_backpressure_and_parent_checks_refuse_or_coalesce => quota_backpressure_and_parent_checks_refuse_or_coalesce_single, quota_backpressure_and_parent_checks_refuse_or_coalesce_optimistic);
both_modes!(completing_the_last_child_rolls_tokens_up_and_wakes_the_parent => completing_the_last_child_rolls_tokens_up_and_wakes_the_parent_single, completing_the_last_child_rolls_tokens_up_and_wakes_the_parent_optimistic);
both_modes!(a_lease_renews_only_for_its_token_and_an_expired_one_is_reclaimed => a_lease_renews_only_for_its_token_and_an_expired_one_is_reclaimed_single, a_lease_renews_only_for_its_token_and_an_expired_one_is_reclaimed_optimistic);
both_modes!(list_jobs_filters_and_orders_newest_first => list_jobs_filters_and_orders_newest_first_single, list_jobs_filters_and_orders_newest_first_optimistic);
both_modes!(a_capacity_probe_answers_a_coalesce_or_capacity_and_writes_nothing => a_capacity_probe_answers_a_coalesce_or_capacity_and_writes_nothing_single, a_capacity_probe_answers_a_coalesce_or_capacity_and_writes_nothing_optimistic);
both_modes!(admit_job_runs_as_a_statement_of_an_open_transaction => admit_job_runs_as_a_statement_of_an_open_transaction_single, admit_job_runs_as_a_statement_of_an_open_transaction_optimistic);
both_modes!(the_idempotency_key_step_alone_coalesces_frees_or_hands_back_a_conflict => the_idempotency_key_step_alone_coalesces_frees_or_hands_back_a_conflict_single, the_idempotency_key_step_alone_coalesces_frees_or_hands_back_a_conflict_optimistic);
both_modes!(a_released_key_is_kept_in_non_object_data_as_jsonb_concatenation_keeps_it => a_released_key_is_kept_in_non_object_data_as_jsonb_concatenation_keeps_it_single, a_released_key_is_kept_in_non_object_data_as_jsonb_concatenation_keeps_it_optimistic);
both_modes!(a_queue_name_with_a_nul_byte_is_refused_and_never_claimed_by_another_queue => a_queue_name_with_a_nul_byte_is_refused_and_never_claimed_by_another_queue_single, a_queue_name_with_a_nul_byte_is_refused_and_never_claimed_by_another_queue_optimistic);
both_modes!(a_token_roll_up_that_overflows_an_integer_refuses_the_completion => a_token_roll_up_that_overflows_an_integer_refuses_the_completion_single, a_token_roll_up_that_overflows_an_integer_refuses_the_completion_optimistic);
both_modes!(admit_inside_a_transaction_is_one_statement => admit_inside_a_transaction_is_one_statement_single, admit_inside_a_transaction_is_one_statement_optimistic);
