//! The Life Chronicle reads and the event projection write (timeline_queries). Most read cases write
//! event projections as raw timeline records so they can set any shape; the upsert cases go through
//! upsertEventProjection. Expected rows follow the PGLite SQL in src/core/engine-sql/timeline.ts.

mod common;

use common::TempDir;
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::sources::SourceInput;
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput};
use gbrain_store::timeline_queries::{
    ChronicleOptions, EventProjectionInput, LastSeenOptions, OnThisDayOptions,
    TimelineDetailRefresh, TimelineRowRemoval,
};
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

fn upsert(brain: &Brain, opts: Value) -> gbrain_store::Result<Value> {
    let input: EventProjectionInput = serde_json::from_value(opts).unwrap();
    brain.store.upsert_event_projection(&input)
}

fn entries(brain: &Brain, slug: &str) -> Vec<Value> {
    brain
        .store
        .get_timeline(slug, &serde_json::from_value(json!({})).unwrap())
        .unwrap()
}

#[test]
fn upsert_event_projection_inserts_then_updates_in_place() {
    let brain = Brain::new("tq-upsert");
    brain.source("alt");
    brain.page("life/diary/a", "default", json!({}));
    brain.page("life/diary/b", "default", json!({}));
    brain.event(
        "life/events/e",
        "default",
        "2026-06-01T09:00:00Z",
        json!({"kind": "standup"}),
    );
    let base =
        json!({"depthSlug": "life/diary/a", "eventSlug": "life/events/e", "date": "2026-06-01"});
    let with = |extra: Value| {
        let mut v = base.clone();
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        v
    };

    let first = upsert(&brain, with(json!({"summary": "Standup", "detail": "v1"}))).unwrap();
    assert_eq!(first, json!({"projected": true}));
    let inserted = entries(&brain, "life/diary/a");
    assert_eq!(inserted.len(), 1);
    assert_eq!(inserted[0]["source"], "life-chronicle:event:life/events/e");
    let id = inserted[0]["id"].clone();

    // Same (event, date): the entry keeps its id and moves to the new depth page.
    upsert(
        &brain,
        with(json!({"summary": "Revised", "depthSlug": "life/diary/b"})),
    )
    .unwrap();
    assert!(entries(&brain, "life/diary/a").is_empty());
    let moved = entries(&brain, "life/diary/b");
    assert_eq!(moved.len(), 1);
    assert_eq!(moved[0]["id"], id);
    assert_eq!(moved[0]["summary"], "Revised");
    assert_eq!(moved[0]["detail"], "");

    // Another date is another entry; the conflict above consumed one serial value.
    upsert(
        &brain,
        with(json!({"summary": "Next", "date": "2026/06/02", "depthSlug": "life/diary/b"})),
    )
    .unwrap();
    let both = entries(&brain, "life/diary/b");
    assert_eq!(both.len(), 2);
    let ids: Vec<u64> = both.iter().map(|e| e["id"].as_u64().unwrap()).collect();
    assert!(ids.contains(&(id.as_u64().unwrap() + 2)), "{ids:?}");

    for missing in [
        json!({"summary": "x", "depthSlug": "life/diary/nope"}),
        json!({"summary": "x", "eventSlug": "life/events/nope"}),
        json!({"summary": "x", "sourceId": "alt"}),
    ] {
        assert_eq!(
            upsert(&brain, with(missing)).unwrap(),
            json!({"projected": false})
        );
    }
    // The date is checked before the pages are looked up.
    let bad = upsert(
        &brain,
        with(json!({"summary": "x", "date": "2026-02-30", "depthSlug": "nope"})),
    );
    assert_eq!(bad.unwrap_err().code, "invalid_argument");
    let nul = upsert(&brain, with(json!({"summary": "a\u{0}b"})));
    assert_eq!(nul.unwrap_err().code, "invalid_argument");

    // Soft-deleted pages still project (the SQL has no deleted_at test).
    brain
        .store
        .soft_delete_page("life/diary/a", Some("default"))
        .unwrap();
    assert_eq!(
        upsert(
            &brain,
            with(json!({"summary": "Ghost", "date": "2026-06-03"}))
        )
        .unwrap(),
        json!({"projected": true})
    );
}

