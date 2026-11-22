//! Takes: `addTakesBatch`, `listTakes`, `listActiveTakesForPages`, `searchTakes`, `updateTake`,
//! `supersedeTake`, `resolveTake`, `getScorecard`, `getCalibrationCurve` and `addSynthesisEvidence`,
//! matched to the PGLite engine.

mod common;

use common::TempDir;
use gbrain_store::env::Env;
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::sources::SourceInput;
use gbrain_store::takes::{
    ActiveTakesInput, CalibrationOptions, EvidenceInput, ListTakesOptions, ResolveTakeInput,
    ScorecardOptions, SearchTakesOptions, SupersedeTakeInput, TakeInput, UpdateTakeInput,
};
use gbrain_store::{OpenOptions, Store};
use serde::de::DeserializeOwned;
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

fn open(dir: &TempDir) -> Store {
    let clock = Arc::new(Clock(AtomicI64::new(T0)));
    let kv = RedbKv::open_path(&dir.path().join("records.redb")).unwrap();
    Store::open_kv(Arc::new(kv), clock, OpenOptions::default()).unwrap()
}

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// A page in `source` with `frontmatter`; returns its id.
fn page(store: &Store, source: &str, slug: &str, frontmatter: Value) -> u64 {
    let input: PageInput = de(json!({
        "type": "note", "title": slug, "compiled_truth": "x", "frontmatter": frontmatter,
    }));
    let opts: PutPageOptions = de(json!({"sourceId": source}));
    store.put_page(slug, &input, &opts).unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn take(page_id: u64, row: i64, claim: &str, extra: Value) -> TakeInput {
    let mut base = json!({
        "page_id": page_id, "row_num": row, "claim": claim, "kind": "bet", "holder": "garry",
        "weight": 0.5, "active": true,
    });
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    de(base)
}

/// `listTakes` as the TS member calls it: `active` defaults to true there, so it does here.
fn list(store: &Store, mut v: Value) -> Vec<Value> {
    if v.get("active").is_none() {
        v["active"] = json!(true);
    }
    store.list_takes(&de::<ListTakesOptions>(v)).unwrap()
}

fn claims(rows: &[Value]) -> Vec<&str> {
    rows.iter().map(|r| r["claim"].as_str().unwrap()).collect()
}

fn code(err: gbrain_store::StoreError) -> &'static str {
    err.code
}

#[test]
fn a_batch_upserts_and_counts_every_row() {
    let dir = TempDir::new("takes-batch");
    let store = open(&dir);
    let p = page(&store, "default", "companies/acme", json!({}));
    let n = store
        .add_takes_batch(&[
            take(p, 1, "first", json!({})),
            take(p, 2, "second", json!({"weight": 0.9})),
        ])
        .unwrap();
    assert_eq!(n, 2);
    let first = list(&store, json!({"page_id": p, "sort_by": "weight"}));
    assert_eq!(claims(&first), ["second", "first"]);
    let created = first[1]["created_at"].clone();

    // Same values: nothing moves. A changed weight updates in place and keeps created_at.
    store
        .add_takes_batch(&[take(p, 1, "first", json!({"weight": 0.55}))])
        .unwrap();
    let rows = list(&store, json!({"page_id": p, "holder": "garry"}));
    let first = rows.iter().find(|r| r["row_num"] == 1).unwrap();
    assert!((first["weight"].as_f64().unwrap() - 0.55).abs() < 1e-6);
    assert_eq!(first["created_at"], created);
    assert_ne!(first["updated_at"], first["created_at"]);
    assert_eq!(first["page_slug"], "companies/acme");
}

#[test]
fn a_batch_refuses_duplicates_bad_weights_nulls_and_missing_pages() {
    let dir = TempDir::new("takes-batch-errors");
    let store = open(&dir);
    let p = page(&store, "default", "a", json!({}));
    let dup = store
        .add_takes_batch(&[take(p, 1, "x", json!({})), take(p, 1, "y", json!({}))])
        .unwrap_err();
    assert_eq!(code(dup), CONSTRAINT_VIOLATION);
    let weight = store
        .add_takes_batch(&[take(p, 1, "x", json!({"weight": 1.5}))])
        .unwrap_err();
    assert_eq!(code(weight), CONSTRAINT_VIOLATION);
    let null = store
        .add_takes_batch(&[take(p, 1, "x", json!({"holder": null}))])
        .unwrap_err();
    assert_eq!(code(null), CONSTRAINT_VIOLATION);
    let fk = store
        .add_takes_batch(&[take(p + 99, 1, "x", json!({}))])
        .unwrap_err();
    assert_eq!(code(fk), CONSTRAINT_VIOLATION);
    let int4 = store
        .add_takes_batch(&[take(p, 1 << 40, "x", json!({}))])
        .unwrap_err();
    assert_eq!(code(int4), INVALID_ARGUMENT);
    // A failed batch writes nothing.
    assert!(list(&store, json!({})).is_empty());
}

