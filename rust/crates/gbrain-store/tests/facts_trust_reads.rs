//! `listSingleFactMetadata` and `listUnpreviewedTrustFacts` (`facts/trust_reads.rs`): the stamped
//! trust columns of fact rows, and the released holds the second read joins.

mod memory_env;

use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::facts::trust_reads::{SingleFactMetadataQuery, UnpreviewedTrustQuery};
use gbrain_store::facts::{ExpireFactArgs, InsertFactsArgs};
use gbrain_store::sources::SourceInput;
use gbrain_store::trust::write_gate::HoldInput;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// One fence fact of `source`, written under a declared tier and origin.
fn fact(b: &Brain, source: &str, name: &str, row: u32, tier: &str, origin: Value) -> u64 {
    // The transaction family is not in this landing: the store's write context stands in for one,
    // and `clear_write_trust` ends it as a commit does.
    let tx: &gbrain_store::Store = b;
    let names = [
        "gbrain.write_trust_tier",
        "gbrain.write_trust_promotion",
        "gbrain.write_origin",
    ]
    .map(String::from);
    tx.apply_write_trust(&names, &[tier.into(), tier.into(), origin.to_string()])
        .unwrap();
    let out = tx
        .insert_facts(&args::<InsertFactsArgs>(json!({
            "rows": [{ "fact": name, "entity_slug": "people/a-example", "source_markdown_slug": "notes/conf",
                "row_num": row, "kind": "fact", "visibility": "world", "source": "fence",
                "claim_metric": "mrr", "claim_unit": "USD", "claim_period": "monthly" }],
            "sourceId": source,
        })))
        .unwrap();
    tx.clear_write_trust();
    out["ids"][0].as_u64().unwrap()
}

fn hold(b: &Brain, row: Value, request: Option<&str>, status: &str) -> u64 {
    hold_in(b, "default", row, request, status)
}

fn hold_in(b: &Brain, source: &str, row: Value, request: Option<&str>, status: &str) -> u64 {
    let id = b
        .upsert_write_gate_hold(args::<HoldInput>(json!({
            "kind": "fact", "source_id": source, "slug": "notes/conf",
            "fingerprint": format!("fp-{row}-{request:?}-{status}-{}", b.clock.now()),
            "detector_version": 1, "tier": "agent_written", "reason_families": ["override"],
            "reasons": ["override found"], "detector_error": false,
            "payload": { "row_num": row }, "write_origin": null, "request_id": request,
        })))
        .unwrap();
    b.clock.advance(1);
    if status != "held" {
        b.decide_write_gate_hold(id as i64, status, "owner")
            .unwrap();
    }
    id
}

fn release(request: &str) -> Value {
    json!({ "channel": "trust_release", "request_id": request })
}

