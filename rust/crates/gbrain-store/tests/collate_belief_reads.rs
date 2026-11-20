//! The belief ledger's orphan lifetime read (belief_ledger.rs). Nothing in the shipped store
//! writes a lifetime, so the cases that need one mint it through the test-only seed and run with
//! `cargo test -p gbrain-store --features test-seeds`; the empty-family cases run on both builds.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::belief_events::EventRow;
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
    let none = store.list_orphan_lifetimes("default", 20, false).unwrap();
    assert_eq!(none.total, 0);
    assert!(none.rows.is_empty());
    assert_eq!(
        store
            .list_orphan_lifetimes("missing", 20, false)
            .unwrap()
            .total,
        0
    );
    assert!(store.list_orphan_lifetimes("a\0b", 20, false).is_err());
}

fn event(inc: &str, key: &str, slug: &str, lifetime: Option<&str>) -> EventRow {
    serde_json::from_value(json!({
        "event_key": key, "source_id": "default", "source_incarnation": inc,
        "page_lifetime": lifetime, "slug": slug, "subject_kind": "page",
        "subject_key": "[\"page\"]", "event_type": "page.baseline", "origin": "live",
        "trust_tier": "unknown", "writer_tier": null, "tier_basis": "unknown",
        "visibility": "world", "publication_id": "6f9619ff-8b86-4d01-b42d-00cf4fc964f1",
        "ord": 0, "source_time": null, "valid_from": null, "valid_until": null, "value": null,
        "value_hash": null, "prior_hash": null, "state_hash": "", "cause": "{}",
        "claim_fp": null, "purged": false, "redacted_fields": null,
    }))
    .unwrap()
}

#[test]
fn the_deep_read_lists_events_that_name_a_missing_lifetime_once_each_in_byte_order() {
    let dir = TempDir::new("belief-orphans-deep");
    let store = open(&dir);
    let inc = store
        .get_source_by_id("default")
        .unwrap()
        .unwrap()
        .incarnation;
    let lifetime = |c: char| format!("00000000-0000-4000-8000-00000000000{c}");
    // Two events name `3`, one names `1` at another slug, one names none.
    let rows = vec![
        event(&inc, "a1", "tie/orphan", Some(&lifetime('3'))),
        event(&inc, "a2", "tie/orphan", Some(&lifetime('3'))),
        event(&inc, "a3", "tie/orphan", Some(&lifetime('1'))),
        event(&inc, "a4", "another", Some(&lifetime('2'))),
        event(&inc, "a5", "tie/orphan", None),
    ];
    assert_eq!(store.insert_belief_events(rows).unwrap(), 5);
    let shallow = store.list_orphan_lifetimes("default", 20, false).unwrap();
    assert_eq!(shallow.total, 0);
    let deep = store.list_orphan_lifetimes("default", 20, true).unwrap();
    assert_eq!(deep.total, 3);
    let found: Vec<(&str, &str, &str)> = deep
        .rows
        .iter()
        .map(|r| (r.slug.as_str(), r.page_lifetime.as_str(), r.reason.as_str()))
        .collect();
    assert_eq!(
        found,
        [
            ("another", lifetime('2').as_str(), "no_lifetime"),
            ("tie/orphan", lifetime('1').as_str(), "no_lifetime"),
            ("tie/orphan", lifetime('3').as_str(), "no_lifetime"),
        ]
    );
    let cut = store.list_orphan_lifetimes("default", 2, true).unwrap();
    assert_eq!((cut.total, cut.rows.len()), (3, 2));
    assert_eq!(
        store
            .list_orphan_lifetimes("other", 20, true)
            .unwrap()
            .total,
        0
    );
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
        let two = store.list_orphan_lifetimes("default", 2, false).unwrap();
        assert_eq!(two.total, 3);
        let found: Vec<&str> = two.rows.iter().map(|r| r.slug.as_str()).collect();
        assert_eq!(found, ["a-z", "a0"]);
        assert!(two.rows.iter().all(|r| r.reason == "no_page"));
        // A limit below one still returns one row, as the SQL's `max(1, limit)` does.
        assert_eq!(
            store
                .list_orphan_lifetimes("default", 0, false)
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
        assert_eq!(
            store
                .list_orphan_lifetimes("default", 20, false)
                .unwrap()
                .total,
            0
        );
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
