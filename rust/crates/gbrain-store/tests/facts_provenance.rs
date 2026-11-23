//! `listFactProvenance` (`facts/provenance.rs`): the stored `source` of the named facts of one
//! source.

mod memory_env;

use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::provenance::FactProvenanceQuery;
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn facts(b: &Brain, source_id: &str, rows: Value) -> Vec<i64> {
    let out = b
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": rows, "sourceId": source_id }),
        ))
        .unwrap();
    out["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_i64().unwrap())
        .collect()
}

fn provenance(b: &Brain, source_id: &str, ids: &[i64]) -> Value {
    json!(
        b.list_fact_provenance(&args::<FactProvenanceQuery>(
            json!({ "sourceId": source_id, "ids": ids }),
        ))
        .unwrap()
    )
}

#[test]
fn reads_the_stored_source_of_the_named_facts_of_one_source() {
    let b = brain("facts-provenance-read");
    b.upsert_source(&SourceInput {
        id: "other".into(),
        name: Some("other".into()),
        ..SourceInput::default()
    })
    .unwrap();
    let ids = facts(
        &b,
        "default",
        json!([
            { "fact": "a", "source": "fence", "source_markdown_slug": "people/a", "row_num": 1 },
            { "fact": "b", "source": "mcp:remember", "source_markdown_slug": "people/a", "row_num": 2 },
        ]),
    );
    let other = facts(&b, "other", json!([{ "fact": "c", "source": "cli" }]));
    // A repeated id answers once, in id order; an id of another source or with no row answers nothing.
    let all = provenance(
        &b,
        "default",
        &[ids[1], ids[0], ids[1], other[0], 9_999, -1],
    );
    assert_eq!(
        all,
        json!([{ "id": ids[0], "source": "fence" }, { "id": ids[1], "source": "mcp:remember" }])
    );
    assert_eq!(
        provenance(&b, "other", &[ids[0], other[0]]),
        json!([{ "id": other[0], "source": "cli" }])
    );
    assert_eq!(provenance(&b, "default", &[]), json!([]));
}

#[test]
fn refuses_a_nul_in_the_source_id() {
    let b = brain("facts-provenance-nul");
    assert!(
        b.list_fact_provenance(&args::<FactProvenanceQuery>(
            json!({ "sourceId": "a\u{0}b", "ids": [1] }),
        ))
        .is_err()
    );
}
