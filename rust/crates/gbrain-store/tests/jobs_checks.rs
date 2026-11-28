//! The doctor and dream-breaker queue reads (`src/core/engine-sql/jobs-checks.ts`): what the
//! parity file cannot create (a bare-string progress, rows older than a window, a clock-driven wait) and the errors on a malformed time.

mod memory_env;

use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::jobs::{
    AdmitSpec, BuildSkewSpec, ClaimSpec, DeadDreamSpec, DeathsSpec, KeyPrefixSpec, QueuedSpendSpec,
    StillDeadSpec,
};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const MARK: &str = "watchdog_suspect";
const HOUR: i64 = 3_600_000_000;

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

fn claim_spec(token: &str, queue: &str, names: &[&str], extra: Value) -> ClaimSpec {
    let mut spec = json!({
        "lockToken": token, "lockDurationMs": 30000, "queue": queue, "names": names,
        "suspectMark": MARK, "handlerTimeouts": {}, "handlerLockDurations": {},
        "legacySpend": {"groupId": "00000000-0000-4000-8000-000000000001", "capUsd": 5},
    });
    for (k, v) in extra.as_object().unwrap() {
        spec[k] = v.clone();
    }
    serde_json::from_value(spec).unwrap()
}

/// A job of `name` that was claimed and then ended as `how` (`dead` or `failed`) with `error`.
fn ended(b: &Brain, name: &str, extra: Value, how: &str, error: &str) -> i64 {
    let extra_queue = extra["queue"].as_str().unwrap_or("default").to_string();
    let id = add(b, name, extra);
    let token = format!("t:{id}");
    let queue = extra_queue;
    b.claim_next_job(&claim_spec(&token, &queue, &[name], json!({})))
        .unwrap()
        .expect("the job is claimed");
    b.fail_job(id, &token, error, how, None, None)
        .unwrap()
        .unwrap();
    id
}

fn ids(rows: &Value, key: &str) -> Vec<i64> {
    rows.as_array()
        .unwrap()
        .iter()
        .map(|r| r[key].as_i64().unwrap())
        .collect()
}

#[test]
fn a_stall_is_found_in_a_bare_string_progress_and_a_missing_source_sorts_last() {
    let b = brain("checks-stall");
    let with_progress = |source: Option<&str>, progress: Value| {
        let data = source.map_or(json!({}), |s| json!({ "sourceId": s }));
        let id = add(&b, "embed-backfill", json!({ "data": data }));
        b.claim_next_job(&claim_spec("t", "default", &["embed-backfill"], json!({})))
            .unwrap()
            .unwrap();
        assert!(b.update_job_progress(id, "t", &progress).unwrap());
        b.fail_job(id, "t", "stalled", "dead", None, None)
            .unwrap()
            .unwrap();
    };
    with_progress(Some("b"), json!("stall"));
    with_progress(None, json!({"stall": 1}));
    with_progress(Some("a"), json!(["x", "stall"]));
    with_progress(Some("z"), json!("not-it"));
    with_progress(Some("y"), json!({"nested": {"stall": 1}}));
    assert_eq!(
        b.list_stalled_embed_backfill_sources().unwrap(),
        vec![Some("a".to_string()), Some("b".to_string()), None]
    );
}

#[test]
fn global_maintenance_reads_the_newest_finished_jobs_and_needs_every_death_to_be_a_timeout() {
    let b = brain("checks-deaths");
    let gm = "autopilot-global-maintenance";
    for _ in 0..3 {
        ended(&b, gm, json!({}), "dead", "timeout exceeded");
        b.clock.advance(HOUR);
    }
    let read = b
        .read_global_maintenance_deaths(&DeathsSpec { deaths: 2 })
        .unwrap();
    assert_eq!(read["recent"].as_array().unwrap().len(), 2);
    assert_eq!(read["recent"][0]["id"], 3);
    assert_eq!(read["child_timeouts"], json!([]));
    let none = b
        .read_global_maintenance_deaths(&DeathsSpec { deaths: 0 })
        .unwrap();
    assert_eq!(none["recent"], json!([]));

    for i in 0..2 {
        let key = format!("dream:patterns:source:s:{i}");
        ended(
            &b,
            "subagent",
            json!({"idempotency_key": key}),
            "dead",
            "x: timeout exceeded",
        );
        b.clock.advance(HOUR);
    }
    let read = b
        .read_global_maintenance_deaths(&DeathsSpec { deaths: 2 })
        .unwrap();
    assert_eq!(read["child_timeouts"][0]["phase"], "patterns");
    assert_eq!(read["child_timeouts"][0]["deaths"], 2);
    // The last death's finish time, as `timestamptz::text`.
    assert_eq!(
        read["child_timeouts"][0]["last_at"],
        "2027-01-15 12:00:00+00"
    );
    let three = b
        .read_global_maintenance_deaths(&DeathsSpec { deaths: 3 })
        .unwrap();
    assert_eq!(
        three["child_timeouts"],
        json!([]),
        "only two children exist"
    );
}

