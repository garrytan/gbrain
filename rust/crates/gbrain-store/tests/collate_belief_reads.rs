//! The belief ledger's orphan lifetime read (belief_ledger.rs). Nothing in the shipped store
//! writes a lifetime, so the cases that need one mint it through the test-only seed and run with
//! `cargo test -p gbrain-store --features test-seeds`; the empty-family cases run on both builds.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::json;

fn put(store: &Store, slug: &str) {
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "body"}))
            .unwrap();
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
}

#[test]
fn a_brain_with_no_lifetimes_has_no_orphans_and_an_unknown_source_has_none() {
    let dir = TempDir::new("belief-orphans-empty");
    let store = open(&dir);
    put(&store, "kept");
    let none = store.list_orphan_lifetimes("default", 20).unwrap();
    assert_eq!(none.total, 0);
    assert!(none.rows.is_empty());
    assert_eq!(store.list_orphan_lifetimes("missing", 20).unwrap().total, 0);
    assert!(store.list_orphan_lifetimes("a\0b", 20).is_err());
}

#[cfg(feature = "test-seeds")]
mod seeded {
    use super::*;
    use gbrain_store::page_ops::SourceOption;

    fn slugs(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn lists_the_open_lifetimes_of_deleted_pages_by_slug_bytes_with_the_total() {
        let dir = TempDir::new("belief-orphans-bytes");
        let store = open(&dir);
        let all = ["ab", "a0", "a-z", "keep"];
        for slug in all {
            put(&store, slug);
        }
        assert_eq!(
            store
                .seed_belief_page_lifetimes("default", &slugs(&all))
                .unwrap()
                .len(),
            4
        );
        // A page that still exists is not an orphan; the three deleted ones are.
        let option = SourceOption {
            source_id: Some("default".into()),
        };
        store
            .delete_pages(&slugs(&["ab", "a0", "a-z"]), &option)
            .unwrap();
        let two = store.list_orphan_lifetimes("default", 2).unwrap();
        assert_eq!(two.total, 3);
        let found: Vec<&str> = two.rows.iter().map(|r| r.slug.as_str()).collect();
        assert_eq!(found, ["a-z", "a0"]);
        assert!(two.rows.iter().all(|r| r.reason == "no_page"));
        // A limit below one still returns one row, as the SQL's `max(1, limit)` does.
        assert_eq!(
            store
                .list_orphan_lifetimes("default", 0)
                .unwrap()
                .rows
                .len(),
            1
        );
    }

    #[test]
    fn a_soft_deleted_page_is_a_row_so_its_lifetime_is_not_an_orphan() {
        let dir = TempDir::new("belief-orphans-soft");
        let store = open(&dir);
        put(&store, "soft");
        store
            .seed_belief_page_lifetimes("default", &slugs(&["soft"]))
            .unwrap();
        store.soft_delete_page("soft", None).unwrap();
        assert_eq!(store.list_orphan_lifetimes("default", 20).unwrap().total, 0);
    }

    #[test]
    fn minting_twice_keeps_one_open_lifetime_and_a_missing_page_refuses() {
        let dir = TempDir::new("belief-orphans-mint");
        let store = open(&dir);
        put(&store, "once");
        assert_eq!(
            store
                .seed_belief_page_lifetimes("default", &slugs(&["once"]))
                .unwrap(),
            ["once"]
        );
        assert!(
            store
                .seed_belief_page_lifetimes("default", &slugs(&["once"]))
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .seed_belief_page_lifetimes("default", &slugs(&["nope"]))
                .is_err()
        );
    }
}
