//! The large-page write guard's read: the stored body size of a live inline page in UTF-8 bytes,
//! and none for a missing or soft-deleted page. Segmented bodies are pinned by the engine parity
//! case (test/engine-parity/large-page.test.ts), which publishes one through the page_body members.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::json;

fn put(store: &Store, slug: &str, truth: &str, timeline: &str) -> serde_json::Value {
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": slug, "compiled_truth": truth, "timeline": timeline}),
    )
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
    store.put_page(slug, &input, &opts).unwrap()
}

#[test]
fn an_inline_page_measures_its_body_columns_in_utf8_bytes() {
    let dir = TempDir::new("large-page");
    let store = open(&dir);
    put(&store, "notes/inline", "café body", "- € event");
    put(&store, "notes/plain", "plain body", "");
    assert_eq!(
        store
            .read_stored_body_bytes("notes/inline", "default")
            .unwrap(),
        Some(("café body".len() + "- € event".len()) as i64)
    );
    assert_eq!(
        store
            .read_stored_body_bytes("notes/plain", "default")
            .unwrap(),
        Some(10)
    );
    assert_eq!(
        store
            .read_stored_body_bytes("notes/inline", "other")
            .unwrap(),
        None
    );
}

#[test]
fn a_missing_or_soft_deleted_page_has_no_stored_size() {
    let dir = TempDir::new("large-page");
    let store = open(&dir);
    put(&store, "notes/gone", "gone body", "");
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    assert_eq!(
        store
            .read_stored_body_bytes("notes/gone", "default")
            .unwrap(),
        None
    );
    assert_eq!(
        store
            .read_stored_body_bytes("notes/missing", "default")
            .unwrap(),
        None
    );
}

#[test]
fn page_size_rows_select_embed_skip_and_over_limit_live_pages_in_slug_byte_order() {
    let dir = TempDir::new("size-rows");
    let store = open(&dir);
    put(&store, "notes/small", "tiny", "");
    put(&store, "notes/big", "café body over the limit", "- € event");
    put(&store, "notes/gone", "gone body over the limit", "");
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": "skip", "compiled_truth": "tiny", "timeline": "",
        "frontmatter": {"embed_skip": true},
    }))
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
    store.put_page("notes/b-skip", &input, &opts).unwrap();
    let slugs =
        |rows: Vec<gbrain_store::cli_reads::sources::PageSizeRow>| -> Vec<(String, Option<i64>)> {
            rows.into_iter().map(|r| (r.slug, r.bytes)).collect()
        };
    let big = ("café body over the limit".len() + "- € event".len()) as i64;
    assert_eq!(
        slugs(store.read_page_size_rows("default", 12, None).unwrap()),
        vec![
            ("notes/b-skip".into(), Some(4)),
            ("notes/big".into(), Some(big))
        ]
    );
    let some = vec![
        "notes/small".to_string(),
        "notes/gone".into(),
        "notes/big".into(),
    ];
    assert_eq!(
        slugs(
            store
                .read_page_size_rows("default", 12, Some(&some))
                .unwrap()
        ),
        vec![("notes/big".into(), Some(big))]
    );
    assert!(
        store
            .read_page_size_rows("default", 12, Some(&[]))
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .read_page_size_rows("missing", 12, None)
            .unwrap()
            .is_empty()
    );
    let row = &store.read_page_size_rows("default", 12, None).unwrap()[0];
    assert_eq!(
        (row.state.clone(), row.reason.clone(), row.segmented),
        (None, None, false)
    );
}

#[test]
fn append_reads_the_body_and_truth_sizes_by_page_id_deleted_or_not() {
    let dir = TempDir::new("large-page");
    let store = open(&dir);
    let page = put(&store, "notes/sized", "café body", "- € event");
    let id = page["id"].as_i64().unwrap();
    let sizes =
        json!({ "bytes": "café body".len() + "- € event".len(), "truth": "café body".len() });
    assert_eq!(store.read_page_body_sizes(id).unwrap(), Some(sizes.clone()));
    store
        .soft_delete_page("notes/sized", Some("default"))
        .unwrap();
    assert_eq!(store.read_page_body_sizes(id).unwrap(), Some(sizes));
    assert_eq!(store.read_page_body_sizes(id + 1000).unwrap(), None);
    assert_eq!(store.read_page_body_sizes(-1).unwrap(), None);
}
