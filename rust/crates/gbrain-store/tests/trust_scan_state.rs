//! The trust scan's state reads (`trust/scan_state.rs`): the claimed sources it refuses to run
//! past and each scanned table's ceiling.

mod memory_env;

use gbrain_store::sources::SourceInput;
use gbrain_store::takes::TakeInput;
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput};
use gbrain_store::trust::scan_state::ClaimPendingQuery;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn source(b: &Brain, id: &str, config: Value) {
    b.upsert_source(&SourceInput {
        id: id.into(),
        name: Some(id.into()),
        config: Some(args(config)),
        ..SourceInput::default()
    })
    .unwrap();
}

fn pending(b: &Brain) -> Vec<String> {
    let kinds = ["google", "github", "meetings", "slack", "imessage"].map(String::from);
    b.list_claim_pending_source_ids(&ClaimPendingQuery {
        connector_kinds: kinds.to_vec(),
    })
    .unwrap()
}

#[test]
fn a_claimed_curated_source_is_pending_until_its_lift_lands() {
    let b = brain("trust-scan-claims");
    let claimed =
        json!({ "trust_claimed_at": "2026-01-01T00:00:00Z", "trust_tier": "operator_curated" });
    source(&b, "zeta", claimed.clone());
    source(&b, "alpha", claimed.clone());
    // The key counts, whatever its value.
    source(
        &b,
        "null-claim",
        json!({ "trust_claimed_at": null, "trust_tier": "operator_curated" }),
    );
    source(
        &b,
        "lifted",
        json!({ "trust_claimed_at": "x", "trust_tier": "operator_curated", "trust_claim_lifted_at": null }),
    );
    source(
        &b,
        "other-tier",
        json!({ "trust_claimed_at": "x", "trust_tier": "agent_written" }),
    );
    source(
        &b,
        "connector",
        json!({ "trust_claimed_at": "x", "trust_tier": "operator_curated", "kind": "slack" }),
    );
    source(
        &b,
        "plain-kind",
        json!({ "trust_claimed_at": "x", "trust_tier": "operator_curated", "kind": "repo" }),
    );
    source(&b, "unclaimed", json!({ "trust_tier": "operator_curated" }));
    assert_eq!(pending(&b), ["alpha", "null-claim", "plain-kind", "zeta"]);
    b.set_source_archived("alpha", true).unwrap();
    assert_eq!(
        pending(&b),
        ["alpha", "null-claim", "plain-kind", "zeta"],
        "the SQL does not filter archived sources"
    );
}

#[test]
fn the_ceilings_are_each_tables_max_id_and_zero_when_empty() {
    let b = brain("trust-scan-ceilings");
    assert_eq!(
        b.read_trust_scan_ceilings().unwrap(),
        json!({ "pages": 0, "facts": 0, "takes": 0, "timeline_entries": 0 })
    );
    let mut ids = Vec::new();
    for slug in ["notes/a", "notes/b"] {
        let input: gbrain_store::pages::PageInput = args(json!({
            "type": "note", "title": slug, "compiled_truth": "body", "timeline": "", "frontmatter": {} }));
        ids.push(
            b.put_page(slug, &input, &args(json!({ "sourceId": "default" })))
                .unwrap()["id"]
                .as_u64()
                .unwrap(),
        );
    }
    let rows: Vec<TakeInput> = args(json!([{ "page_id": ids[0], "row_num": 1, "claim": "c",
        "kind": "take", "holder": "people/a-example", "weight": 0.5, "source": "notes", "active": true }]));
    b.add_takes_batch(&rows).unwrap();
    for day in ["2026-01-01", "2026-01-02"] {
        let entry = TimelineInput {
            date: Some(day.into()),
            summary: Some(format!("s {day}")),
            detail: None,
            source: Some("cli".into()),
        };
        b.add_timeline_entry("notes/a", &entry, &AddTimelineOptions::default())
            .unwrap();
    }
    // A soft-deleted page still holds its id, as `max(id)` reads every row.
    b.soft_delete_page("notes/b", Some("default")).unwrap();
    let c = b.read_trust_scan_ceilings().unwrap();
    assert_eq!(c["pages"], json!(ids[1]));
    assert_eq!(c["facts"], json!(0));
    assert!(c["takes"].as_u64().unwrap() >= 1);
    assert!(c["timeline_entries"].as_u64().unwrap() >= 2);
}
