//! A per-source cycle's window reads (`readCycleListingInstant`, `listSourceChangedPagesAfter`). Expected rows follow
//! the SQL in src/core/engine-sql/cycle-window.ts.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::json;

fn put(store: &Store, source: &str, slug: &str) {
    let input: PageInput =
        serde_json::from_value(json!({ "type": "note", "title": slug, "compiled_truth": "body" }))
            .unwrap();
    let options: PutPageOptions =
        serde_json::from_value(json!({ "sourceId": source, "index": false })).unwrap();
    store.put_page(slug, &input, &options).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2));
}

fn iso_micros(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 27 && b[10] == b'T' && b[19] == b'.' && b[26] == b'Z'
}

#[test]
fn the_window_lists_live_pages_of_the_source_after_the_cursor_in_write_order() {
    let dir = TempDir::new("cycle-window");
    let store = open(&dir);
    store
        .upsert_source(&SourceInput {
            id: "other".into(),
            ..Default::default()
        })
        .unwrap();
    for slug in ["notes/w-1", "notes/w-2", "notes/w-3", "notes/w-4"] {
        put(&store, "default", slug);
    }
    put(&store, "other", "notes/elsewhere");
    store
        .soft_delete_page("notes/w-3", Some("default"))
        .unwrap();

    let all = store
        .list_source_changed_pages_after("default", None, "", 10)
        .unwrap();
    let slugs: Vec<&str> = all.iter().map(|r| r.slug.as_str()).collect();
    assert_eq!(slugs, vec!["notes/w-1", "notes/w-2", "notes/w-4"]);
    assert!(all.iter().all(|r| iso_micros(&r.updated_at)));

    let first = store
        .list_source_changed_pages_after("default", None, "", 1)
        .unwrap();
    assert_eq!(first.len(), 1);
    let after = store
        .list_source_changed_pages_after("default", Some(&first[0].updated_at), &first[0].slug, 10)
        .unwrap();
    let rest: Vec<&str> = after.iter().map(|r| r.slug.as_str()).collect();
    assert_eq!(rest, vec!["notes/w-2", "notes/w-4"]);

    assert!(
        store
            .list_source_changed_pages_after("default", Some("not a time"), "", 10)
            .is_err()
    );
    assert!(iso_micros(&store.read_cycle_listing_instant().unwrap()));
}