#[test]
fn list_filters_sort_and_page() {
    let dir = TempDir::new("takes-list");
    let store = open(&dir);
    let p = page(&store, "default", "a", json!({}));
    store
        .add_takes_batch(&[
            take(
                p,
                1,
                "t-high",
                json!({"since_date": "2025-01-01", "weight": 0.9}),
            ),
            take(
                p,
                2,
                "t-low",
                json!({"since_date": "2026-02-01", "weight": 0.1}),
            ),
            take(p, 3, "t-undated", json!({})),
            take(
                p,
                4,
                "t-month",
                json!({"since_date": "2026-01", "holder": "alice"}),
            ),
            take(p, 5, "t-off", json!({"active": false, "kind": "fact"})),
        ])
        .unwrap();
    assert_eq!(
        claims(&list(&store, json!({"sort_by": "since_date"}))),
        ["t-low", "t-month", "t-high", "t-undated"]
    );
    assert_eq!(
        claims(&list(
            &store,
            json!({"sort_by": "since_date", "oldest_first": true})
        )),
        ["t-high", "t-month", "t-low", "t-undated"]
    );
    assert_eq!(
        claims(&list(
            &store,
            json!({"sort_by": "since_date", "since_on_or_before": "2026-01-15"})
        )),
        ["t-month", "t-high"]
    );
    assert_eq!(
        claims(&list(
            &store,
            json!({"sort_by": "since_date", "limit": 2, "offset": 1})
        )),
        ["t-month", "t-high"]
    );
    assert_eq!(claims(&list(&store, json!({"active": false}))), ["t-off"]);
    assert_eq!(
        claims(&list(&store, json!({"allow_list": ["alice"]}))),
        ["t-month"]
    );
    assert!(list(&store, json!({"allow_list": []})).is_empty());
    assert!(list(&store, json!({"allow_list": [null]})).is_empty());
    let bad = store.list_takes(&de(json!({"offset": "NaN"}))).unwrap_err();
    assert_eq!(code(bad), INVALID_ARGUMENT);
}

#[test]
fn eligible_only_hides_deleted_and_quarantined_pages() {
    let dir = TempDir::new("takes-eligible");
    let store = open(&dir);
    let live = page(&store, "default", "live", json!({}));
    let quarantined = page(&store, "default", "q", json!({"quarantine": false}));
    let gone = page(&store, "default", "gone", json!({}));
    store
        .add_takes_batch(&[
            take(live, 1, "live rust", json!({})),
            take(quarantined, 1, "quarantined rust", json!({})),
            take(gone, 1, "gone rust", json!({})),
        ])
        .unwrap();
    store.soft_delete_page("gone", Some("default")).unwrap();
    assert_eq!(list(&store, json!({})).len(), 3);
    assert_eq!(
        claims(&list(&store, json!({"eligible_only": true}))),
        ["live rust"]
    );
    let hits = store
        .search_takes(&de::<SearchTakesOptions>(
            json!({"query": "rust", "eligible_only": true}),
        ))
        .unwrap();
    assert_eq!(hits.len(), 1);
}

#[test]
fn active_takes_for_pages_and_source_scope() {
    let dir = TempDir::new("takes-active");
    let store = open(&dir);
    store
        .upsert_source(&de::<SourceInput>(json!({"id": "side"})))
        .unwrap();
    let a = page(&store, "default", "a", json!({}));
    let b = page(&store, "side", "b", json!({}));
    store
        .add_takes_batch(&[
            take(a, 1, "a1", json!({})),
            take(a, 2, "a2", json!({"active": false})),
            take(b, 1, "b1", json!({})),
        ])
        .unwrap();
    let rows = store
        .list_active_takes_for_pages(&de::<ActiveTakesInput>(json!({"page_ids": [a, b, a]})))
        .unwrap();
    assert_eq!(claims(&rows), ["a1", "b1"]);
    assert_eq!(
        claims(&list(&store, json!({"source_ids": ["side"]}))),
        ["b1"]
    );
}

