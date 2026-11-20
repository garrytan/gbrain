//! The page scans of the safe-chunks and origin-twins repair plans. The three-arm cases are in
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
    assert_eq!(store.count_live_file_backed_pages("default").unwrap(), 2);
}
