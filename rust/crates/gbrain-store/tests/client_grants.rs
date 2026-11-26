//! The grant writes over `oauth_clients` and the grant audit (`persistOauthClientGrant`, `insertOauthClientGrant`,
//! `listOauthGrantAudit`, `readLatestCatalogProvenanceAudit`, and a client's binding writes). The parity file compares them with PGLite and Postgres;
//! these cover what it cannot see: that a stale revision writes nothing, that the legacy job rewrite touches only the
//! jobs it should, and that the audit table is append-only across writes.

mod memory_env;

use gbrain_store::jobs::{
    AdmitSpec, ClientInsert, CredentialBinding, CredentialKind, GrantPersist, RegisterAudit,
};
use memory_env::{Brain, brain};
use serde_json::{Map, Value, json};

fn client(b: &Brain, id: &str) {
    let row: ClientInsert = serde_json::from_value(json!({
        "client_id": id, "client_name": id, "scope": "read", "source_id": "src-a",
        "federated_read": ["src-a"], "grant_revision": 1,
    }))
    .unwrap();
    let audit: RegisterAudit = serde_json::from_value(json!({
        "actor": "test", "after_grant": "{\"revision\":1}",
    }))
    .unwrap();
    b.insert_oauth_client_grant(&row, &audit).unwrap();
}

fn persist(id: &str, expected: i32, revision: i32, extra: Value) -> GrantPersist {
    let mut input = json!({
        "client_id": id, "expected_revision": expected, "scope": "read write", "source_id": "src-a",
        "federated_read": ["src-a", "src-b"], "delegated_namespace": "prefixes", "bound_max_concurrent": 1,
        "grant_revision": revision, "grant_repair_reasons": [],
        "legacy_jobs": {
            "brain_id": null, "federated_read": ["src-a"], "scopes": ["read"], "allowed_operations": null,
            "max_concurrent": 1, "budget_usd_per_day": null,
        },
        "audit": {
            "actor": "test", "action": "rescope", "before_grant": "{\"revision\":1}",
            "after_grant": "{\"revision\":2,\"catalogProvenance\":null}",
        },
    });
    for (k, v) in extra.as_object().unwrap() {
        input[k] = v.clone();
    }
    serde_json::from_value(input).unwrap()
}

fn sources(b: &Brain) {
    for id in ["src-a", "src-b"] {
        b.insert_source(id, id, None, &Map::new()).unwrap();
    }
}

fn add_job(b: &Brain, name: &str, data: Value) -> i64 {
    let spec: AdmitSpec = serde_json::from_value(json!({
        "insert": {
            "name": name, "queue": "default", "status": "waiting", "priority": 0, "data": data,
            "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000, "backoff_jitter": 0.2,
            "on_child_fail": "fail_parent", "remove_on_complete": false, "remove_on_fail": false,
            "submission_authority": {"version": 1, "kind": "application"},
        },
        "maxSpawnDepth": 5,
    }))
    .unwrap();
    b.admit_job(&spec).unwrap().row["id"].as_i64().unwrap()
}

#[test]
fn a_stale_revision_writes_nothing_and_a_current_one_appends_one_audit_row() {
    let b = brain("grant-persist-revision");
    sources(&b);
    client(&b, "c1");
    assert!(
        !b.persist_oauth_client_grant(&persist("c1", 7, 8, json!({})))
            .unwrap()
    );
    assert!(
        !b.persist_oauth_client_grant(&persist("missing", 1, 2, json!({})))
            .unwrap()
    );
    let audit = b.list_oauth_grant_audit("c1").unwrap();
    assert_eq!(audit.as_array().unwrap().len(), 1, "only the register row");
    assert_eq!(
        b.read_oauth_client("c1").unwrap().unwrap()["grant_revision"],
        1
    );

    assert!(
        b.persist_oauth_client_grant(&persist(
            "c1",
            1,
            2,
            json!({ "private_pages": "granted_sources" })
        ))
        .unwrap()
    );
    let row = b.read_oauth_client("c1").unwrap().unwrap();
    assert_eq!(row["grant_revision"], 2);
    assert_eq!(row["scope"], "read write");
    assert_eq!(row["private_pages"], "granted_sources");
    assert_eq!(row["private_facts"], "none");
    let audit = b.list_oauth_grant_audit("c1").unwrap();
    let rows = audit.as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["action"], "register");
    assert_eq!(rows[0]["before_grant"], Value::Null);
    assert_eq!(rows[1]["action"], "rescope");
    assert_eq!(rows[1]["revision"], 2);
}

