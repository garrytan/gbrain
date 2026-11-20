//! The identity-downgrade reads (identity_downgrades.rs), the checkpoint value rows
//! (op_checkpoint_values.rs) and the cycle window reads (cycle_window.rs).
//!
//! The reads that need a soft-deleted page or a shared `updated_at` seed it through the test-only
//! `test_seeds` methods, so those cases run with `cargo test -p gbrain-store --features test-seeds`.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::links::AddLinkOptions;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::{Value, json};

fn put(store: &Store, slug: &str) -> u64 {
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "body"}))
            .unwrap();
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap()["id"]
        .as_u64()
        .unwrap()
}

#[test]
fn checkpoint_values_round_trip_and_share_the_row_the_key_reader_reads() {
    let dir = TempDir::new("identity-checkpoint-values");
    let store = open(&dir);
    assert_eq!(
        store.read_op_checkpoint_values("op", "fp").unwrap(),
        Value::Null
    );
    let values = [json!({"last": "a-z"})];
    store
        .write_op_checkpoint_values("op", "fp", &values)
        .unwrap();
    assert_eq!(
        store.read_op_checkpoint_values("op", "fp").unwrap(),
        json!([{"last": "a-z"}])
    );
    // The key reader reads the same parent row and gives each element as its JSON text.
    assert_eq!(
        store.read_op_checkpoint_keys("op", "fp").unwrap(),
        json!({"keys": ["{\"last\":\"a-z\"}"], "corruptParent": false})
    );
    store
        .write_op_checkpoint_values("op", "fp", &[json!({"last": ""})])
        .unwrap();
    assert_eq!(
        store.read_op_checkpoint_values("op", "fp").unwrap(),
        json!([{"last": ""}])
    );
    assert_eq!(
        store.read_op_checkpoint_values("op", "other").unwrap(),
        Value::Null
    );
}

#[test]
fn carry_counts_count_the_links_of_a_page_once_whichever_end_it_is() {
    let dir = TempDir::new("identity-carry-counts");
    let store = open(&dir);
    let a = put(&store, "n/a");
    put(&store, "n/b");
    put(&store, "n/c");
    let options: AddLinkOptions =
        serde_json::from_value(json!({"linkType": "mentions", "context": "c"})).unwrap();
    store.add_link("n/a", "n/b", &options).unwrap();
    store.add_link("n/c", "n/a", &options).unwrap();
    store.add_link("n/b", "n/c", &options).unwrap();
    let counts = store.count_page_carry_rows("default", "n/a", a).unwrap();
    assert_eq!((counts.facts, counts.links, counts.aliases), (0, 2, 0));
    let none = store.count_page_carry_rows("default", "n/zz", 999).unwrap();
    assert_eq!((none.facts, none.links, none.aliases), (0, 0, 0));
}

#[cfg(feature = "test-seeds")]
mod seeded {
    use super::*;

    const DAY: i64 = 86_400_000_000;

    #[test]
    fn the_old_page_is_the_latest_deletion_then_the_lowest_id_and_live_pages_list_by_byte() {
        let dir = TempDir::new("identity-old-page");
        let store = open(&dir);
        let ids: Vec<u64> = ["n/ab", "n/a-z", "n/a0"]
            .iter()
            .map(|slug| put(&store, slug))
            .collect();
        // Three pages that one file backed, deleted in one instant; a later deletion at another path.
        for slug in ["n/a0", "n/a-z", "n/ab"] {
            store
                .seed_page_origin("default", slug, Some("notes/old.md"), Some(DAY))
                .unwrap();
        }
        let old = store
            .read_soft_deleted_page_at_origin("default", "notes/old.md", "n/none")
            .unwrap()
            .unwrap();
        assert_eq!(old.id, ids[0]);
        assert_eq!(old.slug, "n/ab");
        assert_eq!(old.deleted_at, "1970-01-02 00:00:00+00");
        put(&store, "n/later");
        store
            .seed_page_origin("default", "n/later", Some("notes/old.md"), Some(2 * DAY))
            .unwrap();
        let later = store
            .read_soft_deleted_page_at_origin("default", "notes/old.md", "n/none")
            .unwrap()
            .unwrap();
        assert_eq!(later.slug, "n/later");
        // A page with no path matches by slug; one with another path does not.
        store
            .seed_page_origin("default", "n/ab", None, Some(DAY))
            .unwrap();
        let by_slug = store
            .read_soft_deleted_page_at_origin("default", "elsewhere.md", "n/ab")
            .unwrap()
            .unwrap();
        assert_eq!(by_slug.slug, "n/ab");
        assert!(
            store
                .read_soft_deleted_page_at_origin("default", "elsewhere.md", "n/a0")
                .unwrap()
                .is_none()
        );
        // Live pages at a path, by slug bytes: `a-z` < `a0` < `ab`.
        for slug in ["n/ab", "n/a0", "n/a-z"] {
            store
                .seed_page_origin("default", slug, Some("notes/new.md"), None)
                .unwrap();
        }
        let live: Vec<String> = store
            .list_live_pages_at_origin("default", "notes/new.md")
            .unwrap()
            .into_iter()
            .map(|p| p.slug)
            .collect();
        assert_eq!(live, ["n/a-z", "n/a0", "n/ab"]);
        assert!(
            store
                .list_live_pages_at_origin("default", "notes/old.md")
                .unwrap()
                .iter()
                .all(|p| p.slug != "n/ab" && p.slug != "n/a0")
        );
    }

    #[test]
    fn a_window_pages_a_shared_updated_at_by_slug_bytes_from_a_cursor() {
        let dir = TempDir::new("identity-window");
        let store = open(&dir);
        for slug in ["ab", "a0", "a-z"] {
            put(&store, slug);
            store.seed_page_updated_at("default", slug, DAY).unwrap();
        }
        put(&store, "late");
        store
            .seed_page_updated_at("default", "late", 2 * DAY)
            .unwrap();
        let slugs = |rows: Vec<gbrain_store::cycle_window::SourceChangedPageRow>| -> Vec<String> {
            rows.into_iter().map(|r| r.slug).collect()
        };
        let all = store
            .list_source_changed_pages_after("default", None, "", 10)
            .unwrap();
        assert_eq!(all[0].updated_at, "1970-01-02T00:00:00.000000Z");
        assert_eq!(slugs(all), ["a-z", "a0", "ab", "late"]);
        let first = store
            .list_source_changed_pages_after("default", None, "", 1)
            .unwrap();
        assert_eq!(slugs(first), ["a-z"]);
        let after = store
            .list_source_changed_pages_after(
                "default",
                Some("1970-01-02T00:00:00.000000Z"),
                "a0",
                10,
            )
            .unwrap();
        assert_eq!(slugs(after), ["ab", "late"]);
        let error = store
            .list_source_changed_pages_after("default", Some("not a time"), "", 10)
            .unwrap_err();
        assert!(error.to_string().contains("UTC ISO"));
        assert!(
            store
                .list_source_changed_pages_after("other", None, "", 10)
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn the_listing_instant_is_utc_iso_text_with_microseconds() {
    let dir = TempDir::new("identity-listing-instant");
    let store = open(&dir);
    let at = store.read_cycle_listing_instant().unwrap();
    assert_eq!(at.len(), "2026-01-01T00:00:00.000000Z".len());
    assert!(at.ends_with('Z') && at.contains('T'));
}
