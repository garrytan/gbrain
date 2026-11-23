//! `readFactForOwnerAction`, `countDerivedFactTaint`, `listLexicalContestCandidates` and
//! `listStandingPreferences` (`facts/trust_owner.rs`): fact rows written under declared tiers and
//! origins, their write-gate receipts, and a claimed source whose lift has not finished.

mod memory_env;

use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::contest::LexicalContestQuery;
use gbrain_store::facts::trust_owner::{OwnerActionFactQuery, StandingPreferencesQuery};
use gbrain_store::sources::SourceInput;
use gbrain_store::trust::write_gate::ReceiptInput;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// One fact of `source` written under a declared tier and origin; `row` overrides the defaults.
fn fact(b: &Brain, source: &str, tier: &str, origin: Value, row: Value) -> u64 {
    let tx = b.begin_transaction(false).unwrap();
    let names = [
        "gbrain.write_trust_tier",
        "gbrain.write_trust_promotion",
        "gbrain.write_origin",
    ]
    .map(String::from);
    tx.apply_write_trust(&names, &[tier.into(), tier.into(), origin.to_string()])
        .unwrap();
    let mut base = json!({ "entity_slug": "people/pat-example", "kind": "fact", "visibility": "private",
        "source": "mcp:remember" });
    base.as_object_mut()
        .unwrap()
        .extend(row.as_object().unwrap().clone());
    let out = tx
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": [base], "sourceId": source }),
        ))
        .unwrap();
    tx.commit_transaction().unwrap();
    b.clock.advance(1);
    out["ids"][0].as_u64().unwrap()
}

fn flag(b: &Brain, id: u64, families: &[&str]) {
    b.upsert_write_gate_receipt(ReceiptInput {
        target_table: "facts".into(),
        target_id: id.to_string(),
        source_id: Some("default".into()),
        content_hash: "h1".into(),
        tier: "agent_written".into(),
        detector_version: 1,
        verdict: "flag".into(),
        reason_families: families.iter().map(|f| f.to_string()).collect(),
        reasons: families.iter().map(|f| format!("{f} found")).collect(),
        detector_error: false,
        request_id: None,
    })
    .unwrap();
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

#[test]
fn owner_action_row_keeps_the_select_order_and_answers_null_for_no_fact() {
    let b = brain("facts-trust-owner-read");
    let id = fact(
        &b,
        "default",
        "tool_observed",
        json!({ "channel": "tool" }),
        json!({ "fact": "Acme has 12 people", "claim_value": 12.5 }),
    );
    let row = b
        .read_fact_for_owner_action(&OwnerActionFactQuery { id: id as i64 })
        .unwrap();
    let keys: Vec<&str> = row
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "id",
            "source_id",
            "trust_tier",
            "fact",
            "entity_slug",
            "kind",
            "claim_metric",
            "claim_value",
            "claim_unit",
            "claim_period",
            "value",
            "event_type",
            "dimension",
            "context",
            "expired_at",
            "superseded_by"
        ]
    );
    assert_eq!(row["trust_tier"], "tool_observed");
    assert_eq!(row["claim_value"], 12.5);
    for missing in [id as i64 + 1, -1] {
        assert_eq!(
            b.read_fact_for_owner_action(&OwnerActionFactQuery { id: missing })
                .unwrap(),
            Value::Null
        );
    }
}

#[test]
fn taint_counts_every_origin_that_names_taint_inputs() {
    let b = brain("facts-trust-owner-taint");
    source(&b, "other", json!({}));
    let row = |n: &str| json!({ "fact": n });
    fact(
        &b,
        "default",
        "external_untrusted",
        json!({ "taint_inputs": ["a"] }),
        row("a"),
    );
    fact(
        &b,
        "default",
        "agent_written",
        json!({ "taint_inputs": null }),
        row("b"),
    );
    fact(
        &b,
        "default",
        "external_untrusted",
        json!({ "channel": "ingest" }),
        row("c"),
    );
    fact(
        &b,
        "other",
        "external_untrusted",
        json!({ "taint_inputs": [] }),
        row("d"),
    );
    assert_eq!(
        b.count_derived_fact_taint().unwrap(),
        json!({ "derived": 3, "external": 2 })
    );
}