#[test]
fn the_last_failed_job_counts_every_match_and_a_malformed_since_is_refused() {
    let b = brain("checks-last-failed");
    let gm = "autopilot-global-maintenance";
    let first = ended(&b, gm, json!({}), "failed", "one");
    b.clock.advance(HOUR);
    let second = ended(&b, gm, json!({}), "dead", "two");
    let all = b
        .read_last_failed_global_maintenance_job(None)
        .unwrap()
        .unwrap();
    assert_eq!(
        (all["id"].as_i64().unwrap(), all["total"].as_i64().unwrap()),
        (second, 2)
    );
    assert_eq!(all["since"], "2027-01-15 08:00:00+00");
    let after = b
        .read_last_failed_global_maintenance_job(Some("2027-01-15T08:30:00.000Z"))
        .unwrap()
        .unwrap();
    assert_eq!(
        (after["total"].as_i64().unwrap(), after["since"].clone()),
        (1, json!("2027-01-15 09:00:00+00"))
    );
    assert!(
        b.read_last_failed_global_maintenance_job(Some("2027-01-15T09:00:00.000Z"))
            .unwrap()
            .is_none(),
        "a finish at the cut is not after it"
    );
    let err = b
        .read_last_failed_global_maintenance_job(Some("yesterday"))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    assert!(first < second);
}

#[test]
fn still_dead_applies_the_window_and_never_supersedes_a_job_with_no_slug() {
    let b = brain("checks-still-dead");
    let fa = "facts-absorb";
    let old = ended(&b, fa, json!({"data": {"slug": "p-old"}}), "dead", "x");
    b.clock.advance(23 * HOUR);
    let noslug = ended(&b, fa, json!({"data": {}}), "failed", "x");
    let done = ended(&b, fa, json!({"data": {"slug": "p-done"}}), "dead", "x");
    let completed = add(&b, fa, json!({"data": {"slug": "p-done"}}));
    b.claim_next_job(&claim_spec("c", "default", &[fa], json!({})))
        .unwrap()
        .unwrap();
    b.complete_job(completed, "c", None).unwrap().unwrap();
    let spec = |hours: f64| StillDeadSpec { hours, limit: 5 };
    let read = b.list_facts_absorb_jobs_still_dead(&spec(24.0)).unwrap();
    assert_eq!(ids(&read["jobs"], "id"), vec![noslug, old]);
    assert_eq!(read["total"], 2);
    assert_eq!(read["jobs"][0]["slug"], Value::Null);
    assert_eq!(read["jobs"][0]["source_id"], "default");
    b.clock.advance(2 * HOUR);
    let later = b.list_facts_absorb_jobs_still_dead(&spec(24.0)).unwrap();
    assert_eq!(
        ids(&later["jobs"], "id"),
        vec![noslug],
        "the old job left the window"
    );
    let none = b.list_facts_absorb_jobs_still_dead(&spec(0.0)).unwrap();
    assert_eq!(
        (none["total"].clone(), none["jobs"].clone()),
        (json!(0), json!([]))
    );
    let limited = b
        .list_facts_absorb_jobs_still_dead(&StillDeadSpec {
            hours: 48.0,
            limit: 1,
        })
        .unwrap();
    assert_eq!(
        (limited["total"].clone(), ids(&limited["jobs"], "id")),
        (json!(2), vec![noslug])
    );
    assert!(done < completed);
}

