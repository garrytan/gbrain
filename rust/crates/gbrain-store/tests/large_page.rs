//! The large-page write guard's read: the stored body size of a live inline page in UTF-8 bytes,
//! and none for a missing or soft-deleted page. Segmented bodies are pinned by the engine parity
//! case (test/engine-parity/large-page.test.ts), which publishes one through the page_body members.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::json;

fn put(store: &Store, slug: &str, truth: &str, timeline: &str) {
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": slug, "compiled_truth": truth, "timeline": timeline}),
    )
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
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
