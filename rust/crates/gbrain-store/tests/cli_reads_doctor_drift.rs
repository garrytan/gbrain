//! The provenance drift reads (`cli_reads/doctor_drift.rs`): the PGLite semantics of each, and null write attribution.

mod memory_env;

use gbrain_store::pages::{PageInput, PutPageOptions};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put(s: &Brain, slug: &str, body: &str) {
    let input: PageInput = args(json!({ "type": "note", "title": slug, "compiled_truth": body }));
    s.put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
}

fn live(s: &Brain, v: Value) -> Vec<Value> {
    s.list_drift_live_rows(&args(v)).unwrap()
}

fn slugs(rows: &[Value]) -> Vec<&str> {
    rows.iter().map(|r| r["slug"].as_str().unwrap()).collect()
}

#[test]
fn live_rows_come_by_id_after_a_cursor_or_at_a_slug_and_skip_deleted_pages() {
    let s = brain("drift-live");
    for slug in ["notes/a", "notes/b", "notes/gone"] {
        put(&s, slug, "body");
    }
    s.soft_delete_page("notes/gone", None).unwrap();
    let all = live(&s, json!({ "sourceId": "default" }));
    assert_eq!(slugs(&all), ["notes/a", "notes/b"]);
    let first = all[0]["id"].as_i64().unwrap();
    assert!(first < all[1]["id"].as_i64().unwrap());
    assert_eq!(
        slugs(&live(&s, json!({ "sourceId": "default", "after": first }))),
        ["notes/b"]
    );
    assert_eq!(
        slugs(&live(
            &s,
            json!({ "sourceId": "default", "slug": "notes/b" })
        )),
        ["notes/b"]
    );
    assert!(live(&s, json!({ "sourceId": "default", "slug": "notes/gone" })).is_empty());
    assert!(live(&s, json!({ "sourceId": "other" })).is_empty());
}

#[test]
fn a_row_carries_no_write_attribution_and_an_unstamped_page_reads_unknown() {
    let s = brain("drift-attribution");
    put(&s, "notes/a", "body");
    let row = &live(&s, json!({ "sourceId": "default" }))[0];
    for key in ["req", "kind", "remote"] {
        assert!(row[key].is_null(), "{key} must be null");
    }
    assert_eq!(row["trust_tier"], "unknown");
    assert!(row["revision"].is_string());
}

#[test]
fn version_rows_come_for_the_given_pages_with_their_frontmatter() {
    let s = brain("drift-versions");
    put(&s, "notes/a", "one");
    put(&s, "notes/b", "two");
    s.create_version("notes/a", None).unwrap();
    let ids: Vec<i64> = live(&s, json!({ "sourceId": "default" }))
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    let rows = s
        .list_drift_version_rows(&args(json!({ "pageIds": ids })))
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["page_id"], ids[0]);
    assert!(rows[0]["req"].is_null() && rows[0]["kind"].is_null() && rows[0]["remote"].is_null());
    assert!(
        s.list_drift_version_rows(&args(json!({ "pageIds": [ids[1]] })))
            .unwrap()
            .is_empty()
    );
}
