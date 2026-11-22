//! Eval capture: `logEvalCandidate`, `listEvalCandidates`, `deleteEvalCandidatesBefore`,
//! `logEvalCaptureFailure` and `listEvalCaptureFailures`, matched to the PGLite engine.

mod common;

use common::TempDir;
use gbrain_store::env::{Env, iso};
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::eval_capture::{
    EvalCandidateInput, ListEvalCandidatesOptions, ListEvalCaptureFailuresOptions,
};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::sources::SourceInput;
use gbrain_store::{OpenOptions, Store};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

/// A clock the test moves by hand; every reading advances it one microsecond so stamps differ.
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

fn open(dir: &TempDir) -> (Store, Arc<Clock>) {
    let clock = Arc::new(Clock(AtomicI64::new(T0)));
    let kv = RedbKv::open_path(&dir.path().join("records.redb")).unwrap();
    let store = Store::open_kv(Arc::new(kv), clock.clone(), OpenOptions::default()).unwrap();
    (store, clock)
}

fn candidate(extra: Value) -> EvalCandidateInput {
    let mut base = json!({
        "tool_name": "query", "query": "who runs acme",
        "retrieved_slugs": ["people/alice", "companies/acme"], "retrieved_chunk_ids": [],
        "source_ids": ["default"], "expand_enabled": true, "detail": "medium",
        "detail_resolved": "high", "vector_enabled": true, "expansion_applied": false,
        "latency_ms": 42, "remote": false, "job_id": null, "subagent_id": null,
        "embedding_column": "embedding",
    });
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    serde_json::from_value(base).unwrap()
}

fn list(store: &Store, v: Value) -> Vec<Value> {
    let opts: ListEvalCandidatesOptions = serde_json::from_value(v).unwrap();
    store.list_eval_candidates(&opts).unwrap()
}

fn queries(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .map(|r| r["query"].as_str().unwrap().to_string())
        .collect()
}

fn put(store: &Store, source: &str, slug: &str) {
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "x"}))
            .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

#[test]
fn a_candidate_round_trips_every_column() {
    let dir = TempDir::new("eval-roundtrip");
    let (store, _) = open(&dir);
    let id = store
        .log_eval_candidate(&candidate(
            json!({"retrieved_chunk_ids": [3, null, 7], "job_id": 5}),
        ))
        .unwrap();
    assert_eq!(id, 1);
    let rows = list(&store, json!({}));
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    let created = row["created_at"].as_str().unwrap().to_string();
    assert_eq!(
        row,
        &json!({
            "id": 1, "tool_name": "query", "query": "who runs acme",
            // No page holds either slug.
            "retrieved_slugs": [], "retrieved_chunk_ids": [3, null, 7],
            "source_ids": ["default"], "expand_enabled": true, "detail": "medium",
            "detail_resolved": "high", "vector_enabled": true, "expansion_applied": false,
            "latency_ms": 42, "remote": false, "job_id": 5, "subagent_id": null,
            "created_at": created, "as_of_ts": null, "salience_param": null,
            "recency_param": null, "salience_resolved": null, "recency_resolved": null,
            "salience_source": null, "recency_source": null, "embedding_column": "embedding",
            "schema_pack_per_source": null,
        })
    );
    // An absent embedding column is stored as null.
    let mut input = candidate(json!({}));
    input.embedding_column = None;
    store.log_eval_candidate(&input).unwrap();
    assert_eq!(list(&store, json!({}))[0]["embedding_column"], Value::Null);
}

#[test]
fn retrieved_slugs_keep_only_pages_of_the_named_sources_in_order() {
    let dir = TempDir::new("eval-slugs");
    let (store, _) = open(&dir);
    let source: SourceInput = serde_json::from_value(json!({"id": "other"})).unwrap();
    store.upsert_source(&source).unwrap();
    put(&store, "default", "a");
    put(&store, "other", "b");
    put(&store, "default", "facts/12");
    let slugs = json!(["b", "missing", "a", null, "facts/12", "a"]);
    let check = |sources: Value, want: Value| {
        store
            .log_eval_candidate(&candidate(
                json!({"retrieved_slugs": slugs, "source_ids": sources}),
            ))
            .unwrap();
        let rows = list(&store, json!({"limit": 1}));
        assert_eq!(rows[0]["retrieved_slugs"], want, "sources {sources}");
    };
    check(json!(["default"]), json!(["a", "facts/12", "a"]));
    check(json!(["other"]), json!(["b"]));
    check(json!([]), json!(["b", "a", "facts/12", "a"]));
    check(json!([null]), json!([]));
    check(json!(["nowhere"]), json!([]));

    // A soft-deleted page still counts: the PGLite probe has no deleted_at filter.
    store.soft_delete_page("a", Some("default")).unwrap();
    check(json!(["default"]), json!(["a", "facts/12", "a"]));
}

