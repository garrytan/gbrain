//! Page operations: frontmatter marker reads and date reads, matched to PGLite.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put_in(store: &Store, source: &str, slug: &str, page: Value) -> Value {
    store
        .put_page(
            slug,
            &de::<PageInput>(page),
            &de::<PutPageOptions>(json!({ "sourceId": source })),
        )
        .unwrap()
}

fn put(store: &Store, slug: &str, page: Value) -> Value {
    put_in(store, "default", slug, page)
}

fn note(title: &str, body: &str) -> Value {
    json!({ "type": "note", "title": title, "compiled_truth": body })
}

fn slugs_of(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .map(|r| r["slug"].as_str().unwrap().to_string())
        .collect()
}

fn id_of(page: &Value) -> i64 {
    page["id"].as_i64().unwrap()
}

#[test]
fn marker_reads_and_dates_follow_the_read_scope() {
    let dir = TempDir::new("ops-markers");
    let store = open(&dir);
    let flagged = put(
        &store,
        "notes/flagged",
        json!({ "type": "note", "title": "F", "compiled_truth": "f", "frontmatter": { "content_flag": { "reason": "spam" } } }),
    );
    let empty_reason = put(
        &store,
        "notes/empty",
        json!({ "type": "note", "title": "E", "compiled_truth": "e", "frontmatter": { "content_flag": { "reason": "" } } }),
    );
    let auto = put(
        &store,
        "notes/auto",
        json!({ "type": "note", "title": "A", "compiled_truth": "a", "frontmatter": { "status": "unverified", "provenance": "auto-extracted" } }),
    );
    let quarantined = put(
        &store,
        "notes/q",
        json!({ "type": "note", "title": "Q", "compiled_truth": "q", "frontmatter": { "status": "draft", "quarantine": true, "content_flag": { "reason": "r", "detail": "d" } } }),
    );
    let ids = vec![
        id_of(&flagged),
        id_of(&empty_reason),
        id_of(&auto),
        id_of(&quarantined),
        999_999,
    ];
    let flags = store
        .get_content_flags_by_page_ids(&ids, &de(json!({})))
        .unwrap();
    assert_eq!(
        flags,
        vec![
            json!({ "id": id_of(&flagged), "reason": "spam", "detail": "" }),
            json!({ "id": id_of(&quarantined), "reason": "r", "detail": "d" }),
        ]
    );
    let live_flags = store
        .get_content_flags_by_page_ids(&ids, &de(json!({ "live": true })))
        .unwrap();
    assert_eq!(live_flags.len(), 1, "a scope hides quarantined pages");
    let states = store
        .get_unverified_extraction_page_ids(&ids, &de(json!({})))
        .unwrap();
    assert_eq!(
        states,
        vec![
            json!({ "id": id_of(&auto), "status": "unverified", "unverified": true }),
            json!({ "id": id_of(&quarantined), "status": "draft", "unverified": false }),
        ]
    );
    let dated = put(
        &store,
        "ts/dated",
        json!({ "type": "note", "title": "D", "compiled_truth": "d", "effective_date": "2024-05-01T00:00:00Z" }),
    );
    put(&store, "ts/undated", note("U", "u"));
    let stamps = store
        .get_page_timestamps(&[
            "ts/dated".to_string(),
            "ts/undated".to_string(),
            "ts/missing".to_string(),
        ])
        .unwrap();
    assert_eq!(slugs_of(&stamps), vec!["ts/dated", "ts/undated"]);
    assert_eq!(stamps[0]["ts"], dated["updated_at"]);
    let refs = de::<Vec<gbrain_store::page_ops::PageRef>>(json!([
        { "slug": "ts/dated", "source_id": "default" },
        { "slug": "ts/undated", "source_id": "default" },
        { "slug": "ts/dated", "source_id": "no-such" },
    ]));
    let dates = store.get_effective_dates(&refs, &de(json!({}))).unwrap();
    assert_eq!(slugs_of(&dates), vec!["ts/dated", "ts/undated"]);
    assert_eq!(dates[0]["ts"], "2024-05-01T00:00:00.000000Z");
    store
        .soft_delete_page("ts/undated", Some("default"))
        .unwrap();
    let live = store
        .get_effective_dates(&refs, &de(json!({ "live": true })))
        .unwrap();
    assert_eq!(slugs_of(&live), vec!["ts/dated"]);
}