#[test]
fn single_fact_metadata_answers_each_listed_fact_of_the_source_once_in_id_order() {
    let b = brain("facts-trust-reads-single");
    b.upsert_source(&SourceInput {
        id: "other".into(),
        name: Some("other".into()),
        ..SourceInput::default()
    })
    .unwrap();
    let agent = fact(
        &b,
        "default",
        "agent",
        1,
        "agent_written",
        json!({ "channel": "agent" }),
    );
    let curated = fact(
        &b,
        "default",
        "curated",
        2,
        "operator_curated",
        json!({ "channel": "import" }),
    );
    let elsewhere = fact(
        &b,
        "other",
        "elsewhere",
        3,
        "agent_written",
        json!({ "channel": "agent" }),
    );
    let read = |source: &str, ids: Vec<i64>| {
        b.list_single_fact_metadata(&SingleFactMetadataQuery {
            source_id: source.into(),
            ids,
        })
        .unwrap()
    };
    let rows = read(
        "default",
        vec![
            curated as i64,
            agent as i64,
            curated as i64,
            elsewhere as i64,
            -1,
            0,
            9_999,
        ],
    );
    let ids: Vec<u64> = rows.iter().map(|r| r["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, vec![agent, curated]);
    assert_eq!(rows[0]["trust_tier"], "agent_written");
    assert_eq!(rows[1]["trust_tier"], "operator_curated");
    assert_eq!(rows[1]["source_markdown_slug"], "notes/conf");
    assert_eq!(rows[1]["row_num"], 2);
    assert_eq!(rows[1]["claim_metric"], "mrr");
    assert_eq!(rows[1]["claim_unit"], "USD");
    assert_eq!(rows[1]["claim_period"], "monthly");
    let other = read("other", vec![agent as i64, elsewhere as i64]);
    assert_eq!(other.len(), 1);
    assert_eq!(other[0]["id"].as_u64(), Some(elsewhere));
    assert!(read("default", vec![]).is_empty());
}

#[test]
fn unpreviewed_trust_facts_join_the_newest_released_hold_and_count_before_the_limit() {
    let b = brain("facts-trust-reads-unpreviewed");
    let plain = fact(&b, "default", "plain", 1, "user_confirmed", release("r1"));
    let plain_hold = hold(&b, json!(1), Some("r1"), "released");
    fact(
        &b,
        "default",
        "previewed",
        2,
        "user_confirmed",
        json!({ "channel": "trust_release", "request_id": "r2", "fields_previewed": true }),
    );
    hold(&b, json!(2), Some("r2"), "released");
    let text = fact(
        &b,
        "default",
        "text row",
        3,
        "user_confirmed",
        release("r3"),
    );
    hold(&b, json!("3"), Some("r3"), "released");
    fact(
        &b,
        "default",
        "only held",
        4,
        "user_confirmed",
        release("r4"),
    );
    hold(&b, json!(4), Some("r4"), "held");
    hold(&b, json!(4), Some("r4"), "dropped");
    let unrequested = fact(
        &b,
        "default",
        "no request",
        5,
        "user_confirmed",
        json!({ "channel": "trust_release" }),
    );
    hold(&b, json!(5), None, "released");
    fact(
        &b,
        "default",
        "other request",
        6,
        "user_confirmed",
        release("r6"),
    );
    hold(&b, json!(6), Some("r-other"), "released");
    let two = fact(
        &b,
        "default",
        "two holds",
        7,
        "user_confirmed",
        release("r7"),
    );
    hold(&b, json!(7), Some("r7"), "released");
    let newest = hold(&b, json!(7), Some("r7"), "released");
    fact(
        &b,
        "default",
        "agent tier",
        8,
        "agent_written",
        release("r8"),
    );
    hold(&b, json!(8), Some("r8"), "released");
    let expired = fact(&b, "default", "expired", 9, "user_confirmed", release("r9"));
    hold(&b, json!(9), Some("r9"), "released");
    b.expire_fact(&ExpireFactArgs {
        id: expired as f64,
        superseded_by: None,
        at: None,
        successor_from: None,
    })
    .unwrap();
    fact(
        &b,
        "default",
        "other channel",
        10,
        "user_confirmed",
        json!({ "channel": "cli", "request_id": "r10" }),
    );
    hold(&b, json!(10), Some("r10"), "released");
    fact(
        &b,
        "default",
        "wrong row",
        11,
        "user_confirmed",
        release("r11"),
    );
    hold(&b, json!(12), Some("r11"), "released");
    b.upsert_source(&SourceInput {
        id: "other".into(),
        name: Some("other".into()),
        ..SourceInput::default()
    })
    .unwrap();
    fact(
        &b,
        "default",
        "other source hold",
        13,
        "user_confirmed",
        release("r13"),
    );
    hold_in(&b, "other", json!(13), Some("r13"), "released");

    let read = |limit: f64| b.list_unpreviewed_trust_facts(&UnpreviewedTrustQuery { limit });
    let wide = read(50.0).unwrap();
    let ids: Vec<u64> = wide.iter().map(|r| r["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, vec![plain, text, unrequested, two]);
    assert_eq!(wide[0]["hold_id"].as_u64(), Some(plain_hold));
    assert_eq!(wide[3]["hold_id"].as_u64(), Some(newest));
    assert_eq!(wide[0]["source_id"], "default");
    assert_eq!(wide[0]["slug"], "notes/conf");
    assert_eq!(wide[0]["row_num"], 1);
    assert!(wide.iter().all(|r| r["total"] == 4));
    let narrow = read(2.0).unwrap();
    assert_eq!(narrow.len(), 2);
    assert!(narrow.iter().all(|r| r["total"] == 4));
    assert!(read(0.0).unwrap().is_empty());
    assert_eq!(read(-1.0).unwrap_err().code, INVALID_ARGUMENT);
    assert_eq!(read(1.5).unwrap_err().code, INVALID_ARGUMENT);
}
