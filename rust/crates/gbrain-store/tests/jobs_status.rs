//! Jobs: the status reads (`src/jobs/status.rs`), matched to `src/core/engine-sql/jobs-status.ts`.
//! The PGLite parity cases are in test/engine-parity/jobs-status.test.ts; these cross the windows by
//! moving the clock (hours, not the parity file's sleep), and cover the LIKE matcher's edges, a page
//! whose `compiled_truth` is NULL, a missing scope target and a minute boundary.

mod memory_env;

use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::jobs::{AdmitSpec, ClaimSpec, StatusFilter};
use gbrain_store::pages::{PageInput, PutPageOptions};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const SEC: i64 = 1_000_000;
const HOUR: i64 = 3_600 * SEC;
const DAY_S: f64 = 86_400.0;

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

fn add(b: &Brain, name: &str, extra: Value) -> i64 {
    let spec: AdmitSpec = serde_json::from_value(json!({
        "insert": insert(name, extra), "maxSpawnDepth": 5,
    }))
    .unwrap();
    let out = b.admit_job(&spec).unwrap();
    assert_eq!(out.outcome, "inserted");
    out.row["id"].as_i64().unwrap()
}

fn claim_spec(token: &str, queue: &str, name: &str, lock_ms: i64) -> ClaimSpec {
    serde_json::from_value(json!({
        "lockToken": token, "lockDurationMs": lock_ms, "queue": queue, "names": [name],
        "suspectMark": "watchdog_suspect", "handlerTimeouts": {}, "handlerLockDurations": {},
        "legacySpend": {"groupId": "00000000-0000-4000-8000-000000000001", "capUsd": 5},
    }))
    .unwrap()
}

/// Admit a job of `name` in `queue` and claim it for `token`: an `active` row.
fn active(b: &Brain, name: &str, queue: &str, data: Value, token: &str, lock_ms: i64) -> i64 {
    let id = add(b, name, json!({ "queue": queue, "data": data }));
    let row = b
        .claim_next_job(&claim_spec(token, queue, name, lock_ms))
        .unwrap()
        .expect("claimed");
    assert_eq!(row["id"].as_i64(), Some(id));
    id
}

fn finished(b: &Brain, name: &str, token: &str) -> i64 {
    finished_with(b, name, token, None)
}

fn finished_with(b: &Brain, name: &str, token: &str, result: Option<&Value>) -> i64 {
    let id = active(b, name, "default", json!({}), token, 30_000);
    b.complete_job(id, token, result).unwrap().unwrap();
    id
}

fn rows(v: Vec<Value>) -> Vec<(String, i64)> {
    v.iter()
        .map(|r| {
            let key = r.get("status").or_else(|| r.get("name")).unwrap();
            (
                key.as_str().unwrap().to_string(),
                r["count"].as_i64().unwrap(),
            )
        })
        .collect()
}

fn page(b: &Brain, slug: &str, source_body: Option<&str>) {
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": source_body.unwrap_or(""),
    }))
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({})).unwrap();
    b.put_page(slug, &input, &options).unwrap();
}

#[test]
fn the_newest_completed_autopilot_run_of_each_kind() {
    let b = brain("st-autopilot");
    assert_eq!(
        b.read_last_autopilot_cycles().unwrap(),
        json!({ "full": null, "targeted": null })
    );
    finished(&b, "autopilot-cycle", "w:1");
    b.clock.advance(HOUR);
    finished(&b, "autopilot-embed", "w:2");
    // A failed run and a name that only contains the prefix do not count.
    let dead = active(&b, "autopilot-cycle", "default", json!({}), "w:3", 30_000);
    b.fail_job(dead, "w:3", "boom", "dead", None, None)
        .unwrap()
        .unwrap();
    finished(&b, "my-autopilot-cycle", "w:4");
    let out = b.read_last_autopilot_cycles().unwrap();
    assert_eq!(out["full"]["name"], "autopilot-cycle");
    assert_eq!(out["targeted"]["name"], "autopilot-embed");
    assert_eq!(out["full"]["status"], "completed");

    // A name that only begins like the full cycle's is targeted, never the full run.
    b.clock.advance(HOUR);
    finished_with(
        &b,
        "autopilot-cycle-2",
        "w:5",
        Some(&json!({ "n": "prefix" })),
    );
    let out = b.read_last_autopilot_cycles().unwrap();
    assert_eq!(out["full"]["name"], "autopilot-cycle");
    assert_eq!(out["targeted"]["result"], json!({ "n": "prefix" }));
}

