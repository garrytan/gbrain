//! The whole `oauth_clients` row and the constraints a write to it meets (`insertOauthClient`, `readOauthClient`,
//! `updateOauthClientBudget`). What the parity file cannot see lives here: the stored message of each refusal (the
//! TypeScript member turns it into SQLSTATE 23514 / 23505 / 23503 and the constraint name), that a refused write leaves
//! the table as it was, the POSIX space set the `agent` scope word is read with, and that a budget write re-checks the row.

mod memory_env;

use gbrain_store::jobs::{ClientInsert, ClientPatch, ClientPatchGuard};
use memory_env::{Brain, brain};
use serde_json::{Map, Value, json};

fn insert(b: &Brain, row: Value) -> Result<(), gbrain_store::error::StoreError> {
    let row: ClientInsert = serde_json::from_value(row).unwrap();
    b.insert_oauth_client(&row)
}

fn refused(r: Result<(), gbrain_store::error::StoreError>) -> String {
    let e = r.expect_err("a refusal");
    assert_eq!(e.code, "constraint_violation");
    e.message
}

fn sources(b: &Brain) {
    for id in ["src-a", "src-b"] {
        b.insert_source(id, id, None, &Map::new()).unwrap();
    }
}

/// A complete agent grant in the prefixes namespace.
fn agent(id: &str, extra: Value) -> Value {
    let mut row = json!({
        "client_id": id, "client_name": id, "scope": "read agent", "bound_tools": ["get_page"],
        "source_id": "src-a", "bound_source_id": "src-a", "federated_read": ["src-a", "src-b"],
        "delegated_namespace": "prefixes", "delegated_slug_prefixes": ["wiki/agents/*"], "bound_max_concurrent": 2,
    });
    for (k, v) in extra.as_object().unwrap() {
        row[k] = v.clone();
    }
    row
}

const AGENT_GRANT: &str = "new row for relation \"oauth_clients\" violates check constraint \"oauth_clients_complete_agent_grant\"";

#[test]
fn an_incomplete_agent_grant_is_refused_with_the_constraint_name_and_leaves_no_row() {
    let b = brain("oauth-agent-refused");
    sources(&b);
    let broken = [
        json!({ "bound_tools": null }),
        json!({ "bound_tools": [] }),
        json!({ "source_id": null, "bound_source_id": null }),
        json!({ "bound_source_id": null }),
        json!({ "bound_source_id": "src-b" }),
        json!({ "federated_read": ["src-b"] }),
        json!({ "federated_read": [] }),
        json!({ "delegated_namespace": "job" }),
        json!({ "delegated_slug_prefixes": null }),
        json!({ "delegated_slug_prefixes": [] }),
        json!({ "delegated_namespace": "other", "delegated_slug_prefixes": null }),
        json!({ "bound_max_concurrent": 0 }),
        json!({ "bound_max_concurrent": -1 }),
        json!({ "scope": "agent", "bound_tools": null }),
        json!({ "scope": "read\tagent", "bound_tools": null }),
        json!({ "scope": "agent\nread", "bound_tools": null }),
        json!({ "scope": "a\u{b}agent\u{c}", "bound_tools": null }),
        json!({ "scope": "x\ragent", "bound_tools": null }),
    ];
    for (n, extra) in broken.iter().enumerate() {
        let id = format!("c{n}");
        assert_eq!(
            refused(insert(&b, agent(&id, extra.clone()))),
            AGENT_GRANT,
            "case {n}: {extra}"
        );
        assert!(
            b.read_oauth_client(&id).unwrap().is_none(),
            "case {n} left a row"
        );
    }
}

#[test]
fn a_complete_agent_grant_and_a_scope_that_only_resembles_the_word_are_kept() {
    let b = brain("oauth-agent-kept");
    sources(&b);
    insert(&b, agent("prefixes", json!({}))).unwrap();
    insert(
        &b,
        agent(
            "job",
            json!({ "delegated_namespace": "job", "delegated_slug_prefixes": null }),
        ),
    )
    .unwrap();
    insert(&b, agent("padded", json!({ "scope": " read   agent " }))).unwrap();
    for (id, scope) in [
        ("agents", "agents"),
        ("sub", "subagent read"),
        ("colon", "agent:read"),
        ("inword", "xagent"),
        ("plain", "read write"),
    ] {
        insert(&b, agent(id, json!({ "scope": scope, "bound_tools": null, "source_id": null, "bound_source_id": null, "bound_max_concurrent": 0 }))).unwrap();
    }
    for id in [
        "prefixes", "job", "padded", "agents", "sub", "colon", "inword", "plain",
    ] {
        assert!(b.read_oauth_client(id).unwrap().is_some(), "{id}");
    }
    // The row comes back whole, with the arrays as arrays and the cap as the numeric's text.
    let row = b.read_oauth_client("prefixes").unwrap().unwrap();
    assert_eq!(row["bound_tools"], json!(["get_page"]));
    assert_eq!(row["delegated_slug_prefixes"], json!(["wiki/agents/*"]));
    assert_eq!(row["grant_types"], json!(["client_credentials"]));
    assert_eq!(row["private_pages"], "none");
    assert_eq!(row["grant_revision"], 0);
}

