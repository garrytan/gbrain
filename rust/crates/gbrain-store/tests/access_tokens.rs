//! The `access_tokens` members (`insertAccessToken`, `findActiveAccessTokens`, `setAccessTokenMinTrust`). What the parity
//! file cannot see lives here: the stored message of each refusal (the TypeScript member turns it into SQLSTATE 23514 /
//! 23505 and the constraint name), that a refused write leaves the table as it was, and the generated ids.

mod memory_env;

use gbrain_store::jobs::TokenInsert;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn insert(b: &Brain, row: Value) -> Result<String, gbrain_store::error::StoreError> {
    let row: TokenInsert = serde_json::from_value(row).unwrap();
    b.insert_access_token(&row)
}

fn token(name: &str, hash: &str, extra: Value) -> Value {
    let mut row = json!({
        "name": name, "token_hash": hash, "scopes": ["read"], "permissions": { "source_id": "wiki" },
        "source_grant": "default", "source_id": null, "federated_read": null, "allowed_operations": null, "takes_holders": null,
    });
    for (k, v) in extra.as_object().unwrap() {
        row[k] = v.clone();
    }
    row
}

fn found(b: &Brain, target: &str) -> Vec<Value> {
    b.find_active_access_tokens(target)
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn an_insert_returns_a_fresh_id_each_time_and_the_row_is_found_by_id_and_by_name() {
    let b = brain("tokens-insert");
    let a = insert(&b, token("harness", "h1", json!({}))).unwrap();
    let c = insert(&b, token("harness", "h2", json!({}))).unwrap();
    assert_ne!(a, c);
    assert_eq!(
        found(&b, &a),
        vec![json!({ "id": a, "name": "harness", "min_trust": null })]
    );
    let both = found(&b, "harness");
    assert_eq!(both.len(), 2, "a name two active tokens share finds both");
    assert!(both[0]["id"].as_str() < both[1]["id"].as_str(), "by id");
    assert!(found(&b, "nobody").is_empty());
}

#[test]
fn a_revoked_token_is_not_found_and_a_repeated_hash_or_bad_value_is_refused_and_leaves_the_table() {
    let b = brain("tokens-refused");
    let live = insert(&b, token("live", "h1", json!({}))).unwrap();
    insert(
        &b,
        token(
            "gone",
            "h2",
            json!({ "revoked_at": "2026-01-02T03:04:05Z" }),
        ),
    )
    .unwrap();
    assert_eq!(found(&b, "live").len(), 1);
    assert!(found(&b, "gone").is_empty(), "a revoked row never matches");

    let dup = insert(&b, token("other", "h1", json!({}))).expect_err("a repeated hash");
    assert_eq!(dup.code, "constraint_violation");
    assert_eq!(
        dup.message,
        "duplicate key value violates unique constraint \"access_tokens_token_hash_key\""
    );
    let grant = insert(
        &b,
        token("bad-grant", "h3", json!({ "source_grant": "everything" })),
    )
    .expect_err("a source grant outside the list");
    assert_eq!(
        grant.message,
        "new row for relation \"access_tokens\" violates check constraint \"access_tokens_source_grant_check\""
    );
    let tier = insert(&b, token("bad-tier", "h4", json!({ "min_trust": "bogus" })))
        .expect_err("a tier outside the six");
    assert_eq!(
        tier.message,
        "new row for relation \"access_tokens\" violates check constraint \"access_tokens_min_trust_check\""
    );
    assert!(
        found(&b, "other").is_empty()
            && found(&b, "bad-grant").is_empty()
            && found(&b, "bad-tier").is_empty()
    );
    assert_eq!(found(&b, &live).len(), 1);
}

#[test]
fn a_floor_is_set_cleared_and_refused_without_touching_the_row() {
    let b = brain("tokens-floor");
    let id = insert(&b, token("t", "h1", json!({}))).unwrap();
    assert!(
        b.set_access_token_min_trust(&id, Some("tool_observed"))
            .unwrap()
    );
    assert_eq!(found(&b, &id)[0]["min_trust"], json!("tool_observed"));
    let err = b
        .set_access_token_min_trust(&id, Some("bogus"))
        .expect_err("a tier outside the six");
    assert_eq!(
        err.message,
        "new row for relation \"access_tokens\" violates check constraint \"access_tokens_min_trust_check\""
    );
    assert_eq!(
        found(&b, &id)[0]["min_trust"],
        json!("tool_observed"),
        "the refused write changed nothing"
    );
    assert!(b.set_access_token_min_trust(&id, None).unwrap());
    assert_eq!(found(&b, &id)[0]["min_trust"], Value::Null);
    assert!(
        !b.set_access_token_min_trust("00000000-0000-4000-8000-000000000000", Some("unknown"))
            .unwrap()
    );
}

#[test]
fn the_list_is_newest_first_with_the_columns_not_kept_at_their_defaults_and_no_hash() {
    let b = brain("tokens-list");
    let first = insert(&b, token("older", "hash-older", json!({}))).unwrap();
    b.clock.advance(1_000_000);
    let second = insert(&b, token("newer", "hash-newer", json!({}))).unwrap();
    let rows = b.list_access_tokens().unwrap();
    let rows = rows.as_array().unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![second.as_str(), first.as_str()]
    );
    assert_eq!(rows[0]["name"], "newer");
    assert_eq!(rows[0]["scopes"], json!(["read"]));
    assert_eq!(rows[0]["revoked_at"], Value::Null);
    assert_eq!(rows[0]["last_used_at"], Value::Null);
    assert_eq!(rows[0]["member_id"], Value::Null);
    assert_eq!(rows[0]["private_pages"], "none");
    assert_eq!(rows[0]["private_facts"], "none");
    assert_eq!(rows[1]["created_at"], "2027-01-15T08:00:00.000000Z");
    assert!(
        rows.iter().all(|r| r.get("token_hash").is_none()),
        "no listed row carries the hash"
    );
}