#[test]
fn equal_finish_times_go_to_the_larger_id() {
    let b = brain("st-autopilot-tie");
    // The clock does not move, so both finish at the same instant.
    finished_with(&b, "autopilot-cycle", "w:1", Some(&json!({ "n": 1 })));
    finished_with(&b, "autopilot-cycle", "w:2", Some(&json!({ "n": 2 })));
    finished_with(&b, "autopilot-extract", "w:3", Some(&json!({ "n": 3 })));
    let out = b.read_last_autopilot_cycles().unwrap();
    assert_eq!(out["full"]["result"], json!({ "n": 2 }));
    assert_eq!(out["targeted"]["result"], json!({ "n": 3 }));
}

#[test]
fn counts_by_status_filter_and_an_empty_status_list() {
    let b = brain("st-counts");
    assert!(
        b.count_jobs_by_status(&StatusFilter::default())
            .unwrap()
            .is_empty()
    );
    finished(&b, "work", "w:1");
    add(&b, "work", json!({}));
    add(&b, "work", json!({ "queue": "late" }));
    add(&b, "other", json!({}));
    let all = rows(b.count_jobs_by_status(&StatusFilter::default()).unwrap());
    assert_eq!(all, vec![("completed".into(), 1), ("waiting".into(), 3)]);
    let work = StatusFilter {
        name: Some("work".into()),
        queue: Some("late".into()),
        statuses: Some(vec!["waiting".into(), "waiting".into(), "active".into()]),
    };
    assert_eq!(
        rows(b.count_jobs_by_status(&work).unwrap()),
        vec![("waiting".into(), 1)]
    );
    let none = StatusFilter {
        statuses: Some(vec![]),
        ..StatusFilter::default()
    };
    assert!(b.count_jobs_by_status(&none).unwrap().is_empty());
}

#[test]
fn queue_depths_round_the_oldest_age_to_seconds_and_break_ties_by_name() {
    let b = brain("st-depths");
    add(&b, "work", json!({ "queue": "b" }));
    add(&b, "work", json!({ "queue": "a" }));
    add(&b, "work", json!({ "queue": "c" }));
    add(&b, "work", json!({ "queue": "c" }));
    b.clock.advance(1_500_000);
    let out = b.read_waiting_queue_depths().unwrap();
    let got: Vec<(&str, i64, i64)> = out
        .iter()
        .map(|r| {
            (
                r["queue"].as_str().unwrap(),
                r["depth"].as_i64().unwrap(),
                r["oldest_waiting_age_seconds"].as_i64().unwrap(),
            )
        })
        .collect();
    // 1.5 s rounds to 2; 1.499999 s would round to 1.
    assert_eq!(got, vec![("c", 2, 2), ("a", 1, 2), ("b", 1, 2)]);
}

#[test]
fn the_last_completed_time_is_the_freshest_updated_at() {
    let b = brain("st-last");
    assert_eq!(b.read_last_completed_job_at().unwrap(), Value::Null);
    finished(&b, "work", "w:1");
    b.clock.advance(HOUR);
    finished(&b, "work", "w:2");
    let at = b.read_last_completed_job_at().unwrap();
    assert!(at.as_str().unwrap().starts_with("2027-01-15T09:"), "{at}");
}