#[test]
fn search_scores_by_word_similarity() {
    let dir = TempDir::new("takes-search");
    let store = open(&dir);
    let p = page(&store, "default", "a", json!({}));
    store
        .add_takes_batch(&[
            take(p, 1, "Rust will win systems", json!({})),
            take(p, 2, "Bob writes rust daily", json!({"holder": "alice"})),
            take(p, 3, "Python everywhere", json!({})),
        ])
        .unwrap();
    let search = |v: Value| store.search_takes(&de::<SearchTakesOptions>(v)).unwrap();
    assert_eq!(search(json!({"query": "rust"})).len(), 2);
    let alice = search(json!({"query": "rust", "allow_list": ["alice"]}));
    assert_eq!(claims(&alice), ["Bob writes rust daily"]);
    assert!(alice[0]["score"].as_f64().unwrap() > 0.6);
    assert!(search(json!({"query": "zzzzqqqq"})).is_empty());
}

#[test]
fn update_and_supersede() {
    let dir = TempDir::new("takes-update");
    let store = open(&dir);
    let p = page(&store, "default", "a", json!({}));
    store
        .add_takes_batch(&[take(p, 1, "old", json!({"source": "s"}))])
        .unwrap();
    let update = |v: Value| store.update_take(&de::<UpdateTakeInput>(v));
    assert!(update(json!({"page_id": p, "row_num": 1, "weight": 0.8})).unwrap());
    assert!(!update(json!({"page_id": p, "row_num": 9, "weight": 0.8})).unwrap());
    assert_eq!(
        code(update(json!({"page_id": p, "row_num": 1, "weight": 2.0})).unwrap_err()),
        CONSTRAINT_VIOLATION
    );
    let row = &list(&store, json!({}))[0];
    assert!((row["weight"].as_f64().unwrap() - 0.8).abs() < 1e-6);
    assert_eq!(row["source"], "s");

    let supersede = |old: i64| {
        store
            .supersede_take(&de::<SupersedeTakeInput>(json!({
                "page_id": p, "old_row": old, "claim": "new", "kind": "bet", "holder": "garry",
                "weight": 0.6, "active": true,
            })))
            .unwrap()
    };
    let out = supersede(1);
    assert_eq!(out["status"], "ok");
    assert_eq!(out["new_row"], 2);
    assert_eq!(supersede(7)["status"], "not_found");
    let old = &list(&store, json!({"active": false}))[0];
    assert_eq!(old["superseded_by"], 2);
    assert_eq!(claims(&list(&store, json!({}))), ["new"]);
}

#[test]
fn resolve_checks_consistency_and_is_immutable() {
    let dir = TempDir::new("takes-resolve");
    let store = open(&dir);
    let p = page(&store, "default", "a", json!({}));
    store
        .add_takes_batch(&[take(p, 1, "x", json!({})), take(p, 2, "y", json!({}))])
        .unwrap();
    let resolve = |row: i64, r: Value| {
        store.resolve_take(&de::<ResolveTakeInput>(
            json!({"page_id": p, "row_num": row, "resolution": r}),
        ))
    };
    assert_eq!(
        code(resolve(1, json!({"quality": "partial", "outcome": true})).unwrap_err()),
        CONSTRAINT_VIOLATION
    );
    assert_eq!(
        code(resolve(1, json!({"quality": "maybe"})).unwrap_err()),
        CONSTRAINT_VIOLATION
    );
    assert_eq!(
        resolve(
            1,
            json!({"quality": "correct", "outcome": true, "value": 1_200_000.0})
        )
        .unwrap(),
        "ok"
    );
    assert_eq!(
        resolve(1, json!({"quality": "incorrect", "outcome": false})).unwrap(),
        "resolved"
    );
    assert_eq!(
        resolve(9, json!({"quality": "correct", "outcome": true})).unwrap(),
        "not_found"
    );
    let row = &list(&store, json!({"resolved": true}))[0];
    assert_eq!(row["resolved_quality"], "correct");
    assert_eq!(row["resolved_value"], 1_200_000.0);
    // A resolved take cannot be superseded.
    let out = store
        .supersede_take(&de::<SupersedeTakeInput>(json!({
            "page_id": p, "old_row": 1, "claim": "n", "kind": "bet", "holder": "garry", "weight": 0.5,
        })))
        .unwrap();
    assert_eq!(out["status"], "resolved");
    assert_eq!(
        resolve(2, json!({"quality": "unresolvable"})).unwrap(),
        "ok"
    );
}

