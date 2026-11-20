//! The `oauth_codes` members (`insertOauthCode`, `readOauthCodeForUpdate`, `deleteOauthCode`, `readOauthCodeChallenge`,
//! the credential sweep, `client_holds_oauth_code`), `issue_oauth_tokens`, and the cascade of a client delete. What the
//! parity file cannot see lives here: the stored message of each refusal, that a refused write leaves the table as it
//! was, and that one refused row of a grant leaves none of its tokens.

mod memory_env;

use gbrain_store::jobs::{ClientInsert, OauthCodeInsert, OauthTokenInsert};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn client(b: &Brain, id: &str) {
    let row: ClientInsert =
        serde_json::from_value(json!({ "client_id": id, "client_name": id, "scope": "read" }))
            .unwrap();
    b.insert_oauth_client(&row).unwrap();
}

fn code(hash: &str, client_id: &str, expires_at: i64) -> OauthCodeInsert {
    serde_json::from_value(json!({ "code_hash": hash, "client_id": client_id, "scopes": ["read", "write"],
        "code_challenge": "challenge", "code_challenge_method": "S256", "redirect_uri": "https://app.example/cb",
        "state": "st", "resource": null, "expires_at": expires_at }))
    .unwrap()
}

fn token(hash: &str, client_id: &str, kind: &str) -> OauthTokenInsert {
    serde_json::from_value(json!({ "token_hash": hash, "token_type": kind, "client_id": client_id,
        "scopes": ["read"], "expires_at": 1_900_000_000, "resource": null, "created_at": 1_800_000_000,
        "grant_type": "authorization_code" }))
    .unwrap()
}