#[test]
fn ttl_cancellations_match_like_and_age_out_of_the_window() {
    let b = brain("st-ttl");
    let cancel = |name: &str, reason: &str| {
        let id = add(&b, name, json!({}));
        b.cancel_jobs(
            &[id],
            &serde_json::from_value(json!({ "reason": reason })).unwrap(),
        )
        .unwrap();
    };
    cancel("old", "waiting_ttl_expired: a");
    b.clock.advance(23 * HOUR);
    cancel("sync", "waiting_ttl_expired: b");
    cancel("sync", "waiting_ttl_expired: c");
    cancel("sync", "waitingXttlXexpired: d");
    cancel("sync", "WAITING_TTL_EXPIRED: e");
    cancel("sync", "other reason");
    let like = "waiting_ttl_expired%";
    assert_eq!(
        rows(b.count_ttl_cancelled_by_name(like, DAY_S).unwrap()),
        vec![("sync".into(), 3), ("old".into(), 1)]
    );
    // Two hours later the first one is outside the day.
    b.clock.advance(2 * HOUR);
    assert_eq!(
        rows(b.count_ttl_cancelled_by_name(like, DAY_S).unwrap()),
        vec![("sync".into(), 3)]
    );
    assert_eq!(
        rows(
            b.count_ttl_cancelled_by_name("waiting\\_ttl\\_expired%", DAY_S)
                .unwrap()
        ),
        vec![("sync".into(), 2)]
    );
    assert!(b.count_ttl_cancelled_by_name(like, 0.0).unwrap().is_empty());
    let err = b.count_ttl_cancelled_by_name("oops\\", DAY_S).unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

#[test]
fn the_waiting_scope_state_needs_its_target_and_a_live_lease() {
    let b = brain("st-scope");
    // No such job: one answer, nothing counted.
    assert_eq!(
        b.read_waiting_scope_state("sync", "default", 99).unwrap(),
        json!({ "waiting": 0, "live_id": null, "age_min": null })
    );
    let target = active(
        &b,
        "sync",
        "default",
        json!({ "sourceId": "s1" }),
        "w:1",
        3 * HOUR / 1000,
    );
    add(&b, "sync", json!({ "data": { "source_id": "s1" } }));
    add(&b, "sync", json!({ "data": { "sourceId": "s2" } }));
    add(
        &b,
        "sync",
        json!({ "queue": "late", "data": { "sourceId": "s1" } }),
    );
    // The name and queue must be the target's.
    assert_eq!(
        b.read_waiting_scope_state("sync", "late", target).unwrap(),
        json!({ "waiting": 0, "live_id": null, "age_min": null })
    );
    b.clock.advance(59 * SEC + 999_999);
    assert_eq!(
        b.read_waiting_scope_state("sync", "default", target)
            .unwrap(),
        json!({ "waiting": 1, "live_id": target, "age_min": 0 })
    );
    b.clock.advance(1);
    assert_eq!(
        b.read_waiting_scope_state("sync", "default", target)
            .unwrap()["age_min"],
        1
    );
    // Past its lease the job is no longer live.
    b.clock.advance(4 * HOUR);
    assert_eq!(
        b.read_waiting_scope_state("sync", "default", target)
            .unwrap(),
        json!({ "waiting": 1, "live_id": null, "age_min": null })
    );
}

#[test]
fn a_target_without_a_scope_counts_the_waiting_jobs_without_one() {
    let b = brain("st-noscope");
    let target = active(&b, "sync", "default", json!({}), "w:1", 30_000);
    add(&b, "sync", json!({}));
    add(&b, "sync", json!({ "data": { "sourceId": "s1" } }));
    assert_eq!(
        b.read_waiting_scope_state("sync", "default", target)
            .unwrap()["waiting"],
        1
    );
}

#[test]
fn recent_completions_and_failures_age_out_of_the_window() {
    let b = brain("st-recent");
    finished(&b, "subagent", "w:1");
    let dead = active(&b, "work", "default", json!({}), "w:2", 30_000);
    b.fail_job(dead, "w:2", "first", "dead", None, None)
        .unwrap()
        .unwrap();
    b.clock.advance(HOUR);
    finished(&b, "subagent", "w:3");
    finished(&b, "other", "w:4");
    let failed = active(&b, "work", "default", json!({}), "w:5", 30_000);
    b.fail_job(failed, "w:5", "second", "failed", None, None)
        .unwrap()
        .unwrap();
    assert_eq!(
        b.count_recent_completed_jobs("subagent", 3600.0).unwrap(),
        1
    );
    assert_eq!(
        b.count_recent_completed_jobs("subagent", 7200.0).unwrap(),
        2
    );
    assert_eq!(b.count_recent_completed_jobs("subagent", 0.0).unwrap(), 0);
    let errors = b.list_recent_failed_job_errors(1800.0).unwrap();
    assert_eq!(
        errors,
        vec![json!({ "id": failed, "last_error": "second" })]
    );
    let errors = b.list_recent_failed_job_errors(DAY_S).unwrap();
    assert_eq!(
        errors,
        vec![
            json!({ "id": dead, "last_error": "first" }),
            json!({ "id": failed, "last_error": "second" })
        ]
    );
}

#[test]
fn queued_page_chars_cap_each_page_and_count_a_null_text_as_the_cap() {
    let b = brain("st-chars");
    let read = |max: i64| b.read_queued_page_chars("drain", "facts", max).unwrap();
    assert_eq!(read(100), Value::Null);
    page(&b, "short", Some(&"é".repeat(40)));
    page(&b, "long", Some(&"x".repeat(300)));
    add(
        &b,
        "drain",
        json!({ "queue": "facts", "data": { "slug": "short" } }),
    );
    add(
        &b,
        "drain",
        json!({ "queue": "facts", "data": { "slug": "long", "sourceId": "default" } }),
    );
    // No slug, a page that does not exist, another queue: none of them join.
    add(&b, "drain", json!({ "queue": "facts", "data": {} }));
    add(
        &b,
        "drain",
        json!({ "queue": "facts", "data": { "slug": "ghost" } }),
    );
    add(
        &b,
        "drain",
        json!({ "queue": "other", "data": { "slug": "long" } }),
    );
    assert_eq!(read(100), json!(70.0));
    assert_eq!(read(1000), json!(170.0));
    // A page with no text (a segmented shell) counts as the cap.
    let shell = serde_json::from_value(json!({ "type": "note", "title": "shell" })).unwrap();
    b.create_segmented_page_shell(
        "shell",
        &shell,
        &serde_json::from_value(json!({ "sourceId": "default" })).unwrap(),
    )
    .unwrap();
    add(
        &b,
        "drain",
        json!({ "queue": "facts", "data": { "slug": "shell" } }),
    );
    assert_eq!(read(90), json!((40.0 + 90.0 + 90.0) / 3.0));
}

#[test]
fn source_job_counts_follow_the_window_and_the_status_groups() {
    let b = brain("st-sources");
    let dead = active(
        &b,
        "sync",
        "default",
        json!({ "sourceId": "s1" }),
        "w:1",
        30_000,
    );
    b.fail_job(dead, "w:1", "boom", "dead", None, None)
        .unwrap()
        .unwrap();
    // Claimed before the waiting backfill jobs exist: a claim takes the oldest waiting job of its name.
    active(
        &b,
        "embed-backfill",
        "default",
        json!({ "sourceId": "s2" }),
        "w:2",
        30_000,
    );
    b.clock.advance(23 * HOUR);
    add(&b, "sync", json!({ "data": { "sourceId": "s1" } }));
    add(
        &b,
        "embed-backfill",
        json!({ "data": { "sourceId": "s1" } }),
    );
    add(&b, "embed-backfill", json!({ "data": { "sourceId": "" } }));
    add(&b, "embed-backfill", json!({ "data": {} }));
    add(&b, "work", json!({ "data": { "sourceId": "s1" } }));
    let count = |sid: &str, key: &str| {
        let out = b.read_source_job_counts(DAY_S).unwrap();
        out.iter()
            .find(|r| r["source_id"] == sid)
            .map(|r| r[key].as_i64().unwrap())
    };
    assert_eq!(count("s1", "failed_24h"), Some(1));
    assert_eq!(count("s1", "queue_depth"), Some(2));
    assert_eq!(count("s1", "backfill_queued"), Some(1));
    assert_eq!(count("s2", "backfill_active"), Some(1));
    assert_eq!(count("s2", "queue_depth"), Some(1));
    assert_eq!(count("s2", "backfill_queued"), Some(0));
    assert_eq!(count("", "queue_depth"), Some(1));
    // The failure is created more than a day before this reading.
    b.clock.advance(2 * HOUR);
    assert_eq!(count("s1", "failed_24h"), Some(0));
    let order: Vec<String> = b
        .read_source_job_counts(DAY_S)
        .unwrap()
        .iter()
        .map(|r| r["source_id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(order, vec!["", "s1", "s2"]);
}

#[test]
fn embed_backfill_by_source_reports_only_the_requested_sources() {
    let b = brain("st-backfill");
    // The first job to run finishes last: the newest completion is not the newest row.
    let s1 = json!({ "sourceId": "s1" });
    let first = active(&b, "embed-backfill", "default", s1.clone(), "w:1", 30_000);
    let second = active(&b, "embed-backfill", "default", s1, "w:2", 30_000);
    b.complete_job(second, "w:2", None).unwrap().unwrap();
    b.clock.advance(HOUR);
    b.complete_job(first, "w:1", None).unwrap().unwrap();
    add(
        &b,
        "embed-backfill",
        json!({ "data": { "sourceId": "s1" } }),
    );
    add(
        &b,
        "embed-backfill",
        json!({ "data": { "sourceId": "s2" } }),
    );
    add(
        &b,
        "embed-backfill",
        json!({ "data": { "sourceId": "s3" } }),
    );
    let out = b
        .read_embed_backfill_by_source(&["s2".to_string(), "s1".to_string(), "nobody".to_string()])
        .unwrap();
    assert_eq!(out.len(), 2);
    assert_eq!(out[0]["source_id"], "s1");
    assert_eq!(
        (out[0]["queued"].as_i64(), out[0]["active"].as_i64()),
        (Some(1), Some(0))
    );
    assert!(
        out[0]["last_completed_at"]
            .as_str()
            .unwrap()
            .starts_with("2027-01-15T09:")
    );
    assert_eq!(out[1]["source_id"], "s2");
    assert_eq!(out[1]["last_completed_at"], Value::Null);
    assert!(b.read_embed_backfill_by_source(&[]).unwrap().is_empty());
}

#[test]
fn no_admitted_job_owns_a_budget_so_the_budget_owner_list_is_empty() {
    let b = brain("jobs-budget-owners");
    assert_eq!(b.list_budget_owner_jobs().unwrap(), Vec::<Value>::new());
    // No admit path writes the budget columns on any engine, so budget-shaped insert data leaves them null.
    let id = add(
        &b,
        "work",
        json!({"budget_remaining_cents": 500, "budget_owner_job_id": 1}),
    );
    assert_eq!(
        b.get_job(id).unwrap().unwrap()["budget_remaining_cents"],
        Value::Null
    );
    assert_eq!(b.list_budget_owner_jobs().unwrap(), Vec::<Value>::new());
}
