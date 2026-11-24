//! The claim conflict sweep, the contested proposal lookup, the live entity page read and the gone-page expiry
//! (facts/rest_sites.rs).

mod memory_env;

use gbrain_store::eval_capture::decide_proposals::DecideProposalInput;
use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::rest_sites::{
    ClaimPairArgs, ContestedArgs, GonePagesArgs, LiveEntityPageArgs,
};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(b: &Brain, slug: &str, kind: &str) {
    let input: gbrain_store::pages::PageInput =
        args(json!({ "type": kind, "title": slug, "compiled_truth": "x", "frontmatter": {} }));
    b.put_page(slug, &input, &args(json!({}))).unwrap();
}

/// One fact built from `row` over the defaults; returns its id.
fn fact(b: &Brain, text: &str, row: Value) -> u64 {
    let mut full = json!({ "fact": text, "kind": "fact", "visibility": "world", "source": "mcp" });
    full.as_object_mut()
        .unwrap()
        .extend(row.as_object().unwrap().clone());
    let out = b
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": [full], "sourceId": "default" }),
        ))
        .unwrap();
    out["ids"][0].as_u64().unwrap()
}

fn claim(b: &Brain, text: &str, value: f64, valid_from: &str, extra: Value) -> u64 {
    let mut row = json!({ "entity_slug": "companies/acme", "claim_metric": "arr", "claim_value": value,
        "claim_unit": "usd", "valid_from": valid_from });
    row.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    fact(b, text, row)
}

fn pair_args(cap: f64) -> ClaimPairArgs {
    args(json!({ "sourceId": "default", "auditSources": [], "cap": cap }))
}

fn pairs(rows: &[Value]) -> Vec<(i64, i64)> {
    rows.iter()
        .map(|r| {
            (
                r["new_fact_id"].as_i64().unwrap(),
                r["old_fact_id"].as_i64().unwrap(),
            )
        })
        .collect()
}

fn proposal(sweep: &str, new_fact: u64, old_fact: u64) -> DecideProposalInput {
    args(
        json!({ "source_id": "default", "sweep_id": sweep, "pair_index": 0, "new_fact_id": new_fact,
        "old_fact_id": old_fact, "direction": "new_supersedes_old", "p_supersede": 0.9, "threshold": 0.8,
        "proposal_floor": 0.5, "model_resolved": "m" }),
    )
}

