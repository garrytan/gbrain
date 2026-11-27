//! The fact purge's version members: `listPurgeVersionBodies` (PGLite's
//! `engine-sql/segmented-purge-writes.ts` `PURGE_VERSION_BODY_SQL`) and `createVersion` with the
//! purge's preimage (`createPageVersion(..., preimage)`).

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{CreateVersionOptions, PageInput, PutPageOptions};
use gbrain_store::purge_version_bodies::PurgeVersionBodyQuery;
use serde_json::{Value, json};

fn put(store: &Store, slug: &str, page: Value) -> u64 {
    let input: PageInput = serde_json::from_value(page).unwrap();
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
    store.create_version(slug, Some("default")).unwrap()["page_id"]
        .as_u64()
        .unwrap()
}

fn query(page_ids: &[u64], after: i64) -> PurgeVersionBodyQuery {
    serde_json::from_value(json!({
        "sourceId": "default", "pageIds": page_ids, "after": after,
        "needle": "alice said \"tea\"", "escaped": "alice said \\\"tea\\\"",
    }))
    .unwrap()
}

#[test]
fn the_purge_reads_named_pages_and_claim_carriers_in_id_order() {
    let dir = TempDir::new("purge-version-bodies");
    let store = open(&dir);
    let named = put(
        &store,
        "notes/named",
        json!({"type": "note", "title": "Named", "compiled_truth": "nothing"}),
    );
    put(
        &store,
        "notes/body",
        json!({"type": "note", "title": "Body", "compiled_truth": "Today ALICE said \"Tea\" here"}),
    );
    put(
        &store,
        "notes/title",
        json!({"type": "note", "title": "Why Alice Said \"Tea\"", "compiled_truth": "plain"}),
    );
    put(
        &store,
        "notes/fm",
        json!({"type": "note", "title": "Fm", "compiled_truth": "plain",
        "frontmatter": {"quote": "Alice said \"tea\" today"}}),
    );
    put(
        &store,
        "notes/other",
        json!({"type": "note", "title": "Other", "compiled_truth": "alice said tea"}),
    );
    let rows = store
        .list_purge_version_bodies(&query(&[named], 0))
        .unwrap();
    let seen: Vec<(String, bool)> = rows
        .iter()
        .map(|r| {
            (
                r["slug"].as_str().unwrap().to_string(),
                r["metadata"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        seen,
        vec![
            ("notes/named".to_string(), false),
            ("notes/body".to_string(), false),
            ("notes/title".to_string(), true),
            ("notes/fm".to_string(), true),
        ]
    );
    let first = rows[0]["id"].as_i64().unwrap();
    assert_eq!(
        store
            .list_purge_version_bodies(&query(&[named], first))
            .unwrap()
            .len(),
        3
    );
    let other: PurgeVersionBodyQuery = serde_json::from_value(json!({
        "sourceId": "elsewhere", "pageIds": [named], "after": 0, "needle": "x", "escaped": "x",
    }))
    .unwrap();
    assert!(store.list_purge_version_bodies(&other).unwrap().is_empty());
}

#[test]
fn a_version_with_a_preimage_keeps_the_read_revision_and_body() {
    let dir = TempDir::new("version-preimage");
    let store = open(&dir);
    put(
        &store,
        "notes/p",
        json!({"type": "note", "title": "Now", "compiled_truth": "current body"}),
    );
    let options: CreateVersionOptions = serde_json::from_value(json!({
        "sourceId": "default",
        "preimage": {"revision": "00000000-0000-4000-8000-000000000001", "title": "Read", "type": "note",
            "frontmatter": {"stage": "read"}, "tags": ["b", "a"], "compiledTruth": "read body", "timeline": null,
            "sourcePath": null, "deleted": false},
    }))
    .unwrap();
    let row = store.create_version_opts("notes/p", &options).unwrap();
    assert_eq!(
        row["knowledge_revision"],
        json!("00000000-0000-4000-8000-000000000001")
    );
    assert_eq!(row["compiled_truth"], json!("read body"));
    assert_eq!(row["title"], json!("Read"));
    assert_eq!(row["frontmatter"], json!({"stage": "read"}));
    // A caller's preimage keeps its tags in the order given, as PGLite's version insert does.
    assert_eq!(row["tags"], json!(["b", "a"]));
    // A revision spelled upper-case is stored lower-case, as the `::uuid` cast stores it.
    let upper: CreateVersionOptions = serde_json::from_value(json!({
        "sourceId": "default",
        "preimage": {"revision": "00000000-0000-4000-8000-0000000000AB", "title": "Read", "type": "note",
            "frontmatter": {}, "tags": [], "compiledTruth": "read body", "timeline": null,
            "sourcePath": null, "deleted": false},
    }))
    .unwrap();
    let row = store.create_version_opts("notes/p", &upper).unwrap();
    assert_eq!(
        row["knowledge_revision"],
        json!("00000000-0000-4000-8000-0000000000ab")
    );
}
