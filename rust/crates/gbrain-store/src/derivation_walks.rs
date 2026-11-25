//! Unit tests of the two `derivation_inputs` walks (`generations/derivation_inputs.rs`): the upward walk the owner-only
//! lineage reads (`lineage_reaches`) and the downward closure a page delete marks (`derived_closure`).
use crate::generations::{DerivationInputsArgs, derived_closure, inputs_of, lineage_reaches};
use crate::test_support::store;
use serde_json::json;
use std::collections::BTreeSet;

fn pair(table: &str, id: &str) -> (String, String) {
    (table.to_string(), id.to_string())
}

/// The upward walk (`lineage_reaches`) and the downward one (`derived_closure`) are transitive and end on a cycle.
#[test]
fn the_lineage_walks_are_transitive_and_survive_a_cycle() {
    let s = store();
    let edge = |d: (&str, &str), i: (&str, &str)| {
        let args: DerivationInputsArgs = serde_json::from_value(json!({
            "derived": { "table": d.0, "id": d.1 }, "inputs": [{ "table": i.0, "id": i.1 }],
        }))
        .unwrap();
        s.record_derivation_inputs(&args).unwrap();
    };
    edge(("pages", "3"), ("pages", "2"));
    edge(("pages", "2"), ("facts", "1"));
    edge(("facts", "1"), ("pages", "3"));
    let read = s.read().unwrap();
    assert_eq!(
        inputs_of(&*read, "pages", "3").unwrap(),
        vec![pair("pages", "2")]
    );
    let mut up = BTreeSet::new();
    let reached = lineage_reaches(&*read, "pages", "3", &mut |t, id| {
        up.insert(pair(t, id));
        Ok(false)
    })
    .unwrap();
    assert!(!reached);
    let all: BTreeSet<_> = [pair("facts", "1"), pair("pages", "2"), pair("pages", "3")]
        .into_iter()
        .collect();
    assert_eq!(up, all);
    assert_eq!(derived_closure(&*read, &[pair("facts", "1")]).unwrap(), all);
}