fn active(b: &Brain, entity: &str) -> Vec<String> {
    let q = args(
        json!({ "sourceId": "default", "entitySlug": entity, "activeOnly": true, "limit": 100 }),
    );
    b.list_facts_by_entity(&q)
        .unwrap()
        .iter()
        .map(|r| r["fact"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn claims_pair_in_one_bucket_and_a_proposal_or_the_cap_leaves_pairs_out() {
    let b = brain("rest-pairs");
    let old = claim(&b, "arr 10", 10.0, "2026-03-01T10:00:00Z", json!({}));
    let new = claim(&b, "arr 12", 12.0, "2026-03-01T18:00:00Z", json!({}));
    // Another day, the same value, another unit and another metric do not pair with the first two.
    claim(&b, "arr next day", 14.0, "2026-03-02T10:00:00Z", json!({}));
    claim(&b, "same value", 12.0, "2026-03-01T20:00:00Z", json!({}));
    claim(
        &b,
        "other unit",
        99.0,
        "2026-03-01T20:00:00Z",
        json!({ "claim_unit": "eur" }),
    );
    claim(
        &b,
        "other metric",
        99.0,
        "2026-03-01T20:00:00Z",
        json!({ "claim_metric": "mrr" }),
    );
    let listed = b.list_claim_conflict_pairs(&pair_args(10.0)).unwrap();
    assert_eq!(pairs(&listed)[0], (new as i64, old as i64));
    assert_eq!(listed[0]["bucket"], "2026-03-01");
    assert_eq!(
        b.count_claim_conflict_pairs(&pair_args(0.0)).unwrap()["n"],
        listed.len()
    );
    assert!(
        b.list_claim_conflict_pairs(&pair_args(0.0))
            .unwrap()
            .is_empty()
    );

    b.insert_decide_proposal(&proposal("s1", new, old)).unwrap();
    let after = b.list_claim_conflict_pairs(&pair_args(10.0)).unwrap();
    assert!(!pairs(&after).contains(&(new as i64, old as i64)));
    assert_eq!(after.len(), listed.len() - 1);
}

#[test]
fn a_cadence_widens_the_bucket_and_audit_sources_are_left_out() {
    let b = brain("rest-cadence");
    let march = claim(
        &b,
        "march",
        1.0,
        "2026-03-05T00:00:00Z",
        json!({ "claim_period": "monthly" }),
    );
    let later = claim(
        &b,
        "late march",
        2.0,
        "2026-03-28T00:00:00Z",
        json!({ "claim_period": "monthly" }),
    );
    claim(
        &b,
        "april",
        3.0,
        "2026-04-02T00:00:00Z",
        json!({ "claim_period": "monthly" }),
    );
    claim(
        &b,
        "other period",
        4.0,
        "2026-03-29T00:00:00Z",
        json!({ "claim_period": "weekly" }),
    );
    let listed = b.list_claim_conflict_pairs(&pair_args(10.0)).unwrap();
    assert_eq!(pairs(&listed), vec![(later as i64, march as i64)]);
    assert_eq!(listed[0]["bucket"], "2026-03");
    let audited: ClaimPairArgs =
        args(json!({ "sourceId": "default", "auditSources": ["mcp"], "cap": 10 }));
    assert!(b.list_claim_conflict_pairs(&audited).unwrap().is_empty());
}

#[test]
fn a_cap_that_is_not_a_whole_number_is_refused() {
    let b = brain("rest-cap");
    for cap in [-1.0, 1.5, f64::NAN, f64::INFINITY] {
        let mut q = pair_args(0.0);
        q.cap = cap;
        let err = b.list_claim_conflict_pairs(&q).unwrap_err();
        assert_eq!(err.code, "invalid_argument", "cap {cap}");
    }
    let nul: ClaimPairArgs = args(json!({ "sourceId": "a\u{0}b", "auditSources": [], "cap": 1 }));
    assert_eq!(
        b.count_claim_conflict_pairs(&nul).unwrap_err().code,
        "invalid_argument"
    );
}

#[test]
fn the_live_entity_page_is_none_for_a_missing_or_deleted_page() {
    let b = brain("rest-page");
    page(&b, "people/ann", "person");
    page(&b, "people/bo", "person");
    b.soft_delete_page("people/bo", None).unwrap();
    let read = |slug: &str| -> Value {
        b.read_live_fact_entity_page(&args::<LiveEntityPageArgs>(
            json!({ "sourceId": "default", "slug": slug }),
        ))
        .unwrap()
    };
    assert_eq!(
        read("people/ann"),
        json!({ "slug": "people/ann", "type": "person" })
    );
    assert_eq!(read("people/bo"), Value::Null);
    assert_eq!(read("people/none"), Value::Null);
}

#[test]
fn a_pending_proposal_is_listed_once_per_named_fact_while_both_facts_are_readable() {
    let b = brain("rest-contested");
    let a = claim(&b, "a", 1.0, "2026-03-01T10:00:00Z", json!({}));
    let c = claim(&b, "c", 2.0, "2026-03-01T11:00:00Z", json!({}));
    let private = claim(
        &b,
        "private",
        3.0,
        "2026-03-01T12:00:00Z",
        json!({ "visibility": "private" }),
    );
    let p1 = b
        .insert_decide_proposal(&proposal("s1", c, a))
        .unwrap()
        .unwrap();
    b.insert_decide_proposal(&proposal("s2", private, a))
        .unwrap()
        .unwrap();
    let ask = |ids: &[u64], remote: bool| -> Vec<(i64, i64)> {
        let q: ContestedArgs = args(json!({ "ids": ids, "remote": remote }));
        b.list_contested_proposal_pairs(&q)
            .unwrap()
            .iter()
            .map(|r| (r["id"].as_i64().unwrap(), r["delivered"].as_i64().unwrap()))
            .collect()
    };
    assert_eq!(
        ask(&[c, a], false),
        vec![
            (p1 as i64, c as i64),
            (p1 as i64, a as i64),
            (p1 as i64 + 1, a as i64)
        ]
    );
    // A remote caller reads world facts only, so the proposal that names the private fact drops out.
    assert_eq!(ask(&[a], true), vec![(p1 as i64, a as i64)]);
    assert!(ask(&[], false).is_empty());
    assert!(ask(&[999], false).is_empty());
}

#[test]
fn gone_page_expiry_takes_the_facts_filed_on_extracted_from_or_about_a_page() {
    let b = brain("rest-gone");
    page(&b, "people/keeper", "person");
    let filed = fact(
        &b,
        "filed",
        json!({ "entity_slug": "people/x", "source_markdown_slug": "notes/gone", "row_num": 1 }),
    );
    let extracted = fact(
        &b,
        "extracted",
        json!({ "entity_slug": "people/x", "source": "sync:import", "context": "notes/gone \u{2014} intro" }),
    );
    let about = fact(&b, "about", json!({ "entity_slug": "notes/gone" }));
    let about_held = fact(
        &b,
        "about but filed on a live page",
        json!({ "entity_slug": "notes/gone", "source_markdown_slug": "people/keeper", "row_num": 1 }),
    );
    let unrelated = fact(
        &b,
        "unrelated",
        json!({ "entity_slug": "people/x", "source": "sync:import", "context": "notes/other" }),
    );
    let unpaired = fact(&b, "unpaired", json!({ "entity_slug": "notes/third" }));
    assert_eq!(active(&b, "people/x").len(), 3);
    b.clock.advance(1_000_000);
    let gone: GonePagesArgs = args(json!({ "sourceIds": ["default"], "slugs": ["notes/gone"] }));
    assert_eq!(b.expire_facts_of_gone_pages(&gone).unwrap(), Value::Null);
    assert_eq!(active(&b, "people/x"), vec!["unrelated"]);
    assert_eq!(
        active(&b, "notes/gone"),
        vec!["about but filed on a live page"]
    );
    // A slug with no source to pair with matches nothing.
    let lone: GonePagesArgs = args(json!({ "sourceIds": [], "slugs": ["notes/third"] }));
    b.expire_facts_of_gone_pages(&lone).unwrap();
    assert_eq!(active(&b, "notes/third"), vec!["unpaired"]);
    let _ = (filed, extracted, about, about_held, unrelated, unpaired);
    let nul: GonePagesArgs = args(json!({ "sourceIds": ["default"], "slugs": ["a\u{0}"] }));
    assert_eq!(
        b.expire_facts_of_gone_pages(&nul).unwrap_err().code,
        "invalid_argument"
    );
}
