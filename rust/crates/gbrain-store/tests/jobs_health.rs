//! Jobs: the queue health reads (`engine-sql/jobs-health.ts`), at exact clock readings: the strict
//! and inclusive edges of each window and lock, the rounding of an age, the bytewise ties and the
//! phase of a dead subagent's key.

mod memory_env;

use gbrain_store::jobs::{AdmitSpec, ClaimSpec, DivergenceSpec, HealthSpec};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const SEC: i64 = 1_000_000;
const HOUR: i64 = 3_600 * SEC;

fn add(b: &Brain, name: &str, extra: Value) -> i64 {
    let mut insert = json!({
        "name": name, "queue": "default", "status": "waiting", "priority": 0, "data": {},
        "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000,
        "backoff_jitter": 0.2, "on_child_fail": "fail_parent", "remove_on_complete": false,
        "remove_on_fail": false, "submission_authority": {"version": 1, "kind": "application"},
    });
    for (k, v) in extra.as_object().unwrap() {
        insert[k] = v.clone();
    }
    let spec: AdmitSpec =
        serde_json::from_value(json!({ "insert": insert, "maxSpawnDepth": 5 })).unwrap();
    let out = b.admit_job(&spec).unwrap();
    assert_eq!(out.outcome, "inserted");
    out.row["id"].as_i64().unwrap()
}

/// Claims the oldest waiting `name` job of `queue` for `ms` milliseconds under `token`.
fn claim(b: &Brain, token: &str, queue: &str, name: &str, ms: i64) -> i64 {
    let spec: ClaimSpec = serde_json::from_value(json!({
        "lockToken": token, "lockDurationMs": ms, "queue": queue, "names": [name],
        "suspectMark": "watchdog_suspect", "handlerTimeouts": {}, "handlerLockDurations": {},
        "legacySpend": {"groupId": "00000000-0000-4000-8000-000000000001", "capUsd": 5},
    }))
    .unwrap();
    b.claim_next_job(&spec).unwrap().unwrap()["id"]
        .as_i64()
        .unwrap()
}

fn ended(b: &Brain, name: &str, status: &str, text: &str, extra: Value) -> i64 {
    add(b, name, extra);
    let token = format!("end:{text}");
    let id = claim(b, &token, "default", name, 30_000);
    b.fail_job(id, &token, text, status, None, None)
        .unwrap()
        .unwrap();
    id
}

fn spec(threshold: f64, old: f64, window: f64, stalled: f64) -> HealthSpec {
    serde_json::from_value(json!({
        "waitingThreshold": threshold, "oldWaitingHours": old, "windowHours": window,
        "stalledAfterHours": stalled,
    }))
    .unwrap()
}

#[test]
fn stalled_forever_is_strictly_older_than_the_cutoff_and_lists_five_with_the_full_total() {
    let b = brain("jobs_health");
    for i in 0..7 {
        add(&b, &format!("job-{i}"), json!({}));
        claim(&b, &format!("t{i}"), "default", &format!("job-{i}"), 30_000);
        b.clock.advance(SEC);
    }
    // job-0 started 7 s ago, job-6 1 s ago.
    let at = |hours: f64| {
        b.read_queue_health_signals(&spec(1e9, 1e9, 24.0, hours))
            .unwrap()["stalled"]
            .clone()
    };
    let exactly_job_0 = 7.0 / 3600.0;
    assert_eq!(
        at(exactly_job_0),
        json!([]),
        "started_at < now - h is strict"
    );
    let listed = at(6.5 / 3600.0);
    assert_eq!(listed, json!([{"id": 1, "name": "job-0", "total": 1}]));
    let many = at(0.0);
    assert_eq!(many.as_array().unwrap().len(), 5);
    assert_eq!(many[0], json!({"id": 1, "name": "job-0", "total": 7}));
    assert_eq!(many[4]["id"], 5);
}

