//! The page scans of the safe-chunks, origin-twins, ghost-pages and legacy-twins repair plans. The three-arm cases are in
//! test/engine-parity/repair-page-scans.test.ts; these pin the filters across a reopen-free store:
//! soft-deleted pages drop out, the legacy-prefix pairing and its cap, and the rebuildable rule;
//! and the twin-merge conflict read: which moving rows land on a key the survivor already holds.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::links::AddLinkOptions;
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput};
use serde_json::{Value, json};

const PRODUCER: &str = "chunker-v4.fence-v4";

fn put(store: &Store, slug: &str, kind: &str, path: Option<&str>, frontmatter: Value) -> u64 {
    let input = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": "body", "timeline": "tl",
        "frontmatter": frontmatter, "page_kind": kind, "source_path": path,
    }))
    .unwrap();
    let options = serde_json::from_value(json!({})).unwrap();
    store.put_page(slug, &input, &options).unwrap()["id"]
        .as_u64()
        .unwrap()
}

#[test]
fn scans_answer_what_the_sql_filters() {
    let dir = TempDir::new("repair-scans");
    let store = open(&dir);
    put(&store, "a", "markdown", Some("x.md"), json!({}));
    put(&store, "b", "markdown", Some("scope/x.md"), json!({}));
    put(&store, "c", "code", None, json!({}));
    put(&store, "d", "code", None, json!({ "file": "src/d.ts" }));
    put(&store, "e", "markdown", Some("gone.md"), json!({}));
    store.soft_delete_page("e", None).unwrap();

    let pending = store
        .list_safe_chunks_pending(&["default".to_owned()], PRODUCER)
        .unwrap();
    let got: Vec<(&str, bool, u64)> = pending
        .iter()
        .map(|p| (p.slug.as_str(), p.rebuildable, p.chars))
        .collect();
    assert_eq!(
        got,
        vec![
            ("a", true, 6),
            ("b", true, 6),
            ("c", false, 6),
            ("d", true, 6)
        ]
    );
    assert!(
        store
            .list_safe_chunks_pending(&["other".to_owned()], PRODUCER)
            .unwrap()
            .is_empty()
    );

    assert!(
        store
            .list_origin_twin_groups("default", 10)
            .unwrap()
            .is_empty()
    );
    let pairs = store
        .list_legacy_origin_pairs("default", "scope/", 10)
        .unwrap();
    assert_eq!(pairs.len(), 1);
    assert_eq!(
        (pairs[0].legacy_slug.as_str(), pairs[0].origin.as_str()),
        ("b", "x.md")
    );
    assert!(
        store
            .list_legacy_origin_pairs("default", "nope/", 10)
            .unwrap()
            .is_empty()
    );

    let live = store
        .list_live_origin_pages("default", &["x.md".to_owned(), "gone.md".to_owned()])
        .unwrap();
    assert_eq!(
        live.iter()
            .map(|p| p.source_path.as_str())
            .collect::<Vec<_>>(),
        vec!["x.md"]
    );
    assert_eq!(
        store
            .count_live_file_backed_pages("default", false)
            .unwrap(),
        2
    );
}

#[test]
fn repair_scan_pages_answer_each_query_shape() {
    let dir = TempDir::new("repair-scan-pages");
    let store = open(&dir);
    put(&store, "a", "markdown", Some("a.md"), json!({}));
    put(&store, "b", "markdown", None, json!({}));
    put(&store, "c", "markdown", Some("  "), json!({}));
    put(&store, "d", "markdown", Some("d.md"), json!({}));
    store.soft_delete_page("d", None).unwrap();
    let q = |v: Value| serde_json::from_value(v).unwrap();
    let slugs = |rows: Vec<gbrain_store::repair_scans::RepairScanPage>| {
        rows.into_iter().map(|r| r.slug).collect::<Vec<_>>()
    };
    let all = store
        .list_repair_scan_pages("default", &q(json!({ "after_id": 0, "limit": 10 })))
        .unwrap();
    assert_eq!(slugs(all.clone()), vec!["a", "b", "c"]);
    let past = store
        .list_repair_scan_pages("default", &q(json!({ "after_id": all[0].id, "limit": 1 })))
        .unwrap();
    assert_eq!(slugs(past), vec!["b"]);
    let legacy = store
        .list_repair_scan_pages(
            "default",
            &q(json!({ "after_id": 0, "limit": 10, "legacy": true })),
        )
        .unwrap();
    assert_eq!(slugs(legacy), vec!["b", "c"]);
    let at = store
        .list_repair_scan_pages("default", &q(json!({ "slugs": ["a", "b", "c", "d"] })))
        .unwrap();
    assert_eq!(slugs(at), vec!["a"]);
    let any = store
        .list_repair_scan_pages("default", &q(json!({ "ids": [all[0].id, all[0].id + 3] })))
        .unwrap();
    assert_eq!(
        any.iter()
            .map(|r| (r.slug.as_str(), r.deleted))
            .collect::<Vec<_>>(),
        vec![("a", false), ("d", true)]
    );
    assert_eq!(any[0].revision, all[0].revision);
    assert!(any[0].updated_ms > 0.0);
    assert!(
        store
            .list_repair_scan_pages("other", &q(json!({ "after_id": 0, "limit": 10 })))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .count_live_file_backed_pages("default", false)
            .unwrap(),
        2
    );
    assert_eq!(
        store.count_live_file_backed_pages("default", true).unwrap(),
        1
    );
}