#[test]
fn upsert_event_projection_refuses_a_duplicate_entry_and_keeps_nothing() {
    let brain = Brain::new("tq-upsert-dup");
    brain.page("life/diary/a", "default", json!({}));
    brain.event(
        "life/events/e",
        "default",
        "2026-06-01T09:00:00Z",
        json!({}),
    );
    let plain = TimelineInput {
        date: Some("2026-06-01".into()),
        source: Some("life-chronicle:event:life/events/e".into()),
        summary: Some("Standup".into()),
        detail: None,
    };
    brain
        .store
        .add_timeline_entry("life/diary/a", &plain, &AddTimelineOptions::default())
        .unwrap();
    let error = upsert(
        &brain,
        json!({"depthSlug": "life/diary/a", "eventSlug": "life/events/e", "date": "2026-06-01", "summary": "Standup"}),
    )
    .unwrap_err();
    assert_eq!(error.code, "constraint_violation");
    let kept = entries(&brain, "life/diary/a");
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0]["summary"], "Standup");
}

#[test]
fn deleting_the_event_page_removes_its_projections_and_a_deleted_depth_page_frees_the_slot() {
    let brain = Brain::new("tq-upsert-cascade");
    brain.page("life/diary/a", "default", json!({}));
    brain.page("life/diary/b", "default", json!({}));
    brain.event(
        "life/events/e",
        "default",
        "2026-06-01T09:00:00Z",
        json!({}),
    );
    brain.event(
        "life/events/f",
        "default",
        "2026-06-01T10:00:00Z",
        json!({}),
    );
    for (event, date) in [
        ("life/events/e", "2026-06-01"),
        ("life/events/e", "2026-06-02"),
        ("life/events/f", "2026-06-01"),
    ] {
        upsert(
            &brain,
            json!({"depthSlug": "life/diary/a", "eventSlug": event, "date": date, "summary": format!("{event} {date}")}),
        )
        .unwrap();
    }
    assert_eq!(entries(&brain, "life/diary/a").len(), 3);
    brain
        .store
        .delete_page("life/events/e", Some("default"))
        .unwrap();
    let left = entries(&brain, "life/diary/a");
    assert_eq!(left.len(), 1);
    assert_eq!(left[0]["summary"], "life/events/f 2026-06-01");

    // The depth page goes with its entries; the index row it leaves names nothing, so the next
    // upsert for the same (event, date) inserts a fresh entry.
    brain
        .store
        .delete_page("life/diary/a", Some("default"))
        .unwrap();
    upsert(
        &brain,
        json!({"depthSlug": "life/diary/b", "eventSlug": "life/events/f", "date": "2026-06-01", "summary": "again"}),
    )
    .unwrap();
    let fresh = entries(&brain, "life/diary/b");
    assert_eq!(fresh.len(), 1);
    assert_eq!(fresh[0]["summary"], "again");
}

