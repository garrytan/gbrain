//! The facts arm's superseded-claim read (`list_typed_claim_facts_at_pages`, facts/recall.rs): the typed-claim facts
//! held on the named pages about the named entities, in every source and any state, and nothing for empty inputs.

mod memory_env;

use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn fact(
    b: &Brain,
    source: &str,
    entity: &str,
    page: &str,
    metric: Option<&str>,
    valid_from: &str,
    row: u32,
) -> u64 {
    let out = b
        .insert_facts(&args::<InsertFactsArgs>(json!({
            "rows": [{ "fact": format!("{entity} {page} {row}"), "entity_slug": entity, "source_markdown_slug": page,
                "row_num": row, "kind": "fact", "visibility": "world", "source": "fence",
                "claim_metric": metric, "claim_period": metric.map(|_| "2025"), "valid_from": valid_from }],
            "sourceId": source,
        })))
        .unwrap();
    out["ids"][0].as_u64().unwrap()
}

fn strs(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn typed_claims_on_the_named_pages_about_the_named_entities_in_every_source() {
    let b = brain("typed-claim-facts");
    b.upsert_source(&SourceInput {
        id: "other".into(),
        name: Some("other".into()),
        ..SourceInput::default()
    })
    .unwrap();
    let older = fact(
        &b,
        "default",
        "people/alice-example",
        "meetings/a",
        Some("revenue"),
        "2025-06-01T00:00:00.000Z",
        1,
    );
    let newer = fact(
        &b,
        "default",
        "people/alice-example",
        "notes/b",
        Some("revenue"),
        "2025-09-01T00:00:00.000Z",
        1,
    );
    let elsewhere = fact(
        &b,
        "other",
        "people/alice-example",
        "meetings/a",
        Some("arr"),
        "2025-07-01T00:00:00.000Z",
        1,
    );
    fact(
        &b,
        "default",
        "people/alice-example",
        "meetings/a",
        None,
        "2025-06-02T00:00:00.000Z",
        2,
    );
    fact(
        &b,
        "default",
        "people/bob-example",
        "meetings/a",
        Some("revenue"),
        "2025-06-03T00:00:00.000Z",
        3,
    );

    let rows = b
        .list_typed_claim_facts_at_pages(
            &strs(&["meetings/a", "notes/b"]),
            &strs(&["people/alice-example"]),
        )
        .unwrap();
    let mut ids: Vec<u64> = rows.iter().map(|r| r["id"].as_u64().unwrap()).collect();
    ids.sort_unstable();
    let mut want = vec![older, newer, elsewhere];
    want.sort_unstable();
    assert_eq!(ids, want);
    let first = rows.iter().find(|r| r["id"] == json!(older)).unwrap();
    assert_eq!(
        first,
        &json!({ "id": older, "source_markdown_slug": "meetings/a", "source_id": "default",
            "entity_slug": "people/alice-example", "claim_metric": "revenue", "claim_period": "2025",
            "valid_from": "2025-06-01T00:00:00.000000Z" })
    );

    let one = b
        .list_typed_claim_facts_at_pages(&strs(&["notes/b"]), &strs(&["people/alice-example"]))
        .unwrap();
    assert_eq!(
        one.iter().map(|r| r["id"].clone()).collect::<Vec<_>>(),
        vec![json!(newer)]
    );
    assert!(
        b.list_typed_claim_facts_at_pages(&[], &strs(&["people/alice-example"]))
            .unwrap()
            .is_empty()
    );
    assert!(
        b.list_typed_claim_facts_at_pages(&strs(&["meetings/a"]), &[])
            .unwrap()
            .is_empty()
    );
    assert!(
        b.list_typed_claim_facts_at_pages(&strs(&["meetings/a"]), &strs(&["people/nobody"]))
            .unwrap()
            .is_empty()
    );
}
