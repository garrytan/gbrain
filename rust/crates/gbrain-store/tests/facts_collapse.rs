//! `pageCollapseFacts`: the collapse-stage read of hybrid search (`facts/collapse.rs`).

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn put(store: &Store, slug: &str, body: &str, frontmatter: Value, source: Option<&str>) -> i64 {
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": body, "frontmatter": frontmatter,
    }))
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({ "sourceId": source })).unwrap();
    store.put_page(slug, &input, &options).unwrap()["id"]
        .as_i64()
        .unwrap()
}

#[test]
fn collapse_facts_answer_every_page_row_by_id() {
    let dir = TempDir::new("facts-collapse");
    let store = open(&dir);
    let other: SourceInput =
        serde_json::from_value(json!({ "id": "other", "name": "other", "config": {} })).unwrap();
    store.upsert_source(&other).unwrap();
    let long = format!("  {}é  ", "x".repeat(250));
    let a = put(
        &store,
        "n/a",
        &long,
        json!({ "redirect_to": "  ", "redirect": 7, "merged_into": " n/t " }),
        None,
    );
    let b = put(
        &store,
        "n/b",
        "\tshort ",
        json!({ "status": "Re-Redirected", "superseded_by": "n/s" }),
        Some("other"),
    );
    let c = put(
        &store,
        "n/c",
        "body",
        json!({ "status": "aliased", "superseded_by": "n/s" }),
        None,
    );
    store.soft_delete_page("n/c", None).unwrap();
    let rows = store
        .page_collapse_facts(&[c, b, a, a, 999_999, -1], &[a, b])
        .unwrap();
    let ids: Vec<i64> = rows.iter().map(|r| r["id"].as_i64().unwrap()).collect();
    let mut want = vec![a, b, c];
    want.sort();
    assert_eq!(ids, want);
    let row = |id: i64| rows.iter().find(|r| r["id"].as_i64() == Some(id)).unwrap();
    let body = format!("{}é", "x".repeat(250));
    // `->>` gives a number its text, so `redirect: 7` answers before `merged_into`.
    assert_eq!(row(a)["target"], json!("7"));
    assert_eq!(row(a)["body_chars"], json!(251));
    assert_eq!(row(a)["body"].as_str().unwrap().len(), 32);
    assert_eq!(row(a)["lead"], json!(body));
    assert_eq!(row(b)["target"], json!("n/s"));
    assert_eq!(row(b)["body_chars"], json!(6));
    assert_eq!(row(b)["body"], Value::Null);
    assert_eq!(row(b)["lead"], json!("\tshort"));
    assert_eq!(row(c)["target"], Value::Null);
    assert_eq!(row(c)["lead"], Value::Null);
    assert!(store.page_collapse_facts(&[], &[]).unwrap().is_empty());
}