#[test]
fn a_budget_write_re_checks_the_row_it_rewrites() {
    let b = brain("oauth-budget");
    sources(&b);
    insert(&b, agent("a1", json!({}))).unwrap();
    assert!(b.update_oauth_client_budget("a1", Some(2.5)).unwrap());
    assert_eq!(
        b.read_oauth_client("a1").unwrap().unwrap()["budget_usd_per_day"],
        "2.50"
    );
}

#[test]
fn the_other_checks_the_key_and_the_source_are_refused_with_their_own_messages() {
    let b = brain("oauth-other-checks");
    sources(&b);
    insert(&b, json!({ "client_id": "k", "client_name": "k" })).unwrap();
    let cases = [
        (
            json!({ "min_trust": "bogus" }),
            "oauth_clients_min_trust_check",
        ),
        (
            json!({ "private_pages": "all" }),
            "oauth_clients_private_pages_check",
        ),
        (
            json!({ "private_facts": "all" }),
            "oauth_clients_private_facts_check",
        ),
        (
            json!({ "registered_via": "cli" }),
            "oauth_clients_registered_via_check",
        ),
        (
            json!({ "source_grant": "all" }),
            "oauth_clients_source_grant_check",
        ),
    ];
    for (n, (extra, name)) in cases.iter().enumerate() {
        let mut row = json!({ "client_id": format!("x{n}"), "client_name": "x" });
        row[extra.as_object().unwrap().keys().next().unwrap()] =
            extra.as_object().unwrap().values().next().unwrap().clone();
        assert_eq!(
            refused(insert(&b, row)),
            format!("new row for relation \"oauth_clients\" violates check constraint \"{name}\"")
        );
        assert!(b.read_oauth_client(&format!("x{n}")).unwrap().is_none());
    }
    assert_eq!(
        refused(insert(
            &b,
            json!({ "client_id": "k", "client_name": "again" })
        )),
        "duplicate key value violates unique constraint \"oauth_clients_pkey\""
    );
    assert_eq!(
        refused(insert(
            &b,
            json!({ "client_id": "fk", "client_name": "n", "source_id": "nowhere" })
        )),
        "insert or update on table \"oauth_clients\" violates foreign key constraint \"oauth_clients_source_id_fkey\""
    );
    assert!(b.read_oauth_client("fk").unwrap().is_none());
}

fn patch(set: &[&str], v: Value) -> ClientPatch {
    let mut p: ClientPatch = serde_json::from_value(v).unwrap();
    p.set = set.iter().map(|s| s.to_string()).collect();
    p
}

#[test]
fn a_patch_sets_only_the_named_columns_and_reports_the_row_before_and_after() {
    let b = brain("oauth-patch");
    sources(&b);
    insert(&b, agent("a", json!({ "client_secret_hash": "old", "token_ttl": 60, "min_trust": "tool_observed", "surface": "full" }))).unwrap();
    let none = ClientPatchGuard::default();
    // A column named in `set` with no value clears it; a column not named is left alone.
    let out = b
        .patch_oauth_client("a", &patch(&["min_trust"], json!({})), &none)
        .unwrap()
        .unwrap();
    assert_eq!(out["before"]["min_trust"], "tool_observed");
    assert_eq!(out["row"]["min_trust"], Value::Null);
    assert_eq!(out["row"]["client_secret_hash"], "old");
    assert_eq!(out["row"]["token_ttl"], 60);
    // The value in the patch is not applied unless its column is named.
    let out = b
        .patch_oauth_client("a", &patch(&[], json!({ "token_ttl": 5 })), &none)
        .unwrap()
        .unwrap();
    assert_eq!(out["row"]["token_ttl"], 60);
    assert_eq!(b.read_oauth_client("a").unwrap().unwrap()["token_ttl"], 60);
    // A name that is not a patchable column is refused and writes nothing.
    let e = b
        .patch_oauth_client(
            "a",
            &patch(&["scope", "token_ttl"], json!({ "token_ttl": 5 })),
            &none,
        )
        .unwrap_err();
    assert_eq!(e.code, "invalid_argument");
    assert_eq!(b.read_oauth_client("a").unwrap().unwrap()["token_ttl"], 60);
    // No such client.
    assert!(
        b.patch_oauth_client("nope", &patch(&["min_trust"], json!({})), &none)
            .unwrap()
            .is_none()
    );
}

