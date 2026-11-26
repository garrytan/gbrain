//! The withdrawal half of the facts insert guard (`write_fact` with no stored row): an inserted active
//! fact a withdrawal of its claim reaches is saved expired at the earliest such withdrawal, its
//! `valid_until` clamped to it; a row inserted already expired keeps its expiry.

mod memory_env;

use gbrain_store::facts::{FactQuery, InsertFactArgs, InsertFactsArgs};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const T1: &str = "2026-03-01T10:00:00.000Z";
const T2: &str = "2026-03-02T10:00:00.000Z";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// (expired_at, valid_until) of the one row of `entity`.
fn stamp(b: &Brain, entity: &str) -> (Value, Value) {
    let rows = b
        .list_facts_by_entity(&args::<FactQuery>(json!({
            "sourceId": "default", "entitySlug": entity, "activeOnly": false, "limit": 10,
        })))
        .unwrap();
    assert_eq!(rows.len(), 1, "{entity}");
    (
        rows[0]["expired_at"].clone(),
        rows[0]["valid_until"].clone(),
    )
}

#[test]
fn an_insert_a_withdrawal_reaches_is_saved_expired_at_the_earliest_one() {
    let b = brain("insert-guard");
    for (claim, subject, at) in [
        ("Alice moved to Paris", "*", T2),
        ("Alice moved to Paris", "people/a", T1),
    ] {
        assert!(
            b.insert_fact_withdrawal("default", "private", claim, subject, Some(at))
                .unwrap()
        );
    }
    let single = |entity: &str, extra: Value| {
        let mut input = json!({ "fact": "Alice moved to Paris", "entity_slug": entity,
            "visibility": "private", "source": "mcp:remember" });
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        b.insert_fact(&args::<InsertFactArgs>(
            json!({ "input": input, "sourceId": "default" }),
        ))
        .unwrap()
    };
    assert_eq!(
        single(
            "people/a",
            json!({ "valid_until": "2027-01-01T00:00:00.000Z" })
        )["status"],
        "inserted"
    );
    single("people/c", json!({}));
    single("people/e", json!({ "visibility": "world" }));
    let out = b
        .insert_facts(&args::<InsertFactsArgs>(json!({
            "rows": [
                { "fact": "Alice moved to Paris", "entity_slug": "people/f", "kind": "fact",
                  "visibility": "private", "source": "fence", "row_num": 1,
                  "source_markdown_slug": "notes/guard" },
                { "fact": "Alice moved to Paris", "entity_slug": "people/g", "kind": "fact",
                  "visibility": "private", "source": "fence", "row_num": 2,
                  "source_markdown_slug": "notes/guard", "expired_at": "2026-01-01T00:00:00.000Z" },
            ],
            "sourceId": "default",
        })))
        .unwrap();
    assert_eq!(out["inserted"], 2);
    assert_eq!(out["warnings"], json!([]));

    // (expired_at, valid_until) to the second.
    let at = |entity: &str| {
        let (e, u) = stamp(&b, entity);
        (e.as_str().map(norm), u.as_str().map(norm))
    };
    let t = |iso: &str| Some(norm(iso));
    // Both withdrawals reach it: the earliest wins and clamps the later valid_until.
    assert_eq!(at("people/a"), (t(T1), t(T1)));
    // Only subject '*' reaches it; a NULL valid_until becomes the withdrawal time.
    assert_eq!(at("people/c"), (t(T2), t(T2)));
    // Another visibility: not reached.
    assert_eq!(at("people/e"), (None, None));
    // A fence row is stamped too; a row inserted expired keeps its expiry.
    assert_eq!(at("people/f"), (t(T2), t(T2)));
    assert_eq!(at("people/g"), (t("2026-01-01T00:00:00.000Z"), None));
}

/// The ISO text to the second, whatever the reader's fraction digits.
fn norm(iso: &str) -> String {
    iso.get(..19).unwrap_or(iso).to_string()
}
