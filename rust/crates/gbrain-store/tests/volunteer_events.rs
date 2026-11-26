//! `insertVolunteerEvents` and `readVolunteerUsage`: the page filter of an insert, the day window, the used count from
//! the page's retrieval record, and the listing by byte of arm then channel; the retention delete, the slug scrub of a page
//! purge and the receipt probe's count.

mod memory_env;

use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::volunteer_events::VolunteerEventInput;
use memory_env::brain;
use serde_json::{Value, json};

const DAY: i64 = 86_400_000_000;

fn put(b: &gbrain_store::Store, slug: &str) -> i64 {
    let input: PageInput = serde_json::from_value(
        json!({ "type": "note", "title": slug, "compiled_truth": format!("{slug} body") }),
    )
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({})).unwrap();
    b.put_page(slug, &input, &options).unwrap()["id"]
        .as_i64()
        .unwrap()
}

fn rows(v: Value) -> Vec<VolunteerEventInput> {
    serde_json::from_value(v).unwrap()
}

fn row(slug: &str, arm: &str, channel: &str) -> Value {
    json!({ "source_id": "default", "slug": slug, "confidence": 0.5, "match_arm": arm, "channel": channel })
}

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn a_row_whose_page_is_gone_is_dropped() {
    let b = brain("volunteer-filter");
    put(&b, "p");
    b.insert_volunteer_events(&rows(json!([row("p", "a", "op"), row("gone", "a", "op")])))
        .unwrap();
    let usage = b.read_volunteer_usage(&ids(&["default"]), 30).unwrap();
    assert_eq!(
        usage,
        json!([{ "match_arm": "a", "channel": "op", "volunteered": 1, "used": 0 }])
    );
}

#[test]
fn the_usage_lists_arms_and_channels_by_byte() {
    let b = brain("volunteer-order");
    put(&b, "p");
    // en_US sorts `a0, ab, a-z`; bytes put `a-z` first.
    let arms = ["ab", "a0", "a-z"];
    let batch: Vec<Value> = arms.iter().map(|a| row("p", a, "op")).collect();
    b.insert_volunteer_events(&rows(Value::Array(batch)))
        .unwrap();
    let batch: Vec<Value> = arms.iter().map(|c| row("p", "z-arm", c)).collect();
    b.insert_volunteer_events(&rows(Value::Array(batch)))
        .unwrap();
    let usage = b.read_volunteer_usage(&ids(&["default"]), 30).unwrap();
    let got: Vec<(String, String)> = usage
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["match_arm"].as_str().unwrap().to_string(),
                r["channel"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    let want: Vec<(&str, &str)> = vec![
        ("a-z", "op"),
        ("a0", "op"),
        ("ab", "op"),
        ("z-arm", "a-z"),
        ("z-arm", "a0"),
        ("z-arm", "ab"),
    ];
    assert_eq!(
        got,
        want.iter()
            .map(|(a, c)| (a.to_string(), c.to_string()))
            .collect::<Vec<_>>()
    );
}

#[test]
fn an_event_older_than_the_window_or_of_another_source_is_not_counted() {
    let b = brain("volunteer-window");
    put(&b, "p");
    b.insert_volunteer_events(&rows(json!([row("p", "old", "op")])))
        .unwrap();
    b.clock.advance(31 * DAY);
    b.insert_volunteer_events(&rows(json!([row("p", "new", "op")])))
        .unwrap();
    let usage = b.read_volunteer_usage(&ids(&["default"]), 30).unwrap();
    assert_eq!(
        usage,
        json!([{ "match_arm": "new", "channel": "op", "volunteered": 1, "used": 0 }])
    );
    assert_eq!(
        b.read_volunteer_usage(&ids(&["other"]), 30).unwrap(),
        json!([])
    );
}

#[test]
fn a_page_retrieved_after_the_event_counts_as_used() {
    let b = brain("volunteer-used");
    let id = put(&b, "p");
    b.insert_volunteer_events(&rows(json!([row("p", "a", "op")])))
        .unwrap();
    // The event's stamp and the bump share the clock: retrieve a minute later.
    b.clock.advance(60_000_000);
    b.bump_page_retrievals(&[id]).unwrap();
    let usage = b.read_volunteer_usage(&ids(&["default"]), 30).unwrap();
    assert_eq!(
        usage,
        json!([{ "match_arm": "a", "channel": "op", "volunteered": 1, "used": 1 }])
    );
}

#[test]
fn a_nul_byte_refuses() {
    let b = brain("volunteer-nul");
    put(&b, "p");
    assert!(
        b.insert_volunteer_events(&rows(json!([row("p", "a\u{0}b", "op")])))
            .is_err()
    );
}

#[test]
fn the_retention_delete_removes_only_the_rows_older_than_its_window() {
    let b = brain("volunteer-retention");
    put(&b, "p");
    b.insert_volunteer_events(&rows(json!([row("p", "old", "op")])))
        .unwrap();
    b.clock.advance(100 * DAY);
    b.insert_volunteer_events(&rows(json!([row("p", "new", "op")])))
        .unwrap();
    assert_eq!(b.delete_volunteer_events_older_than(90.0).unwrap(), 1);
    assert_eq!(b.delete_volunteer_events_older_than(90.0).unwrap(), 0);
    assert_eq!(
        b.count_volunteer_events_for_slug("default", "p").unwrap(),
        1
    );
    // A window in the past removes everything volunteered so far.
    assert_eq!(b.delete_volunteer_events_older_than(-1.0).unwrap(), 1);
    assert_eq!(
        b.count_volunteer_events_for_slug("default", "p").unwrap(),
        0
    );
    let err = b.delete_volunteer_events_older_than(f64::NAN).unwrap_err();
    assert_eq!(err.code, gbrain_store::error::INVALID_ARGUMENT);
}

#[test]
fn the_slug_scrub_counts_and_removes_the_rows_of_those_slugs_of_one_source() {
    let b = brain("volunteer-scrub");
    put(&b, "p");
    put(&b, "q");
    b.insert_volunteer_events(&rows(json!([
        row("p", "a", "op"),
        row("p", "a", "hook"),
        row("q", "a", "op")
    ])))
    .unwrap();
    assert_eq!(
        b.delete_volunteer_events_for_slugs("default", &[]).unwrap(),
        0
    );
    assert_eq!(
        b.delete_volunteer_events_for_slugs("other", &ids(&["p"]))
            .unwrap(),
        0
    );
    assert_eq!(
        b.delete_volunteer_events_for_slugs("default", &ids(&["p", "missing"]))
            .unwrap(),
        2
    );
    assert_eq!(
        b.count_volunteer_events_for_slug("default", "p").unwrap(),
        0
    );
    assert_eq!(
        b.count_volunteer_events_for_slug("default", "q").unwrap(),
        1
    );
}
