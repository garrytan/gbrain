//! Calibration profiles: `getLatestCalibrationProfile`, `isCalibrationProfileUnchanged`,
//! `insertCalibrationProfile`, `readVoiceGateHealth` and `purgeCalibrationProfilesByWave`,
//! matched to the PGLite engine (the same scenarios run on both in test/engine-parity/).

mod common;

use common::TempDir;
use gbrain_store::env::{Env, iso};
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, SOURCE_NOT_FOUND};
use gbrain_store::eval_capture::calibration_profiles::{
    LatestProfileSpec, ProfileInput, UnchangedSpec,
};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::sources::SourceInput;
use gbrain_store::{OpenOptions, Store};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

/// A clock the test moves by hand; every reading advances it one microsecond.
struct Clock(AtomicI64);

impl Env for Clock {
    fn now_micros(&self) -> i64 {
        self.0.fetch_add(1, Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        "00000000-0000-4000-8000-000000000000".into()
    }
}

const T0: i64 = 1_800_000_000_000_000;
const DAY: i64 = 86_400_000_000;

fn open(dir: &TempDir) -> (Store, Arc<Clock>) {
    let clock = Arc::new(Clock(AtomicI64::new(T0)));
    let kv = RedbKv::open_path(&dir.path().join("records.redb")).unwrap();
    let store = Store::open_kv(Arc::new(kv), clock.clone(), OpenOptions::default()).unwrap();
    for id in ["src-a", "src-b"] {
        let source: SourceInput = serde_json::from_value(json!({"id": id})).unwrap();
        store.upsert_source(&source).unwrap();
    }
    (store, clock)
}

fn profile(extra: Value) -> ProfileInput {
    let mut base = json!({
        "sourceId": "default", "holder": "self", "totalResolved": 12, "brier": 0.3,
        "accuracy": 0.7, "partialRate": 0.1, "gradeCompletion": 0.9,
        "domainScorecards": {"people": {"n": 4}}, "patternStatements": ["over-confident", "日本語"],
        "voiceGatePassed": true, "voiceGateAttempts": 1, "activeBiasTags": ["anchoring"],
        "modelId": "model-a", "generatedAt": iso(T0 - 10 * DAY),
    });
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    serde_json::from_value(base).unwrap()
}

fn insert(store: &Store, extra: Value) {
    store.insert_calibration_profile(&profile(extra)).unwrap();
}

fn latest(store: &Store, spec: Value) -> Option<Value> {
    let spec: LatestProfileSpec = serde_json::from_value(spec).unwrap();
    store.get_latest_calibration_profile(&spec).unwrap()
}

fn model(row: Option<Value>) -> Option<String> {
    row.map(|r| r["model_id"].as_str().unwrap().to_string())
}

fn unchanged(store: &Store, spec: Value) -> bool {
    let spec: UnchangedSpec = serde_json::from_value(spec).unwrap();
    store.is_calibration_profile_unchanged(&spec).unwrap()
}

fn at(days_ago: i64) -> Value {
    json!(iso(T0 - days_ago * DAY))
}

#[test]
fn a_profile_round_trips_every_column_the_calibration_read_returns() {
    let dir = TempDir::new("cp-roundtrip");
    let (store, _) = open(&dir);
    insert(
        &store,
        json!({"generatedAt": "2026-03-01T00:00:00.123456Z", "published": true, "waveVersion": "v9"}),
    );
    let row = latest(&store, json!({"holder": "self"})).unwrap();
    assert_eq!(
        row,
        json!({
            "id": "1", "source_id": "default", "holder": "self", "wave_version": "v9",
            "generated_at": "2026-03-01T00:00:00.123456Z", "published": true,
            "total_resolved": 12, "brier": 0.3, "accuracy": 0.7, "partial_rate": 0.1,
            "grade_completion": 0.9, "pattern_statements": ["over-confident", "日本語"],
            "active_bias_tags": ["anchoring"], "voice_gate_passed": true,
            "voice_gate_attempts": 1, "model_id": "model-a",
        })
    );
    // NULL metrics stay NULL; an empty tag list stays empty.
    insert(
        &store,
        json!({"holder": "sparse", "brier": null, "accuracy": null, "partialRate": null, "activeBiasTags": [], "patternStatements": []}),
    );
    let sparse = latest(&store, json!({"holder": "sparse"})).unwrap();
    assert_eq!(sparse["brier"], Value::Null);
    assert_eq!(sparse["partial_rate"], Value::Null);
    assert_eq!(sparse["active_bias_tags"], json!([]));
}

#[test]
fn the_latest_profile_is_the_newest_with_ties_by_id_and_filters_as_the_sql_reads_them() {
    let dir = TempDir::new("cp-latest");
    let (store, _) = open(&dir);
    insert(
        &store,
        json!({"generatedAt": at(5), "modelId": "default-old"}),
    );
    insert(
        &store,
        json!({"generatedAt": at(3), "modelId": "default-new"}),
    );
    insert(
        &store,
        json!({"sourceId": "src-a", "generatedAt": at(2), "modelId": "a"}),
    );
    insert(
        &store,
        json!({"sourceId": "src-b", "generatedAt": at(4), "modelId": "b"}),
    );
    insert(
        &store,
        json!({"holder": "alice", "generatedAt": at(1), "modelId": "alice"}),
    );
    insert(
        &store,
        json!({"holder": "tied", "generatedAt": at(6), "modelId": "tie-first"}),
    );
    insert(
        &store,
        json!({"holder": "tied", "generatedAt": at(6), "modelId": "tie-second"}),
    );
    let s = |v: Value| model(latest(&store, v));
    assert_eq!(s(json!({"holder": "self"})).as_deref(), Some("a"));
    assert_eq!(
        s(json!({"holder": "self", "sourceId": "default"})).as_deref(),
        Some("default-new")
    );
    assert_eq!(
        s(json!({"holder": "self", "sourceIds": ["default", "src-b"]})).as_deref(),
        Some("default-new")
    );
    // An empty list matches nothing, and a list wins over a single source.
    assert_eq!(s(json!({"holder": "self", "sourceIds": []})), None);
    assert_eq!(
        s(json!({"holder": "self", "sourceId": "src-a", "sourceIds": ["src-b"]})).as_deref(),
        Some("b")
    );
    // An empty sourceId is no filter; no holder reads every holder.
    assert_eq!(
        s(json!({"holder": "self", "sourceId": ""})).as_deref(),
        Some("a")
    );
    assert_eq!(s(json!({})).as_deref(), Some("alice"));
    assert_eq!(s(json!({"holder": "nobody"})), None);
    assert_eq!(s(json!({"holder": "self", "sourceId": "nowhere"})), None);
    assert_eq!(s(json!({"holder": "tied"})).as_deref(), Some("tie-second"));
    // An instant before the epoch still sorts by age.
    insert(
        &store,
        json!({"holder": "old", "generatedAt": "1969-12-31T23:59:59.000000Z", "modelId": "before-epoch"}),
    );
    insert(
        &store,
        json!({"holder": "old", "generatedAt": "1969-12-31T23:59:58.000000Z", "modelId": "earlier"}),
    );
    assert_eq!(s(json!({"holder": "old"})).as_deref(), Some("before-epoch"));
}

#[test]
fn the_unchanged_check_compares_only_the_latest_profile_of_the_pair() {
    let dir = TempDir::new("cp-unchanged");
    let (store, _) = open(&dir);
    let spec = json!({"sourceId": "default", "holder": "self", "totalResolved": 12, "brier": 0.1234567, "accuracy": 0.7, "partialRate": 0.1, "modelId": "model-a"});
    assert!(!unchanged(&store, spec.clone()));
    insert(&store, json!({"generatedAt": at(5), "brier": 0.1234567}));
    assert!(unchanged(&store, spec.clone()));
    insert(&store, json!({"generatedAt": at(4), "brier": 0.5}));
    assert!(
        !unchanged(&store, spec.clone()),
        "an older matching row does not count"
    );
    insert(&store, json!({"generatedAt": at(3), "brier": 0.1234567}));
    assert!(unchanged(&store, spec.clone()));
    let with = |k: &str, v: Value| {
        let mut s = spec.clone();
        s[k] = v;
        s
    };
    assert!(!unchanged(&store, with("modelId", json!("model-b"))));
    assert!(!unchanged(&store, with("totalResolved", json!(13))));
    assert!(!unchanged(&store, with("accuracy", json!(0.71))));
    assert!(!unchanged(&store, with("partialRate", Value::Null)));
    assert!(!unchanged(&store, with("holder", json!("alice"))));
    assert!(!unchanged(&store, with("sourceId", json!("src-a"))));
    // A double that rounds to the same REAL is the same value.
    assert!(unchanged(&store, with("brier", json!(0.12345670000001))));
    // NULL against NULL is the same; NULL against a number is not.
    insert(
        &store,
        json!({"sourceId": "src-a", "generatedAt": at(2), "brier": null, "accuracy": null, "partialRate": null}),
    );
    let nulls = json!({"sourceId": "src-a", "holder": "self", "totalResolved": 12, "brier": null, "accuracy": null, "partialRate": null, "modelId": "model-a"});
    assert!(unchanged(&store, nulls.clone()));
    let mut number = nulls;
    number["brier"] = json!(0.3);
    assert!(!unchanged(&store, number));
    // A total outside int4 is refused before any row is read.
    let big: UnchangedSpec =
        serde_json::from_value(with("totalResolved", json!(2_147_483_648u64))).unwrap();
    assert_eq!(
        store
            .is_calibration_profile_unchanged(&big)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}

#[test]
fn an_insert_applies_the_column_defaults_and_refuses_like_the_table() {
    let dir = TempDir::new("cp-insert");
    let (store, _) = open(&dir);
    let phase = json!({
        "sourceId": "default", "holder": "self", "totalResolved": 1, "brier": null,
        "accuracy": null, "partialRate": null, "gradeCompletion": 1,
        "domainScorecards": {}, "patternStatements": [], "voiceGatePassed": false,
        "voiceGateAttempts": 2, "activeBiasTags": [], "modelId": "m",
    });
    let parsed: ProfileInput = serde_json::from_value(phase.clone()).unwrap();
    store.insert_calibration_profile(&parsed).unwrap();
    let row = latest(&store, json!({"holder": "self"})).unwrap();
    assert_eq!(row["wave_version"], "v0.36.1.0");
    assert_eq!(row["published"], false);
    // The default stamp is the clock's now (the transaction's time).
    let stamped = row["generated_at"].as_str().unwrap().to_string();
    assert!(stamped >= iso(T0) && stamped < iso(T0 + 1_000), "{stamped}");

    let refuse = |change: Value, code: &str, holder: &str| {
        let mut row = phase.clone();
        row["holder"] = json!(holder);
        for (k, v) in change.as_object().unwrap() {
            row[k] = v.clone();
        }
        let input: ProfileInput = serde_json::from_value(row).unwrap();
        let err = store.insert_calibration_profile(&input).unwrap_err();
        assert_eq!(err.code, code, "{change}: {}", err.message);
        assert!(
            latest(&store, json!({"holder": holder})).is_none(),
            "{change} left a row"
        );
    };
    refuse(
        json!({"sourceId": "no-such-source"}),
        SOURCE_NOT_FOUND,
        "h1",
    );
    refuse(json!({"voiceGateAttempts": 40000}), INVALID_ARGUMENT, "h2");
    refuse(json!({"voiceGateAttempts": -40000}), INVALID_ARGUMENT, "h3");
    refuse(
        json!({"totalResolved": 2147483648u64}),
        INVALID_ARGUMENT,
        "h4",
    );
    refuse(json!({"totalResolved": 1.5}), INVALID_ARGUMENT, "h5");
    refuse(json!({"brier": 1e300}), INVALID_ARGUMENT, "h6");
    refuse(json!({"generatedAt": "yesterday"}), INVALID_ARGUMENT, "h7");
    refuse(json!({"modelId": "a\u{0}b"}), INVALID_ARGUMENT, "h8");
    refuse(json!({"modelId": null}), CONSTRAINT_VIOLATION, "h9");
    refuse(
        json!({"domainScorecards": null}),
        CONSTRAINT_VIOLATION,
        "h10",
    );
    refuse(json!({"totalResolved": null}), CONSTRAINT_VIOLATION, "h11");
    refuse(
        json!({"gradeCompletion": null}),
        CONSTRAINT_VIOLATION,
        "h12",
    );
    refuse(
        json!({"voiceGatePassed": null}),
        CONSTRAINT_VIOLATION,
        "h13",
    );
    refuse(
        json!({"patternStatements": null}),
        CONSTRAINT_VIOLATION,
        "h14",
    );
    refuse(json!({"activeBiasTags": null}), CONSTRAINT_VIOLATION, "h15");
    // Refusals take no id: the next profile is the second.
    insert(&store, json!({"holder": "after"}));
    assert_eq!(
        latest(&store, json!({"holder": "after"})).unwrap()["id"],
        "2"
    );
}

#[test]
fn voice_gate_health_counts_the_last_seven_days_of_the_named_sources() {
    let dir = TempDir::new("cp-voice");
    let (store, _) = open(&dir);
    insert(
        &store,
        json!({"generatedAt": at(1), "voiceGatePassed": true}),
    );
    insert(
        &store,
        json!({"generatedAt": at(2), "voiceGatePassed": false}),
    );
    insert(
        &store,
        json!({"sourceId": "src-a", "generatedAt": at(6), "voiceGatePassed": false}),
    );
    insert(
        &store,
        json!({"sourceId": "src-b", "holder": "alice", "generatedAt": at(5), "voiceGatePassed": true}),
    );
    insert(
        &store,
        json!({"generatedAt": iso(T0 - 7 * DAY - DAY / 2), "voiceGatePassed": false}),
    );
    insert(
        &store,
        json!({"sourceId": "src-a", "generatedAt": at(30), "voiceGatePassed": true}),
    );
    // The window has no upper bound: a future stamp counts.
    insert(
        &store,
        json!({"sourceId": "src-b", "generatedAt": at(-2), "voiceGatePassed": false}),
    );
    let ids = |v: &[&str]| Some(v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    let read = |v: Option<Vec<String>>| store.read_voice_gate_health(v.as_deref()).unwrap();
    assert_eq!(read(None), json!({"total": 5, "failures": 3}));
    assert_eq!(read(ids(&["default"])), json!({"total": 2, "failures": 1}));
    assert_eq!(
        read(ids(&["src-a", "src-b"])),
        json!({"total": 3, "failures": 2})
    );
    assert_eq!(read(ids(&[])), json!({"total": 0, "failures": 0}));
    assert_eq!(read(ids(&["nowhere"])), json!({"total": 0, "failures": 0}));
}

#[test]
fn a_wave_purge_counts_on_a_dry_run_and_deletes_only_that_wave() {
    let dir = TempDir::new("cp-purge");
    let (store, _) = open(&dir);
    insert(
        &store,
        json!({"generatedAt": at(5), "modelId": "default-wave"}),
    );
    insert(
        &store,
        json!({"generatedAt": at(4), "waveVersion": "v-doomed", "modelId": "d1"}),
    );
    insert(
        &store,
        json!({"sourceId": "src-a", "generatedAt": at(3), "waveVersion": "v-doomed", "modelId": "d2"}),
    );
    insert(
        &store,
        json!({"holder": "alice", "generatedAt": at(2), "waveVersion": "v-doomed", "modelId": "d3"}),
    );
    insert(
        &store,
        json!({"sourceId": "src-b", "generatedAt": at(1), "waveVersion": "v-kept", "modelId": "kept"}),
    );
    assert_eq!(
        store
            .purge_calibration_profiles_by_wave("v-doomed", true)
            .unwrap(),
        3
    );
    assert_eq!(
        model(latest(
            &store,
            json!({"holder": "self", "sourceId": "src-a"})
        ))
        .as_deref(),
        Some("d2")
    );
    assert_eq!(
        store
            .purge_calibration_profiles_by_wave("v-none", false)
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .purge_calibration_profiles_by_wave("v-doomed", false)
            .unwrap(),
        3
    );
    assert_eq!(
        store
            .purge_calibration_profiles_by_wave("v-doomed", false)
            .unwrap(),
        0
    );
    assert_eq!(
        model(latest(
            &store,
            json!({"holder": "self", "sourceId": "default"})
        ))
        .as_deref(),
        Some("default-wave")
    );
    assert_eq!(
        model(latest(
            &store,
            json!({"holder": "self", "sourceId": "src-a"})
        )),
        None
    );
    assert_eq!(
        model(latest(
            &store,
            json!({"holder": "self", "sourceId": "src-b"})
        ))
        .as_deref(),
        Some("kept")
    );
    assert_eq!(model(latest(&store, json!({"holder": "alice"}))), None);
    // The index goes with the rows: the newest overall is the kept one, then the default one.
    assert_eq!(model(latest(&store, json!({}))).as_deref(), Some("kept"));
    store
        .purge_calibration_profiles_by_wave("v-kept", false)
        .unwrap();
    assert_eq!(
        model(latest(&store, json!({}))).as_deref(),
        Some("default-wave")
    );
}

#[test]
fn profiles_survive_a_reopen() {
    let dir = TempDir::new("cp-reopen");
    {
        let (store, _) = open(&dir);
        insert(&store, json!({"modelId": "kept"}));
    }
    let (store, _) = {
        let clock = Arc::new(Clock(AtomicI64::new(T0)));
        let kv = RedbKv::open_path(&dir.path().join("records.redb")).unwrap();
        (
            Store::open_kv(Arc::new(kv), clock.clone(), OpenOptions::default()).unwrap(),
            clock,
        )
    };
    assert_eq!(
        model(latest(&store, json!({"holder": "self"}))).as_deref(),
        Some("kept")
    );
    insert(&store, json!({"modelId": "next", "generatedAt": at(0)}));
    assert_eq!(
        latest(&store, json!({"holder": "self"})).unwrap()["id"],
        "2"
    );
}

#[test]
fn a_non_finite_native_number_is_refused_and_leaves_no_row() {
    let dir = TempDir::new("cp-nonfinite");
    let (store, _) = open(&dir);
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        for column in 0..4 {
            let mut input = profile(json!({}));
            match column {
                0 => input.brier = Some(bad),
                1 => input.accuracy = Some(bad),
                2 => input.partial_rate = Some(bad),
                _ => input.grade_completion = Some(bad),
            }
            let err = store.insert_calibration_profile(&input).unwrap_err();
            assert_eq!(err.code, INVALID_ARGUMENT, "{bad} in column {column}");
        }
    }
    assert!(latest(&store, json!({"holder": "self"})).is_none());
    insert(&store, json!({}));
    assert!(latest(&store, json!({"holder": "self"})).is_some());
}
