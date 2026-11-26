//! `listHeldTakeRows` (engine-sql/trust-fence.ts; `takes/held.rs`): the takes a write may not
//! delete or overwrite, by the stamped tier against the writer, and by an open `forget` contest
//! when the caller asks for it.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::takes::{HeldTakeSpec, ListTakesOptions, TakeInput};
use gbrain_store::trust::proposals::NewProposal;
use serde_json::{Value, json};
use std::collections::HashMap;

fn declare(store: &Store, tier: &str) {
    let names = ["gbrain.write_trust_tier".to_string()];
    store
        .apply_write_trust(&names, &[tier.to_string()])
        .unwrap();
}

fn add(store: &Store, page_id: u64, row_num: i32, claim: &str) {
    let take: TakeInput = serde_json::from_value(json!({
        "page_id": page_id, "row_num": row_num, "claim": claim, "kind": "take",
        "holder": "alice-example", "weight": 0.5, "active": true,
    }))
    .unwrap();
    assert_eq!(store.add_takes_batch(&[take]).unwrap(), 1);
}

/// A page with four takes: `curated` (operator_curated), `agent` (agent_written), `plain`
/// (undeclared, `unknown`) and `external` (external_untrusted). Returns their ids by claim.
fn seed(store: &Store) -> HashMap<String, i64> {
    let input = PageInput {
        page_type: "note".into(),
        title: "P".into(),
        compiled_truth: "body".into(),
        ..PageInput::default()
    };
    let page_id = store
        .put_page("p", &input, &PutPageOptions::default())
        .unwrap()["id"]
        .as_u64()
        .unwrap();
    declare(store, "operator_curated");
    add(store, page_id, 1, "curated");
    declare(store, "agent_written");
    add(store, page_id, 2, "agent");
    store.clear_write_trust();
    add(store, page_id, 3, "plain");
    declare(store, "external_untrusted");
    add(store, page_id, 4, "external");
    store.clear_write_trust();
    let options: ListTakesOptions =
        serde_json::from_value(json!({ "page_id": page_id, "limit": 50 })).unwrap();
    store
        .list_takes(&options)
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["claim"].as_str().unwrap().to_string(),
                r["id"].as_i64().unwrap(),
            )
        })
        .collect()
}

fn spec(ids: &[i64], writer: Option<&str>, pending: bool) -> HeldTakeSpec {
    serde_json::from_value(json!({
        "ids": ids,
        "writer": writer,
        "pending": pending,
    }))
    .unwrap()
}

/// The held takes as `(claim, tier)`, so the answer reads without raw ids.
fn held(store: &Store, ids: &HashMap<String, i64>, spec: &HeldTakeSpec) -> Vec<(String, String)> {
    let by_id: HashMap<i64, &String> = ids.iter().map(|(k, v)| (*v, k)).collect();
    store
        .list_held_take_rows(spec, &store.fence_context())
        .unwrap()
        .iter()
        .map(|r: &Value| {
            let id = r["id"].as_i64().unwrap();
            let name = by_id
                .get(&id)
                .map_or_else(|| format!("other:{id}"), |s| (*s).clone());
            (name, r["trust_tier"].as_str().unwrap().to_string())
        })
        .collect()
}

fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
    items
        .iter()
        .map(|(a, b)| ((*a).to_string(), (*b).to_string()))
        .collect()
}

#[test]
fn takes_above_the_writer_are_held_by_id_and_the_writer_defaults_to_the_write_trust_context() {
    let dir = TempDir::new("takes-held-tier");
    let store = open(&dir);
    let ids = seed(&store);
    let all: Vec<i64> = ["external", "plain", "agent", "curated"]
        .iter()
        .map(|s| ids[*s])
        .collect();
    let above_unknown = pairs(&[("curated", "operator_curated"), ("agent", "agent_written")]);
    // No writer named and nothing declared: the writer is `unknown`.
    assert_eq!(held(&store, &ids, &spec(&all, None, false)), above_unknown);
    // A named writer wins over the context; a name that is no tier ranks below every tier.
    declare(&store, "operator_curated");
    assert_eq!(
        held(&store, &ids, &spec(&all, Some("agent_written"), false)),
        pairs(&[("curated", "operator_curated")])
    );
    assert_eq!(
        held(&store, &ids, &spec(&all, Some("not_a_tier"), false)),
        pairs(&[
            ("curated", "operator_curated"),
            ("agent", "agent_written"),
            ("plain", "unknown"),
            ("external", "external_untrusted"),
        ])
    );
    // The declared tier is the writer when none is named; a writer equal to a take holds nothing.
    assert!(held(&store, &ids, &spec(&all, None, false)).is_empty());
    declare(&store, "external_untrusted");
    assert_eq!(
        held(&store, &ids, &spec(&all, None, false)),
        pairs(&[
            ("curated", "operator_curated"),
            ("agent", "agent_written"),
            ("plain", "unknown"),
        ])
    );
    store.clear_write_trust();
    // Only listed ids count; an id with no take, a negative id and an empty list read nothing.
    assert_eq!(
        held(
            &store,
            &ids,
            &spec(&[ids["agent"], 999_999, -4], None, false)
        ),
        pairs(&[("agent", "agent_written")])
    );
    assert!(held(&store, &ids, &spec(&[], None, false)).is_empty());
}

#[test]
fn a_pending_forget_holds_its_target_take_only_when_the_caller_asks_and_while_it_is_pending() {
    let dir = TempDir::new("takes-held-contest");
    let store = open(&dir);
    let ids = seed(&store);
    let all: Vec<i64> = ids.values().copied().collect();
    let proposal = |table: &str, target: &str, related: &str| -> NewProposal {
        serde_json::from_value(json!({
            "action": "forget", "sourceId": "default",
            "target": { "table": table, "id": ids[target] },
            "related": { "table": table, "id": ids[related] },
            "before": {}, "proposer": "test",
        }))
        .unwrap()
    };
    // `plain` is the target of a pending forget; `external` is only its related row. A forget of
    // the timeline row with `agent`'s id names another table and holds no take.
    let tp = store
        .insert_trust_proposal(&proposal("takes", "plain", "external"))
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    store
        .insert_trust_proposal(&proposal("timeline_entries", "agent", "agent"))
        .unwrap();
    let top = Some("user_confirmed");
    assert!(held(&store, &ids, &spec(&all, top, false)).is_empty());
    assert_eq!(
        held(&store, &ids, &spec(&all, top, true)),
        pairs(&[("plain", "unknown")])
    );
    // A decided proposal holds nothing.
    assert!(
        store
            .transition_trust_proposal(tp, "pending", "rejected", None, None)
            .unwrap()
    );
    assert!(held(&store, &ids, &spec(&all, top, true)).is_empty());
}
