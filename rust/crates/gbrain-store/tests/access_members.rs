//! Access members and groups (`access_members.rs`): each write family against the Postgres
//! behavior it mirrors, including the trigger effects that run in the same write.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::access_members::{AccessMemberInsert, AccessMemberLookup};
use serde_json::{Value, json};

fn add(store: &Store, id: &str, email: Option<&str>, groups: &[&str]) -> Value {
    let spec: AccessMemberInsert = serde_json::from_value(json!({
        "id": id, "email": email, "groups": groups,
    }))
    .unwrap();
    store.insert_access_member(&spec).unwrap()
}

fn rows(store: &Store, include_removed: bool) -> Vec<Value> {
    let lookup = AccessMemberLookup {
        id: None,
        email: None,
        include_removed,
    };
    store
        .read_access_members(&lookup)
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

fn one(store: &Store, id: &str) -> Value {
    let lookup = AccessMemberLookup {
        id: Some(id.into()),
        email: None,
        include_removed: false,
    };
    store.read_access_members(&lookup).unwrap()[0].clone()
}

#[test]
fn a_member_insert_sets_the_restriction_flag_and_creates_its_groups() {
    let dir = TempDir::new("access-members");
    let store = open(&dir);
    assert_eq!(
        store.get_config("access.restrictions_present").unwrap(),
        None
    );
    let out = add(
        &store,
        "alice-example",
        Some("a@example.com"),
        &["team-a", "team-b"],
    );
    assert_eq!(out, json!({"groupsCreated": ["team-a", "team-b"]}));
    assert_eq!(
        store
            .get_config("access.restrictions_present")
            .unwrap()
            .as_deref(),
        Some("1")
    );
    let out = add(&store, "bob-example", None, &["team-b", "team-c"]);
    assert_eq!(out, json!({"groupsCreated": ["team-c"]}));
    let alice = one(&store, "alice-example");
    assert_eq!(alice["kind"], "person");
    assert_eq!(alice["email"], "a@example.com");
    assert_eq!(alice["groups"], json!(["team-a", "team-b"]));
    assert!(alice["created_at"].is_string());
    assert!(alice["disabled_at"].is_null());
}

#[test]
fn the_insert_refuses_a_bad_id_a_bad_kind_a_duplicate_and_a_taken_email() {
    let dir = TempDir::new("access-members");
    let store = open(&dir);
    add(&store, "alice-example", Some("a@example.com"), &[]);
    let bad = |spec: Value| {
        let spec: AccessMemberInsert = serde_json::from_value(spec).unwrap();
        let err = store.insert_access_member(&spec).unwrap_err();
        assert_eq!(err.code, "constraint_violation");
        err.message
    };
    assert!(bad(json!({"id": "Alice"})).contains("access_members_id_check"));
    assert!(bad(json!({"id": "carol", "kind": "robot"})).contains("access_members_kind_check"));
    assert!(bad(json!({"id": "alice-example"})).contains("access_members_pkey"));
    assert!(
        bad(json!({"id": "carol", "email": "a@example.com"})).contains("access_members_email_key")
    );
    assert!(
        bad(json!({"id": "carol", "groups": ["Bad Group"]})).contains("access_groups_id_check")
    );
    // A refused insert leaves nothing behind.
    assert_eq!(rows(&store, true).len(), 1);
    assert_eq!(
        store
            .read_access_member_id_by_email("a@example.com")
            .unwrap()
            .as_deref(),
        Some("alice-example")
    );
}

#[test]
fn two_enabled_members_derive_several_and_set_serves_since_once() {
    let dir = TempDir::new("access-members");
    let store = open(&dir);
    add(&store, "alice-example", None, &[]);
    assert_eq!(store.get_config("access.serves_derived").unwrap(), None);
    add(&store, "bob-example", None, &[]);
    assert_eq!(
        store
            .get_config("access.serves_derived")
            .unwrap()
            .as_deref(),
        Some("several")
    );
    let since = store.get_config("access.serves_since").unwrap().unwrap();
    assert_eq!(since.len(), 20);
    assert!(since.ends_with('Z'));
    assert_eq!(
        store.list_active_access_members().unwrap(),
        vec!["alice-example", "bob-example"]
    );
    store
        .set_access_member_disabled("bob-example", true)
        .unwrap();
    assert_eq!(
        store
            .get_config("access.serves_derived")
            .unwrap()
            .as_deref(),
        Some("one")
    );
    assert_eq!(
        store.get_config("access.serves_since").unwrap().as_deref(),
        Some(since.as_str())
    );
    assert_eq!(
        store.list_active_access_members().unwrap(),
        vec!["alice-example"]
    );
    let first = one(&store, "bob-example")["disabled_at"].clone();
    store
        .set_access_member_disabled("bob-example", true)
        .unwrap();
    assert_eq!(one(&store, "bob-example")["disabled_at"], first);
    store
        .set_access_member_disabled("bob-example", false)
        .unwrap();
    assert!(one(&store, "bob-example")["disabled_at"].is_null());
    assert_eq!(
        store
            .get_config("access.serves_derived")
            .unwrap()
            .as_deref(),
        Some("several")
    );
}

#[test]
fn email_and_kind_writes_skip_removed_members_and_keep_email_unique() {
    let dir = TempDir::new("access-members");
    let store = open(&dir);
    add(&store, "alice-example", Some("a@example.com"), &[]);
    add(&store, "bob-example", None, &[]);
    assert!(
        store
            .set_access_member_email("alice-example", Some("a@example.com"))
            .unwrap()
    );
    let err = store
        .set_access_member_email("bob-example", Some("a@example.com"))
        .unwrap_err();
    assert!(err.message.contains("access_members_email_key"));
    assert!(
        store
            .set_access_member_email("bob-example", Some("b@example.com"))
            .unwrap()
    );
    assert!(
        store
            .set_access_member_email("alice-example", None)
            .unwrap()
    );
    assert!(one(&store, "alice-example")["email"].is_null());
    assert!(
        !store
            .set_access_member_email("nobody", Some("n@example.com"))
            .unwrap()
    );
    store
        .set_access_member_kind("bob-example", "audience")
        .unwrap();
    assert_eq!(one(&store, "bob-example")["kind"], "audience");
    assert!(
        store
            .set_access_member_kind("bob-example", "robot")
            .is_err()
    );
    store.tombstone_access_member("bob-example").unwrap();
    assert!(
        !store
            .set_access_member_email("bob-example", Some("c@example.com"))
            .unwrap()
    );
    store
        .set_access_member_kind("bob-example", "person")
        .unwrap();
    assert_eq!(one(&store, "bob-example")["kind"], "audience");
}

#[test]
fn a_tombstone_clears_email_and_groups_and_hides_the_member() {
    let dir = TempDir::new("access-members");
    let store = open(&dir);
    add(&store, "alice-example", Some("a@example.com"), &["team-a"]);
    add(&store, "bob-example", None, &["team-a"]);
    store.tombstone_access_member("alice-example").unwrap();
    assert_eq!(rows(&store, false).len(), 1);
    let gone = one(&store, "alice-example");
    assert!(gone["tombstoned_at"].is_string());
    assert!(gone["disabled_at"].is_string());
    assert!(gone["email"].is_null());
    assert_eq!(gone["groups"], json!([]));
    assert_eq!(
        store
            .read_access_member_id_by_email("a@example.com")
            .unwrap(),
        None
    );
    assert_eq!(
        store
            .get_config("access.serves_derived")
            .unwrap()
            .as_deref(),
        Some("one")
    );
    // The email is free again.
    add(&store, "carol-example", Some("a@example.com"), &[]);
}

#[test]
fn group_writes_add_remove_and_cascade() {
    let dir = TempDir::new("access-members");
    let store = open(&dir);
    add(&store, "alice-example", None, &[]);
    add(&store, "bob-example", None, &[]);
    let both = vec!["alice-example".to_string(), "bob-example".to_string()];
    assert!(store.add_access_group_members("team-a", &both).unwrap());
    assert!(!store.add_access_group_members("team-a", &both).unwrap());
    let err = store
        .add_access_group_members("team-a", &["nobody".into()])
        .unwrap_err();
    assert!(err.message.contains("access_group_members_member_id_fkey"));
    store
        .remove_access_group_members("team-a", &["alice-example".into()])
        .unwrap();
    assert_eq!(one(&store, "alice-example")["groups"], json!([]));
    assert_eq!(one(&store, "bob-example")["groups"], json!(["team-a"]));
    store.delete_access_group("team-a").unwrap();
    assert_eq!(one(&store, "bob-example")["groups"], json!([]));
    // The group is gone, so adding to it creates it again.
    assert!(store.add_access_group_members("team-a", &[]).unwrap());
}

#[test]
fn group_ids_name_the_groups_that_exist_once_each_in_byte_order() {
    let dir = TempDir::new("access-members");
    let store = open(&dir);
    add(&store, "alice-example", None, &["team-b", "team-a"]);
    let ask = |ids: &[&str]| {
        let ids: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
        store.read_access_group_ids(&ids).unwrap()
    };
    // A member id is not a group, a missing group is not named, and a repeated id is named once.
    assert_eq!(
        ask(&["team-b", "alice-example", "team-z", "team-a", "team-b"]),
        ["team-a", "team-b"]
    );
    assert!(ask(&[]).is_empty());
    store.delete_access_group("team-a").unwrap();
    assert_eq!(ask(&["team-a", "team-b"]), ["team-b"]);
}
