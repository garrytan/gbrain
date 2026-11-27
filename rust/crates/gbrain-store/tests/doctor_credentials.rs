//! Doctor's credential reads (`jobs/doctor_credentials.rs`): what the parity case does not pin. The active-token read
//! skips a revoked token and keeps the hash, the client read skips a deleted client, and the attest read keeps only
//! live credentials with an attest actor, a token row in `to_jsonb` time text and a client row without its secret hash.

mod memory_env;

use gbrain_store::jobs::{ClientInsert, CredentialBinding, CredentialKind, TokenInsert};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn token(b: &Brain, name: &str, extra: Value) -> String {
    let mut row = json!({
        "name": name, "token_hash": format!("hash-{name}"), "scopes": ["read"], "permissions": {},
        "source_grant": "default", "source_id": null, "federated_read": null, "allowed_operations": null,
        "takes_holders": null,
    });
    for (k, v) in extra.as_object().unwrap() {
        row[k] = v.clone();
    }
    let row: TokenInsert = serde_json::from_value(row).unwrap();
    b.insert_access_token(&row).unwrap()
}

fn client(b: &Brain, id: &str, extra: Value) {
    let mut row = json!({ "client_id": id, "client_name": format!("{id} name"), "scope": "read" });
    for (k, v) in extra.as_object().unwrap() {
        row[k] = v.clone();
    }
    let row: ClientInsert = serde_json::from_value(row).unwrap();
    b.insert_oauth_client(&row).unwrap();
}

fn attest(actor: &str) -> CredentialBinding {
    serde_json::from_value(
        json!({ "member": null, "mayActFor": null, "attestActor": actor, "attestOps": ["query"],
        "attestSources": null, "attestRead": "scope" }),
    )
    .unwrap()
}

fn field<'a>(rows: &'a Value, key: &str) -> Vec<&'a Value> {
    rows.as_array().unwrap().iter().map(|r| &r[key]).collect()
}

#[test]
fn active_tokens_are_oldest_first_with_their_hash_and_skip_revoked_ones() {
    let b = brain("doctor-tokens");
    token(
        &b,
        "late",
        json!({ "member_id": null, "created_at": "2026-01-03T00:00:00Z" }),
    );
    token(
        &b,
        "early",
        json!({ "member_id": null, "created_at": "2026-01-01T00:00:00Z" }),
    );
    token(
        &b,
        "revoked",
        json!({ "revoked_at": "2026-01-02T00:00:00Z" }),
    );
    let rows = b.list_active_access_token_rows().unwrap();
    assert_eq!(field(&rows, "name"), vec!["early", "late"]);
    assert_eq!(field(&rows, "token_hash"), vec!["hash-early", "hash-late"]);
    assert_eq!(rows[0]["created_at"], "2026-01-01T00:00:00.000000Z");
}

#[test]
fn live_clients_go_by_client_id_in_byte_order_and_skip_deleted_ones() {
    let b = brain("doctor-clients");
    client(&b, "b-app", json!({ "client_secret_hash": "s" }));
    client(&b, "B-app", json!({}));
    client(&b, "gone", json!({ "deleted_at": "2026-01-01T00:00:00Z" }));
    let rows = b.list_active_oauth_client_rows().unwrap();
    assert_eq!(field(&rows, "client_id"), vec!["B-app", "b-app"]);
    assert_eq!(rows[1]["client_secret_hash"], "s");
}

#[test]
fn attest_rows_keep_live_credentials_with_an_actor_as_jsonb_rows() {
    let b = brain("doctor-attest");
    let kept = token(
        &b,
        "kept",
        json!({ "member_id": null, "created_at": "2026-01-03T00:00:00.215Z" }),
    );
    let revoked = token(&b, "revoked", json!({}));
    token(&b, "plain", json!({}));
    for id in [&kept, &revoked] {
        b.write_credential_binding(CredentialKind::Token, id, &attest("slack"))
            .unwrap();
    }
    b.revoke_access_token(&revoked).unwrap();
    client(
        &b,
        "zed",
        json!({ "client_secret_hash": "s", "attest_actor": "slack", "budget_usd_per_day": 2.5 }),
    );
    client(
        &b,
        "old",
        json!({ "attest_actor": "slack", "deleted_at": "2026-01-01T00:00:00Z" }),
    );
    client(&b, "amy", json!({}));
    let rows = b.list_attest_credential_rows().unwrap();
    assert_eq!(field(&rows, "kind"), vec!["client", "token"]);
    assert_eq!(field(&rows, "name"), vec!["zed name", "kept"]);
    assert_eq!(rows[1]["id"], json!(kept));
    assert_eq!(
        rows[1]["row"]["created_at"],
        "2026-01-03T00:00:00.215+00:00"
    );
    assert_eq!(rows[1]["row"]["token_hash"], "hash-kept");
    assert!(rows[0]["row"].get("client_secret_hash").is_none());
    assert_eq!(rows[0]["row"]["budget_usd_per_day"], json!(2.5));
}
