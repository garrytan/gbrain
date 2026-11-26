//! The three doctor-check page reads of the facts family (`facts/doctor_pages.rs`), each against
//! what the PGLite SQL of src/core/engine-sql/facts-doctor.ts answers.

mod memory_env;

use gbrain_store::facts::doctor_pages::SegmentedCensusQuery;
use gbrain_store::page_body::SegmentedPageMeta;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(b: &Brain, source: &str, slug: &str, kind: &str, body: &str, path: Option<&str>) {
    let mut input =
        json!({ "type": kind, "title": slug, "compiled_truth": body, "frontmatter": {} });
    if let Some(path) = path {
        input["source_path"] = json!(path);
    }
    let input: PageInput = de(input);
    b.put_page(
        slug,
        &input,
        &de::<PutPageOptions>(json!({ "sourceId": source, "index": false })),
    )
    .unwrap();
}

fn shell(b: &Brain, source: &str, slug: &str, kind: &str) {
    b.create_segmented_page_shell(
        slug,
        &de::<SegmentedPageMeta>(json!({ "type": kind, "title": slug })),
        &de(json!({ "sourceId": source })),
    )
    .unwrap();
}

fn census(b: &Brain, sources: &[&str], walked: &[&str]) -> Value {
    let q: SegmentedCensusQuery =
        de(json!({ "sourceIds": sources, "checkedOutSourceIds": walked }));
    b.count_segmented_census_pages(&q).unwrap()
}

#[test]
fn the_census_counts_live_segmented_markdown_pages_no_walked_file_covers() {
    let b = brain("doctor-census");
    b.upsert_source(&de::<SourceInput>(
        json!({ "id": "other", "name": "other", "config": {} }),
    ))
    .unwrap();
    page(&b, "default", "notes/inline", "note", "inline body", None);
    shell(&b, "default", "notes/seg-a", "note");
    shell(&b, "default", "notes/seg-b", "note");
    shell(&b, "other", "notes/seg-c", "note");
    // A segmented shell has no source path, so a walked source still counts it.
    assert_eq!(census(&b, &["default"], &[]), json!({ "n": 2 }));
    assert_eq!(census(&b, &["default"], &["default"]), json!({ "n": 2 }));
    assert_eq!(census(&b, &["default", "other"], &[]), json!({ "n": 3 }));
    assert_eq!(census(&b, &[], &["default"]), json!({ "n": 0 }));
    b.soft_delete_page("notes/seg-a", Some("default")).unwrap();
    assert_eq!(census(&b, &["default"], &[]), json!({ "n": 1 }));
}

#[test]
fn facts_page_bodies_list_live_facts_pages_by_source_then_slug_in_byte_order() {
    let b = brain("doctor-facts-bodies");
    b.upsert_source(&de::<SourceInput>(
        json!({ "id": "a-src", "name": "a-src", "config": {} }),
    ))
    .unwrap();
    page(
        &b,
        "default",
        "me/facts",
        "facts",
        "- 2026-01-01 born",
        None,
    );
    page(&b, "default", "company-x/facts", "facts", "- founded", None);
    page(&b, "default", "company/facts", "facts", "- c", None);
    page(&b, "default", "notes/plain", "note", "- not facts", None);
    page(&b, "default", "gone/facts", "facts", "- gone", None);
    b.soft_delete_page("gone/facts", Some("default")).unwrap();
    page(&b, "a-src", "me/facts", "facts", &"é".repeat(70_000), None);
    shell(&b, "default", "seg/facts", "facts");
    let rows = b.list_facts_page_bodies().unwrap();
    let keys: Vec<(String, String, bool)> = rows
        .iter()
        .map(|r| {
            (
                r["source_id"].as_str().unwrap().to_string(),
                r["slug"].as_str().unwrap().to_string(),
                r["segmented"].as_bool().unwrap(),
            )
        })
        .collect();
    let key = |s: &str, slug: &str, seg: bool| (s.to_string(), slug.to_string(), seg);
    assert_eq!(
        keys,
        vec![
            key("a-src", "me/facts", false),
            key("default", "company-x/facts", false),
            key("default", "company/facts", false),
            key("default", "me/facts", false),
            key("default", "seg/facts", true),
        ]
    );
    // `left` counts code points; a shell no flip published has no truth lead.
    assert_eq!(rows[0]["body"].as_str().unwrap().chars().count(), 65_536);
    assert_eq!(rows[1]["body"], json!("- founded"));
    assert_eq!(rows[4]["body"], Value::Null);
}

#[test]
fn the_fact_table_catalog_names_both_tables() {
    let b = brain("doctor-catalog");
    assert_eq!(
        b.read_fact_table_catalog().unwrap(),
        json!({ "facts": "facts", "attempts": "fact_relink_attempts" })
    );
}
