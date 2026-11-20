//! The phantom-redirect pass's root-page walk (phantom_redirect.rs): live root pages after a
//! cursor, minus the held ones, in slug byte order.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::json;

fn put(store: &Store, slug: &str) {
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "body"}))
            .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

#[test]
fn walks_root_pages_by_bytes_after_the_cursor_without_the_held() {
    let dir = TempDir::new("phantom-walk");
    let store = open(&dir);
    for slug in ["ab", "a0", "a-z", "b", "notes/x", "zz"] {
        put(&store, slug);
    }
    let all = store
        .list_root_page_slugs_after("default", "", &[], 10)
        .unwrap();
    assert_eq!(all, ["a-z", "a0", "ab", "b", "zz"]);
    let limited = store
        .list_root_page_slugs_after("default", "", &[], 2)
        .unwrap();
    assert_eq!(limited, ["a-z", "a0"]);
    let after = store
        .list_root_page_slugs_after("default", "a-z", &["ab".into()], 10)
        .unwrap();
    assert_eq!(after, ["a0", "b", "zz"]);
    assert!(
        store
            .list_root_page_slugs_after("other", "", &[], 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_deleted_page_is_not_walked_and_a_nul_byte_refuses() {
    let dir = TempDir::new("phantom-walk-deleted");
    let store = open(&dir);
    put(&store, "gone");
    put(&store, "kept");
    store.soft_delete_page("gone", None).unwrap();
    assert_eq!(
        store
            .list_root_page_slugs_after("default", "", &[], 10)
            .unwrap(),
        ["kept"]
    );
    let err = store
        .list_root_page_slugs_after("default", "a\0", &[], 10)
        .unwrap_err();
    assert_eq!(err.code, gbrain_store::error::INVALID_ARGUMENT);
}
