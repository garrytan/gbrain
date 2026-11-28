//! The retention purge's bookkeeping the store serves (`persistence/retention_purge.rs`). The TypeScript parity cases
//! (test/engine-parity/retention-purge.test.ts) compare the same members with PGLite; these cover what a parity case
//! cannot see: the stored record bytes and stamps, the arguments the store refuses, and the record shapes no caller writes.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::persistence::PurgeFailureRow;
use serde_json::{Value, json};

const PARK: &str = "derived-origin-park";
const PURGE_PARK: &str = "purge-deleted-park";

fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let store = open(&dir);
    (dir, store)
}

fn put(store: &Store, slug: &str) -> i64 {
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": slug, "frontmatter": {},
    }))
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({ "sourceId": "default" })).unwrap();
    store.put_page(slug, &input, &options).unwrap();
    store
        .read_page_label_row("default", slug)
        .unwrap()
        .expect("page written")
        .id as i64
}

fn failure(key: &str, first: &str, reason: &str) -> PurgeFailureRow {
    PurgeFailureRow {
        op: PURGE_PARK.into(),
        key: key.into(),
        first: first.into(),
        code: None,
        reason: reason.into(),
        failed_at: "2026-11-26T00:00:00.000Z".into(),
        version: "1".into(),
    }
}

/// The stamp of one record, as the listing reports it.
fn stamp(store: &Store, op: &str, fingerprint: &str) -> i64 {
    let rows = store.list_op_checkpoint_records(op).unwrap();
    rows.as_array()
        .unwrap()
        .iter()
        .find(|r| r["fingerprint"] == fingerprint)
        .expect("record listed")["updated_at_us"]
        .as_i64()
        .unwrap()
}

#[test]
fn a_failure_record_is_stored_from_its_first_text_then_counts_each_repeat() {
    let (_dir, store) = brain("retention-failure");
    let key = r#"["default","a","10"]"#;
    store
        .record_purge_failure_record(&failure(
            key,
            r#"[{"source_id":"default","slug":"a","deleted_us":"10","failures":1,"reason":"first"}]"#,
            "first",
        ))
        .unwrap();
    store
        .record_purge_failure_record(&failure(key, "[{}]", "second"))
        .unwrap();
    let doc = store.read_op_checkpoint_doc(PURGE_PARK, key).unwrap();
    assert_eq!(doc["failures"], json!(2));
    assert_eq!(doc["reason"], json!("second"));
    assert_eq!(doc["code"], Value::Null);
    assert_eq!(doc["slug"], json!("a"));
}

#[test]
fn a_failure_record_refuses_text_jsonb_refuses_and_a_count_the_int_cast_refuses() {
    let (_dir, store) = brain("retention-failure-refusals");
    let key = r#"["default","a","10"]"#;
    assert!(
        store
            .record_purge_failure_record(&failure(key, "not json", "r"))
            .is_err()
    );
    assert!(
        store
            .record_purge_failure_record(&failure(key, r#"[{"reason":"a\u0000b"}]"#, "r"))
            .is_err()
    );
    store
        .record_purge_failure_record(&failure(key, r#"[{"failures":"many"}]"#, "r"))
        .unwrap();
    assert!(
        store
            .record_purge_failure_record(&failure(key, "[{}]", "r"))
            .is_err()
    );
    assert_eq!(
        store.read_op_checkpoint_doc(PURGE_PARK, key).unwrap()["failures"],
        json!("many")
    );
}

#[test]
fn marking_a_source_inactive_keeps_the_record_stamp_and_the_rearm_counts_only_marked_records() {
    let (_dir, store) = brain("retention-inactive");
    for (key, source) in [("k1", "default"), ("k2", "default"), ("k3", "other")] {
        store
            .record_purge_failure_record(&failure(
                key,
                &format!(r#"[{{"source_id":"{source}","slug":"{key}","deleted_us":"1"}}]"#),
                "r",
            ))
            .unwrap();
    }
    let before = stamp(&store, PURGE_PARK, "k1");
    assert_eq!(
        store
            .drop_rearmed_purge_parks(PURGE_PARK, "default")
            .unwrap(),
        0
    );
    store
        .mark_purge_parks_inactive(PURGE_PARK, "default")
        .unwrap();
    assert_eq!(stamp(&store, PURGE_PARK, "k1"), before);
    assert_eq!(
        store.read_op_checkpoint_doc(PURGE_PARK, "k1").unwrap()["inactive_seen"],
        json!(true)
    );
    assert_eq!(
        store.read_op_checkpoint_doc(PURGE_PARK, "k3").unwrap()["inactive_seen"],
        Value::Null
    );
    assert_eq!(
        store
            .drop_rearmed_purge_parks(PURGE_PARK, "default")
            .unwrap(),
        2
    );
    assert_eq!(
        store.read_op_checkpoint_doc(PURGE_PARK, "k1").unwrap(),
        Value::Null
    );
    assert!(
        store
            .read_op_checkpoint_doc(PURGE_PARK, "k3")
            .unwrap()
            .is_object()
    );
}

#[test]
fn a_held_tombstone_of_json_null_is_released_only_by_a_live_page_and_a_park_of_no_page_stays() {
    let (_dir, store) = brain("retention-release");
    let live = put(&store, "r/live");
    let gone = put(&store, "r/gone");
    store.soft_delete_page("r/gone", Some("default")).unwrap();
    let held = json!({ "slug": "x", "held_request_id": "req", "held_deleted_us": null });
    store.upsert_derived_origin_park(live, &held).unwrap();
    store.upsert_derived_origin_park(gone, &held).unwrap();
    store.upsert_derived_origin_park(999_999, &held).unwrap();
    store.release_stale_origin_park_holds(PARK).unwrap();
    let doc = |id: i64| store.read_op_checkpoint_doc(PARK, &id.to_string()).unwrap();
    assert_eq!(doc(live), json!({ "slug": "x" }));
    assert_eq!(doc(gone)["held_request_id"], json!("req"));
    assert_eq!(doc(999_999)["held_request_id"], json!("req"));
}

#[test]
fn the_candidate_and_expiring_reads_refuse_an_hour_count_the_interval_cast_refuses() {
    let (_dir, store) = brain("retention-hours");
    assert!(
        store
            .list_managed_purge_candidates("two", &[], &[])
            .is_err()
    );
    assert!(store.list_released_purge_origins(&[1], &[], "NaN").is_err());
    assert!(store.list_expiring_origin_pages("", false).is_err());
    assert_eq!(
        store
            .list_managed_purge_candidates(" 0 ", &[], &[])
            .unwrap(),
        vec![]
    );
}

#[test]
fn every_member_refuses_a_nul_in_its_op() {
    let (_dir, store) = brain("retention-nul");
    assert!(store.release_stale_origin_park_holds("a\0b").is_err());
    assert!(store.list_owed_purge_records("a\0b").is_err());
    assert!(store.prune_owed_purge_records("a\0b").is_err());
    assert!(store.prune_origin_park_records("a\0b").is_err());
    assert!(store.prune_purge_park_records("a\0b").is_err());
    assert!(store.delete_purge_park_record("a\0b", "k").is_err());
    assert!(store.mark_purge_parks_inactive("op", "a\0b").is_err());
    assert!(store.drop_rearmed_purge_parks("op", "a\0b").is_err());
}
