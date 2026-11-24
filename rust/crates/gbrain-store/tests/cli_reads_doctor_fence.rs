//! The fence census reads and writes (`cli_reads/doctor_fence.rs`): the PGLite semantics of each.

mod memory_env;

use gbrain_store::cli_reads::doctor_fence::*;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const MINUTE: i64 = 60_000_000;

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put(s: &Brain, slug: &str, source: Option<&str>, path: Option<&str>, body: &str) {
    let mut input: PageInput =
        args(json!({ "type": "note", "title": slug, "compiled_truth": body }));
    input.source_path = path.map(str::to_string);
    let opts = PutPageOptions {
        source_id: source.map(str::to_string),
        ..PutPageOptions::default()
    };
    s.put_page(slug, &input, &opts).unwrap();
}

fn pages(s: &Brain, v: Value) -> Vec<Value> {
    s.list_fence_census_pages(&args(v)).unwrap()
}

fn slugs(rows: &[Value]) -> Vec<&str> {
    rows.iter().map(|r| r["slug"].as_str().unwrap()).collect()
}

#[test]
fn census_sources_come_by_id_with_their_incarnation_and_honour_the_filter() {
    let s = brain("fence-sources");
    for id in ["zeta", "alpha"] {
        s.upsert_source(&SourceInput {
            id: id.into(),
            name: Some(id.into()),
            local_path: Some(format!("/repo/{id}")),
            ..SourceInput::default()
        })
        .unwrap();
    }
    let all = s
        .list_fence_census_sources(&args(json!({ "sourceIds": null })))
        .unwrap();
    let ids: Vec<&str> = all.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["alpha", "default", "zeta"]);
    assert_eq!(all[0]["local_path"], "/repo/alpha");
    assert!(
        all[0]["incarnation"]
            .as_str()
            .is_some_and(|i| !i.is_empty())
    );
    let one = s
        .list_fence_census_sources(&args(json!({ "sourceIds": ["zeta"] })))
        .unwrap();
    assert_eq!(one.len(), 1);
    assert_eq!(one[0]["id"], "zeta");
}

#[test]
fn pass_horizon_is_the_store_clock_minus_the_grace() {
    let s = brain("fence-horizon");
    s.clock.advance(5 * MINUTE);
    let text = s
        .read_fence_pass_horizon(&args(json!({ "graceMs": 60_000 })))
        .unwrap();
    // T0 is 2027-01-15T08:00:00Z; five minutes on, one minute of grace.
    assert_eq!(text, "2027-01-15T08:04:00.000000Z");
}

#[test]
fn page_scans_page_by_id_and_by_updated_time_and_hold_bodies_for_fenced_live_pages() {
    let s = brain("fence-pages");
    put(&s, "n/a", None, Some("n/a.md"), "plain");
    s.clock.advance(MINUTE);
    put(
        &s,
        "n/b",
        None,
        Some("n/b.md"),
        "<!--- gbrain:facts:begin -->\nrows\n",
    );
    s.clock.advance(MINUTE);
    put(&s, "n/c", None, None, "<!--- gbrain:takes:begin -->");
    put(&s, "n/gone", None, None, "<!--- gbrain:facts:begin -->");
    s.soft_delete_page("n/gone", None).unwrap();

    let by_id = pages(
        &s,
        json!({ "sourceId": "default", "mode": "id", "afterId": 0, "limit": 2 }),
    );
    assert_eq!(slugs(&by_id), ["n/a", "n/b"]);
    assert_eq!(by_id[0]["compiled_truth"], Value::Null);
    assert_eq!(by_id[0]["live"], true);
    assert!(
        by_id[1]["compiled_truth"]
            .as_str()
            .unwrap()
            .contains("gbrain:facts:")
    );
    let next_id = by_id[1]["id"].as_i64().unwrap();
    let rest = pages(
        &s,
        json!({ "sourceId": "default", "mode": "id", "afterId": next_id, "limit": 10 }),
    );
    assert_eq!(slugs(&rest), ["n/c", "n/gone"]);
    assert_eq!(rest[1]["live"], false);
    assert_eq!(rest[1]["compiled_truth"], Value::Null);
    assert_eq!(rest[0]["source_path"], Value::Null);

    let lower = by_id[1]["updated_at"].as_str().unwrap().to_string();
    let upd = pages(
        &s,
        json!({ "sourceId": "default", "mode": "updated", "lower": lower, "after": null, "limit": 10 }),
    );
    assert_eq!(slugs(&upd), ["n/b", "n/c", "n/gone"]);
    let after = json!({ "at": upd[1]["updated_at"], "id": upd[1]["id"] });
    let tail = pages(
        &s,
        json!({ "sourceId": "default", "mode": "updated", "lower": lower, "after": after, "limit": 10 }),
    );
    assert_eq!(slugs(&tail), ["n/gone"]);
    // Another source's pages are not in the scan.
    assert!(
        pages(
            &s,
            json!({ "sourceId": "other", "mode": "id", "afterId": 0, "limit": 10 })
        )
        .is_empty()
    );
    assert!(
        s.list_fence_census_pages(&args(
            json!({ "sourceId": "default", "mode": "nope", "limit": 1 })
        ))
        .is_err()
    );
}