#[test]
fn depth_is_strictly_above_the_threshold_and_ties_break_bytewise() {
    let b = brain("jobs_health");
    for (name, n) in [("alpha", 2), ("Zed", 2), ("one", 1)] {
        for _ in 0..n {
            add(&b, name, json!({}));
        }
    }
    let depth = |t: f64| {
        b.read_queue_health_signals(&spec(t, 1e9, 24.0, 1.0))
            .unwrap()["depth"]
            .clone()
    };
    assert_eq!(
        depth(1.0),
        json!([
            {"name": "Zed", "queue": "default", "depth": 2},
            {"name": "alpha", "queue": "default", "depth": 2},
        ])
    );
    assert_eq!(depth(2.0), json!([]));
    assert_eq!(
        depth(1.5).as_array().unwrap().len(),
        2,
        "a fractional threshold compares as a number"
    );
    assert_eq!(depth(0.0).as_array().unwrap().len(), 3);
}

#[test]
fn old_embed_backfill_rounds_the_age_and_orders_oldest_first() {
    let b = brain("jobs_health");
    add(&b, "embed-backfill", json!({"queue": "q-a"}));
    b.clock.advance(500_000);
    add(&b, "embed-backfill", json!({"queue": "q-b"}));
    add(&b, "embed-backfill", json!({"queue": "q-b"}));
    add(&b, "sync", json!({"queue": "q-c"}));
    b.clock.advance(2 * SEC);
    // q-a is 2.5 s old (rounds to 3), q-b 2 s; `sync` is not an embed-backfill.
    let rows = |old: f64| {
        b.read_queue_health_signals(&spec(1e9, old, 24.0, 1.0))
            .unwrap()["old_embed_backfill"]
            .clone()
    };
    assert_eq!(
        rows(0.0),
        json!([
            {"name": "embed-backfill", "queue": "q-a", "depth": 1, "oldest_age_seconds": 3},
            {"name": "embed-backfill", "queue": "q-b", "depth": 2, "oldest_age_seconds": 2},
        ])
    );
    // 2.25 s: only q-a (2.5 s) is older; q-b (2 s) is not.
    assert_eq!(rows(2.25 / 3600.0).as_array().unwrap().len(), 1);
    assert_eq!(b.read_oldest_waiting_age("q-a").unwrap(), Some(3));
    assert_eq!(b.read_oldest_waiting_age("q-b").unwrap(), Some(2));
    assert_eq!(b.read_oldest_waiting_age("nope").unwrap(), None);
    let waiting = b.list_waiting_by_queue().unwrap();
    assert_eq!(
        waiting[0],
        json!({"queue": "q-b", "depth": 2, "oldest_age_seconds": 2})
    );
    assert_eq!(waiting.as_array().unwrap().len(), 3);
}

#[test]
fn watchdog_kills_and_prompt_too_long_count_inside_a_strict_window() {
    let b = brain("jobs_health");
    ended(&b, "a", "dead", "aborted: watchdog", json!({}));
    ended(&b, "b", "failed", "aborted: watchdog", json!({}));
    ended(&b, "c", "dead", "aborted: watchdog!", json!({}));
    let keys = [
        ("dream:patterns:x", "patterns"),
        ("dream:synthesize:x", "synthesize"),
        ("dream:synth", "synthesize"),
        ("dream:other", "other"),
    ];
    for (key, _) in keys {
        ended(
            &b,
            "subagent",
            "dead",
            "prompt_too_long: x",
            json!({"idempotency_key": key}),
        );
    }
    ended(
        &b,
        "subagent",
        "dead",
        "prompt_too_long: kept",
        json!({"data": {"__released_idempotency_key": "dream:patterns:r"}}),
    );
    ended(&b, "subagent", "dead", "prompt_too_long: none", json!({}));
    ended(
        &b,
        "subagent",
        "dead",
        "promptXtooXlong: wildcard",
        json!({}),
    );
    ended(&b, "subagent", "dead", "prompt_too_longer", json!({}));
    ended(
        &b,
        "subagent",
        "failed",
        "prompt_too_long: failed",
        json!({"idempotency_key": "dream:patterns:f"}),
    );
    ended(&b, "other", "dead", "prompt_too_long: name", json!({}));
    let read = |window: f64| {
        b.read_queue_health_signals(&spec(1e9, 1e9, window, 1.0))
            .unwrap()
    };
    let all = read(24.0);
    assert_eq!(all["rss_kills"], 2);
    assert_eq!(
        all["prompt_too_long"],
        json!([
            {"phase": "other", "cnt": 3},
            {"phase": "patterns", "cnt": 2},
            {"phase": "synthesize", "cnt": 2},
        ])
    );
    // Every row finished at the same reading, so a window of exactly 1 h excludes them an hour later.
    b.clock.advance(HOUR);
    assert_eq!(
        read(1.0)["rss_kills"],
        0,
        "finished_at > now - window is strict"
    );
    assert_eq!(read(1.0)["prompt_too_long"], json!([]));
    assert_eq!(read(1.5)["rss_kills"], 2);
}

