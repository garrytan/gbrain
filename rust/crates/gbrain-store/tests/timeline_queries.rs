//! The Life Chronicle reads (timeline_queries). Event projections are written here as raw timeline
//! records, standing in for upsertEventProjection until the core timeline write helpers land; the
//! expected rows follow the PGLite SQL in src/core/engine-sql/timeline.ts.

mod common;

use common::TempDir;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::sources::SourceInput;
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput};
use gbrain_store::timeline_queries::{ChronicleOptions, LastSeenOptions, OnThisDayOptions};
use gbrain_store::{Kv, OpenOptions, Store, SystemEnv, keys};
use serde_json::{Value, json};
use std::sync::Arc;

struct Brain {
    _dir: TempDir,
    kv: Arc<RedbKv>,
    store: Store,
    next_id: u64,
}

impl Brain {
    fn new(name: &str) -> Self {
        let dir = TempDir::new(name);
        let kv = Arc::new(RedbKv::open_path(&dir.path().join("records.redb")).unwrap());
        let store =
            Store::open_kv(kv.clone(), Arc::new(SystemEnv), OpenOptions::default()).unwrap();
        Brain {
            _dir: dir,
            kv,
            store,
            next_id: 10_000,
        }
    }

    fn source(&self, id: &str) {
        let input: SourceInput = serde_json::from_value(json!({"id": id, "name": id})).unwrap();
        self.store.upsert_source(&input).unwrap();
    }

    fn page(&self, slug: &str, source: &str, extra: Value) -> u64 {
        let mut body =
            json!({"type": "note", "title": slug, "compiled_truth": format!("{slug} body")});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let input: PageInput = serde_json::from_value(body).unwrap();
        let options: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
        let page = self.store.put_page(slug, &input, &options).unwrap();
        page["id"].as_u64().unwrap()
    }

    fn event(&self, slug: &str, source: &str, effective: &str, event: Value) -> u64 {
        self.page(
            slug,
            source,
            json!({"type": "event", "frontmatter": {"event": event}, "effective_date": effective,
                   "effective_date_source": "event_date"}),
        )
    }

