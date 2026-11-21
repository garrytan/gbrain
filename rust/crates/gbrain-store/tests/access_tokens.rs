//! The `access_tokens` members (`insertAccessToken`, `findActiveAccessTokens`, `readAccessTokenWriteGrant`, `setAccessTokenMinTrust`). What the parity
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
fn the_name_read_answers_each_asked_token_once_by_id_a_revoked_one_included() {
    let b = brain("tokens-names");
    let live = insert(&b, token("live", "h1", json!({}))).unwrap();
    let gone = insert(
        &b,
        token(
            "gone",
            "h2",
            json!({ "revoked_at": "2026-01-02T03:04:05Z" }),
        ),
    )
    .unwrap();
    insert(&b, token("unasked", "h3", json!({}))).unwrap();
    let ids = [&live, &gone, &live, &"not-a-token".to_string()].map(|s| s.to_string());
    let mut want = vec![
        json!({ "id": live, "name": "live" }),
        json!({ "id": gone, "name": "gone" }),
    ];
    want.sort_by(|a, c| a["id"].as_str().cmp(&c["id"].as_str()));
    assert_eq!(b.read_access_token_names(&ids).unwrap(), Value::Array(want));
    assert_eq!(b.read_access_token_names(&[]).unwrap(), json!([]));
}

#[test]
fn the_write_grant_read_answers_the_grant_columns_a_revoked_token_included_and_null_for_no_token() {
    let b = brain("tokens-write-grant");
    let live = insert(
        &b,
        token(
            "live",
            "h1",
            json!({ "scopes": ["read", "write"], "source_grant": "scalar", "source_id": "notes", "takes_holders": ["world"], "read_shared": true }),
        ),
    )
    .unwrap();
    let gone = insert(
        &b,
        token(
            "gone",
            "h2",
            json!({ "revoked_at": "2026-01-02T03:04:05Z" }),
        ),
    )
    .unwrap();
    assert_eq!(
        b.read_access_token_write_grant(&live).unwrap(),
        json!({
            "id": live, "scopes": ["read", "write"], "permissions": { "source_id": "wiki" }, "source_grant": "scalar",
            "source_id": "notes", "federated_read": null, "allowed_operations": null, "takes_holders": ["world"],
            "grant_revision": 1, "read_shared_revision": 1, "revoked_at": null,
        })
    );
    assert_eq!(
        b.read_access_token_write_grant(&gone).unwrap()["revoked_at"],
        json!("2026-01-02T03:04:05.000000Z")
    );
    assert_eq!(
        b.read_access_token_write_grant("00000000-0000-4000-8000-000000000000")
            .unwrap(),
        Value::Null
    );
}
