//! `insertHoldingPagePurges`: a tombstone under each holding page that holds one of the facts about an entity with no
//! page of its own, none twice (facts/holding_purges.rs).

mod memory_env;

use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::holding_purges::HoldingPagePurgeArgs;
use gbrain_store::facts::purge::PurgeTargetArgs;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const REQUEST: &str = "6F9619FF-8B86-4D01-B42D-00CF4FC964FF";
const HOLDING: &str = "memory/unattributed";
const NESTED: &str = "members/ann/memory/unattributed";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(b: &Brain, slug: &str) {
    let input: gbrain_store::pages::PageInput =
        args(json!({ "type": "person", "title": slug, "compiled_truth": "x" }));
    b.put_page(slug, &input, &args(json!({}))).unwrap();
}

/// Inserts one fact and returns its id and its fingerprint.
fn fact(b: &Brain, text: &str, entity: Option<&str>, slug: &str, row_num: i64) -> (f64, String) {
    let rows = json!([{ "fact": text, "entity_slug": entity, "source_markdown_slug": slug,
        "row_num": row_num, "kind": "fact", "visibility": "world", "source": "fence" }]);
    let out = b
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": rows, "sourceId": "default" }),
        ))
        .unwrap();
    let id = out["ids"][0].as_f64().unwrap();
    let target: PurgeTargetArgs = args(json!({ "id": id, "sourceId": "default" }));
    let hash = b.load_purge_target(&target).unwrap()["fact_hash"]
        .as_str()
        .unwrap()
        .to_string();
    (id, hash)
}

fn call(hash: &str, ids: &[f64]) -> HoldingPagePurgeArgs {
    args(
        json!({ "sourceId": "default", "visibility": "world", "factHash": hash,
        "requestId": REQUEST, "actor": "owner:local", "reason": "test", "factIds": ids }),
    )
}

fn purged(b: &Brain, text: &str, subject: &str) -> bool {
    b.is_fact_purged("default", "world", text, Some(subject))
        .unwrap()
}

#[test]
fn each_holding_page_of_the_facts_gets_one_tombstone_and_nothing_else_does() {
    let b = brain("hp-rows");
    for slug in [HOLDING, NESTED, "people/home"] {
        page(&b, slug);
    }
    let (a, hash) = fact(&b, "Acme raised a round", Some("acme"), HOLDING, 1);
    let (n, _) = fact(&b, "Acme raised a round", Some("acme"), NESTED, 1);
    let (own, _) = fact(&b, "Acme raised a round", Some("acme"), "people/home", 1);
    let (bare, _) = fact(&b, "Acme raised a round", None, HOLDING, 2);
    let (unlisted, _) = fact(&b, "Acme raised a round", Some("acme"), HOLDING, 3);
    let _ = unlisted;
    assert_eq!(
        b.insert_holding_page_purges(&call(&hash, &[a, a, n, own, bare, 9999.0, 0.0]))
            .unwrap(),
        2
    );
    let claim = "Acme raised a round";
    assert!(purged(&b, claim, HOLDING));
    assert!(purged(&b, claim, NESTED));
    assert!(!purged(&b, claim, "people/home"));
    assert!(!purged(&b, claim, "acme"));
    // Run again: the tombstones exist, so nothing is added.
    assert_eq!(
        b.insert_holding_page_purges(&call(&hash, &[a, n])).unwrap(),
        0
    );
}

#[test]
fn a_fact_of_another_source_or_with_no_holding_page_adds_nothing() {
    let b = brain("hp-none");
    page(&b, "people/home");
    let (own, hash) = fact(&b, "Beta hired a CTO", Some("beta"), "people/home", 1);
    let mut other = call(&hash, &[own]);
    other.source_id = "elsewhere".into();
    assert_eq!(b.insert_holding_page_purges(&other).unwrap(), 0);
    assert_eq!(
        b.insert_holding_page_purges(&call(&hash, &[own])).unwrap(),
        0
    );
    assert_eq!(b.insert_holding_page_purges(&call(&hash, &[])).unwrap(), 0);
}

#[test]
fn a_request_id_that_is_not_a_uuid_or_a_nul_byte_is_refused_before_anything_is_written() {
    let b = brain("hp-refuse");
    let mut bad = call("hash", &[]);
    bad.request_id = "not-a-uuid".into();
    assert!(b.insert_holding_page_purges(&bad).is_err());
    let mut nul = call("hash", &[]);
    nul.actor = "owner\0".into();
    assert!(b.insert_holding_page_purges(&nul).is_err());
    let mut fractional = call("hash", &[1.5]);
    fractional.reason = None;
    assert!(b.insert_holding_page_purges(&fractional).is_err());
}
