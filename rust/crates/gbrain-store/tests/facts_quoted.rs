//! The slot-history read of `facts/quoted.rs` against the rows its PGLite statement returns
//! (src/core/engine-sql/facts-recall.ts). The quote reads are `facts_quote.rs`.

mod memory_env;

use gbrain_store::facts::quoted::ReadablePageSlugsQuery;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn args<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// Puts `slug` into `source` with `page_type`; resolves the page id.
fn page(b: &Brain, source: &str, slug: &str, page_type: &str, frontmatter: Value) -> u64 {
    let input: PageInput = args(json!({
        "type": page_type, "title": slug, "compiled_truth": "x", "frontmatter": frontmatter }));
    let options: PutPageOptions = args(json!({ "sourceId": source }));
    b.put_page(slug, &input, &options).unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn source(b: &Brain, id: &str) {
    let input: SourceInput = args(json!({ "id": id, "name": id, "config": {} }));
    b.upsert_source(&input).unwrap();
}

#[test]
fn readable_page_slugs_apply_the_live_page_policy_in_the_asked_source() {
    let b = brain("quoted-readable-slugs");
    source(&b, "other");
    page(&b, "default", "people/a", "person", json!({}));
    page(&b, "default", "people/b", "person", json!({}));
    page(&b, "default", "people/gone", "person", json!({}));
    page(
        &b,
        "default",
        "people/held",
        "person",
        json!({ "quarantine": "x" }),
    );
    page(&b, "other", "people/c", "person", json!({}));
    b.soft_delete_page("people/gone", Some("default")).unwrap();
    let q = |slugs: Value, scope: Value, limit: u32| -> ReadablePageSlugsQuery {
        args(json!({ "sourceId": "default", "slugs": slugs, "scope": scope, "limit": limit }))
    };
    let asked = json!([
        "people/gone",
        "people/held",
        "people/c",
        "people/b",
        "people/a",
        "people/b"
    ]);
    assert_eq!(
        b.list_readable_page_slugs(&q(asked.clone(), json!({}), 10))
            .unwrap(),
        ["people/b", "people/a"]
    );
    assert_eq!(
        b.list_readable_page_slugs(&q(asked.clone(), json!({}), 1))
            .unwrap(),
        ["people/b"]
    );
    // The scope's own sources do not narrow the read: the source is `sourceId`.
    assert_eq!(
        b.list_readable_page_slugs(&q(
            asked,
            json!({ "sourceId": "other", "sourceIds": ["other"] }),
            10
        ))
        .unwrap(),
        ["people/b", "people/a"]
    );
    assert!(
        b.list_readable_page_slugs(&q(
            json!(["people/a"]),
            json!({ "minTrust": "operator_curated" }),
            10
        ))
        .unwrap()
        .is_empty()
    );
}
