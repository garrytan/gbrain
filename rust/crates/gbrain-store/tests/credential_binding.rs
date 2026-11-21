//! The credential binding of tokens and clients: the binding read and writes, the live credential
//! read of readLiveMember and readMayActFor, readAccessCredentials, and the token a member insert
//! binds.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::access_members::AccessMemberInsert;
use gbrain_store::jobs::{
    ClientInsert, CredentialBinding, CredentialKind, CredentialLookup, TokenInsert,
};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};

/// A fresh token hash per token (the hash is unique per table).
static NEXT: AtomicUsize = AtomicUsize::new(0);

fn token(store: &Store, name: &str, revoked: bool) -> String {
    let hash = format!("hash-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let mut row = json!({"name": name, "token_hash": hash, "scopes": ["read"]});
    if revoked {
        row["revoked_at"] = json!("2026-01-01T00:00:00Z");
    }
    let row: TokenInsert = serde_json::from_value(row).unwrap();
    store.insert_access_token(&row).unwrap()
}

fn client(store: &Store, row: Value) {
    let row: ClientInsert = serde_json::from_value(row).unwrap();
    store.insert_oauth_client(&row).unwrap();
}

fn credentials(store: &Store, by: Value) -> Vec<(String, String)> {
    let by: CredentialLookup = serde_json::from_value(by).unwrap();
    let rows = store.read_access_credentials(&by).unwrap();
    let text = |r: &Value, k: &str| r[k].as_str().unwrap().to_owned();
    rows.as_array()
        .unwrap()
        .iter()
        .map(|r| (text(r, "kind"), text(r, "name")))
        .collect()
}

fn binding(member: Option<&str>, may_act_for: Option<&[&str]>) -> CredentialBinding {
    CredentialBinding {
        member: member.map(str::to_owned),
        may_act_for: may_act_for.map(|l| l.iter().map(|s| s.to_string()).collect()),
        ..Default::default()
    }
}

#[test]
fn a_member_insert_binds_the_token_with_exactly_that_id() {
    let dir = TempDir::new("binding-insert");
    let store = open(&dir);
    let id = token(&store, "laptop", false);
    let spec: AccessMemberInsert =
        serde_json::from_value(json!({"id": "alice", "bindTokenId": id.to_uppercase()})).unwrap();
    store.insert_access_member(&spec).unwrap();
    assert_eq!(
        store
            .read_live_credential("legacy_token", &id)
            .unwrap()
            .unwrap()["member_id"],
        Value::Null
    );
    let spec: AccessMemberInsert =
        serde_json::from_value(json!({"id": "bob", "bindTokenId": id})).unwrap();
    store.insert_access_member(&spec).unwrap();
    assert_eq!(
        store
            .read_live_credential("legacy_token", &id)
            .unwrap()
            .unwrap()["member_id"],
        "bob"
    );
    assert_eq!(
        credentials(&store, json!({"memberId": "bob"})),
        [("token".into(), "laptop".into())]
    );
}

#[test]
fn binding_writes_read_back_and_skip_an_absent_credential() {
    let dir = TempDir::new("binding-writes");
    let store = open(&dir);
    let id = token(&store, "laptop", false);
    client(
        &store,
        json!({"client_id": "cc", "client_name": "cc-app", "grant_types": ["client_credentials"], "client_secret_hash": "h"}),
    );
    let full = CredentialBinding {
        attest_actor: Some("qm".into()),
        attest_ops: Some(vec!["query".into()]),
        attest_sources: Some(vec!["scope-a".into()]),
        attest_read: Some("scope".into()),
        ..binding(Some("alice"), Some(&["member:alice"]))
    };
    store
        .write_credential_binding(CredentialKind::Token, &id, &full)
        .unwrap();
    store
        .write_credential_reads_unscoped(CredentialKind::Token, &id, true)
        .unwrap();
    let row = store
        .read_credential_binding(CredentialKind::Token, &id, true)
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            row["member_id"].clone(),
            row["may_act_for"].clone(),
            row["attest_ops"].clone(),
            row["attest_read"].clone()
        ),
        (
            json!("alice"),
            json!(["member:alice"]),
            json!(["query"]),
            json!("scope")
        )
    );
    assert!(row["reads_unscoped"].is_string());
    let narrow = store
        .read_credential_binding(CredentialKind::Token, &id, false)
        .unwrap()
        .unwrap();
    assert!(narrow.get("reads_unscoped").is_none());
    store
        .write_credential_reads_unscoped(CredentialKind::Token, &id, false)
        .unwrap();
    let cleared = store
        .read_credential_binding(CredentialKind::Token, &id, true)
        .unwrap()
        .unwrap();
    assert_eq!(cleared["reads_unscoped"], Value::Null);
    let cc = store
        .read_credential_binding(CredentialKind::Client, "cc", false)
        .unwrap()
        .unwrap();
    assert_eq!(
        (cc["grant_types"].clone(), cc["confidential"].clone()),
        (json!(["client_credentials"]), json!(true))
    );
    store
        .write_credential_binding(CredentialKind::Client, "none", &full)
        .unwrap();
    assert_eq!(
        store
            .read_credential_binding(CredentialKind::Client, "none", false)
            .unwrap(),
        None
    );
    assert_eq!(
        store
            .read_credential_binding(CredentialKind::Token, &id.to_uppercase(), false)
            .unwrap(),
        None
    );
}

#[test]
fn live_reads_skip_revoked_tokens_and_deleted_clients() {
    let dir = TempDir::new("binding-live");
    let store = open(&dir);
    let live = token(&store, "shared", false);
    let gone = token(&store, "shared", true);
    let older = token(&store, "shared", false);
    for id in [&live, &gone, &older] {
        store
            .write_credential_binding(
                CredentialKind::Token,
                id,
                &binding(Some("alice"), Some(&["guest"])),
            )
            .unwrap();
    }
    client(
        &store,
        json!({"client_id": "c-live", "client_name": "zeta", "member_id": "alice", "may_act_for": ["group:a"]}),
    );
    client(
        &store,
        json!({"client_id": "c-gone", "client_name": "gone", "member_id": "alice", "deleted_at": "2026-01-01T00:00:00Z"}),
    );
    assert_eq!(
        store.read_live_credential("legacy_token", &gone).unwrap(),
        None
    );
    assert_eq!(
        store
            .read_live_credential("oauth_client", "c-gone")
            .unwrap(),
        None
    );
    assert_eq!(
        store.read_live_credential("oauth_client", &live).unwrap(),
        None
    );
    let c = store
        .read_live_credential("oauth_client", "c-live")
        .unwrap()
        .unwrap();
    assert_eq!(c, json!({"member_id": "alice", "may_act_for": ["group:a"]}));
    assert_eq!(
        store
            .read_live_credential("member", "alice")
            .unwrap_err()
            .code,
        "invalid_argument"
    );
    let by_name = credentials(&store, json!({"tokenName": "shared"}));
    assert_eq!(by_name.len(), 2);
    let by_member = credentials(&store, json!({"memberId": "alice"}));
    assert_eq!(by_member.last().unwrap(), &("client".into(), "zeta".into()));
    assert_eq!(by_member.len(), 3);
    assert_eq!(
        credentials(&store, json!({"memberId": "Alice"})),
        Vec::<(String, String)>::new()
    );
}
