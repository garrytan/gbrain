//! Contradiction-probe runs and the judge cache: the PGLite semantics of each member.

mod memory_env;

use gbrain_store::contradictions::{ContradictionCacheInput, ContradictionsRunInput};
use gbrain_store::env::iso;
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use memory_env::{T0, brain};
use serde_json::{Value, json};

const DAY: i64 = 86_400_000_000;

fn run(id: &str, over: Value) -> ContradictionsRunInput {
    let mut row = json!({
        "run_id": id, "judge_model": "judge-m1", "prompt_version": "v1", "queries_evaluated": 20,
        "queries_with_contradiction": 4, "total_contradictions_flagged": 6, "wilson_ci_lower": 0.08,
        "wilson_ci_upper": 0.42, "judge_errors_total": 1, "cost_usd_total": 0.37, "duration_ms": 1234,
        "source_tier_breakdown": {"curated": 3, "bulk": 1}, "report_json": {"notes": ["a"], "nested": {"ok": true}}
    });
    for (k, v) in over.as_object().unwrap() {
        row[k] = v.clone();
    }
    serde_json::from_value(row).unwrap()
}

fn cache(over: Value) -> ContradictionCacheInput {
    let mut row = json!({
        "chunk_a_hash": "a", "chunk_b_hash": "b", "model_id": "m", "prompt_version": "v1",
        "truncation_policy": "head-2k"
    });
    for (k, v) in over.as_object().unwrap() {
        row[k] = v.clone();
    }
    serde_json::from_value(row).unwrap()
}

