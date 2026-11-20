//! The page scans of the safe-chunks, origin-twins, ghost-pages and legacy-twins repair plans. The three-arm cases are in
//! test/engine-parity/repair-page-scans.test.ts; these pin the filters across a reopen-free store:
//! soft-deleted pages drop out, the legacy-prefix pairing and its cap, and the rebuildable rule.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use serde_json::{Value, json};

const PRODUCER: &str = "chunker-v4.fence-v4";

fn put(store: &Store, slug: &str, kind: &str, path: Option<&str>, frontmatter: Value) {
    let input = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": "body", "timeline": "tl",
        "frontmatter": frontmatter, "page_kind": kind, "source_path": path,
    }))
    .unwrap();
    let options = serde_json::from_value(json!({})).unwrap();
    store.put_page(slug, &input, &options).unwrap();
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
