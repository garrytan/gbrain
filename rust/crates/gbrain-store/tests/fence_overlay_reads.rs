//! The fence overlay's read of one page, matched to PGLite (`engine-sql/cli-reads-ops.ts`
//! `readFenceOverlayRows`, `eligibility/fence-overlay.ts` `loadFenceChunkOverlay`).
//! test/engine-parity/fence-overlay.test.ts pins the same rows on every arm.

mod memory_env;

use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::facts::{ExpireFactArgs, FenceOverlayInput, InsertFactsArgs};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::trust::write_gate::{HoldInput, ReceiptInput};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const SLUG: &str = "people/overlay-example";
const OTHER: &str = "people/other-example";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// Runs `f` in a transaction whose write trust context declares `tier`.
fn declared<R>(b: &Brain, tier: &str, f: impl FnOnce(&gbrain_store::Store) -> R) -> R {
    let tx = b.begin_transaction(false).unwrap();
    let channel = if tier == "agent_written" {
        "agent"
    } else {
        "tool"
    };
    let names = ["gbrain.write_trust_tier", "gbrain.write_origin"].map(String::from);
    tx.apply_write_trust(
        &names,
        &[tier.to_string(), json!({ "channel": channel }).to_string()],
    )
    .unwrap();
    let out = f(&tx);
    tx.commit_transaction().unwrap();
    out
}

fn fact(b: &Brain, tier: &str, n: i32, text: &str, visibility: &str) -> u64 {
    declared(b, tier, |tx| {
        let out = tx
            .insert_facts(&args::<InsertFactsArgs>(json!({
                "rows": [{ "fact": text, "source": "fence", "source_markdown_slug": SLUG, "entity_slug": SLUG,
                    "kind": "fact", "visibility": visibility, "row_num": n }],
                "sourceId": "default",
            })))
            .unwrap();
        out["ids"][0].as_u64().unwrap()
    })
}

fn hold(b: &Brain, slug: &str, fp: &str) -> u64 {
    b.upsert_write_gate_hold(args::<HoldInput>(json!({
        "kind": "fact", "source_id": "default", "slug": slug, "fingerprint": fp,
        "detector_version": 1, "tier": "agent_written", "reason_families": ["override"],
        "reasons": ["override found"], "detector_error": false,
        "payload": { "row_num": 1 }, "write_origin": null, "request_id": null,
    })))
    .unwrap()
}

/// The page is tool-observed. Row 1: an expired agent-written fact. Row 2: an agent-written fact
/// with an activation flag. Row 3: a held hold on `fp-3`. Row 4: a private agent-written fact.
/// Row 5: a tool-observed fact. Row 6: no fact, a released hold on `fp-6`. The other page holds `fp-1`.
fn seed(b: &Brain) {
    declared(b, "tool_observed", |tx| {
        let input = PageInput {
            page_type: "person".into(),
            title: "Ana Example".into(),
            compiled_truth: "Ana Example runs acme-example.".into(),
            ..PageInput::default()
        };
        tx.put_page(SLUG, &input, &PutPageOptions::default())
            .unwrap();
    });
    let expired = fact(b, "agent_written", 1, "Ana lives in Lima", "world");
    assert!(
        b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": expired })))
            .unwrap()
    );
    let flagged = fact(b, "agent_written", 2, "Ana keeps bees", "world");
    fact(b, "agent_written", 4, "Ana paints", "private");
    fact(b, "tool_observed", 5, "Ana rides horses", "world");
    b.upsert_write_gate_receipt(ReceiptInput {
        target_table: "facts".into(),
        target_id: flagged.to_string(),
        source_id: Some("default".into()),
        content_hash: "h".into(),
        tier: "agent_written".into(),
        detector_version: 1,
        verdict: "flag".into(),
        reason_families: vec!["override".into()],
        reasons: vec!["a reason".into()],
        detector_error: false,
        request_id: None,
    })
    .unwrap();
    hold(b, SLUG, "fp-3");
    hold(b, OTHER, "fp-1");
    let released = hold(b, SLUG, "fp-6");
    b.decide_write_gate_hold(released as i64, "released", "owner")
        .unwrap();
}

fn incoming(rows: &[(i64, &str)]) -> Vec<Value> {
    rows.iter()
        .map(|(n, claim)| json!({ "row_num": n, "claim": claim, "visibility": "world", "fp": format!("fp-{n}") }))
        .collect()
}

fn read(b: &Brain, slug: &str, rows: Vec<Value>, hide_held: bool) -> Vec<Value> {
    b.read_fence_overlay_rows(&args::<FenceOverlayInput>(json!({
        "sourceId": "default", "slug": slug, "incoming": rows, "hideHeld": hide_held,
    })))
    .unwrap()
}

fn out(
    n: i64,
    page: Option<&str>,
    row: Option<&str>,
    flagged: Option<bool>,
    held: bool,
    narrower: bool,
) -> Value {
    json!({ "row_num": n, "page_tier": page, "row_tier": row, "row_flagged": flagged,
        "purged": false, "held": held, "narrower": narrower })
}

#[test]
fn each_incoming_row_reads_its_page_tier_newest_fact_hold_and_narrower_fact_in_order() {
    let b = brain("fence-overlay-rows");
    seed(&b);
    let tool = Some("tool_observed");
    let agent = Some("agent_written");
    let rows = incoming(&[
        (5, "Ana rides horses"),
        (1, "Ana lives in Lima"),
        (2, "Ana keeps bees"),
        (3, "Ana sings opera"),
        (4, "Ana paints"),
        (6, "Ana swims daily"),
    ]);
    assert_eq!(
        read(&b, SLUG, rows.clone(), true),
        [
            out(5, tool, tool, Some(false), false, false),
            out(1, tool, agent, Some(false), false, false),
            out(2, tool, agent, Some(true), false, false),
            out(3, tool, None, None, true, false),
            out(4, tool, agent, Some(false), false, true),
            out(6, tool, None, None, false, false),
        ]
    );
    // Without hideHeld no row is narrower; a null fingerprint is never held.
    let mut open = read(&b, SLUG, rows[3..5].to_vec(), false);
    assert_eq!(
        open,
        [
            out(3, tool, None, None, true, false),
            out(4, tool, agent, Some(false), false, false),
        ]
    );
    let mut unprinted = rows[3].clone();
    unprinted["fp"] = Value::Null;
    open = read(&b, SLUG, vec![unprinted], false);
    assert_eq!(open, [out(3, tool, None, None, false, false)]);
    // A page with no live row reads a null tier; its own holds still count.
    assert_eq!(
        read(&b, OTHER, rows[1..2].to_vec(), true),
        [out(1, None, None, None, true, false)]
    );
    assert!(read(&b, SLUG, Vec::new(), true).is_empty());
}

#[test]
fn a_nul_character_or_an_out_of_range_row_number_refuses() {
    let b = brain("fence-overlay-refusals");
    for bad in [
        json!({ "row_num": 1, "claim": "a\u{0}b", "visibility": "world", "fp": null }),
        json!({ "row_num": 1, "claim": "a", "visibility": "world", "fp": "f\u{0}" }),
        json!({ "row_num": 4_294_967_296_i64, "claim": "a", "visibility": "world", "fp": null }),
    ] {
        let err = b
            .read_fence_overlay_rows(&args::<FenceOverlayInput>(json!({
                "sourceId": "default", "slug": SLUG, "incoming": [bad], "hideHeld": false,
            })))
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
    }
}
