//! The reads withdrawal discovery makes (`facts/withdrawal_discovery.rs`): a read's shape, the claim keys and the
//! pages of the facts that carry a claim, candidate matches by either fingerprint, the inline fence shortlist with
//! escaped LIKE tokens, and the page reads by id (sample slugs in byte order, never another source's page).

mod memory_env;

use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::withdrawal_discovery::DiscoveryRead;
use memory_env::{Brain, brain};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn sha(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn page(b: &Brain, slug: &str, compiled_truth: &str) -> i64 {
    let input: gbrain_store::pages::PageInput = args(json!({
        "type": "note", "title": slug, "compiled_truth": compiled_truth, "frontmatter": {} }));
    let out = b.put_page(slug, &input, &args(json!({}))).unwrap();
    out["id"].as_i64().unwrap()
}

fn read(b: &Brain, q: Value) -> Vec<Value> {
    b.read_withdrawal_discovery(&args::<DiscoveryRead>(q))
        .unwrap()
}

fn fence(claim: &str) -> String {
    format!(
        "<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | {claim} | fact | 1.0 | world | medium |  |  |  |  |\n<!--- gbrain:facts:end -->\n"
    )
}

#[test]
fn a_read_with_an_unknown_kind_or_field_is_refused() {
    let bad_kind = serde_json::from_value::<DiscoveryRead>(
        json!({ "kind": "every_page", "sourceId": "default" }),
    );
    assert!(bad_kind.is_err());
    let bad_field = serde_json::from_value::<DiscoveryRead>(
        json!({ "kind": "target_pages", "sourceId": "default", "ids": [], "limit": 3 }),
    );
    assert!(bad_field.is_err());
}

#[test]
fn claim_keys_normalize_a_claim_or_take_a_source_fact_by_either_fingerprint() {
    let b = brain("wd-keys");
    b.insert_facts(&args::<InsertFactsArgs>(json!({
        "rows": [{ "fact": "Alice keeps bees!", "entity_slug": "people/e-example", "source_markdown_slug": null,
            "row_num": 1, "kind": "fact", "visibility": "world", "source": "fence" }],
        "sourceId": "default",
    })))
    .unwrap();
    let keys = read(
        &b,
        json!({ "kind": "claim_keys", "sourceId": "default", "claims": [
            { "visibility": "world", "fact_hash": "x", "subject": "*", "claim": " Alice,  KEEPS bees. " },
            { "visibility": "world", "fact_hash": sha("alice keeps bees"), "subject": null, "claim": null },
            { "visibility": "world", "fact_hash": sha("alice keeps bees!"), "subject": "people/e-example", "claim": null },
            { "visibility": "private", "fact_hash": sha("alice keeps bees"), "subject": "*", "claim": null },
        ] }),
    );
    let norms: Vec<(Value, Value)> = keys
        .iter()
        .map(|k| (k["subject"].clone(), k["norm"].clone()))
        .collect();
    assert_eq!(
        norms,
        vec![
            (json!("*"), json!("alice keeps bees")),
            (json!("*"), json!("alice keeps bees")),
            (json!("people/e-example"), json!("alice keeps bees")),
            (json!("*"), Value::Null),
        ]
    );
    let pages = read(
        &b,
        json!({ "kind": "provenance_pages", "sourceId": "default", "keys": [
            { "visibility": "world", "fact_hash": "x", "subject": "*", "norm": "alice keeps bees", "patterns": [] }] }),
    );
    assert!(pages.is_empty(), "the entity page was never written");
    let id = page(&b, "people/e-example", "x");
    let pages = read(
        &b,
        json!({ "kind": "provenance_pages", "sourceId": "default", "keys": [
            { "visibility": "world", "fact_hash": "x", "subject": "*", "norm": "alice keeps bees", "patterns": [] }] }),
    );
    assert_eq!(pages, vec![json!({ "id": id })]);
}

#[test]
fn claim_matches_take_either_fingerprint_visibility_and_subject() {
    let b = brain("wd-matches");
    let key =
        json!({ "visibility": "world", "fact_hash": sha("alice keeps bees"), "subject": "*" });
    let out = read(
        &b,
        json!({ "kind": "claim_matches", "keys": [key], "incoming": [
            { "id": 3, "slug": "a", "claim": "ALICE keeps bees", "visibility": null, "ambiguous": true },
            { "id": 1, "slug": "a", "claim": "alice keeps bees!", "visibility": "world", "ambiguous": false },
            { "id": 2, "slug": "b", "claim": "alice keeps bees", "visibility": "private", "ambiguous": false },
            { "id": 1, "slug": "a", "claim": "Alice keeps bees", "visibility": "world", "ambiguous": false },
        ] }),
    );
    assert_eq!(
        out,
        vec![
            json!({ "id": 1, "ambiguous": false }),
            json!({ "id": 3, "ambiguous": true })
        ]
    );
}

#[test]
fn inline_fence_pages_shortlist_by_escaped_tokens_after_a_cursor() {
    let b = brain("wd-inline");
    let literal = page(&b, "notes/literal", &fence("50% of C_plus"));
    let near = page(&b, "notes/near", &fence("50 of C plus"));
    page(&b, "notes/plain", "50% of C_plus");
    let key = |patterns: Value| json!({ "visibility": "world", "fact_hash": "x", "subject": "*", "patterns": patterns });
    let slugs = |patterns: Value, after: i64| -> Vec<Value> {
        read(
            &b,
            json!({ "kind": "inline_fence_pages", "sourceId": "default", "keys": [key(patterns)],
            "after": after, "limit": 10, "subjects": null }),
        )
        .into_iter()
        .map(|r| r["slug"].clone())
        .collect()
    };
    assert_eq!(
        slugs(json!(["%50\\%%", "%c\\_plus%"]), 0),
        vec![json!("notes/literal")]
    );
    assert_eq!(
        slugs(json!([]), 0),
        vec![json!("notes/literal"), json!("notes/near")]
    );
    assert_eq!(slugs(json!([]), literal), vec![json!("notes/near")]);
    assert_eq!(slugs(json!([]), near), Vec::<Value>::new());
}

#[test]
fn page_reads_by_id_keep_to_the_source_and_sample_in_byte_order() {
    let b = brain("wd-pages");
    // Byte order puts `_` (0x5f) before `b`; a linguistic collation that skips punctuation would not.
    let lower = page(&b, "notes/ab", "x");
    let upper = page(&b, "notes/a_z", "x");
    let out = read(
        &b,
        json!({ "kind": "sample_slugs", "sourceId": "default", "ids": [lower, upper, 999] }),
    );
    assert_eq!(
        out,
        vec![
            json!({ "slug": "notes/a_z" }),
            json!({ "slug": "notes/ab" })
        ]
    );
    let out = read(
        &b,
        json!({ "kind": "target_pages", "sourceId": "other", "ids": [lower, upper] }),
    );
    assert!(out.is_empty());
    let out = read(
        &b,
        json!({ "kind": "target_pages", "sourceId": "default", "ids": [lower] }),
    );
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["slug"], json!("notes/ab"));
    assert_eq!(out[0]["page_id"], json!(lower));
    assert!(out[0]["revision"].is_string());
}