#[test]
fn a_patch_guard_leaves_an_excluded_client_alone_and_a_refused_value_leaves_the_row() {
    let b = brain("oauth-patch-guard");
    sources(&b);
    insert(&b, json!({ "client_id": "pinned", "client_name": "p", "surface_set_by": "operator", "surface": "minimal" })).unwrap();
    insert(&b, json!({ "client_id": "unpinned", "client_name": "u" })).unwrap();
    insert(&b, json!({ "client_id": "gone", "client_name": "g", "deleted_at": "2025-01-01T00:00:00.000Z" })).unwrap();
    let set = patch(
        &["surface", "surface_set_by"],
        json!({ "surface": "full", "surface_set_by": "self" }),
    );
    let unless = ClientPatchGuard {
        unless_surface_set_by: Some("operator".into()),
        ..Default::default()
    };
    assert!(
        b.patch_oauth_client("pinned", &set, &unless)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        b.read_oauth_client("pinned").unwrap().unwrap()["surface"],
        "minimal"
    );
    // A NULL pin is not the operator's.
    assert!(
        b.patch_oauth_client("unpinned", &set, &unless)
            .unwrap()
            .is_some()
    );
    let live = ClientPatchGuard {
        live: true,
        ..Default::default()
    };
    assert!(b.patch_oauth_client("gone", &set, &live).unwrap().is_none());
    assert!(
        b.patch_oauth_client("gone", &set, &ClientPatchGuard::default())
            .unwrap()
            .is_some()
    );
    // A value a CHECK refuses is refused with that check's message, and the row is as it was.
    let bad = patch(&["min_trust"], json!({ "min_trust": "bogus" }));
    let e = b
        .patch_oauth_client("unpinned", &bad, &ClientPatchGuard::default())
        .unwrap_err();
    assert_eq!(e.code, "constraint_violation");
    assert!(
        e.message.contains("oauth_clients_min_trust"),
        "{}",
        e.message
    );
    assert_eq!(
        b.read_oauth_client("unpinned").unwrap().unwrap()["min_trust"],
        Value::Null
    );
}

#[test]
fn a_secret_patch_that_names_the_hash_it_read_writes_only_while_the_hash_is_still_that() {
    let b = brain("oauth-patch-cas");
    insert(
        &b,
        json!({ "client_id": "c", "client_name": "c", "client_secret_hash": "h0" }),
    )
    .unwrap();
    insert(&b, json!({ "client_id": "public", "client_name": "p" })).unwrap();
    fn is(h: &str) -> ClientPatchGuard {
        ClientPatchGuard {
            client_secret_hash_is: Some(h.into()),
            ..Default::default()
        }
    }
    fn set(h: &str) -> ClientPatch {
        patch(&["client_secret_hash"], json!({ "client_secret_hash": h }))
    }
    // A stale read changes nothing; a current read writes and reports the hash it replaced.
    assert!(
        b.patch_oauth_client("c", &set("h9"), &is("old"))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        b.read_oauth_client("c").unwrap().unwrap()["client_secret_hash"],
        "h0"
    );
    let done = b
        .patch_oauth_client("c", &set("h1"), &is("h0"))
        .unwrap()
        .unwrap();
    assert_eq!(done["before"]["client_secret_hash"], "h0");
    assert_eq!(done["row"]["client_secret_hash"], "h1");
    assert!(
        b.patch_oauth_client("c", &set("h2"), &is("h0"))
            .unwrap()
            .is_none()
    );
    // A client with no secret is never equal to a hash.
    assert!(
        b.patch_oauth_client("public", &set("h3"), &is(""))
            .unwrap()
            .is_none()
    );
    assert!(b.read_oauth_client("public").unwrap().unwrap()["client_secret_hash"].is_null());
    // Eight callers that read the same hash at once: one write wins, the rest are told nothing changed.
    let store = &b.store;
    let wins: usize = std::thread::scope(|s| {
        let callers: Vec<_> = (0..8)
            .map(|i| {
                s.spawn(move || {
                    store
                        .patch_oauth_client("c", &set(&format!("w{i}")), &is("h1"))
                        .unwrap()
                        .is_some()
                })
            })
            .collect();
        callers
            .into_iter()
            .map(|h| usize::from(h.join().unwrap()))
            .sum()
    });
    assert_eq!(wins, 1);
}

