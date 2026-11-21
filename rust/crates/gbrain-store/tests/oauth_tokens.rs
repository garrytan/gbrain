//! The `oauth_tokens` members (`insertOauthToken`, `readOauthAccessTokenRows`, the expiry sweep) and the cascade of a
//! client delete. What the parity file cannot see lives here: the stored message of each refusal (the TypeScript member
//! turns it into SQLSTATE 23505 / 23503 and the constraint name), that a refused write leaves the table as it was, the
//! degrade rungs of the bearer read, and the `to_jsonb` shape of `current_grant`.

mod memory_env;

use gbrain_store::jobs::{ClientInsert, OauthTokenInsert};
use memory_env::{Brain, brain};
use serde_json::{Map, Value, json};

fn client(b: &Brain, row: Value) {
    let row: ClientInsert = serde_json::from_value(row).unwrap();
    b.insert_oauth_client(&row).unwrap();
}

fn token(b: &Brain, row: Value) -> Result<(), gbrain_store::error::StoreError> {
    let row: OauthTokenInsert = serde_json::from_value(row).unwrap();
    b.insert_oauth_token(&row)
}

fn access(hash: &str, client_id: &str) -> Value {
    json!({ "token_hash": hash, "token_type": "access", "client_id": client_id, "scopes": ["read", "write"],
        "expires_at": 1_900_000_000, "resource": "https://brain.example/mcp", "created_at": 1_800_000_000,
        "grant_type": "client_credentials" })
}