#[test]
fn list_filters_by_tool_since_and_limit_newest_first() {
    let dir = TempDir::new("eval-list");
    let (store, clock) = open(&dir);
    store
        .log_eval_candidate(&candidate(json!({"query": "one"})))
        .unwrap();
    clock.0.fetch_add(1_000, Ordering::SeqCst);
    store
        .log_eval_candidate(&candidate(json!({"query": "two", "tool_name": "search"})))
        .unwrap();
    clock.0.fetch_add(1_000, Ordering::SeqCst);
    let cutoff = clock.0.load(Ordering::SeqCst);
    store
        .log_eval_candidate(&candidate(json!({"query": "three"})))
        .unwrap();

    assert_eq!(queries(&list(&store, json!({}))), ["three", "two", "one"]);
    assert_eq!(
        queries(&list(&store, json!({"tool": "query"}))),
        ["three", "one"]
    );
    assert_eq!(queries(&list(&store, json!({"tool": "search"}))), ["two"]);
    assert_eq!(
        queries(&list(&store, json!({"limit": 2}))),
        ["three", "two"]
    );
    assert_eq!(queries(&list(&store, json!({"limit": 1.9}))), ["three"]);
    for unusable in [json!(0), json!(-3), json!(null)] {
        assert_eq!(list(&store, json!({ "limit": unusable })).len(), 3);
    }
    assert_eq!(
        queries(&list(&store, json!({"since": iso(cutoff)}))),
        ["three"]
    );
    // The millisecond form `Date#toISOString` gives parses too.
    assert_eq!(
        list(&store, json!({"since": "2100-01-01T00:00:00.000Z"})).len(),
        0
    );
    let bad: ListEvalCandidatesOptions =
        serde_json::from_value(json!({"since": "yesterday"})).unwrap();
    assert_eq!(
        store.list_eval_candidates(&bad).unwrap_err().code,
        INVALID_ARGUMENT
    );
}

#[test]
fn equal_timestamps_order_by_id_descending() {
    struct Frozen;
    impl Env for Frozen {
        fn now_micros(&self) -> i64 {
            T0
        }
        fn new_uuid(&self) -> String {
            "00000000-0000-4000-8000-000000000000".into()
        }
    }
    let dir = TempDir::new("eval-ties");
    let kv = RedbKv::open_path(&dir.path().join("records.redb")).unwrap();
    let store = Store::open_kv(Arc::new(kv), Arc::new(Frozen), OpenOptions::default()).unwrap();
    for q in ["a", "b", "c"] {
        store
            .log_eval_candidate(&candidate(json!({ "query": q })))
            .unwrap();
        store.log_eval_capture_failure(Some("other")).unwrap();
    }
    assert_eq!(queries(&list(&store, json!({}))), ["c", "b", "a"]);
    let ids: Vec<u64> = store
        .list_eval_capture_failures(&ListEvalCaptureFailuresOptions::default())
        .unwrap()
        .iter()
        .map(|f| f["id"].as_u64().unwrap())
        .collect();
    assert_eq!(ids, [3, 2, 1]);
}

