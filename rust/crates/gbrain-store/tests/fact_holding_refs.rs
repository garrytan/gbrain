//! The observed-date read's holding refs (`list_fact_holding_refs`, facts/recall.rs): each named fact's source,
//! holding page slug and entity, in every source and any state, in id order; a missing id answers nothing and a
//! fractional id is an error, as the bigint cast is.

mod memory_env;

use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn fact(b: &Brain, source: &str, entity: &str, page: Option<&str>, row: u32) -> u64 {
    let out = b
        .insert_facts(&args::<InsertFactsArgs>(json!({
            "rows": [{ "fact": format!("{entity} {row}"), "entity_slug": entity, "source_markdown_slug": page,
                "row_num": row, "kind": "fact", "visibility": "world", "source": "fence" }],
            "sourceId": source,
        })))
        .unwrap();
    out["ids"][0].as_u64().unwrap()
}

#[test]
fn each_fact_answers_its_source_holding_slug_and_entity() {
    let b = brain("fact-holding-refs");
    b.upsert_source(&SourceInput {
        id: "other".into(),
        name: Some("other".into()),
        ..SourceInput::default()
    })
    .unwrap();
    let held = fact(&b, "default", "people/alice-example", Some("meetings/a"), 1);
    let own = fact(&b, "other", "people/bob-example", None, 2);
    let rows = b
        .list_fact_holding_refs(&[own as f64, held as f64, 999_999.0])
        .unwrap();
    assert_eq!(
        rows,
        vec![
            json!({ "id": held, "source_id": "default", "slug": "meetings/a", "entity_slug": "people/alice-example" }),
            json!({ "id": own, "source_id": "other", "slug": null, "entity_slug": "people/bob-example" }),
        ]
    );
    assert!(b.list_fact_holding_refs(&[]).unwrap().is_empty());
}

#[test]
fn a_fractional_id_is_an_error() {
    let b = brain("fact-holding-refs-fraction");
    assert!(b.list_fact_holding_refs(&[1.5]).is_err());
}
