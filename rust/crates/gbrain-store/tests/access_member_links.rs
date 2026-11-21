//! Member links (`access_member_links.rs`): the `access_member_links` rows of v286, against the
//! Postgres constraints they mirror.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::access_members::AccessMemberInsert;
use serde_json::{Value, json};

fn add(store: &Store, id: &str) {
    let spec: AccessMemberInsert = serde_json::from_value(json!({ "id": id })).unwrap();
    store.insert_access_member(&spec).unwrap();
}

fn refusal(store: &Store, system: &str, external_id: &str, member: &str) -> String {
    let err = store
        .insert_access_member_link(system, external_id, member)
        .unwrap_err();
    assert_eq!(err.code, "constraint_violation");
    err.message
}

fn ids(rows: &Value) -> Vec<(String, String)> {
    rows.as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["member_id"].as_str().unwrap().to_owned(),
                r["external_id"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[test]
fn a_link_is_read_exactly_listed_by_member_and_removed_once() {
    let dir = TempDir::new("member-links");
    let store = open(&dir);
    add(&store, "bob-example");
    add(&store, "alice-example");
    assert_eq!(store.read_access_member_link("qm", "U1").unwrap(), None);
    store
        .insert_access_member_link("qm", "U2", "bob-example")
        .unwrap();
    store
        .insert_access_member_link("qm", "U1", "bob-example")
        .unwrap();
    store
        .insert_access_member_link("qm", "oidc:3f2a:alice", "alice-example")
        .unwrap();
    let link = store.read_access_member_link("qm", "U1").unwrap().unwrap();
    assert_eq!(link["system"], "qm");
    assert_eq!(link["external_id"], "U1");
    assert_eq!(link["member_id"], "bob-example");
    assert!(link["created_at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        store.read_access_member_link("qm", "u1").unwrap(),
        None,
        "the id is matched exactly"
    );
    assert_eq!(store.read_access_member_link("other", "U1").unwrap(), None);
    let all = store.list_access_member_links(None).unwrap();
    assert_eq!(
        ids(&all),
        [
            ("alice-example", "oidc:3f2a:alice"),
            ("bob-example", "U1"),
            ("bob-example", "U2")
        ]
        .map(|(m, e)| (m.to_owned(), e.to_owned()))
    );
    let bob = store.list_access_member_links(Some("bob-example")).unwrap();
    assert_eq!(ids(&bob).len(), 2);
    assert_eq!(
        store.list_access_member_links(Some("bob")).unwrap(),
        json!([])
    );
    store.delete_access_member_link("qm", "U1").unwrap();
    store.delete_access_member_link("qm", "U1").unwrap();
    assert_eq!(store.read_access_member_link("qm", "U1").unwrap(), None);
    assert_eq!(
        ids(&store.list_access_member_links(Some("bob-example")).unwrap()).len(),
        1
    );
}

#[test]
fn a_repeated_link_a_bad_value_and_a_missing_member_are_refused_and_write_nothing() {
    let dir = TempDir::new("member-links-refused");
    let store = open(&dir);
    add(&store, "alice-example");
    store
        .insert_access_member_link("qm", "U1", "alice-example")
        .unwrap();
    assert!(refusal(&store, "qm", "U1", "alice-example").contains("access_member_links_pkey"));
    assert!(
        refusal(&store, "QM", "U2", "alice-example").contains("access_member_links_system_check")
    );
    assert!(
        refusal(&store, "qm", "has space", "alice-example")
            .contains("access_member_links_external_id_check")
    );
    assert!(
        refusal(&store, "qm", "", "alice-example")
            .contains("access_member_links_external_id_check")
    );
    assert!(
        refusal(&store, "qm", &"a".repeat(257), "alice-example")
            .contains("access_member_links_external_id_check")
    );
    assert!(refusal(&store, "qm", "U3", "nobody").contains("access_member_links_member_id_fkey"));
    store
        .insert_access_member_link("qm", &"a".repeat(256), "alice-example")
        .unwrap();
    assert_eq!(ids(&store.list_access_member_links(None).unwrap()).len(), 2);
}

#[test]
fn a_removed_member_keeps_its_links_as_postgres_does() {
    let dir = TempDir::new("member-links-tombstone");
    let store = open(&dir);
    add(&store, "alice-example");
    store
        .insert_access_member_link("qm", "U1", "alice-example")
        .unwrap();
    store.tombstone_access_member("alice-example").unwrap();
    assert!(store.read_access_member_link("qm", "U1").unwrap().is_some());
}

#[test]
fn a_linked_member_reads_with_its_groups_only_while_enabled() {
    let dir = TempDir::new("member-links-linked");
    let store = open(&dir);
    let spec: AccessMemberInsert =
        serde_json::from_value(json!({ "id": "alice-example", "groups": ["team-b", "team-a"] }))
            .unwrap();
    store.insert_access_member(&spec).unwrap();
    add(&store, "bob-example");
    store
        .insert_access_member_link("qm", "person-1", "alice-example")
        .unwrap();
    store
        .insert_access_member_link("qm", "person-2", "bob-example")
        .unwrap();
    assert_eq!(
        store.read_linked_member("qm", "person-1").unwrap(),
        Some(json!({ "id": "alice-example", "groups": ["team-a", "team-b"] }))
    );
    assert_eq!(
        store.read_linked_member("qm", "person-2").unwrap(),
        Some(json!({ "id": "bob-example", "groups": [] }))
    );
    // Matched exactly: another system, another case or no link reads nothing.
    assert_eq!(store.read_linked_member("other", "person-1").unwrap(), None);
    assert_eq!(store.read_linked_member("qm", "PERSON-1").unwrap(), None);
    assert_eq!(store.read_linked_member("qm", "person-3").unwrap(), None);
    // A disabled member reads nothing until it is enabled; a removed member reads nothing.
    store
        .set_access_member_disabled("alice-example", true)
        .unwrap();
    assert_eq!(store.read_linked_member("qm", "person-1").unwrap(), None);
    store
        .set_access_member_disabled("alice-example", false)
        .unwrap();
    assert!(
        store
            .read_linked_member("qm", "person-1")
            .unwrap()
            .is_some()
    );
    store.tombstone_access_member("bob-example").unwrap();
    assert_eq!(store.read_linked_member("qm", "person-2").unwrap(), None);
}
