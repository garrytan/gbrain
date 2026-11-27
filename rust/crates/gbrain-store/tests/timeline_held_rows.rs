//! `listHeldTimelineRows` (engine-sql/trust-fence.ts; `timeline/held.rs`): the timeline rows a
//! write may not delete or overwrite, by the stamped tier against the writer, and by an open
//! `forget` contest when the caller asks for it.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::timeline::{
    AddTimelineOptions, HeldTimelineSpec, TimelineInput, TimelineOptions,
};
use gbrain_store::trust::proposals::NewProposal;
use serde_json::{Value, json};
use std::collections::HashMap;

fn declare(store: &Store, tier: &str) {
    let names = ["gbrain.write_trust_tier".to_string()];
    store
        .apply_write_trust(&names, &[tier.to_string()])
        .unwrap();
}

fn add(store: &Store, date: &str, summary: &str) {
    let entry = TimelineInput {
        date: Some(date.into()),
        summary: Some(summary.into()),
        ..TimelineInput::default()
    };
    assert!(
        store
            .add_timeline_entry("p", &entry, &AddTimelineOptions::default())
            .unwrap()
    );
}

/// A page with four rows: `curated` (operator_curated), `agent` (agent_written), `plain`
/// (undeclared, `unknown`) and `external` (external_untrusted). Returns their ids by summary.
fn seed(store: &Store) -> HashMap<String, i64> {
    let input = PageInput {
        page_type: "note".into(),
        title: "P".into(),
        compiled_truth: "body".into(),
        ..PageInput::default()
    };
    store
        .put_page("p", &input, &PutPageOptions::default())
        .unwrap();
    declare(store, "operator_curated");
    add(store, "2026-01-01", "curated");
    declare(store, "agent_written");
    add(store, "2026-01-02", "agent");
    store.clear_write_trust();
    add(store, "2026-01-03", "plain");
    declare(store, "external_untrusted");
    add(store, "2026-01-04", "external");
    store.clear_write_trust();
    store
        .get_timeline("p", &TimelineOptions::default())
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["summary"].as_str().unwrap().to_string(),
                r["id"].as_i64().unwrap(),
            )
        })
        .collect()
}

fn spec(ids: &[i64], writer: Option<&str>, pending: bool) -> HeldTimelineSpec {
    serde_json::from_value(json!({
        "ids": ids,
        "writer": writer,
        "pending": pending,
    }))
    .unwrap()
}

/// The held rows as `(summary, tier)`, so the answer reads without raw ids.
fn held(
    store: &Store,
    ids: &HashMap<String, i64>,
    spec: &HeldTimelineSpec,
) -> Vec<(String, String)> {
    let by_id: HashMap<i64, &String> = ids.iter().map(|(k, v)| (*v, k)).collect();
    store
        .list_held_timeline_rows(spec, &store.fence_context())
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
fn rows_above_the_writer_are_held_by_id_and_the_writer_defaults_to_the_write_trust_context() {
    let dir = TempDir::new("timeline-held-tier");
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
    // The declared tier is the writer when none is named.
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
    // Only listed ids count; an id with no row, a negative id and an empty list read nothing.
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
fn a_pending_forget_holds_its_target_only_when_the_caller_asks_and_while_it_is_pending() {
    let dir = TempDir::new("timeline-held-contest");
    let store = open(&dir);
    let ids = seed(&store);
    let all: Vec<i64> = ids.values().copied().collect();
    let proposal = |target: &str, related: &str| -> NewProposal {
        serde_json::from_value(json!({
            "action": "forget", "sourceId": "default",
            "target": { "table": "timeline_entries", "id": ids[target] },
            "related": { "table": "timeline_entries", "id": ids[related] },
            "before": {}, "proposer": "test",
        }))
        .unwrap()
    };
    // `plain` is the target of a pending forget; `external` is only its related row.
    let tp = store
        .insert_trust_proposal(&proposal("plain", "external"))
        .unwrap()["id"]
        .as_i64()
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
