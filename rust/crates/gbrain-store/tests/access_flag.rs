//! The sticky member-access flag: a page write whose frontmatter has a top-level `readable_by`
//! key sets config `access.restrictions_present` to `'1'`, as PGLite's trigger
//! `pages_access_mark_restricted` does; a page without it leaves the flag unset.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::{Value, json};

const FLAG: &str = "access.restrictions_present";

fn put(store: &Store, slug: &str, frontmatter: Value) {
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter
    }))
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

#[test]
fn a_page_without_readable_by_leaves_the_flag_unset() {
    let dir = TempDir::new("access-flag");
    let store = open(&dir);
    put(
        &store,
        "notes/open",
        json!({"tags": ["a"], "meta": {"readable_by": ["x"]}}),
    );
    assert_eq!(store.get_config(FLAG).unwrap(), None);
}

#[test]
fn a_page_with_readable_by_sets_the_flag_and_it_stays_set() {
    let dir = TempDir::new("access-flag");
    let store = open(&dir);
    put(
        &store,
        "notes/closed",
        json!({"readable_by": ["alice-example"]}),
    );
    assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
    put(&store, "notes/closed", json!({}));
    store
        .soft_delete_page("notes/closed", Some("default"))
        .unwrap();
    assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
}

#[test]
fn a_flag_set_to_another_value_is_set_to_one() {
    let dir = TempDir::new("access-flag");
    let store = open(&dir);
    store.set_config(FLAG, "0").unwrap();
    put(
        &store,
        "notes/closed",
        json!({"readable_by": "group:team-a"}),
    );
    assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
}