#[test]
fn divergence_counts_per_waiting_name_and_ttl_cancellations_inside_the_window() {
    let b = brain("jobs_health");
    for _ in 0..2 {
        add(&b, "alpha", json!({}));
        let id = claim(&b, "d", "default", "alpha", 30_000);
        b.complete_job(id, "d", None).unwrap();
    }
    add(&b, "alpha", json!({}));
    add(&b, "Beta", json!({}));
    add(
        &b,
        "later",
        json!({"status": "delayed", "delay_until": "2099-01-01T00:00:00Z"}),
    );
    let c1 = add(&b, "Beta", json!({}));
    let c2 = add(&b, "Beta", json!({}));
    let c3 = add(&b, "Beta", json!({}));
    let cancel = |id: i64, reason: Value| {
        let opts = serde_json::from_value(json!({ "reason": reason })).unwrap();
        b.cancel_jobs(&[id], &opts).unwrap();
    };
    cancel(c1, json!("waiting_ttl_expired: waited > 1h"));
    cancel(c2, json!("waitingXttlXexpired: wildcard"));
    cancel(c3, json!("by hand"));
    let read = |window: f64| -> Value {
        let spec: DivergenceSpec = serde_json::from_value(
            json!({ "windowHours": window, "ttlReasonPrefix": "waiting_ttl_expired" }),
        )
        .unwrap();
        b.read_queue_divergence(&spec).unwrap()
    };
    assert_eq!(
        read(24.0),
        json!({
            "divergence": [
                {"name": "Beta", "intake": 4, "completed": 0, "waiting": 1},
                {"name": "alpha", "intake": 3, "completed": 2, "waiting": 1},
            ],
            "ttl_cancelled": [{"name": "Beta", "count": 2}],
        })
    );
    b.clock.advance(HOUR);
    let later = read(1.0);
    assert_eq!(
        later["divergence"][0],
        json!({"name": "Beta", "intake": 0, "completed": 0, "waiting": 1})
    );
    assert_eq!(later["ttl_cancelled"], json!([]));
}

#[test]
fn wedge_rows_treat_a_lock_expiring_exactly_now_as_neither_live_nor_stalled() {
    let b = brain("jobs_health");
    add(&b, "live", json!({}));
    claim(&b, "l", "default", "live", 60_000);
    add(&b, "edge", json!({}));
    claim(&b, "e", "default", "edge", 10_000);
    add(&b, "lapsed", json!({}));
    claim(&b, "p", "default", "lapsed", 5_000);
    add(&b, "work", json!({}));
    add(
        &b,
        "due",
        json!({"status": "delayed", "delay_until": "2027-01-15T08:00:10Z"}),
    );
    add(
        &b,
        "late",
        json!({"status": "delayed", "delay_until": "2027-01-15T08:00:11Z"}),
    );
    add(&b, "done", json!({}));
    let id = claim(&b, "d", "default", "done", 30_000);
    b.complete_job(id, "d", None).unwrap();
    b.clock.advance(10 * SEC);
    let names: Vec<String> = ["work", "due", "late", "done", "lapsed"]
        .map(String::from)
        .to_vec();
    let s = b.read_wedge_signals("default", &names).unwrap();
    assert_eq!(
        s["stalled"], 1,
        "only the 5 s lock has lapsed; the 10 s one expires exactly now"
    );
    assert_eq!(s["activeHealthy"], 1);
    assert_eq!(s["waiting"], 1);
    assert_eq!(
        s["waitingClaimable"], 2,
        "a waiting job of a handled name, and a delayed job due exactly now"
    );
    assert_eq!(s["lastCompleted"], "2027-01-15T08:00:00.000000Z");
    assert_eq!(s["lastCompletedClaimable"], s["lastCompleted"]);
    let other = b
        .read_wedge_signals("default", &["nothing".to_string()])
        .unwrap();
    assert_eq!(other["waitingClaimable"], 0);
    assert_eq!(other["lastCompletedClaimable"], Value::Null);
    let empty = b.read_wedge_signals("no-such-queue", &names).unwrap();
    assert_eq!(
        empty,
        json!({"stalled": 0, "activeHealthy": 0, "waiting": 0, "waitingClaimable": 0, "lastCompleted": null, "lastCompletedClaimable": null})
    );

    let rows = b.list_queue_wedge_counts().unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["active_healthy"], 1);
    assert_eq!(rows[0]["waiting"], 1);
    assert_eq!(rows[0]["mins_since_completion"], 10.0 / 60.0);
}