fn rows_of(brain: &Brain, slug: &str) -> Vec<(u64, String, String)> {
    entries(brain, slug)
        .iter()
        .map(|e| {
            (
                e["id"].as_u64().unwrap(),
                e["date"].as_str().unwrap().to_string(),
                e["summary"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn id_of(brain: &Brain, slug: &str, summary: &str) -> u64 {
    rows_of(brain, slug)
        .into_iter()
        .find(|r| r.2 == summary)
        .unwrap()
        .0
}

fn removals(rows: Value) -> Vec<TimelineRowRemoval> {
    serde_json::from_value(rows).unwrap()
}

fn refreshes(rows: Value) -> Vec<TimelineDetailRefresh> {
    serde_json::from_value(rows).unwrap()
}

#[test]
fn remove_timeline_rows_deletes_only_rows_that_still_match_and_frees_the_dedup_slot() {
    let mut b = Brain::new("tq-remove");
    let page = b.page("people/prune", "default", json!({}));
    let other = b.page("people/prune-other", "default", json!({}));
    let event = b.event(
        "life/events/2026-07-01-001",
        "default",
        "2026-07-01T09:00:00Z",
        json!({"kind": "meeting"}),
    );
    b.project(page, event, "2026-07-01", "Event row");
    b.entry("people/prune", "2026-01-02", "drop me");
    b.entry("people/prune", "2026-02-03", "edited since");
    b.entry("people/prune", "2026-03-04", "kept");
    b.entry("people/prune-other", "2026-01-02", "other page");
    let row = |slug: &str, summary: &str, date: &str, removed: bool| json!({"id": id_of(&b, slug, summary), "date": date, "source": "diary", "summary": summary, "detail": "", "removed": removed});
    let event_row = json!({"id": id_of(&b, "people/prune", "Event row"), "date": "2026-07-01",
        "source": "life-chronicle:event:x", "summary": "Event row", "detail": "", "removed": true});
    let mut stale = row("people/prune", "edited since", "2026-02-03", true);
    stale["detail"] = json!("older text");
    let mut null_source = row("people/prune", "kept", "2026-03-04", true);
    null_source["source"] = Value::Null;
    let out = b
        .store
        .remove_timeline_rows(
            page as i64,
            &removals(json!([
                row("people/prune", "drop me", "2026/01/02", true),
                stale,
                null_source,
                event_row,
                row("people/prune-other", "other page", "2026-01-02", true),
                {"id": 987_654, "date": "2026-01-02", "source": "diary", "summary": "never", "detail": "", "removed": true},
            ])),
        )
        .unwrap();
    assert_eq!(out, json!([{"date": "2026-01-02", "removed": true}]));
    let left: Vec<String> = rows_of(&b, "people/prune")
        .into_iter()
        .map(|r| r.2)
        .collect();
    assert_eq!(left, ["Event row", "kept", "edited since"]);
    assert_eq!(rows_of(&b, "people/prune-other").len(), 1);

    // The dedup slot is free again, and a row named twice goes (and is returned) once.
    b.entry("people/prune", "2026-01-02", "drop me");
    let kept = row("people/prune", "kept", "2026-03-04", false);
    let out = b
        .store
        .remove_timeline_rows(page as i64, &removals(json!([kept.clone(), kept])))
        .unwrap();
    assert_eq!(out, json!([{"date": "2026-03-04", "removed": false}]));
    // Another page's id, no rows and a negative page id delete nothing.
    let drop_me = row("people/prune", "drop me", "2026-01-02", true);
    assert_eq!(
        b.store
            .remove_timeline_rows(other as i64, &removals(json!([drop_me.clone()])))
            .unwrap(),
        json!([])
    );
    assert_eq!(
        b.store.remove_timeline_rows(page as i64, &[]).unwrap(),
        json!([])
    );
    assert_eq!(
        b.store
            .remove_timeline_rows(-1, &removals(json!([drop_me])))
            .unwrap(),
        json!([])
    );
    assert_eq!(rows_of(&b, "people/prune").len(), 3);
}

#[test]
fn remove_timeline_rows_reports_in_the_order_given_and_refuses_a_bad_date_before_any_delete() {
    let b = Brain::new("tq-remove-order");
    let page = b.page("people/prune-dates", "default", json!({}));
    for (date, summary) in [
        ("2026-09-03", "c"),
        ("2026-09-01", "a"),
        ("2026-09-02", "b"),
    ] {
        b.entry("people/prune-dates", date, summary);
    }
    let row = |summary: &str, date: &str, removed: bool| json!({"id": id_of(&b, "people/prune-dates", summary), "date": date, "source": "diary", "summary": summary, "detail": "", "removed": removed});
    let err = b
        .store
        .remove_timeline_rows(
            page as i64,
            &removals(json!([
                row("a", "2026-09-01", true),
                row("b", "not a date", true)
            ])),
        )
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    assert_eq!(rows_of(&b, "people/prune-dates").len(), 3);
    let out = b
        .store
        .remove_timeline_rows(
            page as i64,
            &removals(json!([
                row("b", "2026/09/02", false),
                row("c", "2026-09-03", true),
                row("a", "2026-09-01", true)
            ])),
        )
        .unwrap();
    assert_eq!(
        out,
        json!([
            {"date": "2026-09-02", "removed": false},
            {"date": "2026-09-03", "removed": true},
            {"date": "2026-09-01", "removed": true},
        ])
    );
    assert!(rows_of(&b, "people/prune-dates").is_empty());
}

#[test]
fn update_timeline_details_rewrites_a_detail_only_while_it_is_the_preimage() {
    let mut b = Brain::new("tq-refresh");
    let page = b.page("people/refresh", "default", json!({}));
    let other = b.page("people/refresh-other", "default", json!({}));
    let event = b.event(
        "life/events/2026-07-02-001",
        "default",
        "2026-07-02T09:00:00Z",
        json!({"kind": "meeting"}),
    );
    b.project(page, event, "2026-07-02", "Event row");
    for (slug, summary) in [
        ("people/refresh", "refresh me"),
        ("people/refresh", "edited since"),
        ("people/refresh-other", "other page"),
    ] {
        let input: TimelineInput = serde_json::from_value(
            json!({"date": "2026-02-03", "source": "diary", "summary": summary, "detail": "before"}),
        )
        .unwrap();
        b.store
            .add_timeline_entry(slug, &input, &AddTimelineOptions::default())
            .unwrap();
    }
    let details = |slug: &str| -> Vec<(String, String)> {
        entries(&b, slug)
            .iter()
            .map(|e| {
                (
                    e["summary"].as_str().unwrap().into(),
                    e["detail"].as_str().unwrap().into(),
                )
            })
            .collect()
    };
    let before = rows_of(&b, "people/refresh");
    b.store
        .update_timeline_details(
            page as i64,
            &refreshes(json!([
                {"id": id_of(&b, "people/refresh", "refresh me"), "detail": "before", "next": "after"},
                {"id": id_of(&b, "people/refresh", "refresh me"), "detail": "before", "next": "second"},
                {"id": id_of(&b, "people/refresh", "edited since"), "detail": "earlier", "next": "never"},
                {"id": id_of(&b, "people/refresh", "Event row"), "detail": "", "next": "moved"},
                {"id": id_of(&b, "people/refresh-other", "other page"), "detail": "before", "next": "moved"},
                {"id": 987_654, "detail": "before", "next": "moved"},
                {"id": id_of(&b, "people/refresh", "edited since"), "detail": null, "next": "null preimage"},
            ])),
        )
        .unwrap();
    let own = details("people/refresh");
    assert!(own.contains(&("refresh me".into(), "after".into())));
    assert!(own.contains(&("edited since".into(), "before".into())));
    assert!(own.contains(&("Event row".into(), String::new())));
    assert_eq!(
        details("people/refresh-other"),
        [("other page".into(), "before".into())]
    );
    // The entry keeps its id and date, and an empty list writes nothing.
    assert_eq!(rows_of(&b, "people/refresh"), before);
    b.store.update_timeline_details(page as i64, &[]).unwrap();
    b.store.update_timeline_details(other as i64, &refreshes(json!([
        {"id": id_of(&b, "people/refresh", "refresh me"), "detail": "after", "next": "wrong page"},
    ]))).unwrap();
    assert!(details("people/refresh").contains(&("refresh me".into(), "after".into())));

    // A null `next` on a matching row is the not-null violation, and nothing is written.
    let err = b
        .store
        .update_timeline_details(
            page as i64,
            &refreshes(json!([
                {"id": id_of(&b, "people/refresh", "refresh me"), "detail": "after", "next": "applied first"},
                {"id": id_of(&b, "people/refresh", "edited since"), "detail": "before", "next": null},
            ])),
        )
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    assert!(details("people/refresh").contains(&("refresh me".into(), "after".into())));
}

/// `excludePrivate` with the policy PGLite renders for no caller record.
fn policy() -> Value {
    json!({"honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn"})
}

#[test]
fn exclude_private_drops_rows_whose_depth_or_event_page_the_policy_hides() {
    let mut b = Brain::new("tq-private");
    b.source("alt");
    let open = b.page("life/diary/open", "default", json!({}));
    let private = b.page(
        "life/diary/private",
        "default",
        json!({"frontmatter": {"visibility": "private"}}),
    );
    let alias = b.page(
        "life/diary/alias",
        "default",
        json!({"frontmatter": {"access": "restricted"}}),
    );
    let e_open = b.event(
        "life/events/open",
        "default",
        "2026-07-01T08:00:00Z",
        json!({"kind": "call", "who": ["people/alice-example"]}),
    );
    let e_readers = b.page(
        "life/events/readers",
        "default",
        json!({"type": "event", "frontmatter": {"readable_by": ["alice-example"],
               "event": {"kind": "call", "who": ["people/alice-example"]}}}),
    );
    // An event page in another source: the read scoped to `default` nulls out its fields, but the
    // privacy test still judges it by id.
    let e_foreign = b.page(
        "life/events/foreign-private",
        "alt",
        json!({"type": "event", "frontmatter": {"visibility": "private", "event": {"kind": "call"}}}),
    );
    b.project(open, e_open, "2026-07-01", "open depth, open event");
    b.project(
        open,
        e_readers,
        "2026-07-01",
        "open depth, event with readers",
    );
    b.project(
        open,
        e_foreign,
        "2026-07-01",
        "open depth, foreign private event",
    );
    b.project(private, e_open, "2026-07-02", "private depth, open event");
    b.entry("life/diary/alias", "2026-07-01", "alias depth plain");
    b.entry("life/diary/open", "2025-07-01", "open last year");
    b.entry("life/diary/private", "2025-07-01", "private last year");
    let _ = alias;

    let day = |opts: Value| {
        b.store
            .get_timeline_for_date("2026-07-01", &chronicle(opts))
            .unwrap()
    };
    assert_eq!(day(json!({})).len(), 4);
    assert_eq!(
        field(&day(json!({"excludePrivate": policy()})), "summary"),
        vec![json!("open depth, open event")]
    );
    let scoped = day(json!({"sourceId": "default"}));
    assert_eq!(scoped.len(), 4);
    assert_eq!(
        field(
            &day(json!({"sourceId": "default", "excludePrivate": policy()})),
            "summary"
        ),
        vec![json!("open depth, open event")]
    );
    // The policy without the privacy part judges readers only: the readers event still hides. The
    // foreign event has no effective date, so it orders at midnight.
    let readers_only = json!({"honorAliases": true, "entityPrivacy": false, "ownerOnly": "fn"});
    assert_eq!(
        field(&day(json!({"excludePrivate": readers_only})), "summary"),
        vec![
            json!("alias depth plain"),
            json!("open depth, foreign private event"),
            json!("open depth, open event"),
        ]
    );
    let since: ChronicleOptions = chronicle(json!({"excludePrivate": policy()}));
    assert_eq!(
        field(&b.store.get_since("2026-07-01", &since).unwrap(), "summary"),
        vec![json!("open depth, open event")]
    );
    let on_this_day: OnThisDayOptions =
        serde_json::from_value(json!({"date": "2026-07-01", "excludePrivate": policy()})).unwrap();
    assert_eq!(
        field(&b.store.get_on_this_day(&on_this_day).unwrap(), "summary"),
        vec![json!("open last year")]
    );
    let seen = |opts: Value| {
        let options: LastSeenOptions = serde_json::from_value(opts).unwrap();
        b.store
            .get_last_seen("people/alice-example", &options)
            .unwrap()
    };
    assert_eq!(
        seen(json!({"asof": "2026-07-05"}))["last_date"],
        json!("2026-07-02")
    );
    let kept = seen(json!({"asof": "2026-07-05", "excludePrivate": policy()}));
    assert_eq!(kept["last_date"], json!("2026-07-01"));
    assert_eq!(kept["last_event_slug"], json!("life/events/open"));
}