#[test]
fn a_code_is_read_with_all_its_columns_by_its_own_client_only_and_deleted_once() {
    let b = brain("ocode-read");
    client(&b, "c1");
    client(&b, "c2");
    b.insert_oauth_code(&code("h1", "c1", 1_900_000_000))
        .unwrap();
    let row = b.read_oauth_code_for_update("h1", "c1").unwrap();
    assert_eq!(row["code_hash"], "h1");
    assert_eq!(row["client_id"], "c1");
    assert_eq!(row["scopes"], json!(["read", "write"]));
    assert_eq!(row["code_challenge"], "challenge");
    assert_eq!(row["code_challenge_method"], "S256");
    assert_eq!(row["redirect_uri"], "https://app.example/cb");
    assert_eq!(row["state"], "st");
    assert_eq!(row["resource"], Value::Null);
    assert_eq!(row["expires_at"], 1_900_000_000);
    assert!(row["created_at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        b.read_oauth_code_for_update("h1", "c2").unwrap(),
        Value::Null,
        "another client's code reads null"
    );
    assert_eq!(
        b.read_oauth_code_for_update("nope", "c1").unwrap(),
        Value::Null
    );
    b.delete_oauth_code("h1", "c2").unwrap();
    assert_ne!(
        b.read_oauth_code_for_update("h1", "c1").unwrap(),
        Value::Null,
        "another client's delete keeps it"
    );
    b.delete_oauth_code("h1", "c1").unwrap();
    assert_eq!(
        b.read_oauth_code_for_update("h1", "c1").unwrap(),
        Value::Null
    );
    b.delete_oauth_code("h1", "c1").unwrap();
}

#[test]
fn a_repeated_hash_and_a_client_with_no_row_are_refused_and_leave_no_row() {
    let b = brain("ocode-refuse");
    client(&b, "c1");
    b.insert_oauth_code(&code("h1", "c1", 1_900_000_000))
        .unwrap();
    let dup = b.insert_oauth_code(&code("h1", "c1", 1)).unwrap_err();
    assert_eq!(dup.code, "constraint_violation");
    assert_eq!(
        dup.message,
        "duplicate key value violates unique constraint \"oauth_codes_pkey\""
    );
    let orphan = b
        .insert_oauth_code(&code("h2", "ghost", 1_900_000_000))
        .unwrap_err();
    assert_eq!(
        orphan.message,
        "insert or update on table \"oauth_codes\" violates foreign key constraint \"oauth_codes_client_id_fkey\""
    );
    assert_eq!(
        b.read_oauth_code_for_update("h2", "ghost").unwrap(),
        Value::Null
    );
    assert_eq!(
        b.read_oauth_code_for_update("h1", "c1").unwrap()["expires_at"],
        1_900_000_000,
        "the first row is untouched"
    );
}

#[test]
fn the_challenge_reads_for_an_unexpired_code_of_a_live_client_of_that_client_only() {
    let b = brain("ocode-challenge");
    client(&b, "c1");
    client(&b, "c2");
    b.insert_oauth_code(&code("h1", "c1", 200)).unwrap();
    assert_eq!(
        b.read_oauth_code_challenge("h1", "c1", 100)
            .unwrap()
            .as_deref(),
        Some("challenge")
    );
    assert_eq!(
        b.read_oauth_code_challenge("h1", "c1", 200).unwrap(),
        None,
        "expiring at now is expired"
    );
    assert_eq!(b.read_oauth_code_challenge("h1", "c2", 100).unwrap(), None);
    assert_eq!(
        b.read_oauth_code_challenge("nope", "c1", 100).unwrap(),
        None
    );
    let soft: ClientInsert = serde_json::from_value(
        json!({ "client_id": "c3", "client_name": "c3", "scope": "read",
        "deleted_at": "2027-01-01T00:00:00Z" }),
    )
    .unwrap();
    b.insert_oauth_client(&soft).unwrap();
    b.insert_oauth_code(&code("h3", "c3", 200)).unwrap();
    assert_eq!(
        b.read_oauth_code_challenge("h3", "c3", 100).unwrap(),
        None,
        "a soft-deleted client's code reads none"
    );
}

#[test]
fn the_credential_sweep_deletes_the_expired_codes_and_tokens_in_one_count() {
    let b = brain("ocode-sweep");
    client(&b, "c1");
    b.insert_oauth_code(&code("old", "c1", 100)).unwrap();
    b.insert_oauth_code(&code("edge", "c1", 200)).unwrap();
    b.insert_oauth_code(&code("live", "c1", 300)).unwrap();
    let mut old = token("t-old", "c1", "access");
    old.expires_at = Some(50);
    b.insert_oauth_token(&old).unwrap();
    b.insert_oauth_token(&token("t-live", "c1", "refresh"))
        .unwrap();
    assert_eq!(b.delete_expired_oauth_credentials(200).unwrap(), 2);
    assert_eq!(
        b.read_oauth_code_for_update("old", "c1").unwrap(),
        Value::Null
    );
    assert_ne!(
        b.read_oauth_code_for_update("edge", "c1").unwrap(),
        Value::Null,
        "expiring at now is not yet swept"
    );
    assert_ne!(
        b.read_oauth_code_for_update("live", "c1").unwrap(),
        Value::Null
    );
    assert_eq!(
        b.read_oauth_access_token_rows("t-old", 0).unwrap(),
        json!([])
    );
    assert_eq!(b.delete_expired_oauth_credentials(200).unwrap(), 0);
}

#[test]
fn a_client_holds_a_code_until_it_is_deleted_and_a_client_delete_removes_its_codes() {
    let b = brain("ocode-holds");
    client(&b, "c1");
    client(&b, "c2");
    assert!(!b.client_holds_oauth_code("c1").unwrap());
    b.insert_oauth_code(&code("expired", "c1", 1)).unwrap();
    assert!(
        b.client_holds_oauth_code("c1").unwrap(),
        "an expired code still counts"
    );
    assert!(!b.client_holds_oauth_code("c2").unwrap());
    b.insert_oauth_code(&code("kept", "c2", 1_900_000_000))
        .unwrap();
    b.delete_oauth_client("c1").unwrap();
    assert_eq!(
        b.read_oauth_code_for_update("expired", "c1").unwrap(),
        Value::Null
    );
    assert!(!b.client_holds_oauth_code("c1").unwrap());
    assert!(
        b.client_holds_oauth_code("c2").unwrap(),
        "another client's code stays"
    );
}

#[test]
fn a_grant_writes_all_its_tokens_in_one_write_or_none() {
    let b = brain("ocode-issue");
    client(&b, "c1");
    b.issue_oauth_tokens(&[token("a1", "c1", "access"), token("r1", "c1", "refresh")])
        .unwrap();
    assert_eq!(
        b.read_oauth_access_token_rows("a1", 0)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let again = b
        .issue_oauth_tokens(&[token("a2", "c1", "access"), token("r1", "c1", "refresh")])
        .unwrap_err();
    assert_eq!(
        again.message,
        "duplicate key value violates unique constraint \"oauth_tokens_pkey\""
    );
    assert_eq!(
        b.read_oauth_access_token_rows("a2", 0).unwrap(),
        json!([]),
        "the access token of the refused grant is not kept"
    );
    let orphan = b
        .issue_oauth_tokens(&[token("a3", "ghost", "access")])
        .unwrap_err();
    assert!(orphan.message.contains("oauth_tokens_client_id_fkey"));
}

#[test]
fn the_restore_quarantine_expires_every_code_and_token_and_keeps_the_rows() {
    let b = brain("ocode-expire-all");
    client(&b, "c1");
    client(&b, "c2");
    b.insert_oauth_code(&code("k1", "c1", 1_900_000_000))
        .unwrap();
    b.insert_oauth_code(&code("k2", "c2", 300)).unwrap();
    b.insert_oauth_token(&token("t-acc", "c1", "access"))
        .unwrap();
    b.insert_oauth_token(&token("t-ref", "c2", "refresh"))
        .unwrap();
    let mut never = token("t-never", "c1", "access");
    never.expires_at = None;
    b.insert_oauth_token(&never).unwrap();
    b.expire_all_oauth_credentials().unwrap();
    for (hash, client_id) in [("k1", "c1"), ("k2", "c2")] {
        let row = b.read_oauth_code_for_update(hash, client_id).unwrap();
        assert_eq!(row["expires_at"], 0, "{hash} expires and stays");
    }
    let refresh = b
        .read_oauth_refresh_token_for_update("t-ref", "c2")
        .unwrap();
    assert_eq!(refresh["expires_at"], 0);
    // The sweep then removes every row: each now expires before any later clock.
    assert_eq!(b.delete_expired_oauth_credentials(1).unwrap(), 5);
    b.expire_all_oauth_credentials().unwrap();
}