#[test]
fn wedge_counts_leave_private_queues_out_and_private_health_reads_them() {
    let b = brain("jobs_health");
    add(
        &b,
        "m",
        json!({"queue": "dream-inline-1-aaaa", "data": {"source_id": "src-b"}}),
    );
    b.clock.advance(60 * SEC);
    add(
        &b,
        "m",
        json!({"queue": "dream-inline-1-aaaa", "status": "delayed", "delay_until": "2099-01-01T00:00:00Z", "data": {"source_id": "Src-C"}}),
    );
    add(
        &b,
        "m",
        json!({"queue": "dream-inline-1-aaaa", "data": {"source_id": null}}),
    );
    add(
        &b,
        "m",
        json!({"queue": "dream-inline-1-aaaa", "data": {"source_id": 7}}),
    );
    add(&b, "m", json!({"queue": "dream-inline-2-bbbb"}));
    let paused = add(&b, "m", json!({"queue": "dream-inline-2-bbbb"}));
    b.pause_job(paused).unwrap();
    add(&b, "work", json!({}));
    b.clock.advance(120 * SEC);
    let rows = b.list_queue_wedge_counts().unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["queue"], "default");
    let health = b.list_private_queue_health().unwrap();
    assert_eq!(health[0]["queue"], "dream-inline-1-aaaa");
    assert_eq!(
        health[0]["source_id"], "7",
        "bytewise minimum of the ->> texts: '7' < 'Src-C' < 'src-b'"
    );
    assert_eq!(health[0]["waiting"], 4);
    assert_eq!(health[0]["oldest_waiting_minutes"], 3.0);
    assert_eq!(health[0]["birth_epoch_ms"], 1_800_000_000_000.0_f64);
    assert_eq!(health[1]["queue"], "dream-inline-2-bbbb");
    assert_eq!(health[1]["source_id"], Value::Null);
    assert_eq!(health[1]["paused"], 1);
    assert_eq!(health[1]["waiting"], 1);
    assert_eq!(health[1]["oldest_waiting_minutes"], 2.0);
}

#[test]
fn stuck_active_jobs_are_a_lapsed_lock_or_two_stalls_and_order_by_count_then_name() {
    let b = brain("jobs_health");
    // `twice`: two stalls (each reclaim requeues it), then a live claim.
    add(&b, "twice", json!({"max_stalled": 5}));
    claim(&b, "t1", "default", "twice", 1_000);
    b.clock.advance(2 * SEC);
    b.reclaim_stalled_jobs(0.0, "watchdog_suspect").unwrap();
    claim(&b, "t2", "default", "twice", 1_000);
    b.clock.advance(2 * SEC);
    b.reclaim_stalled_jobs(0.0, "watchdog_suspect").unwrap();
    claim(&b, "t3", "default", "twice", 60_000);
    for (name, token) in [
        ("work", "w1"),
        ("work", "w2"),
        ("Alpha", "a1"),
        ("Alpha", "a2"),
    ] {
        add(&b, name, json!({}));
        claim(&b, token, "default", name, 1_000);
    }
    add(&b, "fine", json!({}));
    claim(&b, "f1", "default", "fine", 60_000);
    add(&b, "waiting-one", json!({}));
    b.clock.advance(2 * SEC);
    assert_eq!(
        b.list_stuck_active_jobs_by_name().unwrap(),
        json!([{"name": "Alpha", "n": 2}, {"name": "work", "n": 2}, {"name": "twice", "n": 1}])
    );
}