#[test]
fn the_list_is_every_row_by_name_then_id_in_byte_order() {
    let b = brain("oauth-list");
    assert_eq!(b.list_oauth_clients().unwrap(), json!([]));
    for (id, name) in [
        ("c-beta", "beta"),
        ("z-twin", "twin"),
        ("c-upper", "Zeta"),
        ("y-twin", "twin"),
        ("c-alpha", "alpha"),
    ] {
        insert(&b, json!({ "client_id": id, "client_name": name })).unwrap();
    }
    let ids: Vec<String> = b
        .list_oauth_clients()
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["client_id"].as_str().unwrap().to_string())
        .collect();
    // Upper case sorts first in byte order; equal names fall back to the id.
    assert_eq!(ids, ["c-upper", "c-alpha", "c-beta", "y-twin", "z-twin"]);
    // Each element is the row a read returns.
    assert_eq!(
        b.list_oauth_clients().unwrap()[1],
        b.read_oauth_client("c-alpha").unwrap().unwrap()
    );
}

#[test]
fn a_source_delete_is_refused_while_a_client_names_it_and_clears_a_bound_source_that_names_it() {
    let b = brain("oauth-source-delete");
    sources(&b);
    insert(
        &b,
        json!({ "client_id": "owner", "client_name": "owner", "source_id": "src-a" }),
    )
    .unwrap();
    insert(
        &b,
        json!({ "client_id": "bound", "client_name": "bound", "bound_source_id": "src-b" }),
    )
    .unwrap();

    let e = b
        .delete_source_record("src-a", false)
        .expect_err("a refusal");
    assert_eq!(e.code, "constraint_violation");
    assert_eq!(
        e.message,
        "update or delete on table \"sources\" violates foreign key constraint \"oauth_clients_source_id_fkey\" on table \"oauth_clients\""
    );
    assert!(b.get_source("src-a").unwrap().is_some());
    assert_eq!(
        b.read_oauth_client("owner").unwrap().unwrap()["source_id"],
        json!("src-a")
    );

    assert!(b.delete_source_record("src-b", false).unwrap());
    assert!(b.get_source("src-b").unwrap().is_none());
    assert_eq!(
        b.read_oauth_client("bound").unwrap().unwrap()["bound_source_id"],
        Value::Null
    );
}

#[test]
fn a_client_delete_returns_the_row_once_and_ends_its_liveness_and_a_lifetime_write_finds_only_a_kept_client()
 {
    let b = brain("clients-delete");
    insert(&b, json!({ "client_id": "cl-live", "client_name": "Live" })).unwrap();
    insert(&b, json!({ "client_id": "cl-gone", "client_name": "Gone", "deleted_at": "2027-01-01T00:00:00.000Z" })).unwrap();
    assert!(b.oauth_client_live("cl-live").unwrap());
    assert!(
        !b.oauth_client_live("cl-gone").unwrap(),
        "a soft-deleted client is not live"
    );
    assert!(!b.oauth_client_live("cl-none").unwrap());
    assert!(b.set_oauth_client_token_ttl("cl-live", 3600).unwrap());
    assert_eq!(
        b.read_oauth_client("cl-live").unwrap().unwrap()["token_ttl"],
        3600
    );
    assert!(!b.set_oauth_client_token_ttl("cl-none", 3600).unwrap());
    assert_eq!(
        b.delete_oauth_client("cl-live").unwrap(),
        Some(("cl-live".to_string(), "Live".to_string()))
    );
    assert_eq!(b.delete_oauth_client("cl-live").unwrap(), None);
    assert!(!b.oauth_client_live("cl-live").unwrap());
    assert!(b.read_oauth_client("cl-live").unwrap().is_none());
    assert_eq!(
        b.delete_oauth_client("cl-gone").unwrap().map(|r| r.1),
        Some("Gone".to_string()),
        "the delete is not limited to live clients"
    );
}