#[test]
fn contest_candidates_outrank_the_writer_newest_first_by_page() {
    let b = brain("facts-trust-owner-contest");
    let o = json!({ "channel": "x" });
    let curated = fact(
        &b,
        "default",
        "operator_curated",
        o.clone(),
        json!({ "fact": "Lisbon" }),
    );
    let agent = fact(
        &b,
        "default",
        "agent_written",
        o.clone(),
        json!({ "fact": "Evora" }),
    );
    fact(
        &b,
        "default",
        "user_confirmed",
        o.clone(),
        json!({ "fact": "Faro", "kind": "preference" }),
    );
    let member = fact(
        &b,
        "default",
        "operator_curated",
        o.clone(),
        json!({ "fact": "Porto", "source_markdown_slug": "memory/members/pat-example", "row_num": 1 }),
    );
    let q = |writer: &str, page: Option<&str>| -> Vec<u64> {
        b.list_lexical_contest_candidates(&LexicalContestQuery {
            source_id: "default".into(),
            entity_slug: "people/pat-example".into(),
            kind: "fact".into(),
            visibility: "private".into(),
            page_slug: page.map(str::to_string),
            writer: writer.into(),
        })
        .unwrap()
        .iter()
        .map(|r| r["id"].as_u64().unwrap())
        .collect()
    };
    assert_eq!(q("external_untrusted", None), [agent, curated]);
    assert_eq!(q("external_untrusted", Some("")), [agent, curated]);
    assert_eq!(q("not-a-tier", None), [agent, curated]);
    assert_eq!(q("agent_written", None), [curated]);
    assert_eq!(q("unknown", Some("memory/members/pat-example")), [member]);
}

#[test]
fn standing_preferences_skip_unknown_rows_of_a_pending_claim() {
    let b = brain("facts-trust-owner-standing");
    let claim = json!({ "trust_tier": "operator_curated", "trust_claimed_at": "2026-01-01" });
    source(&b, "claimed", claim.clone());
    let mut connector = claim.clone();
    connector["kind"] = json!("imessage");
    source(&b, "connector", connector);
    let o = json!({ "channel": "x" });
    let pref = |n: &str| json!({ "fact": n, "kind": "preference" });
    let listed = fact(&b, "default", "agent_written", o.clone(), pref("listed"));
    let pending = fact(&b, "claimed", "unknown", o.clone(), pref("pending"));
    let agent_in_claim = fact(
        &b,
        "claimed",
        "agent_written",
        o.clone(),
        pref("agent in claim"),
    );
    let in_connector = fact(&b, "connector", "unknown", o.clone(), pref("connector"));
    let other_family = fact(
        &b,
        "default",
        "agent_written",
        o.clone(),
        pref("other family"),
    );
    let observed = fact(&b, "default", "tool_observed", o.clone(), pref("observed"));
    for id in [listed, pending, agent_in_claim, in_connector, observed] {
        flag(&b, id, &["standing_instruction"]);
    }
    flag(&b, other_family, &["override"]);
    let q = |source_id: Option<&str>, since: Option<&str>| -> Vec<u64> {
        b.list_standing_preferences(&StandingPreferencesQuery {
            source_id: source_id.map(str::to_string),
            since: since.map(str::to_string),
            owner_floor: "operator_curated".into(),
            connector_kinds: vec!["imessage".into()],
        })
        .unwrap()
        .iter()
        .map(|r| r["id"].as_u64().unwrap())
        .collect()
    };
    assert_eq!(q(None, None), [listed, agent_in_claim, in_connector]);
    assert_eq!(q(Some("claimed"), None), [agent_in_claim]);
    assert_eq!(q(None, Some("2999-01-01T00:00:00Z")), Vec::<u64>::new());
}
