//! Salience: `batchLoadEmotionalInputs`, `setEmotionalWeightBatch`, `getRecentSalience` and
//! `getSalienceScores`, matched to the PGLite engine.

mod common;

use common::TempDir;
use gbrain_store::env::Env;
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::salience::{EmotionalWeightRow, RecentSalienceOptions, SalienceScoresInput};
use gbrain_store::sources::SourceInput;
use gbrain_store::takes::TakeInput;
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
const DAY: i64 = 86_400_000_000;

fn open(dir: &TempDir) -> (Store, Arc<Clock>) {
    let clock = Arc::new(Clock(AtomicI64::new(T0)));
    let kv = RedbKv::open_path(&dir.path().join("records.redb")).unwrap();
    let store = Store::open_kv(Arc::new(kv), clock.clone(), OpenOptions::default()).unwrap();
    (store, clock)
}

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(store: &Store, source: &str, slug: &str, frontmatter: Value) -> u64 {
    let input: PageInput = de(json!({
        "type": "note", "title": slug, "compiled_truth": "x", "frontmatter": frontmatter,
    }));
    let opts: PutPageOptions = de(json!({"sourceId": source}));
    store.put_page(slug, &input, &opts).unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn source(store: &Store, id: &str) {
    let input: SourceInput = de(json!({"id": id, "name": id}));
    store.upsert_source(&input).unwrap();
}

fn takes(store: &Store, rows: &[(u64, i64, &str, f64, bool)]) {
    let rows: Vec<TakeInput> = rows
        .iter()
        .map(|(p, r, holder, weight, active)| {
            de(json!({
                "page_id": p, "row_num": r, "claim": format!("c{p}-{r}"), "kind": "take",
                "holder": holder, "weight": weight, "active": active,
            }))
        })
        .collect();
    store.add_takes_batch(&rows).unwrap();
}

fn weights(store: &Store, rows: Value) -> u64 {
    let rows: Vec<EmotionalWeightRow> = de(rows);
    store.set_emotional_weight_batch(&rows).unwrap()
}

/// `getRecentSalience` with the flat recency term and a 14-day window ending at the clock.
fn recent(store: &Store, clock: &Clock, extra: Value) -> Vec<Value> {
    let mut opts = json!({
        "boundary_ms": (clock.0.load(Ordering::SeqCst) - 14 * DAY) as f64 / 1000.0, "limit": 20,
        "exclude_briefings": true,
        "recency": {"fallback_halflife_days": 1, "fallback_coefficient": 1},
    });
    for (k, v) in extra.as_object().unwrap() {
        opts[k] = v.clone();
    }
    let opts: RecentSalienceOptions = de(opts);
    store.get_recent_salience(&opts).unwrap()
}

fn ids(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .map(|r| {
            format!(
                "{}:{}",
                r["source_id"].as_str().unwrap(),
                r["slug"].as_str().unwrap()
            )
        })
        .collect()
}

fn scores(store: &Store, input: Value) -> Vec<(String, f64)> {
    let input: SalienceScoresInput = de(input);
    store
        .get_salience_scores(&input)
        .unwrap()
        .iter()
        .map(|r| {
            (
                format!(
                    "{}::{}",
                    r["source_id"].as_str().unwrap(),
                    r["slug"].as_str().unwrap()
                ),
                r["score"].as_f64().unwrap(),
            )
        })
        .collect()
}

#[test]
fn set_emotional_weight_batch_counts_changed_pages_by_source_and_slug() {
    let dir = TempDir::new("salience-1");
    let (store, _) = open(&dir);
    source(&store, "other");
    page(&store, "default", "notes/a", json!({}));
    page(&store, "other", "notes/a", json!({}));
    let changed = weights(
        &store,
        json!([
            {"slug": "notes/a", "source_id": "default", "weight": 0.9},
            {"slug": "notes/a", "source_id": "other", "weight": 0.4},
            {"slug": "notes/missing", "source_id": "default", "weight": 1},
            {"slug": "notes/a", "source_id": "default", "weight": 0.1},
        ]),
    );
    assert_eq!(
        changed, 2,
        "a missing page and a repeated page are not counted"
    );
    let same = json!([{"slug": "notes/a", "source_id": "default", "weight": 0.9}]);
    assert_eq!(weights(&store, same), 0);
    let zero = json!([{"slug": "notes/a", "source_id": "other", "weight": 0}]);
    assert_eq!(weights(&store, zero.clone()), 1);
    assert_eq!(weights(&store, zero), 0);
    assert_eq!(weights(&store, json!([])), 0);
}

#[test]
fn set_emotional_weight_batch_rejects_null_and_out_of_range_weights() {
    let dir = TempDir::new("salience-2");
    let (store, _) = open(&dir);
    page(&store, "default", "notes/a", json!({}));
    let rows: Vec<EmotionalWeightRow> =
        de(json!([{"slug": "notes/a", "source_id": "default", "weight": null}]));
    let err = store.set_emotional_weight_batch(&rows).unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    let rows: Vec<EmotionalWeightRow> =
        de(json!([{"slug": "notes/a", "source_id": "default", "weight": 1e40}]));
    let err = store.set_emotional_weight_batch(&rows).unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    // A null weight for a page that does not exist updates nothing, so nothing fails.
    let rows: Vec<EmotionalWeightRow> =
        de(json!([{"slug": "notes/none", "source_id": "default", "weight": null}]));
    assert_eq!(store.set_emotional_weight_batch(&rows).unwrap(), 0);
}

#[test]
fn batch_load_emotional_inputs_returns_distinct_tags_and_active_takes() {
    let dir = TempDir::new("salience-3");
    let (store, _) = open(&dir);
    let a = page(&store, "default", "people/a", json!({}));
    page(&store, "default", "people/b", json!({}));
    store.add_tag("people/a", "b", Some("default")).unwrap();
    store.add_tag("people/a", "B", Some("default")).unwrap();
    store.add_tag("people/a", "a", Some("default")).unwrap();
    takes(
        &store,
        &[(a, 1, "garry", 0.7, true), (a, 2, "x", 0.5, false)],
    );
    store.soft_delete_page("people/b", Some("default")).unwrap();
    let all = store.batch_load_emotional_inputs(None).unwrap();
    assert_eq!(all.len(), 2);
    let one = store
        .batch_load_emotional_inputs(Some(&["people/a".to_string()]))
        .unwrap();
    assert_eq!(
        one,
        vec![json!({
            "slug": "people/a", "source_id": "default", "tags": ["B", "a", "b"],
            "takes": [{"holder": "garry", "weight": 0.7, "kind": "take", "active": true}],
        })]
    );
    let deleted = store
        .batch_load_emotional_inputs(Some(&["people/b".to_string()]))
        .unwrap();
    assert_eq!(deleted[0]["tags"], json!([]));
    assert_eq!(deleted[0]["takes"], json!([]));
    assert!(
        store
            .batch_load_emotional_inputs(Some(&[]))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn get_recent_salience_ranks_live_pages_and_applies_every_filter() {
    let dir = TempDir::new("salience-4");
    let (store, clock) = open(&dir);
    source(&store, "other");
    let calm = page(&store, "default", "notes/calm", json!({}));
    page(&store, "default", "notes/charged", json!({}));
    page(&store, "other", "notes/charged", json!({}));
    page(&store, "default", "briefings/daily", json!({}));
    page(&store, "default", "people/p", json!({}));
    page(
        &store,
        "default",
        "notes/hidden",
        json!({"quarantine": true}),
    );
    page(&store, "default", "notes/gone", json!({}));
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    takes(
        &store,
        &[(calm, 1, "garry", 0.5, true), (calm, 2, "alice", 0.7, true)],
    );
    weights(
        &store,
        json!([
            {"slug": "notes/charged", "source_id": "default", "weight": 0.9},
            {"slug": "notes/charged", "source_id": "other", "weight": 0.4},
            {"slug": "people/p", "source_id": "default", "weight": 0.2},
        ]),
    );
    let all = recent(&store, &clock, json!({}));
    assert_eq!(
        ids(&all),
        vec![
            "default:notes/charged",
            "other:notes/charged",
            "default:notes/calm",
            "default:people/p"
        ]
    );
    let top = &all[0];
    assert_eq!(top["emotional_weight"], json!(0.9));
    assert!((top["score"].as_f64().unwrap() - (f64::from(0.9f32) * 5.0 + 1.0)).abs() < 1e-6);
    let calm_row = &all[2];
    assert_eq!(calm_row["take_count"], json!(2));
    assert!((calm_row["take_avg_weight"].as_f64().unwrap() - 0.6).abs() < 1e-6);

    let briefings = recent(
        &store,
        &clock,
        json!({"slug_prefix": "briefings", "exclude_briefings": false}),
    );
    assert_eq!(ids(&briefings), vec!["default:briefings/daily"]);
    let scoped = recent(&store, &clock, json!({"source_ids": ["other"]}));
    assert_eq!(ids(&scoped), vec!["other:notes/charged"]);
    assert_eq!(recent(&store, &clock, json!({"limit": 2})).len(), 2);

    // A restricted read ignores the weight and counts only the allowed holders' takes.
    let restricted = recent(&store, &clock, json!({"holders": ["alice"]}));
    let calm_row = restricted
        .iter()
        .find(|r| r["slug"] == "notes/calm")
        .unwrap();
    assert_eq!(calm_row["take_count"], json!(1));
    assert!(
        restricted
            .iter()
            .all(|r| r["emotional_weight"] == json!(0.0))
    );
    assert_eq!(ids(&restricted)[0], "default:notes/calm");
}

#[test]
fn get_recent_salience_window_uses_the_touch_time_unless_restricted() {
    let dir = TempDir::new("salience-5");
    let (store, clock) = open(&dir);
    page(&store, "default", "notes/old", json!({}));
    clock.0.fetch_add(30 * DAY, Ordering::SeqCst);
    assert!(recent(&store, &clock, json!({})).is_empty());
    weights(
        &store,
        json!([{"slug": "notes/old", "source_id": "default", "weight": 0.5}]),
    );
    let rows = recent(&store, &clock, json!({}));
    assert_eq!(ids(&rows), vec!["default:notes/old"]);
    // The recency term reads updated_at, which the weight write left 30 days back.
    let expected = f64::from(0.5f32) * 5.0 + 1.0 / 31.0;
    assert!((rows[0]["score"].as_f64().unwrap() - expected).abs() < 1e-6);
    assert!(recent(&store, &clock, json!({"holders": []})).is_empty());
}

#[test]
fn get_salience_scores_combines_weight_and_takes_and_applies_the_read_policy() {
    let dir = TempDir::new("salience-6");
    let (store, _) = open(&dir);
    page(&store, "default", "sal/plain", json!({}));
    page(&store, "default", "sal/weighted", json!({}));
    let taken = page(&store, "default", "sal/taken", json!({}));
    page(&store, "default", "sal/hidden", json!({"quarantine": "x"}));
    weights(
        &store,
        json!([{"slug": "sal/weighted", "source_id": "default", "weight": 0.4}]),
    );
    takes(
        &store,
        &[
            (taken, 1, "garry", 0.5, true),
            (taken, 2, "alice", 0.5, true),
        ],
    );
    let refs = json!(
        [
            "sal/plain",
            "sal/weighted",
            "sal/taken",
            "sal/missing",
            "sal/hidden"
        ]
        .iter()
        .map(|s| json!({"slug": s, "source_id": "default"}))
        .collect::<Vec<_>>()
    );
    let open_read = scores(&store, json!({"refs": refs}));
    assert_eq!(
        open_read.len(),
        4,
        "the quarantined page shows without a read policy"
    );
    assert_eq!(open_read[0], ("default::sal/plain".to_string(), 0.0));
    assert!((open_read[1].1 - f64::from(0.4f32) * 5.0).abs() < 1e-12);
    assert!((open_read[2].1 - 3f64.ln()).abs() < 1e-12);
    let live = scores(&store, json!({"refs": refs, "live": true}));
    assert_eq!(live.len(), 3);
    let restricted = scores(
        &store,
        json!({"refs": refs, "live": true, "holders": ["alice"]}),
    );
    assert_eq!(restricted[1], ("default::sal/weighted".to_string(), 0.0));
    assert!((restricted[2].1 - 2f64.ln()).abs() < 1e-12);
    let scoped = scores(&store, json!({"refs": refs, "source_ids": ["other"]}));
    assert!(scoped.is_empty());
}

#[test]
fn salience_scores_under_exclude_private_skip_the_pages_the_policy_hides() {
    let dir = TempDir::new("salience-private");
    let (store, _) = open(&dir);
    page(&store, "default", "notes/open", json!({}));
    page(
        &store,
        "default",
        "notes/private",
        json!({"visibility": "private"}),
    );
    page(
        &store,
        "default",
        "notes/alias",
        json!({"access": "private"}),
    );
    let refs = json!([
        {"slug": "notes/open", "source_id": "default"},
        {"slug": "notes/private", "source_id": "default"},
        {"slug": "notes/alias", "source_id": "default"},
    ]);
    let slugs = |extra: Value| -> Vec<String> {
        let mut input = json!({"refs": refs, "live": true});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        scores(&store, input).into_iter().map(|(k, _)| k).collect()
    };
    let all = [
        "default::notes/open",
        "default::notes/private",
        "default::notes/alias",
    ];
    assert_eq!(slugs(json!({})), all, "no policy hides nothing private");
    let policy = json!({"honorAliases": true, "entityPrivacy": true, "ownerOnly": "lineage"});
    assert_eq!(
        slugs(json!({"exclude_private": policy})),
        ["default::notes/open"]
    );
    let visibility_only =
        json!({"honorAliases": false, "entityPrivacy": true, "ownerOnly": "lineage"});
    assert_eq!(
        slugs(json!({"exclude_private": visibility_only})),
        ["default::notes/open", "default::notes/alias"],
        "without the alias keys only `visibility` hides a page"
    );
}