fn link(store: &Store, from: &str, to: &str, context: &str) {
    let options = AddLinkOptions {
        context: Some(context.into()),
        link_type: Some("mentions".into()),
        link_source: Some("markdown".into()),
        ..AddLinkOptions::default()
    };
    store.add_link(from, to, &options).unwrap();
}

fn event(store: &Store, slug: &str, detail: &str) {
    let entry = TimelineInput {
        date: Some("2026-01-02".into()),
        source: Some("notes".into()),
        summary: Some("met".into()),
        detail: Some(detail.into()),
    };
    store
        .add_timeline_entry(slug, &entry, &AddTimelineOptions::default())
        .unwrap();
}

#[test]
fn twin_merge_losers_name_each_landing_row() {
    let dir = TempDir::new("twin-merge-losers");
    let store = open(&dir);
    let survivor = put(&store, "s", "markdown", Some("s.md"), json!({}));
    let twin = put(&store, "t", "markdown", Some("t.md"), json!({}));
    put(&store, "x", "markdown", Some("x.md"), json!({}));
    put(&store, "y", "markdown", Some("y.md"), json!({}));
    put(&store, "z", "markdown", Some("z.md"), json!({}));

    // x: same key, same context (a quiet loser); y: same key, other context; z: twin only.
    link(&store, "s", "x", "c");
    link(&store, "t", "x", "c");
    link(&store, "s", "y", "c");
    link(&store, "t", "y", "other");
    link(&store, "t", "z", "c");
    // Between the pair: not a moving row.
    link(&store, "t", "s", "c");
    event(&store, "s", "one");
    event(&store, "t", "two");
    store
        .put_raw_data("s", Some("api"), Some(r#"{"a":1}"#), None)
        .unwrap();
    store
        .put_raw_data("t", Some("api"), Some(r#"{"a":2}"#), None)
        .unwrap();
    store
        .put_raw_data("t", Some("same"), Some(r#"{"a":1}"#), None)
        .unwrap();
    store
        .put_raw_data("s", Some("same"), Some(r#"{"a":1}"#), None)
        .unwrap();

    let got = serde_json::to_value(store.list_twin_merge_losers(survivor, twin).unwrap()).unwrap();
    let links: Vec<(Option<&str>, bool)> = got["links"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| (l["link_source"].as_str(), l["same"].as_bool().unwrap()))
        .collect();
    assert_eq!(
        links,
        vec![(Some("markdown"), true), (Some("markdown"), false)]
    );
    assert!(got["transitions"].as_array().unwrap().is_empty());
    assert_eq!(got["timeline"].as_array().unwrap().len(), 1);
    assert_eq!(got["raw_data"], json!([{ "source": "api" }]));

    // The survivor's own view of a pair it is not in: nothing moves.
    let none = serde_json::to_value(store.list_twin_merge_losers(survivor, 999).unwrap()).unwrap();
    assert_eq!(
        none,
        json!({ "links": [], "transitions": [], "timeline": [], "raw_data": [] })
    );
}

/// listFileTombstones: soft-deleted pages recording a non-blank file, by id descending below
/// `before`; `by_sync` follows the page's `sync-delete-tombstone` record at its `deleted_at`.
#[test]
fn file_tombstones_read_what_the_sql_reads() {
    let dir = TempDir::new("file-tombstones");
    let store = open(&dir);
    let a = put(&store, "a", "markdown", Some("a.md"), json!({}));
    let b = put(&store, "b", "markdown", Some("b.md"), json!({}));
    put(&store, "blank", "markdown", Some("  "), json!({}));
    put(&store, "none", "markdown", None, json!({}));
    put(&store, "live", "markdown", Some("live.md"), json!({}));
    for slug in ["a", "b", "blank", "none"] {
        store.soft_delete_page(slug, None).unwrap();
    }
    let read = |before: Option<u64>, limit: u64| {
        let q = serde_json::from_value(json!({ "before": before, "limit": limit })).unwrap();
        store.list_file_tombstones("default", &q).unwrap()
    };
    let all = read(None, 10);
    let ids: Vec<u64> = all.iter().map(|t| t.id).collect();
    assert_eq!(ids, vec![b, a]);
    assert!(all.iter().all(|t| !t.by_sync));
    assert_eq!(all[0].source_path, "b.md");
    assert_eq!(
        read(Some(b), 10).iter().map(|t| t.id).collect::<Vec<_>>(),
        vec![a]
    );
    assert_eq!(read(None, 1).len(), 1);
    assert!(
        store
            .list_file_tombstones(
                "other",
                &serde_json::from_value(json!({ "limit": 5 })).unwrap()
            )
            .unwrap()
            .is_empty()
    );

    // The record arm: a record at the page's deleted_at marks it; one at another time does not.
    let at = all[1].deleted_at.clone();
    store
        .write_op_checkpoint_record(
            "sync-delete-tombstone",
            &a.to_string(),
            Some(&json!([{ "deleted_at": at }])),
        )
        .unwrap();
    store
        .write_op_checkpoint_record(
            "sync-delete-tombstone",
            &b.to_string(),
            Some(&json!([{ "deleted_at": "2001-01-01T00:00:00+00:00" }])),
        )
        .unwrap();
    let marked: Vec<(u64, bool)> = read(None, 10).iter().map(|t| (t.id, t.by_sync)).collect();
    assert_eq!(marked, vec![(b, false), (a, true)]);
}