#[test]
fn queued_spend_waits_by_the_clock_and_names_its_basis() {
    let b = brain("checks-spend");
    // `spend_authorization` crosses as JSON text.
    let spend = |kind: &str| json!({"spend_authorization": json!({"version": 1, "kind": kind}).to_string()});
    let paid = add(&b, "paid", spend("operator"));
    let nokind = add(
        &b,
        "paid",
        json!({"spend_authorization": "{\"version\":1}"}),
    );
    add(&b, "legacy", json!({"idempotency_key": "book:1"}));
    add(&b, "legacy", json!({"idempotency_key": "other:1"}));
    add(&b, "legacy", json!({}));
    b.clock.advance(10_000_000);
    let spec = |wait_ms: f64| QueuedSpendSpec {
        legacy_prefixes: [("legacy".to_string(), vec!["book:".to_string()])].into(),
        wait_ms,
    };
    let read = b.read_queued_spend_rows(&spec(5000.0)).unwrap();
    assert_eq!(
        read["by_basis"],
        json!([
            {"name": "legacy", "basis": "legacy_default", "n": 1},
            {"name": "legacy", "basis": "unrecorded", "n": 2},
            {"name": "paid", "basis": "operator", "n": 1},
            {"name": "paid", "basis": null, "n": 1},
        ])
    );
    assert_eq!(read["waiting_ids"], json!([paid, nokind]));
    let fresh = b.read_queued_spend_rows(&spec(60_000.0)).unwrap();
    assert_eq!(fresh["waiting_ids"], json!([]));
}

#[test]
fn dead_dream_submissions_age_out_and_a_malformed_reset_is_refused_only_for_a_counted_key() {
    let b = brain("checks-dream");
    let dead = |key: &str, queue: &str| {
        ended(
            &b,
            "subagent",
            json!({"idempotency_key": key, "queue": queue}),
            "dead",
            "x",
        )
    };
    dead("dream:synth-v2:old", "default");
    b.clock.advance(25 * HOUR);
    dead("dream:synth-v2:new", "default");
    let spec = |resets: Value, hours: f64| -> DeadDreamSpec {
        serde_json::from_value(json!({
            "keyPrefixes": ["dream:synth", "dream:patterns:"],
            "patternsSourcePrefix": "dream:patterns:source:",
            "synthFilePrefix": "dream:synth-v2:@file:",
            "resets": resets, "windowHours": hours,
        }))
        .unwrap()
    };
    let rows = b
        .count_dead_dream_submission_rows(&spec(json!({}), 24.0))
        .unwrap();
    let keys: Vec<&str> = rows
        .iter()
        .map(|r| r["base_key"].as_str().unwrap())
        .collect();
    assert_eq!(
        keys,
        vec!["dream:synth-v2:new"],
        "the old death left the window"
    );
    assert_eq!(rows[0]["last_dead_at"], "2027-01-16 09:00:00+00");
    let wide = b
        .count_dead_dream_submission_rows(&spec(json!({}), 48.0))
        .unwrap();
    assert_eq!(wide.len(), 2);
    // A reset for a key no row counts under is never parsed.
    b.count_dead_dream_submission_rows(&spec(json!({"absent": "garbage"}), 48.0))
        .unwrap();
    let err = b
        .count_dead_dream_submission_rows(&spec(json!({"dream:synth-v2:new": "garbage"}), 48.0))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    let reset = b
        .count_dead_dream_submission_rows(&spec(
            json!({"dream:synth-v2:new": "2027-01-16T09:00:00.000Z"}),
            48.0,
        ))
        .unwrap();
    assert_eq!(reset.len(), 1, "a death at the reset time does not count");
}

#[test]
fn facts_absorb_rows_carry_the_slug_the_source_and_the_finish_time() {
    let b = brain("checks-facts");
    let fa = "facts-absorb";
    let key = |k: &str, slug: &str| json!({"idempotency_key": k, "data": {"slug": slug, "sourceId": "src"}});
    let dead = ended(&b, fa, key("w:1", "p1"), "dead", "boom");
    let keyed = ended(&b, fa, key("w:2", "p2"), "failed", "boom");
    ended(&b, fa, key("x:3", "p3"), "dead", "boom");
    let rows = b
        .list_facts_absorb_jobs_by_key_prefix(&KeyPrefixSpec {
            prefix: "w:".into(),
            keys: vec!["w:2".into()],
        })
        .unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r["id"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![dead, keyed]
    );
    assert_eq!(rows[0]["slug"], "p1");
    assert_eq!(rows[0]["source_id"], "src");
    assert_eq!(rows[0]["finished_at"], "2027-01-15T08:00:00.000000Z");
    let dead_only = b
        .list_dead_facts_absorb_jobs_by_keys(&["w:1".into(), "w:2".into()])
        .unwrap();
    assert_eq!(ids(&Value::Array(dead_only), "id"), vec![dead]);
}