#[test]
fn the_legacy_rewrite_gives_only_the_clients_open_subagent_jobs_without_a_grant_one() {
    let b = brain("grant-persist-legacy");
    sources(&b);
    client(&b, "c1");
    let mine = add_job(
        &b,
        "subagent",
        json!({ "__owner_client_id": "c1", "source_id": "src-a", "allowed_tools": ["get_page"] }),
    );
    let has = add_job(
        &b,
        "subagent",
        json!({ "__owner_client_id": "c1", "__delegation_grant": { "x": 1 } }),
    );
    let other = add_job(&b, "subagent", json!({ "__owner_client_id": "c2" }));
    let not_subagent = add_job(&b, "sync", json!({ "__owner_client_id": "c1" }));
    assert!(
        b.persist_oauth_client_grant(&persist("c1", 1, 2, json!({})))
            .unwrap()
    );
    let grant = |id: i64| b.get_job(id).unwrap().unwrap()["data"]["__delegation_grant"].clone();
    let g = grant(mine);
    assert_eq!(g["clientId"], "c1");
    assert_eq!(g["sourceId"], "src-a");
    assert_eq!(g["namespace"], "job");
    assert_eq!(g["slugPrefixes"], json!(["wiki/agents/{job_id}/*"]));
    assert_eq!(g["readSources"], json!(["src-a"]));
    assert_eq!(g["scopes"], json!(["read"]));
    assert_eq!(g["tools"], json!(["get_page"]));
    assert_eq!(grant(has), json!({ "x": 1 }));
    assert_eq!(grant(other), Value::Null);
    assert_eq!(grant(not_subagent), Value::Null);
}

#[test]
fn the_latest_catalog_provenance_audit_counts_a_json_null_and_skips_rows_without_the_key() {
    let b = brain("grant-audit-provenance");
    sources(&b);
    client(&b, "c1");
    assert_eq!(b.read_latest_catalog_provenance_audit("c1").unwrap(), None);
    assert!(
        b.persist_oauth_client_grant(&persist("c1", 1, 2, json!({})))
            .unwrap()
    );
    assert_eq!(
        b.read_latest_catalog_provenance_audit("c1").unwrap(),
        Some(json!({ "catalogProvenance": null, "revision": 2 }))
    );
    let mut next = persist("c1", 2, 3, json!({}));
    next.audit.after_grant = "{\"revision\":3}".to_string();
    assert!(b.persist_oauth_client_grant(&next).unwrap());
    assert_eq!(
        b.read_latest_catalog_provenance_audit("c1").unwrap(),
        Some(json!({ "catalogProvenance": null, "revision": 2 })),
        "the newest row with the key, not the newest row"
    );
}

#[test]
fn the_source_config_replaces_whole_and_the_live_client_read_skips_deleted_ones() {
    let b = brain("grant-source-config");
    sources(&b);
    b.replace_source_config("src-a", json!({ "a": 1, "b": 2 }).as_object().unwrap())
        .unwrap();
    assert!(
        b.replace_source_config("src-a", json!({ "c": 3 }).as_object().unwrap())
            .unwrap()
    );
    assert!(!b.replace_source_config("nope", &Map::new()).unwrap());
    let state = b.read_source_grant_state("src-a").unwrap().unwrap();
    assert_eq!(state, json!({ "archived": false, "config": { "c": 3 } }));
    assert_eq!(b.read_source_grant_state("nope").unwrap(), None);
    client(&b, "c1");
    client(&b, "c2");
    assert_eq!(
        b.read_live_oauth_clients()
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn a_client_binding_write_sets_the_binding_columns_and_the_unscoped_time_and_nothing_else() {
    let b = brain("grant-client-binding");
    sources(&b);
    client(&b, "c1");
    let binding: CredentialBinding = serde_json::from_value(json!({
        "member": null, "mayActFor": ["person:a"], "attestActor": "qm",
        "attestOps": ["memory_write"], "attestSources": ["src-a"], "attestRead": "scope",
    }))
    .unwrap();
    let client_kind = CredentialKind::Client;
    b.write_credential_binding(client_kind, "missing", &binding)
        .unwrap();
    assert_eq!(
        b.read_oauth_client("missing").unwrap(),
        None,
        "a missing client is not created"
    );
    b.write_credential_binding(client_kind, "c1", &binding)
        .unwrap();
    let row = b.read_oauth_client("c1").unwrap().unwrap();
    assert_eq!(row["attest_actor"], "qm");
    assert_eq!(row["attest_sources"], json!(["src-a"]));
    assert_eq!(row["attest_read"], "scope");
    assert_eq!(row["may_act_for"], json!(["person:a"]));
    assert_eq!(row["scope"], "read", "the grant columns are untouched");
    assert_eq!(row["grant_revision"], 1);
    assert_eq!(row["reads_unscoped"], Value::Null);

    b.write_credential_reads_unscoped(client_kind, "c1", true)
        .unwrap();
    assert!(
        !b.read_oauth_client("c1").unwrap().unwrap()["reads_unscoped"].is_null(),
        "set to the write's time"
    );
    b.write_credential_reads_unscoped(client_kind, "c1", false)
        .unwrap();
    let row = b.read_oauth_client("c1").unwrap().unwrap();
    assert_eq!(row["reads_unscoped"], Value::Null);
    assert_eq!(row["attest_actor"], "qm", "the binding is untouched");
    b.write_credential_reads_unscoped(client_kind, "missing", true)
        .unwrap();
    assert_eq!(b.read_oauth_client("missing").unwrap(), None);
}
