//! The revoke and lifecycle writes of `OAuthGrants.revokeToken` and `revokeClient` (`deleteOauthTokenByHash`, `deleteOauthClientTokens`,
//! `softDeleteOauthClient`). The parity file compares them with PGLite and Postgres through the grants; these cover what
//! it cannot see: that a token another client owns survives a revoke naming the wrong client, that a soft delete keeps
//! the row and its tokens, and that a second soft delete moves the time.

mod memory_env;

use gbrain_store::jobs::{ClientInsert, GrantAuditInsert, OauthTokenInsert};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn client(b: &Brain, id: &str) {
    let row: ClientInsert =
        serde_json::from_value(json!({ "client_id": id, "client_name": id, "scope": "read" }))
            .unwrap();
    b.insert_oauth_client(&row).unwrap();
}

fn token(b: &Brain, hash: &str, client_id: &str, kind: &str) {
    let row: OauthTokenInsert = serde_json::from_value(json!({
        "token_hash": hash, "token_type": kind, "client_id": client_id, "scopes": ["read"],
        "expires_at": 1_900_000_000, "created_at": 1_800_000_000,
    }))
    .unwrap();
    b.insert_oauth_token(&row).unwrap();
}

fn live(b: &Brain, hash: &str) -> bool {
    !b.read_oauth_access_token_rows(hash, 0)
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty()
}

#[test]
fn a_token_goes_only_for_the_client_that_owns_it() {
    let b = brain("orev-token");
    client(&b, "c1");
    client(&b, "c2");
    token(&b, "a1", "c1", "access");
    token(&b, "a2", "c2", "access");
    b.delete_oauth_token_by_hash("a1", "c2").unwrap();
    assert!(live(&b, "a1"), "another client's revoke leaves the token");
    b.delete_oauth_token_by_hash("a1", "c1").unwrap();
    assert!(!live(&b, "a1"));
    assert!(live(&b, "a2"));
    // an unknown hash is not an error: the statement deletes no row
    b.delete_oauth_token_by_hash("nope", "c1").unwrap();
}

#[test]
fn deleting_a_clients_tokens_leaves_the_client_and_other_clients_tokens() {
    let b = brain("orev-tokens");
    client(&b, "c1");
    client(&b, "c2");
    token(&b, "a1", "c1", "access");
    token(&b, "r1", "c1", "refresh");
    token(&b, "a2", "c2", "access");
    b.delete_oauth_client_tokens("c1").unwrap();
    assert!(!live(&b, "a1"));
    assert!(live(&b, "a2"));
    assert!(b.read_oauth_client("c1").unwrap().is_some());
    // the refresh token went with it: its hash is free again
    token(&b, "r1", "c1", "refresh");
}

#[test]
fn a_soft_delete_keeps_the_row_and_its_tokens_and_a_second_one_moves_the_time() {
    let b = brain("orev-soft");
    client(&b, "c1");
    token(&b, "a1", "c1", "access");
    assert!(!b.soft_delete_oauth_client("missing").unwrap());
    assert!(b.oauth_client_live("c1").unwrap());
    assert!(b.soft_delete_oauth_client("c1").unwrap());
    assert!(!b.oauth_client_live("c1").unwrap());
    let row: Value = b.read_oauth_client("c1").unwrap().unwrap();
    assert!(
        row["deleted_at"].is_string(),
        "the row stays, stamped: {row}"
    );
    assert!(
        b.soft_delete_oauth_client("c1").unwrap(),
        "no guard: a soft-deleted client takes the statement again"
    );
    // the tokens are the caller's separate delete
    assert_eq!(
        b.read_oauth_access_token_rows("a1", 0)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        0,
        "a revoked client's token is not an active read"
    );
}

#[test]
fn a_revision_write_sets_the_revision_and_a_revoke_stamps_deleted_at_once() {
    let b = brain("orev-revision");
    client(&b, "c1");
    assert!(!b.set_oauth_client_revision("missing", 2, true).unwrap());
    assert!(b.set_oauth_client_revision("c1", 2, false).unwrap());
    let row: Value = b.read_oauth_client("c1").unwrap().unwrap();
    assert_eq!(row["grant_revision"], 2);
    assert!(
        row["deleted_at"].is_null(),
        "an invalidate keeps the client live: {row}"
    );
    assert!(b.set_oauth_client_revision("c1", 3, true).unwrap());
    let first: Value = b.read_oauth_client("c1").unwrap().unwrap();
    assert_eq!(first["grant_revision"], 3);
    assert!(first["deleted_at"].is_string());
    assert!(b.set_oauth_client_revision("c1", 4, true).unwrap());
    let second: Value = b.read_oauth_client("c1").unwrap().unwrap();
    assert_eq!(second["grant_revision"], 4);
    assert_eq!(
        second["deleted_at"], first["deleted_at"],
        "COALESCE keeps the first revoke time"
    );
}

#[test]
fn a_grant_audit_row_outlives_its_client_and_reads_back_in_order() {
    let b = brain("orev-audit");
    client(&b, "c1");
    let row = |action: &str, revision: i64, before: Value| -> GrantAuditInsert {
        serde_json::from_value(json!({
            "client_id": "c1", "actor": "admin", "action": action, "revision": revision,
            "before_grant": before.to_string(), "after_grant": json!({ "revision": revision }).to_string(),
        }))
        .unwrap()
    };
    b.insert_oauth_grant_audit(&row("revoke", 1, json!({ "revision": 0 })))
        .unwrap();
    b.delete_oauth_client("c1").unwrap();
    b.insert_oauth_grant_audit(&row("delete", 2, json!({ "revision": 1 })))
        .unwrap();
    let rows = b.list_oauth_grant_audit("c1").unwrap();
    let actions: Vec<&str> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["action"].as_str().unwrap())
        .collect();
    assert_eq!(actions, ["revoke", "delete"]);
    let bad: GrantAuditInsert = serde_json::from_value(
        json!({ "client_id": "c1", "actor": "a", "action": "x", "revision": 1, "after_grant": "{not json" }),
    )
    .unwrap();
    assert!(b.insert_oauth_grant_audit(&bad).is_err());
}

#[test]
fn access_tokens_are_counted_by_their_expiry_window() {
    let b = brain("orev-count");
    client(&b, "c1");
    for (hash, kind, expires) in [
        ("a-in", "access", 1_000),
        ("a-edge-lo", "access", 900),
        ("a-edge-hi", "access", 1_100),
        ("a-after", "access", 1_101),
        ("a-before", "access", 899),
        ("r-in", "refresh", 1_000),
    ] {
        let row: OauthTokenInsert = serde_json::from_value(json!({
            "token_hash": hash, "token_type": kind, "client_id": "c1", "scopes": ["read"],
            "expires_at": expires, "created_at": 1_800_000_000,
        }))
        .unwrap();
        b.insert_oauth_token(&row).unwrap();
    }
    let none: OauthTokenInsert = serde_json::from_value(json!({
        "token_hash": "a-none", "token_type": "access", "client_id": "c1", "scopes": ["read"],
        "created_at": 1_800_000_000,
    }))
    .unwrap();
    b.insert_oauth_token(&none).unwrap();
    assert_eq!(b.count_oauth_access_tokens(900, Some(1_100)).unwrap(), 3);
    assert_eq!(
        b.count_oauth_access_tokens(900, None).unwrap(),
        3,
        "after is exclusive: 1000, 1100 and 1101"
    );
    assert_eq!(b.count_oauth_access_tokens(2_000, None).unwrap(), 0);
}
