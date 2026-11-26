//! The credential binding of `access_tokens` and `oauth_clients` (`credential_binding.rs`): what the parity files
//! cannot see directly. A binding write changes only its own row and nothing when no row has the id; the live reads
//! skip a revoked token and a deleted client; readAccessCredentials orders names by byte; the write grant reads keep a
//! revoked token and a deleted client; and a member insert that names a token binds it in the
//! same write.

mod memory_env;

use gbrain_store::access_members::AccessMemberInsert;
use gbrain_store::jobs::{
    ClientInsert, CredentialBinding, CredentialKind, CredentialLookup, TokenInsert,
};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn token(b: &Brain, name: &str, extra: Value) -> String {
    let mut row = json!({
        "name": name, "token_hash": format!("hash-{name}"), "scopes": ["read"], "permissions": { "source_id": "default" },
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
    let mut row =
        json!({ "client_id": id, "client_name": id, "scope": "read", "source_id": "default" });
    for (k, v) in extra.as_object().unwrap() {
        row[k] = v.clone();
    }
    let row: ClientInsert = serde_json::from_value(row).unwrap();
    b.insert_oauth_client(&row).unwrap();
}

fn member(b: &Brain, id: &str, bind_token_id: Option<&str>) {
    let spec: AccessMemberInsert =
        serde_json::from_value(json!({ "id": id, "groups": [], "bindTokenId": bind_token_id }))
            .unwrap();
    b.insert_access_member(&spec).unwrap();
}

fn binding(member: Option<&str>, may_act_for: Option<&[&str]>) -> CredentialBinding {
    serde_json::from_value(json!({ "member": member, "mayActFor": may_act_for })).unwrap()
}

fn credentials(b: &Brain, by: Value) -> Value {
    let by: CredentialLookup = serde_json::from_value(by).unwrap();
    b.read_access_credentials(&by).unwrap()
}

#[test]
fn a_binding_write_sets_only_its_own_row_and_nothing_for_an_absent_id() {
    let b = brain("binding-write");
    member(&b, "alice-example", None);
    let a = token(&b, "a", json!({}));
    let other = token(&b, "other", json!({}));
    client(&b, "client-a", json!({}));

    b.write_credential_binding(
        CredentialKind::Token,
        &a,
        &binding(Some("alice-example"), Some(&["bob-example"])),
    )
    .unwrap();
    b.write_credential_binding(
        CredentialKind::Client,
        "client-a",
        &binding(Some("alice-example"), None),
    )
    .unwrap();
    b.write_credential_binding(
        CredentialKind::Token,
        "no-such-id",
        &binding(Some("alice-example"), None),
    )
    .unwrap();
    b.write_credential_binding(
        CredentialKind::Client,
        "client-none",
        &binding(Some("alice-example"), None),
    )
    .unwrap();

    assert_eq!(
        b.read_credential_binding(CredentialKind::Token, &a, false)
            .unwrap(),
        Some(json!({
            "member_id": "alice-example", "may_act_for": ["bob-example"], "attest_actor": null, "attest_ops": null,
            "attest_sources": null, "attest_read": null,
        }))
    );
    assert_eq!(
        b.read_credential_binding(CredentialKind::Token, &other, false)
            .unwrap()
            .unwrap()["member_id"],
        Value::Null,
        "another token keeps no binding"
    );
    let c = b
        .read_credential_binding(CredentialKind::Client, "client-a", true)
        .unwrap()
        .unwrap();
    assert_eq!(c["member_id"], json!("alice-example"));
    assert_eq!(c["confidential"], json!(false));
    assert_eq!(c["reads_unscoped"], Value::Null, "asked for, and not set");
    assert_eq!(
        b.read_credential_binding(CredentialKind::Token, "no-such-id", false)
            .unwrap(),
        None
    );
    assert_eq!(
        b.read_credential_binding(CredentialKind::Client, "client-none", false)
            .unwrap(),
        None
    );

    b.write_credential_reads_unscoped(CredentialKind::Token, &a, true)
        .unwrap();
    let stamped = b
        .read_credential_binding(CredentialKind::Token, &a, true)
        .unwrap()
        .unwrap();
    assert!(
        stamped["reads_unscoped"].is_string(),
        "the transaction's time, as ISO text"
    );
    b.write_credential_reads_unscoped(CredentialKind::Token, &a, false)
        .unwrap();
    let cleared = b
        .read_credential_binding(CredentialKind::Token, &a, true)
        .unwrap()
        .unwrap();
    assert_eq!(cleared["reads_unscoped"], Value::Null);
    assert!(
        !b.read_credential_binding(CredentialKind::Token, &a, false)
            .unwrap()
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("reads_unscoped"),
        "not asked for, not read"
    );
}

#[test]
fn the_live_read_skips_a_revoked_token_and_a_deleted_client_and_refuses_another_kind() {
    let b = brain("binding-live");
    member(&b, "alice-example", None);
    let live = token(
        &b,
        "live",
        json!({ "member_id": "alice-example", "may_act_for": ["bob-example"] }),
    );
    let gone = token(&b, "gone", json!({ "member_id": "alice-example" }));
    b.revoke_access_token(&gone).unwrap();
    client(&b, "client-live", json!({}));
    client(
        &b,
        "client-gone",
        json!({ "deleted_at": "2026-02-01T00:00:00Z" }),
    );
    for id in ["client-live", "client-gone"] {
        b.write_credential_binding(
            CredentialKind::Client,
            id,
            &binding(Some("alice-example"), None),
        )
        .unwrap();
    }

    assert_eq!(
        b.read_live_credential("legacy_token", &live).unwrap(),
        Some(json!({ "member_id": "alice-example", "may_act_for": ["bob-example"] }))
    );
    assert_eq!(b.read_live_credential("legacy_token", &gone).unwrap(), None);
    assert_eq!(
        b.read_live_credential("legacy_token", &format!("{{{live}}}"))
            .unwrap(),
        None,
        "the id text matches exactly: a braced UUID is not it"
    );
    assert_eq!(
        b.read_live_credential("oauth_client", "client-live")
            .unwrap(),
        Some(json!({ "member_id": "alice-example", "may_act_for": null }))
    );
    assert_eq!(
        b.read_live_credential("oauth_client", "client-gone")
            .unwrap(),
        None
    );
    assert_eq!(
        b.read_live_credential("oauth_client", "client-none")
            .unwrap(),
        None
    );
    let e = b.read_live_credential("session", "x").unwrap_err();
    assert_eq!(e.code, "invalid_argument");
}

#[test]
fn access_credentials_by_name_are_oldest_first_and_by_member_are_tokens_by_byte_name_then_clients()
{
    let b = brain("binding-credentials");
    member(&b, "alice-example", None);
    let newer = token(
        &b,
        "laptop",
        json!({ "created_at": "2026-03-01T00:00:00Z", "token_hash": "h-newer" }),
    );
    let older = token(
        &b,
        "laptop",
        json!({ "created_at": "2026-01-01T00:00:00Z", "token_hash": "h-older" }),
    );
    let revoked = token(
        &b,
        "laptop",
        json!({ "created_at": "2026-02-01T00:00:00Z", "token_hash": "h-revoked" }),
    );
    b.revoke_access_token(&revoked).unwrap();
    assert_eq!(
        credentials(&b, json!({ "tokenName": "laptop" })),
        json!([
            { "kind": "token", "id": older, "name": "laptop" },
            { "kind": "token", "id": newer, "name": "laptop" },
        ])
    );
    assert_eq!(
        credentials(&b, json!({ "tokenName": "Laptop" })),
        json!([]),
        "the name matches exactly"
    );

    let lower = token(&b, "b-phone", json!({ "member_id": "alice-example" }));
    let upper = token(&b, "Z-desk", json!({ "member_id": "alice-example" }));
    let gone = token(&b, "a-gone", json!({ "member_id": "alice-example" }));
    b.revoke_access_token(&gone).unwrap();
    client(
        &b,
        "client-gone",
        json!({ "deleted_at": "2026-02-01T00:00:00Z" }),
    );
    for id in ["client-b", "client-A"] {
        client(&b, id, json!({}));
    }
    for id in ["client-b", "client-A", "client-gone"] {
        b.write_credential_binding(
            CredentialKind::Client,
            id,
            &binding(Some("alice-example"), None),
        )
        .unwrap();
    }
    assert_eq!(
        credentials(&b, json!({ "memberId": "alice-example" })),
        json!([
            { "kind": "token", "id": upper, "name": "Z-desk" },
            { "kind": "token", "id": lower, "name": "b-phone" },
            { "kind": "client", "id": "client-A", "name": "client-A" },
            { "kind": "client", "id": "client-b", "name": "client-b" },
        ]),
        "byte order puts an upper-case letter first"
    );
    assert_eq!(
        credentials(&b, json!({ "memberId": "ALICE-EXAMPLE" })),
        json!([])
    );
    assert_eq!(
        b.read_access_credentials(&CredentialLookup::default())
            .unwrap_err()
            .code,
        "invalid_argument"
    );
}

#[test]
fn the_write_grant_reads_keep_a_revoked_token_and_a_deleted_client() {
    let b = brain("binding-grants");
    let id = token(&b, "writer", json!({ "scopes": ["read", "write"] }));
    let grant = b.read_access_token_write_grant(&id).unwrap().unwrap();
    assert_eq!(grant["id"], json!(id));
    assert_eq!(grant["scopes"], json!(["read", "write"]));
    assert_eq!(grant["private_pages"], json!("none"));
    assert_eq!(grant["revoked_at"], Value::Null);
    b.revoke_access_token(&id).unwrap();
    assert!(b.read_access_token_write_grant(&id).unwrap().unwrap()["revoked_at"].is_string());
    assert_eq!(
        b.read_access_token_write_grant("ffffffff-ffff-ffff-ffff-ffffffffffff")
            .unwrap(),
        None
    );

    client(&b, "client-writer", json!({ "scope": "read write" }));
    let c = b
        .read_oauth_client_write_grant("client-writer")
        .unwrap()
        .unwrap();
    assert_eq!(c["deleted_at"], Value::Null);
    assert_eq!(c["scope"], json!("read write"));
    assert_eq!(c["source_id"], json!("default"));
    client(
        &b,
        "client-deleted",
        json!({ "deleted_at": "2026-02-01T00:00:00Z" }),
    );
    assert_eq!(
        b.read_oauth_client_write_grant("client-deleted")
            .unwrap()
            .unwrap()["deleted_at"],
        json!("2026-02-01T00:00:00.000000Z")
    );
    b.delete_oauth_client("client-writer").unwrap();
    assert_eq!(
        b.read_oauth_client_write_grant("client-writer").unwrap(),
        None,
        "a removed row reads as none"
    );
    assert_eq!(
        b.read_oauth_client_write_grant("client-none").unwrap(),
        None
    );
}

#[test]
fn a_member_insert_that_names_a_token_binds_only_the_member_in_the_same_write() {
    let b = brain("binding-member-insert");
    let laptop = token(&b, "laptop", json!({ "may_act_for": ["carol-example"] }));
    member(&b, "alice-example", Some(&laptop));
    member(&b, "bob-example", Some("no-such-id"));
    assert_eq!(
        b.read_credential_binding(CredentialKind::Token, &laptop, false)
            .unwrap()
            .unwrap(),
        json!({
            "member_id": "alice-example", "may_act_for": ["carol-example"], "attest_actor": null, "attest_ops": null,
            "attest_sources": null, "attest_read": null,
        }),
        "may_act_for is left as it was, as the SQL UPDATE leaves it"
    );
    assert_eq!(
        credentials(&b, json!({ "memberId": "alice-example" })),
        json!([{ "kind": "token", "id": laptop, "name": "laptop" }])
    );
    assert_eq!(
        credentials(&b, json!({ "memberId": "bob-example" })),
        json!([])
    );
}