#[test]
fn delete_before_removes_strictly_older_rows() {
    let dir = TempDir::new("eval-delete");
    let (store, clock) = open(&dir);
    store
        .log_eval_candidate(&candidate(json!({"query": "old"})))
        .unwrap();
    let cutoff = clock.0.fetch_add(1_000, Ordering::SeqCst) + 500;
    store
        .log_eval_candidate(&candidate(json!({"query": "new"})))
        .unwrap();
    assert_eq!(
        store
            .delete_eval_candidates_before("2000-01-01T00:00:00.000Z")
            .unwrap(),
        0
    );
    assert_eq!(
        store.delete_eval_candidates_before(&iso(cutoff)).unwrap(),
        1
    );
    assert_eq!(queries(&list(&store, json!({}))), ["new"]);
    // `created_at < date` is strict: a row stamped exactly at `date` stays.
    let new_at = list(&store, json!({}))[0]["created_at"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(store.delete_eval_candidates_before(&new_at).unwrap(), 0);
    assert_eq!(
        store
            .delete_eval_candidates_before("2100-01-01T00:00:00Z")
            .unwrap(),
        1
    );
    assert!(list(&store, json!({})).is_empty());
    // Ids keep counting after deletes, as a serial does.
    assert_eq!(store.log_eval_candidate(&candidate(json!({}))).unwrap(), 3);
}

#[test]
fn constraints_refuse_as_postgres_does() {
    let dir = TempDir::new("eval-constraints");
    let (store, _) = open(&dir);
    let refused = |extra: Value| store.log_eval_candidate(&candidate(extra)).unwrap_err();
    for (extra, code) in [
        (json!({"tool_name": "grep"}), CONSTRAINT_VIOLATION),
        (json!({"tool_name": null}), CONSTRAINT_VIOLATION),
        (json!({"query": null}), CONSTRAINT_VIOLATION),
        (json!({"query": "x".repeat(51_201)}), CONSTRAINT_VIOLATION),
        (json!({"detail": "max"}), CONSTRAINT_VIOLATION),
        (json!({"detail_resolved": "low-ish"}), CONSTRAINT_VIOLATION),
        (json!({"retrieved_chunk_ids": null}), CONSTRAINT_VIOLATION),
        (json!({"source_ids": null}), CONSTRAINT_VIOLATION),
        (json!({"vector_enabled": null}), CONSTRAINT_VIOLATION),
        (json!({"expansion_applied": null}), CONSTRAINT_VIOLATION),
        (json!({"latency_ms": null}), CONSTRAINT_VIOLATION),
        (json!({"remote": null}), CONSTRAINT_VIOLATION),
        (json!({"latency_ms": 1.5}), INVALID_ARGUMENT),
        (json!({"latency_ms": 3_000_000_000_i64}), INVALID_ARGUMENT),
        (json!({"retrieved_chunk_ids": ["x"]}), INVALID_ARGUMENT),
        (json!({"query": "a\u{0}b"}), INVALID_ARGUMENT),
    ] {
        assert_eq!(refused(extra.clone()).code, code, "{extra}");
    }
    // 51200 characters (not bytes) is the limit.
    store
        .log_eval_candidate(&candidate(json!({"query": "é".repeat(51_200)})))
        .unwrap();
    // A refused row takes no id.
    assert_eq!(list(&store, json!({})).len(), 1);
    assert_eq!(list(&store, json!({}))[0]["id"], 1);
    // A null retrieved_slugs is an empty array, as `unnest(NULL)` yields no rows.
    store
        .log_eval_candidate(&candidate(json!({"retrieved_slugs": null})))
        .unwrap();
    assert_eq!(
        list(&store, json!({"limit": 1}))[0]["retrieved_slugs"],
        json!([])
    );
}

#[test]
fn failures_record_reasons_and_filter_by_since() {
    let dir = TempDir::new("eval-failures");
    let (store, clock) = open(&dir);
    let all = |since: Option<String>| {
        store
            .list_eval_capture_failures(&ListEvalCaptureFailuresOptions { since })
            .unwrap()
    };
    assert!(all(None).is_empty());
    store.log_eval_capture_failure(Some("db_down")).unwrap();
    store
        .log_eval_capture_failure(Some("scrubber_exception"))
        .unwrap();
    let cutoff = clock.0.fetch_add(1_000, Ordering::SeqCst) + 500;
    store.log_eval_capture_failure(Some("other")).unwrap();
    let rows = all(None);
    let reasons: Vec<&str> = rows.iter().map(|r| r["reason"].as_str().unwrap()).collect();
    assert_eq!(reasons, ["other", "scrubber_exception", "db_down"]);
    assert_eq!(rows[0]["id"], 3);
    assert!(rows[0]["ts"].as_str().unwrap().ends_with('Z'));
    let recent = all(Some(iso(cutoff)));
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0]["reason"], "other");
    for bad in [Some("unknown"), None] {
        assert_eq!(
            store.log_eval_capture_failure(bad).unwrap_err().code,
            CONSTRAINT_VIOLATION
        );
    }
    assert_eq!(all(None).len(), 3);
}