fn rows(b: &Brain, hash: &str, rung: u8) -> Vec<Value> {
    b.read_oauth_access_token_rows(hash, rung)
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn a_token_is_read_with_its_client_and_the_grant_row_without_the_secret_hash() {
    let b = brain("otok-read");
    b.insert_source("wiki", "wiki", None, &Map::new()).unwrap();
    b.insert_source("old", "old", None, &Map::new()).unwrap();
    b.set_source_archived("old", true).unwrap();
    client(
        &b,
        json!({ "client_id": "c1", "client_name": "Client One", "client_secret_hash": "secret", "scope": "read write",
            "source_id": "wiki", "federated_read": ["wiki", "old", "ghost"], "bound_slug_prefixes": ["a/"],
            "surface": "full", "surface_set_by": "operator", "budget_usd_per_day": 5.0, "token_ttl": 600 }),
    );
    token(&b, access("h1", "c1")).unwrap();
    let r = &rows(&b, "h1", 0)[0];
    assert_eq!(r["client_id"], "c1");
    assert_eq!(r["scopes"], json!(["read", "write"]));
    assert_eq!(r["expires_at"], 1_900_000_000);
    assert_eq!(r["resource"], "https://brain.example/mcp");
    assert_eq!(r["client_name"], "Client One");
    assert_eq!(r["current_scopes"], "read write");
    assert_eq!(r["token_grant"], "client_credentials");
    assert_eq!(r["source_active"], true);
    assert_eq!(
        r["active_read_sources"],
        json!(["wiki"]),
        "an archived or missing source is not active"
    );
    assert_eq!(r["source_id"], "wiki");
    assert_eq!(r["federated_read"], json!(["wiki", "old", "ghost"]));
    assert_eq!(r["bound_slug_prefixes"], json!(["a/"]));
    assert_eq!(r["surface"], "full");
    assert_eq!(r["surface_set_by"], "operator");
    let g = &r["current_grant"];
    assert!(g.get("client_secret_hash").is_none());
    assert_eq!(g["token_ttl"], 600);
    assert_eq!(
        g["budget_usd_per_day"],
        json!(5.0),
        "to_jsonb prints a NUMERIC as a number"
    );
    assert_eq!(g["deleted_at"], Value::Null);
    assert_eq!(g["created_at"], "2027-01-15T08:00:00+00:00");
    assert_eq!(g["delegated_namespace"], "prefixes");
    assert_eq!(g["grant_revision"], 0);
}

#[test]
fn only_an_access_token_of_a_live_client_is_read_and_a_missing_source_is_not_active() {
    let b = brain("otok-live");
    client(
        &b,
        json!({ "client_id": "c1", "client_name": "One", "scope": "read" }),
    );
    token(&b, access("h-access", "c1")).unwrap();
    let mut refresh = access("h-refresh", "c1");
    refresh["token_type"] = json!("refresh");
    token(&b, refresh).unwrap();
    assert!(
        rows(&b, "h-refresh", 0).is_empty(),
        "a refresh token is not a bearer"
    );
    assert!(rows(&b, "nope", 0).is_empty());
    let r = &rows(&b, "h-access", 0)[0];
    assert_eq!(
        r["source_active"], false,
        "a client with no source has no active source"
    );
    assert_eq!(r["active_read_sources"], json!([]));
    let deleted = json!({ "client_id": "c2", "client_name": "Two", "scope": "read", "deleted_at": "2027-01-01T00:00:00Z" });
    client(&b, deleted);
    token(&b, access("h-gone", "c2")).unwrap();
    assert!(
        rows(&b, "h-gone", 0).is_empty(),
        "a soft-deleted client's token is not read"
    );
}

#[test]
fn the_degrade_rungs_drop_the_columns_a_older_brain_lacks() {
    let b = brain("otok-rungs");
    client(
        &b,
        json!({ "client_id": "c1", "client_name": "One", "scope": "read" }),
    );
    token(&b, access("h1", "c1")).unwrap();
    let keys = |rung: u8| -> Vec<String> {
        let mut k: Vec<String> = rows(&b, "h1", rung)[0]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        k.sort();
        k
    };
    let has = |rung: u8, name: &str| keys(rung).iter().any(|k| k == name);
    for name in [
        "token_grant",
        "surface",
        "surface_set_by",
        "bound_slug_prefixes",
        "federated_read",
        "source_id",
    ] {
        assert!(has(0, name), "rung 0 has {name}");
    }
    assert!(
        !has(1, "token_grant")
            && !has(1, "surface")
            && !has(1, "surface_set_by")
            && has(1, "bound_slug_prefixes")
    );
    assert!(!has(2, "bound_slug_prefixes") && has(2, "federated_read"));
    assert!(!has(3, "federated_read") && has(3, "source_id"));
    assert!(!has(4, "source_id") && has(4, "source_active") && has(4, "current_grant"));
    assert_eq!(keys(0).len(), 15);
    assert_eq!(keys(4).len(), 9);
}

#[test]
fn a_repeated_hash_and_an_unknown_client_are_refused_and_leave_the_table() {
    let b = brain("otok-refused");
    client(
        &b,
        json!({ "client_id": "c1", "client_name": "One", "scope": "read" }),
    );
    token(&b, access("h1", "c1")).unwrap();
    let e = token(&b, access("h1", "c1")).unwrap_err();
    assert_eq!(e.code, "constraint_violation");
    assert_eq!(
        e.message,
        "duplicate key value violates unique constraint \"oauth_tokens_pkey\""
    );
    let e = token(&b, access("h2", "nobody")).unwrap_err();
    assert_eq!(e.code, "constraint_violation");
    assert_eq!(
        e.message,
        "insert or update on table \"oauth_tokens\" violates foreign key constraint \"oauth_tokens_client_id_fkey\""
    );
    assert!(rows(&b, "h2", 0).is_empty());
    let e = token(&b, access("h1", "nobody")).unwrap_err();
    assert!(
        e.message.contains("oauth_tokens_pkey"),
        "the duplicate is found before the foreign key, as Postgres does"
    );
}

#[test]
fn deleting_a_client_removes_its_tokens_and_no_other() {
    let b = brain("otok-cascade");
    client(
        &b,
        json!({ "client_id": "c1", "client_name": "One", "scope": "read" }),
    );
    client(
        &b,
        json!({ "client_id": "c2", "client_name": "Two", "scope": "read" }),
    );
    token(&b, access("a1", "c1")).unwrap();
    let mut refresh = access("r1", "c1");
    refresh["token_type"] = json!("refresh");
    token(&b, refresh).unwrap();
    token(&b, access("a2", "c2")).unwrap();
    b.delete_oauth_client("c1").unwrap();
    assert!(rows(&b, "a1", 0).is_empty());
    assert_eq!(rows(&b, "a2", 0).len(), 1);
    // the refresh token went too: its hash is free again (primary key), and the client is gone (foreign key).
    client(
        &b,
        json!({ "client_id": "c1", "client_name": "One again", "scope": "read" }),
    );
    token(&b, access("r1", "c1")).unwrap();
}

#[test]
fn the_sweep_deletes_the_tokens_that_expired_and_counts_them() {
    let b = brain("otok-sweep");
    client(
        &b,
        json!({ "client_id": "c1", "client_name": "One", "scope": "read" }),
    );
    for (hash, exp) in [
        ("old1", Some(100)),
        ("old2", Some(199)),
        ("edge", Some(200)),
        ("fresh", Some(300)),
    ] {
        let mut t = access(hash, "c1");
        t["expires_at"] = json!(exp);
        token(&b, t).unwrap();
    }
    let mut never = access("never", "c1");
    never["expires_at"] = Value::Null;
    token(&b, never).unwrap();
    assert_eq!(b.delete_expired_oauth_tokens(200).unwrap(), 2);
    assert!(rows(&b, "old1", 0).is_empty() && rows(&b, "old2", 0).is_empty());
    for kept in ["edge", "fresh", "never"] {
        assert_eq!(rows(&b, kept, 0).len(), 1, "{kept} stays");
    }
    assert_eq!(b.delete_expired_oauth_tokens(200).unwrap(), 0);
}

#[test]
fn a_refresh_token_is_read_by_its_own_client_only_and_deleted_once() {
    let b = brain("otok-refresh");
    client(
        &b,
        json!({ "client_id": "c1", "client_name": "c1", "scope": "read" }),
    );
    client(
        &b,
        json!({ "client_id": "c2", "client_name": "c2", "scope": "read" }),
    );
    let mut refresh = access("r1", "c1");
    refresh["token_type"] = json!("refresh");
    refresh["grant_type"] = json!("authorization_code");
    token(&b, refresh).unwrap();
    token(&b, access("a1", "c1")).unwrap();
    let row = b.read_oauth_refresh_token_for_update("r1", "c1").unwrap();
    assert_eq!(row["token_hash"], "r1");
    assert_eq!(row["token_type"], "refresh");
    assert_eq!(row["client_id"], "c1");
    assert_eq!(row["scopes"], json!(["read", "write"]));
    assert_eq!(row["expires_at"], 1_900_000_000);
    assert_eq!(row["resource"], "https://brain.example/mcp");
    assert_eq!(row["grant_type"], "authorization_code");
    assert!(
        row["created_at"]
            .as_str()
            .unwrap()
            .starts_with("2027-01-15T")
    );
    assert_eq!(
        b.read_oauth_refresh_token_for_update("r1", "c2").unwrap(),
        Value::Null,
        "another client's refresh token reads null"
    );
    assert_eq!(
        b.read_oauth_refresh_token_for_update("a1", "c1").unwrap(),
        Value::Null,
        "an access token is not a refresh token"
    );
    b.delete_oauth_refresh_token("a1", "c1").unwrap();
    assert_eq!(
        rows(&b, "a1", 0).len(),
        1,
        "the refresh delete keeps an access token"
    );
    b.delete_oauth_refresh_token("r1", "c2").unwrap();
    assert_ne!(
        b.read_oauth_refresh_token_for_update("r1", "c1").unwrap(),
        Value::Null,
        "another client's delete keeps it"
    );
    b.delete_oauth_refresh_token("r1", "c1").unwrap();
    assert_eq!(
        b.read_oauth_refresh_token_for_update("r1", "c1").unwrap(),
        Value::Null
    );
    b.delete_oauth_refresh_token("r1", "c1").unwrap();
}
