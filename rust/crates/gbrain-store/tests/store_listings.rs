//! Byte-order listings the store serves for the engine-parity collate cases (lane 17): the shared-skill
//! member migration rows and the markdown page slugs.

mod common;

use common::{TempDir, open};
use gbrain_store::shared_skill_members::SharedSkillMemberEnroll;
use serde_json::json;

#[test]
fn shared_member_migration_rows_match_object_keys_and_array_elements_by_adapter_bytes() {
    let dir = TempDir::new("store-listings-members");
    let store = open(&dir);
    let enroll = |id: &str, adapter: &str, policy: serde_json::Value| {
        store
            .enroll_shared_skill_member(&SharedSkillMemberEnroll {
                installation_id: id.into(),
                principal_kind: "client".into(),
                principal_id: "c".into(),
                adapter: adapter.into(),
                brain_id: "00000000-0000-4000-8000-0000000000ff".into(),
                follow_policy: policy,
            })
            .unwrap();
    };
    enroll(
        "00000000-0000-4000-8000-000000000001",
        "ab",
        json!({ "sources": { "s": "1" } }),
    );
    enroll(
        "00000000-0000-4000-8000-000000000002",
        "a/z",
        json!({ "sources": { "s": 7 } }),
    );
    enroll(
        "00000000-0000-4000-8000-000000000003",
        "a-z",
        json!({ "sources": ["s"] }),
    );
    enroll(
        "00000000-0000-4000-8000-000000000004",
        "zz",
        json!({ "sources": { "other": "1" } }),
    );
    let rows = store.list_shared_member_migration_rows("s").unwrap();
    let rows = rows.as_array().unwrap();
    let adapters: Vec<&str> = rows
        .iter()
        .map(|r| r["adapter"].as_str().unwrap())
        .collect();
    assert_eq!(adapters, vec!["a-z", "a/z", "ab"]);
    // `->>` reads a number as its text and finds nothing under a key of an array.
    let approved: Vec<_> = rows
        .iter()
        .map(|r| r["approved_incarnation"].clone())
        .collect();
    assert_eq!(approved, vec![json!(null), json!("7"), json!("1")]);
    assert!(
        rows.iter()
            .all(|r| r["stage"].is_null() && r["epoch"] == json!(1) && r["active"] == json!(true))
    );
}

mod deletes {
    use super::common::{TempDir, open};
    use gbrain_store::Store;
    use gbrain_store::page_ops::SourceOption;
    use gbrain_store::pages::{PageInput, PutPageOptions};
    use gbrain_store::retrieval_feedback::{RatingBatchInput, RetrievalEventInput};
    use gbrain_store::sources::SourceInput;
    use gbrain_store::volunteer_events::VolunteerEventInput;
    use serde_json::{Value, json};

    fn put(store: &Store, source: &str, slug: &str) {
        let options: PutPageOptions =
            serde_json::from_value(json!({ "sourceId": source })).unwrap();
        let input: PageInput = serde_json::from_value(
            json!({ "type": "note", "title": slug, "compiled_truth": slug }),
        )
        .unwrap();
        store.put_page(slug, &input, &options).unwrap();
    }

    /// One source `work` with pages `a`, `b` and `c`, an event that returned `a` and `b` and used the link `a|t|b`,
    /// ratings and weights for `a`, `b` and the link, and a volunteer event per page.
    fn seeded(name: &str) -> (TempDir, Store) {
        let dir = TempDir::new(name);
        let store = open(&dir);
        store
            .upsert_source(&SourceInput {
                id: "work".into(),
                ..Default::default()
            })
            .unwrap();
        for slug in ["a", "b", "c"] {
            put(&store, "work", slug);
        }
        let events: Vec<RetrievalEventInput> = serde_json::from_value(json!([{ "id": "e1", "client_id": "local", "op": "query",
            "pages": [{ "source_id": "work", "slug": "a", "content_hash": null, "rank": 1, "cited": false },
                      { "source_id": "work", "slug": "b", "content_hash": null, "rank": 2, "cited": false }],
            "links": [{ "source_id": "work", "edge_key": "a|t|b", "to_slug": "c" }] }])).unwrap();
        store.insert_retrieval_events(&events).unwrap();
        let batch: RatingBatchInput = serde_json::from_value(json!({ "eventId": "e1", "clientId": "local", "signal": "explicit", "alpha": 0.5,
            "targets": [{ "kind": "page", "source_id": "work", "key": "a", "rating": 1, "content_hash": null },
                        { "kind": "page", "source_id": "work", "key": "b", "rating": 5, "content_hash": null },
                        { "kind": "link", "source_id": "work", "key": "a|t|b", "rating": 5, "content_hash": null }] })).unwrap();
        store.apply_retrieval_ratings(&batch).unwrap();
        let rows: Vec<VolunteerEventInput> = ["a", "b", "c"].iter()
            .map(|s| serde_json::from_value(json!({ "source_id": "work", "slug": s, "confidence": 0.5, "match_arm": "arm", "channel": "op" })).unwrap())
            .collect();
        store.insert_volunteer_events(&rows).unwrap();
        (dir, store)
    }

    fn channels(store: &Store) -> Value {
        store.list_volunteer_channels(None).unwrap()
    }

    #[test]
    fn a_hard_delete_scrubs_the_slug_from_the_feedback_rows_and_the_volunteer_log() {
        let (_dir, store) = seeded("listings-hard-delete");
        store
            .delete_pages(
                &["a".to_string()],
                &SourceOption {
                    source_id: Some("work".into()),
                },
            )
            .unwrap();
        let event = store.read_retrieval_event("e1").unwrap().unwrap();
        // The page row of `a` and the link whose edge starts at `a` go; `b` stays.
        assert_eq!(
            event["pages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p["slug"].clone())
                .collect::<Vec<_>>(),
            vec![json!("b")]
        );
        assert_eq!(event["links"], json!([]));
        let status = store.read_feedback_status().unwrap();
        // Of the three weights only `b`'s is left: `a` and the edge naming `a` are scrubbed.
        assert_eq!(status["counts"]["weights_total"], json!(1));
        assert_eq!(status["counts"]["ratings_explicit"], json!(1));
        assert_eq!(
            channels(&store),
            json!([{ "channel": "op", "n": 2, "last_fired": channels(&store)[0]["last_fired"] }])
        );
    }

    #[test]
    fn removing_a_source_drops_its_feedback_rows_and_volunteer_log_but_keeps_the_event() {
        let (_dir, store) = seeded("listings-source-delete");
        store.delete_source_record("work", false).unwrap();
        let event = store.read_retrieval_event("e1").unwrap().unwrap();
        assert_eq!(event["pages"], json!([]));
        assert_eq!(event["links"], json!([]));
        let status = store.read_feedback_status().unwrap();
        assert_eq!(status["counts"]["events"], json!(1));
        assert_eq!(status["counts"]["weights_total"], json!(0));
        assert_eq!(status["counts"]["ratings_explicit"], json!(0));
        assert_eq!(channels(&store), json!([]));
    }
}