#[test]
fn live_page_ids_drop_soft_deleted_and_unknown_pages() {
    let s = brain("fence-live");
    put(&s, "n/a", None, None, "a");
    put(&s, "n/b", None, None, "b");
    let ids = pages(
        &s,
        json!({ "sourceId": "default", "mode": "id", "afterId": 0, "limit": 10 }),
    );
    let (a, b) = (
        ids[0]["id"].as_i64().unwrap(),
        ids[1]["id"].as_i64().unwrap(),
    );
    s.soft_delete_page("n/a", None).unwrap();
    let live = s
        .list_live_fence_page_ids(&args(json!({ "pageIds": [b, a, 999, -1] })))
        .unwrap();
    assert_eq!(live, [b as u64]);
}

#[test]
fn scan_records_round_trip_and_a_candidate_keeps_its_other_part_until_both_are_cleared() {
    let s = brain("fence-records");
    let at = |fp: &str| -> CheckpointRef { args(json!({ "op": "fence_scan", "fingerprint": fp })) };
    assert_eq!(
        s.read_fence_checkpoint_record(&at("one")).unwrap(),
        Value::Null
    );
    s.write_fence_scan_record(&args(json!({
        "op": "fence_scan", "fingerprint": "one", "record": { "version": 1, "b": 2, "a": [1] } })))
        .unwrap();
    assert_eq!(
        s.read_fence_checkpoint_record(&at("one")).unwrap(),
        json!({ "version": 1, "b": 2, "a": [1] })
    );

    let source = s
        .list_fence_census_sources(&args(json!({ "sourceIds": null })))
        .unwrap()[0]
        .clone();
    let part = |fp: &str, part: &str, finding: Value| -> CandidatePartWrite {
        args(
            json!({ "op": "fence_candidate", "fingerprint": fp, "sourceId": source["id"],
            "incarnation": source["incarnation"], "key": "k", "part": part, "finding": finding }),
        )
    };
    s.upsert_fence_candidate_part(&part("a", "page", json!({ "n": 1 })))
        .unwrap();
    s.upsert_fence_candidate_part(&part("a", "file", json!({ "n": 2 })))
        .unwrap();
    s.upsert_fence_candidate_part(&part("b", "file", json!({ "n": 3 })))
        .unwrap();
    let list = |ids: Value| -> Vec<Value> {
        s.list_fence_candidate_records(&args(json!({ "op": "fence_candidate", "sourceIds": ids })))
            .unwrap()
    };
    let all = list(Value::Null);
    assert_eq!(all.len(), 2);
    assert_eq!(
        all[0],
        json!({ "version": 1, "source_id": source["id"], "incarnation": source["incarnation"],
        "key": "k", "page": { "n": 1 }, "file": { "n": 2 } })
    );
    assert_eq!(list(json!(["nope"])).len(), 0);

    let clear = |fps: &[&str], p: &str| -> CandidatePartsClear {
        args(json!({ "op": "fence_candidate", "fingerprints": fps, "part": p }))
    };
    // `b` holds only a file part, so clearing its page part leaves it; `a` loses only the page part.
    s.clear_fence_candidate_parts(&clear(&["a", "b", "missing"], "page"))
        .unwrap();
    let all = list(Value::Null);
    assert_eq!(all.len(), 2);
    assert!(all[0].get("page").is_none() && all[0].get("file").is_some());
    // Clearing the last part deletes the row.
    s.clear_fence_candidate_parts(&clear(&["a", "b"], "file"))
        .unwrap();
    assert!(list(Value::Null).is_empty());
    assert!(
        s.upsert_fence_candidate_part(&part("a", "other", json!(1)))
            .is_err()
    );
}

#[test]
fn a_candidate_of_an_old_incarnation_is_not_listed() {
    let s = brain("fence-incarnation");
    let source = s
        .list_fence_census_sources(&args(json!({ "sourceIds": null })))
        .unwrap()[0]
        .clone();
    s.upsert_fence_candidate_part(&args(json!({ "op": "fence_candidate", "fingerprint": "x",
        "sourceId": source["id"], "incarnation": "00000000-0000-4000-8000-000000000000",
        "key": "k", "part": "page", "finding": {} })))
        .unwrap();
    assert!(
        s.list_fence_candidate_records(&args(
            json!({ "op": "fence_candidate", "sourceIds": null })
        ))
        .unwrap()
        .is_empty()
    );
}

#[test]
fn segmented_pages_count_when_they_have_no_path_or_their_checkout_was_not_walked() {
    let s = brain("fence-segmented");
    let shell = |slug: &str| {
        s.create_segmented_page_shell(
            slug,
            &args(json!({ "type": "note", "title": slug })),
            &args(json!({ "sourceId": "default" })),
        )
        .unwrap();
    };
    shell("n/a");
    shell("n/b");
    put(&s, "n/full", None, None, "full body");
    let count = |walked: Value| -> u64 {
        s.count_segmented_fence_pages(&args(
            json!({ "sourceIds": ["default"], "walkedSourceIds": walked }),
        ))
        .unwrap()
    };
    // Both shells have no path; a whole page is not segmented.
    assert_eq!(count(json!(["default"])), 2);
    assert_eq!(count(json!([])), 2);
    let none: u64 = s
        .count_segmented_fence_pages(&args(
            json!({ "sourceIds": ["other"], "walkedSourceIds": [] }),
        ))
        .unwrap();
    assert_eq!(none, 0);
}