#[test]
fn build_skew_lines_follow_the_window_and_the_scan_limit() {
    let b = brain("checks-skew");
    let spec = |hours: f64, scan: i64| BuildSkewSpec {
        prefix: "boom".into(),
        window_hours: hours,
        scan_jobs: scan,
    };
    let failed = ended(&b, "skew", json!({}), "failed", "boom: one");
    // `failJob` appends the error to the stacktrace, so the line carries the error text.
    let rows = b.list_build_skew_stacktrace_lines(&spec(24.0, 10)).unwrap();
    assert_eq!(ids(&Value::Array(rows.clone()), "id"), vec![failed]);
    b.clock.advance(25 * HOUR);
    assert!(
        b.list_build_skew_stacktrace_lines(&spec(24.0, 10))
            .unwrap()
            .is_empty()
    );
    assert!(
        b.list_build_skew_stacktrace_lines(&spec(48.0, 0))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        b.list_build_skew_stacktrace_lines(&spec(48.0, 1))
            .unwrap()
            .len(),
        rows.len()
    );
}

/// A sync job of `source_id`, claimed and completed with `result`.
fn sync_done(b: &Brain, source_id: &str, result: Value) -> i64 {
    let id = add(b, "sync", json!({ "data": { "sourceId": source_id } }));
    let token = format!("t:{id}");
    b.claim_next_job(&claim_spec(&token, "default", &["sync"], json!({})))
        .unwrap()
        .expect("the job is claimed");
    b.complete_job(id, &token, Some(&result)).unwrap().unwrap();
    id
}

#[test]
fn the_last_sync_job_follows_the_lock_clock_the_window_and_the_numeric_cast() {
    let b = brain("checks-last-sync");
    let limited = |extra: Value| {
        let mut r = json!({ "status": "partial", "stopped_on": "usage_limit" });
        for (k, v) in extra.as_object().unwrap() {
            r[k] = v.clone();
        }
        r
    };
    // A landed limited run, then a run that is still live: the live one is neither, so the limited run counts.
    let landed = sync_done(&b, "src-a", limited(json!({ "added": "NaN" })));
    b.clock.advance(HOUR);
    let live = add(&b, "sync", json!({ "data": { "sourceId": "src-a" } }));
    b.claim_next_job(&claim_spec("live", "default", &["sync"], json!({})))
        .unwrap()
        .expect("the job is claimed");
    let read = b
        .read_last_sync_job("src-a", Some("2000-01-01T00:00:00.000Z"))
        .unwrap()
        .unwrap();
    assert_eq!(read["job_id"].as_i64().unwrap(), live);
    assert_eq!(read["live"], json!(true));
    assert_eq!(
        read["usage_limited_since"],
        json!("2027-01-15T08:00:00.000000Z"),
        "a numeric NaN is more than zero"
    );
    assert!(landed < live);
    // Past its 30 s lock the active job is no longer live and ended the other way: the limited run stops counting.
    b.clock.advance(60_000_000);
    let read = b
        .read_last_sync_job("src-a", Some("2000-01-01T00:00:00.000Z"))
        .unwrap()
        .unwrap();
    assert_eq!(
        (read["live"].clone(), read["usage_limited_since"].clone()),
        (json!(false), Value::Null)
    );
    // A window that starts after the landed run but before the expired one: nothing landed in it.
    let read = b
        .read_last_sync_job("src-a", Some("2027-01-15T08:30:00.000Z"))
        .unwrap()
        .unwrap();
    assert_eq!(read["usage_limited_since"], Value::Null);

    // A limited run whose counts are not numbers is the cast's error, but only when the run is limited.
    sync_done(&b, "src-b", json!({ "status": "ok", "added": "many" }));
    assert!(
        b.read_last_sync_job("src-b", Some("2000-01-01T00:00:00.000Z"))
            .unwrap()
            .is_some()
    );
    sync_done(&b, "src-b", limited(json!({ "added": "many" })));
    let err = b
        .read_last_sync_job("src-b", Some("2000-01-01T00:00:00.000Z"))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    assert!(
        b.read_last_sync_job("src-b", None).unwrap().is_some(),
        "no window, no cast"
    );

    let err = b
        .read_last_sync_job("src-a", Some("yesterday"))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    assert!(b.read_last_sync_job("nobody", None).unwrap().is_none());
}