    /// What upsertEventProjection inserts: an entry on the depth page that points at the event.
    fn project(&mut self, page_id: u64, event_page_id: u64, date: &str, summary: &str) {
        self.next_id += 1;
        let id = self.next_id;
        let record = json!({
            "id": id, "page_id": page_id, "date": date, "source": "life-chronicle:event:x",
            "summary": summary, "detail": "", "event_page_id": event_page_id, "created_at_us": 0,
        });
        let mut tx = self.kv.begin_write().unwrap();
        tx.put(
            &keys::timeline(page_id, date, id),
            &serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
        tx.commit().unwrap();
    }

    fn entry(&self, slug: &str, date: &str, summary: &str) {
        let input: TimelineInput =
            serde_json::from_value(json!({"date": date, "summary": summary, "source": "diary"}))
                .unwrap();
        assert!(
            self.store
                .add_timeline_entry(slug, &input, &AddTimelineOptions::default())
                .unwrap()
        );
    }
}

fn chronicle(opts: Value) -> ChronicleOptions {
    serde_json::from_value(opts).unwrap()
}

fn field(rows: &[Value], key: &str) -> Vec<Value> {
    rows.iter().map(|r| r[key].clone()).collect()
}

/// Two depth pages and three events over three days, the later event of a day projected first.
fn seed(name: &str) -> Brain {
    let mut b = Brain::new(name);
    let d18 = b.page("life/diary/2026-06-18", "default", json!({}));
    let d20 = b.page("life/diary/2026-06-20", "default", json!({}));
    let e1 = b.event(
        "life/events/2026-06-18-001",
        "default",
        "2026-06-18T09:00:00.250Z",
        json!({"kind": "meeting", "who": ["people/sarah-chen"]}),
    );
    let e2 = b.event(
        "life/events/2026-06-18-002",
        "default",
        "2026-06-18T15:00:00Z",
        json!({"kind": "commitment", "who": ["[[people/sarah-chen|Sarah]]"]}),
    );
    let e3 = b.event(
        "life/events/2026-06-20-001",
        "default",
        "2026-06-20T10:00:00Z",
        json!({"kind": "meeting", "who": ["people/bob-jones"]}),
    );
    b.project(d18, e2, "2026-06-18", "Promised the deck");
    b.project(d18, e1, "2026-06-18", "Met Sarah");
    b.project(d20, e3, "2026-06-20", "Call with Bob");
    b
}

#[test]
fn a_day_reads_in_event_order_and_a_week_spans_monday_to_sunday() {
    let b = seed("tq-day");
    let day = b
        .store
        .get_timeline_for_date("2026-06-18", &chronicle(json!({})))
        .unwrap();
    assert_eq!(
        field(&day, "event_slug"),
        vec![
            json!("life/events/2026-06-18-001"),
            json!("life/events/2026-06-18-002")
        ]
    );
    assert_eq!(day[0]["effective_date"], json!("2026-06-18 09:00:00.25+00"));
    assert_eq!(day[1]["effective_date"], json!("2026-06-18 15:00:00+00"));
    assert_eq!(day[0]["kind"], json!("meeting"));
    assert_eq!(day[0]["page_slug"], json!("life/diary/2026-06-18"));
    assert_eq!(day[0]["trust_tier"], json!("unknown"));
    // 2026-06-18 is a Thursday: its week is 2026-06-15 .. 2026-06-21.
    let week = b
        .store
        .get_timeline_for_date("2026-06-21", &chronicle(json!({"week": true})))
        .unwrap();
    assert_eq!(
        field(&week, "date"),
        vec![
            json!("2026-06-18"),
            json!("2026-06-18"),
            json!("2026-06-20")
        ]
    );
    let next_week = b
        .store
        .get_timeline_for_date("2026-06-22", &chronicle(json!({"week": true})))
        .unwrap();
    assert!(next_week.is_empty());
    let limited = b
        .store
        .get_timeline_for_date("2026-06-18", &chronicle(json!({"limit": 1})))
        .unwrap();
    assert_eq!(limited.len(), 1);
    let none = b
        .store
        .get_timeline_for_date("2026-06-18", &chronicle(json!({"limit": 0})))
        .unwrap();
    assert!(none.is_empty());
    let other = b
        .store
        .get_timeline_for_date(
            "2026-06-18",
            &chronicle(json!({"sourceId": "no-such-source"})),
        )
        .unwrap();
    assert!(other.is_empty());
    assert_eq!(
        b.store
            .get_timeline_for_date("2026-06-18", &chronicle(json!({"limit": -1})))
            .unwrap_err()
            .code,
        "invalid_argument"
    );
    assert_eq!(
        b.store
            .get_timeline_for_date("not a date", &chronicle(json!({})))
            .unwrap_err()
            .code,
        "invalid_argument"
    );
}

#[test]
fn since_filters_by_date_and_kind() {
    let b = seed("tq-since");
    let since19 = b
        .store
        .get_since("2026-06-19", &chronicle(json!({})))
        .unwrap();
    assert_eq!(
        field(&since19, "event_slug"),
        vec![json!("life/events/2026-06-20-001")]
    );
    let commitments = b
        .store
        .get_since("2026-06-18", &chronicle(json!({"kind": "commitment"})))
        .unwrap();
    assert_eq!(
        field(&commitments, "event_slug"),
        vec![json!("life/events/2026-06-18-002")]
    );
    let meetings = b
        .store
        .get_since(
            "2026-06-01",
            &chronicle(json!({"kind": "meeting", "limit": 1})),
        )
        .unwrap();
    assert_eq!(
        field(&meetings, "event_slug"),
        vec![json!("life/events/2026-06-18-001")]
    );
    assert!(
        b.store
            .get_since("2030-01-01", &chronicle(json!({})))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn an_event_page_outside_the_scope_nulls_out_and_a_deleted_one_hides_the_row() {
    let mut b = Brain::new("tq-scope");
    b.source("alt");
    let depth = b.page("life/diary/2026-07-01", "default", json!({}));
    let foreign = b.event(
        "life/events/alt-1",
        "alt",
        "2026-07-01T08:00:00Z",
        json!({"kind": "call"}),
    );
    let gone = b.event(
        "life/events/gone",
        "default",
        "2026-07-01T09:00:00Z",
        json!({"kind": "call"}),
    );
    b.project(depth, foreign, "2026-07-01", "Foreign event");
    b.project(depth, gone, "2026-07-01", "Deleted event");
    b.store
        .soft_delete_page("life/events/gone", Some("default"))
        .unwrap();

    let scoped = b
        .store
        .get_timeline_for_date("2026-07-01", &chronicle(json!({"sourceId": "default"})))
        .unwrap();
    assert_eq!(field(&scoped, "summary"), vec![json!("Foreign event")]);
    assert_eq!(scoped[0]["event_slug"], Value::Null);
    assert_eq!(scoped[0]["effective_date"], Value::Null);
    assert_eq!(scoped[0]["kind"], Value::Null);
    assert_eq!(scoped[0]["event_page_id"], json!(foreign));

    let unscoped = b
        .store
        .get_timeline_for_date("2026-07-01", &chronicle(json!({})))
        .unwrap();
    assert_eq!(unscoped[0]["event_slug"], json!("life/events/alt-1"));
    // A list beats the scalar.
    let listed = b
        .store
        .get_timeline_for_date(
            "2026-07-01",
            &chronicle(json!({"sourceId": "alt", "sourceIds": ["default"]})),
        )
        .unwrap();
    assert_eq!(listed.len(), 1);
    // A soft-deleted depth page hides its rows.
    b.store
        .soft_delete_page("life/diary/2026-07-01", Some("default"))
        .unwrap();
    assert!(
        b.store
            .get_timeline_for_date("2026-07-01", &chronicle(json!({})))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn on_this_day_reads_earlier_years_newest_first() {
    let b = Brain::new("tq-otd");
    b.page("life/diary/history", "default", json!({}));
    for (date, summary) in [
        ("2024-06-18", "two years ago"),
        ("2025-06-18", "last year"),
        ("2026-06-18", "this year"),
        ("2025-06-19", "wrong day"),
        ("2023-06-18", "three years ago"),
        ("2025-06-18", "last year again"),
    ] {
        b.entry("life/diary/history", date, summary);
    }
    let options: OnThisDayOptions = serde_json::from_value(json!({"date": "2026-06-18"})).unwrap();
    let rows = b.store.get_on_this_day(&options).unwrap();
    assert_eq!(
        field(&rows, "summary"),
        vec![
            json!("last year"),
            json!("last year again"),
            json!("two years ago"),
            json!("three years ago")
        ]
    );
    assert_eq!(rows[0]["event_slug"], Value::Null);
    let limited: OnThisDayOptions =
        serde_json::from_value(json!({"date": "2026-06-18", "limit": 2})).unwrap();
    assert_eq!(b.store.get_on_this_day(&limited).unwrap().len(), 2);
}

#[test]
fn last_seen_matches_the_own_page_or_an_exact_who() {
    let mut b = seed("tq-last");
    b.page("people/own-page", "default", json!({}));
    b.entry("people/own-page", "2026-06-10", "Own entry");
    // A slug that only prefixes another is never a sighting.
    let d = b.page("life/diary/2026-06-22", "default", json!({}));
    let e = b.event("life/events/2026-06-22-001", "default", "2026-06-22T10:00:00Z",
        json!({"kind": "meeting", "who": ["people/sarah-chen-2", "[[people/sarah-chenx]]", 7, null]}));
    b.project(d, e, "2026-06-22", "Someone else");
    let seen = |slug: &str, asof: &str| {
        let options: LastSeenOptions = serde_json::from_value(json!({"asof": asof})).unwrap();
        b.store.get_last_seen(slug, &options).unwrap()
    };
    assert_eq!(
        seen("people/sarah-chen", "2026-06-25"),
        json!({"last_date": "2026-06-18", "last_event_slug": "life/events/2026-06-18-002"})
    );
    assert_eq!(
        seen("people/own-page", "2026-06-25"),
        json!({"last_date": "2026-06-10", "last_event_slug": null})
    );
    assert_eq!(
        seen("people/bob-jones", "2026-06-19"),
        json!({"last_date": null, "last_event_slug": null})
    );
    assert_eq!(seen("7", "2026-06-25")["last_date"], json!("2026-06-22"));
}