#[test]
fn a_revoke_by_name_stamps_every_active_token_of_that_name_once_and_ends_its_liveness() {
    let b = brain("tokens-revoke-name");
    let a = insert(&b, token("shared", "hash-a", json!({}))).unwrap();
    let c = insert(&b, token("shared", "hash-c", json!({}))).unwrap();
    let other = insert(&b, token("other", "hash-o", json!({}))).unwrap();
    assert!(b.access_token_live(&a).unwrap());
    b.clock.advance(5_000_000);
    let mut want = vec![a.clone(), c.clone()];
    want.sort();
    assert_eq!(b.revoke_access_tokens_named("shared").unwrap(), want);
    assert!(
        b.revoke_access_tokens_named("shared").unwrap().is_empty(),
        "a revoked token is not revoked twice"
    );
    assert!(!b.access_token_live(&a).unwrap());
    assert!(!b.access_token_live(&c).unwrap());
    assert!(b.access_token_live(&other).unwrap());
    assert!(found(&b, "shared").is_empty());
    let rows = b.list_access_tokens().unwrap();
    let revoked: Vec<_> = rows
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["name"] == "shared")
        .map(|r| r["revoked_at"].clone())
        .collect();
    assert_eq!(
        revoked,
        vec![
            json!("2027-01-15T08:00:05.000000Z"),
            json!("2027-01-15T08:00:05.000000Z")
        ]
    );
}

#[test]
fn a_revoke_by_id_returns_the_name_once_and_the_grant_read_stops_finding_it() {
    let b = brain("tokens-revoke-id");
    let id = insert(&b, token("solo", "hash-s", json!({}))).unwrap();
    assert_eq!(
        b.read_active_access_token_grant(&id.to_ascii_uppercase())
            .unwrap(),
        Some(json!({ "permissions": { "source_id": "wiki" }, "private_pages": "none" }))
    );
    assert!(b.access_token_live(&id).unwrap());
    assert!(
        !b.access_token_live("00000000-0000-4000-8000-0000000000c1")
            .unwrap()
    );
    assert_eq!(
        b.revoke_access_token(&id.to_ascii_uppercase())
            .unwrap()
            .as_deref(),
        Some("solo")
    );
    assert_eq!(b.revoke_access_token(&id).unwrap(), None);
    assert_eq!(
        b.revoke_access_token("00000000-0000-4000-8000-0000000000c1")
            .unwrap(),
        None
    );
    assert_eq!(b.read_active_access_token_grant(&id).unwrap(), None);
    assert!(!b.access_token_live(&id).unwrap());
}

#[test]
fn the_bearer_read_finds_the_active_token_by_hash_without_the_hash_and_not_after_revoke() {
    let b = brain("tokens-by-hash");
    let id = insert(
        &b,
        token("bearer", "hash-b", json!({ "min_trust": "tool_observed" })),
    )
    .unwrap();
    insert(&b, token("other", "hash-o", json!({}))).unwrap();
    let row = b
        .read_active_access_token_by_hash("hash-b")
        .unwrap()
        .unwrap();
    assert_eq!(row["id"], json!(id));
    assert_eq!(row["name"], json!("bearer"));
    assert_eq!(row["scopes"], json!(["read"]));
    assert_eq!(row["source_grant"], json!("default"));
    assert_eq!(row["min_trust"], json!("tool_observed"));
    assert_eq!(row["grant_revision"], json!(1));
    assert_eq!(row["private_pages"], json!("none"));
    assert_eq!(row["member_id"], Value::Null);
    assert!(row.get("token_hash").is_none());
    assert_eq!(b.read_active_access_token_by_hash("hash-").unwrap(), None);
    assert_eq!(b.read_active_access_token_by_hash("nope").unwrap(), None);
    b.revoke_access_token(&id).unwrap();
    assert_eq!(b.read_active_access_token_by_hash("hash-b").unwrap(), None);
    assert!(
        b.read_active_access_token_by_hash("hash-o")
            .unwrap()
            .is_some()
    );
}
