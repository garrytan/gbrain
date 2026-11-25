//! The owner gate and the per-call revalidation of [`Scope`].

use super::*;
use crate::access_members::AccessMemberInsert;
use crate::jobs::TokenInsert;
use crate::test_support::store;

fn member(s: &Store, id: &str) {
    s.insert_access_member(&AccessMemberInsert {
        id: id.into(),
        display_name: None,
        email: None,
        kind: None,
        groups: vec![],
        bind_token_id: None,
    })
    .unwrap();
}

/// Mints a token with the bearer `secret`, bound to `member_id`; returns its id.
fn token(s: &Store, name: &str, secret: &str, member_id: Option<&str>) -> String {
    let insert: TokenInsert = serde_json::from_value(serde_json::json!({
        "name": name, "token_hash": token_hash(secret), "scopes": ["read", "write"], "member_id": member_id,
    }))
    .unwrap();
    s.insert_access_token(&insert).unwrap()
}

fn denied<T: std::fmt::Debug>(r: Result<T>) -> String {
    let e = r.expect_err("refused");
    assert_eq!(e.code, "permission_denied");
    e.to_string()
}

fn brain() -> Store {
    let s = store();
    member(&s, "owner-example");
    member(&s, "alice-example");
    s.set_config(OWNER_MEMBER_KEY, "owner-example").unwrap();
    s
}

#[test]
fn the_owner_token_is_admitted_and_stays_admitted() {
    let s = brain();
    let id = token(&s, "owner-key", "secret-owner", Some("owner-example"));
    let p = s.authenticate_bearer("secret-owner").unwrap();
    assert_eq!(p.token_id(), id);
    assert_eq!(p.member_id(), Some("owner-example"));
    assert!(
        p.row().get("token_hash").is_none(),
        "the row never carries the hash"
    );
    let scope = Scope::from_principal(&s, &p).unwrap();
    assert!(scope.is_principal());
    scope.revalidate(&s).unwrap();
}

#[test]
fn every_other_credential_gets_the_same_refusal() {
    let s = brain();
    token(&s, "owner-key", "secret-owner", Some("owner-example"));
    token(&s, "alice-key", "secret-alice", Some("alice-example"));
    token(&s, "unbound-key", "secret-unbound", None);
    let unknown = denied(s.authenticate_bearer("no-such-secret"));
    let empty = denied(s.authenticate_bearer(""));
    let other = denied(Scope::from_principal(
        &s,
        &s.authenticate_bearer("secret-alice").unwrap(),
    ));
    let unbound = denied(Scope::from_principal(
        &s,
        &s.authenticate_bearer("secret-unbound").unwrap(),
    ));
    assert_eq!([&empty, &other, &unbound], [&unknown, &unknown, &unknown]);
}

#[test]
fn a_brain_with_no_live_owner_admits_nobody() {
    let s = store();
    member(&s, "owner-example");
    token(&s, "owner-key", "secret-owner", Some("owner-example"));
    let p = s.authenticate_bearer("secret-owner").unwrap();
    denied(Scope::from_principal(&s, &p));
    s.set_config(OWNER_MEMBER_KEY, "owner-example").unwrap();
    s.set_access_member_disabled("owner-example", true).unwrap();
    denied(Scope::from_principal(&s, &p));
}

#[test]
fn a_change_after_admission_refuses_the_next_call() {
    // Revoked.
    let s = brain();
    let id = token(&s, "owner-key", "secret-owner", Some("owner-example"));
    let scope = Scope::from_principal(&s, &s.authenticate_bearer("secret-owner").unwrap()).unwrap();
    s.revoke_access_token(&id).unwrap();
    denied(scope.revalidate(&s));
    denied(s.authenticate_bearer("secret-owner"));

    // Owner member disabled.
    let s = brain();
    token(&s, "owner-key", "secret-owner", Some("owner-example"));
    let scope = Scope::from_principal(&s, &s.authenticate_bearer("secret-owner").unwrap()).unwrap();
    s.set_access_member_disabled("owner-example", true).unwrap();
    denied(scope.revalidate(&s));

    // Owner moved to another member.
    let s = brain();
    token(&s, "owner-key", "secret-owner", Some("owner-example"));
    let scope = Scope::from_principal(&s, &s.authenticate_bearer("secret-owner").unwrap()).unwrap();
    s.set_config(OWNER_MEMBER_KEY, "alice-example").unwrap();
    denied(scope.revalidate(&s));

    // Grant narrowed to read-only (the grant revision moves).
    let s = brain();
    let id = token(&s, "owner-key", "secret-owner", Some("owner-example"));
    let scope = Scope::from_principal(&s, &s.authenticate_bearer("secret-owner").unwrap()).unwrap();
    let columns: crate::jobs::TokenGrantColumns = serde_json::from_value(
        serde_json::json!({ "source_grant": "scalar", "source_id": "default" }),
    )
    .unwrap();
    s.write_access_token_grant(
        &id,
        &columns,
        Some(vec!["read".into()]),
        serde_json::json!({}),
    )
    .unwrap()
    .expect("the token exists");
    denied(scope.revalidate(&s));
}

#[test]
fn the_embedded_caller_is_trusted_as_today() {
    let s = store();
    let scope = Scope::trusted_local(&serde_json::json!({ "identity": [] }));
    assert!(!scope.is_principal());
    assert!(scope.principal().is_none());
    scope.revalidate(&s).unwrap();
}