#[test]
fn scorecard_and_calibration() {
    let dir = TempDir::new("takes-score");
    let store = open(&dir);
    let p = page(&store, "default", "companies/acme", json!({}));
    let q = page(&store, "default", "people/bob", json!({}));
    store
        .add_takes_batch(&[
            take(p, 1, "a", json!({"weight": 0.9})),
            take(p, 2, "b", json!({"weight": 0.95})),
            take(p, 3, "c", json!({"weight": 0.2})),
            take(q, 1, "d", json!({"weight": 0.5})),
        ])
        .unwrap();
    for (pid, row, quality, outcome) in [
        (p, 1, "correct", Some(true)),
        (p, 2, "incorrect", Some(false)),
        (p, 3, "partial", None),
    ] {
        store
            .resolve_take(&de::<ResolveTakeInput>(json!({
                "page_id": pid, "row_num": row,
                "resolution": {"quality": quality, "outcome": outcome},
            })))
            .unwrap();
    }
    let card = store.get_scorecard(&ScorecardOptions::default()).unwrap();
    assert_eq!(card["total_bets"], 4);
    assert_eq!(card["resolved"], 3);
    assert_eq!(card["correct"], 1);
    assert_eq!(card["incorrect"], 1);
    assert_eq!(card["partial"], 1);
    // Brier over the binary rows: ((0.9-1)^2 + (0.95-0)^2) / 2.
    let want = (0.01_f64 + 0.9025) / 2.0;
    assert!((card["brier"].as_f64().unwrap() - want).abs() < 1e-6);
    let scoped = store
        .get_scorecard(&de(json!({"domain_prefix": "people/"})))
        .unwrap();
    assert_eq!(scoped["total_bets"], 1);
    assert!(scoped["brier"].is_null());

    let curve = store
        .get_calibration_curve(&CalibrationOptions::default())
        .unwrap();
    assert_eq!(curve.len(), 1);
    assert!((curve[0]["bucket_lo"].as_f64().unwrap() - 0.9).abs() < 1e-6);
    assert_eq!(curve[0]["n"], 2);
    let bad = store
        .get_calibration_curve(&de(json!({"bucket_size": 5.0})))
        .unwrap_err();
    assert_eq!(code(bad), INVALID_ARGUMENT);
}

#[test]
fn evidence_inserts_once_and_checks_both_keys() {
    let dir = TempDir::new("takes-evidence");
    let store = open(&dir);
    let p = page(&store, "default", "a", json!({}));
    let s = page(&store, "default", "synth", json!({}));
    store
        .add_takes_batch(&[take(p, 1, "x", json!({})), take(p, 2, "y", json!({}))])
        .unwrap();
    let ev = |row: i64, synth: u64| -> EvidenceInput {
        de(
            json!({"synthesis_page_id": synth, "take_page_id": p, "take_row_num": row, "citation_index": 1}),
        )
    };
    assert_eq!(
        store.add_synthesis_evidence(&[ev(1, s), ev(2, s)]).unwrap(),
        2
    );
    assert_eq!(store.add_synthesis_evidence(&[ev(1, s)]).unwrap(), 0);
    assert_eq!(
        code(store.add_synthesis_evidence(&[ev(9, s)]).unwrap_err()),
        CONSTRAINT_VIOLATION
    );
    assert_eq!(
        code(store.add_synthesis_evidence(&[ev(1, s + 99)]).unwrap_err()),
        CONSTRAINT_VIOLATION
    );
    // Deleting the take page drops its takes and their evidence.
    store.delete_page("a", Some("default")).unwrap();
    assert!(list(&store, json!({"active": false})).is_empty());
    assert!(list(&store, json!({})).is_empty());
}