#[test]
fn a_run_is_written_once_and_the_trend_lists_runs_newest_first() {
    let b = brain("contra-run");
    assert!(
        b.write_contradictions_run(&run("run-a", json!({})))
            .unwrap()
    );
    b.clock.advance(1_000);
    assert!(
        b.write_contradictions_run(&run("run-b", json!({"queries_evaluated": 30})))
            .unwrap()
    );
    b.clock.advance(1_000);
    assert!(
        !b.write_contradictions_run(&run("run-a", json!({"queries_evaluated": 999})))
            .unwrap()
    );
    let trend = b.load_contradictions_trend(7.0).unwrap();
    let ids: Vec<&str> = trend
        .iter()
        .map(|r| r["run_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["run-b", "run-a"]);
    assert_eq!(
        trend[1],
        json!({
            "run_id": "run-a", "ran_at": iso(T0), "judge_model": "judge-m1", "queries_evaluated": 20,
            "queries_with_contradiction": 4, "total_contradictions_flagged": 6, "wilson_ci_lower": 0.08,
            "wilson_ci_upper": 0.42, "judge_errors_total": 1, "cost_usd_total": 0.37, "duration_ms": 1234,
            "source_tier_breakdown": {"bulk": 1, "curated": 3},
            "report_json": {"notes": ["a"], "nested": {"ok": true}}
        })
    );
    // jsonb key order: shorter keys first.
    let keys: Vec<&String> = trend[1]["source_tier_breakdown"]
        .as_object()
        .unwrap()
        .keys()
        .collect();
    assert_eq!(keys, ["bulk", "curated"]);
}

#[test]
fn real_columns_hold_an_f32_and_print_its_shortest_decimal() {
    let b = brain("contra-real");
    b.write_contradictions_run(&run(
        "r",
        json!({"wilson_ci_lower": 0.1234567891, "cost_usd_total": 1.0e-7, "wilson_ci_upper": 16777217}),
    ))
    .unwrap();
    let row = &b.load_contradictions_trend(1.0).unwrap()[0];
    assert_eq!(row["wilson_ci_lower"], json!(0.12345679));
    assert_eq!(row["cost_usd_total"], json!(1e-7));
    assert_eq!(row["wilson_ci_upper"], json!(16777216.0));
}

#[test]
fn the_trend_cutoff_is_a_millisecond_time_days_back_and_inclusive() {
    let b = brain("contra-cutoff");
    b.clock.set(T0 + 250); // 0.25 ms past T0
    b.write_contradictions_run(&run("old", json!({}))).unwrap();
    // now - 3 days, truncated to the millisecond, is T0 exactly: the run (T0 + 250us) is kept.
    b.clock.set(T0 + 3 * DAY + 999);
    assert_eq!(b.load_contradictions_trend(3.0).unwrap().len(), 1);
    b.clock.set(T0 + 3 * DAY + 1_000);
    assert_eq!(b.load_contradictions_trend(3.0).unwrap().len(), 0);
    // Negative days count as zero: the cutoff is now.
    b.clock.set(T0 + 1_000);
    assert_eq!(b.load_contradictions_trend(-5.0).unwrap().len(), 0);
    b.clock.set(T0);
    assert_eq!(b.load_contradictions_trend(0.0).unwrap().len(), 1);
    assert_eq!(
        b.load_contradictions_trend(f64::NAN).unwrap_err().code,
        INVALID_ARGUMENT
    );
}

#[test]
fn a_run_postgres_refuses_is_refused_and_writes_nothing() {
    let b = brain("contra-refuse");
    let mut missing = run("x", json!({}));
    missing.judge_model = None;
    assert_eq!(
        b.write_contradictions_run(&missing).unwrap_err().code,
        CONSTRAINT_VIOLATION
    );
    for bad in [
        json!({"queries_evaluated": 1.5}),
        json!({"duration_ms": 1e12}),
        json!({"wilson_ci_lower": 1e300}),
        json!({"report_json": {"a": "\u{0}"}}),
        json!({"run_id": "x\u{0}"}),
    ] {
        assert_eq!(
            b.write_contradictions_run(&run("x", bad.clone()))
                .unwrap_err()
                .code,
            INVALID_ARGUMENT,
            "{bad}"
        );
    }
    assert!(b.load_contradictions_trend(30.0).unwrap().is_empty());
}

#[test]
fn the_cache_keys_on_all_five_parts_and_an_upsert_replaces_the_verdict() {
    let b = brain("contra-cache");
    assert_eq!(
        b.get_contradiction_cache_entry(&cache(json!({}))).unwrap(),
        None
    );
    b.put_contradiction_cache_entry(&cache(
        json!({"verdict": {"contradicts": true, "axes": ["d"]}}),
    ))
    .unwrap();
    assert_eq!(
        b.get_contradiction_cache_entry(&cache(json!({}))).unwrap(),
        Some(json!({"axes": ["d"], "contradicts": true}))
    );
    for other in [
        json!({"chunk_a_hash": "z"}),
        json!({"chunk_b_hash": "z"}),
        json!({"model_id": "z"}),
        json!({"prompt_version": "z"}),
        json!({"truncation_policy": "z"}),
        json!({"model_id": null}),
    ] {
        assert_eq!(
            b.get_contradiction_cache_entry(&cache(other)).unwrap(),
            None
        );
    }
    b.put_contradiction_cache_entry(&cache(json!({"verdict": {"contradicts": false}})))
        .unwrap();
    assert_eq!(
        b.get_contradiction_cache_entry(&cache(json!({}))).unwrap(),
        Some(json!({"contradicts": false}))
    );
    let e = b
        .put_contradiction_cache_entry(&cache(json!({})))
        .unwrap_err();
    assert_eq!(e.code, CONSTRAINT_VIOLATION);
}

#[test]
fn cache_entries_expire_on_a_floored_ttl_and_the_sweep_deletes_only_expired_ones() {
    let b = brain("contra-ttl");
    b.clock.set(T0 + 700); // the expiry is millisecond-truncated: T0 + ttl
    b.put_contradiction_cache_entry(&cache(json!({"verdict": {"v": 1}, "ttl_seconds": 1})))
        .unwrap();
    b.put_contradiction_cache_entry(&cache(
        json!({"prompt_version": "v2", "verdict": {"v": 2}, "ttl_seconds": 120}),
    ))
    .unwrap();
    b.put_contradiction_cache_entry(&cache(json!({"prompt_version": "v3", "verdict": {"v": 3}})))
        .unwrap();
    assert_eq!(b.sweep_contradiction_cache().unwrap(), 0);
    b.clock.set(T0 + 60_000_000 - 1);
    assert!(
        b.get_contradiction_cache_entry(&cache(json!({})))
            .unwrap()
            .is_some()
    );
    b.clock.set(T0 + 60_000_000);
    assert_eq!(
        b.get_contradiction_cache_entry(&cache(json!({}))).unwrap(),
        None
    );
    assert_eq!(b.sweep_contradiction_cache().unwrap(), 1);
    b.clock.set(T0 + 30 * DAY);
    assert_eq!(b.sweep_contradiction_cache().unwrap(), 2);
    assert_eq!(b.sweep_contradiction_cache().unwrap(), 0);
}
