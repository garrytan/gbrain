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

/// The id of the member (any status) whose row declares `email`, read through `readAccessMembers`.
fn email_owner(store: &Store, email: &str) -> Option<String> {
    rows(store, true)
        .iter()
        .find(|r| r["email"].as_str() == Some(email))
        .map(|r| r["id"].as_str().unwrap().to_owned())
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
        email_owner(&store, "a@example.com").as_deref(),
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
    assert_eq!(since.len(), 27);
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
fn the_labelled_only_write_skips_removed_members_and_leaves_the_serves_keys() {
    let dir = TempDir::new("access-members");
    let store = open(&dir);
    add(&store, "alice-example", None, &[]);
    add(&store, "bob-example", None, &[]);
    let serves = store.get_config("access.serves_since").unwrap();
    store
        .set_access_member_labelled_only("alice-example", true)
        .unwrap();
    let after = one(&store, "alice-example");
    assert_eq!(after["labelled_only"], json!(true));
    assert_eq!(one(&store, "bob-example")["labelled_only"], json!(false));
    assert_eq!(store.get_config("access.serves_since").unwrap(), serves);
    store
        .set_access_member_labelled_only("alice-example", false)
        .unwrap();
    assert_eq!(one(&store, "alice-example")["labelled_only"], json!(false));
    store.tombstone_access_member("bob-example").unwrap();
    store
        .set_access_member_labelled_only("bob-example", true)
        .unwrap();
    let removed = rows(&store, true);
    let bob = removed.iter().find(|r| r["id"] == "bob-example").unwrap();
    assert_eq!(bob["labelled_only"], json!(false));
    store
        .set_access_member_labelled_only("nobody", true)
        .unwrap();
    assert_eq!(rows(&store, true).len(), 2);
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
    assert_eq!(email_owner(&store, "a@example.com"), None);
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
    // An emptied group still exists for readAccessGroupIds; an unknown id does not.
    store
        .remove_access_group_members("team-a", &["bob-example".into()])
        .unwrap();
    let asked = vec![
        "zz-none".to_string(),
        "team-a".to_string(),
        "team-a".to_string(),
    ];
    assert_eq!(
        store.read_access_group_ids(&asked).unwrap(),
        vec!["team-a".to_string()]
    );
    store.delete_access_group("team-a").unwrap();
    assert_eq!(one(&store, "bob-example")["groups"], json!([]));
    assert!(store.read_access_group_ids(&asked).unwrap().is_empty());
    // The group is gone, so adding to it creates it again.
    assert!(store.add_access_group_members("team-a", &[]).unwrap());
}

#[test]
fn read_access_groups_lists_each_group_with_its_members_in_byte_order() {
    let dir = TempDir::new("access-members");
    let store = open(&dir);
    assert_eq!(store.read_access_groups(None).unwrap(), json!([]));
    add(&store, "bob-example", None, &["team-b", "team-a"]);
    add(&store, "alice-example", None, &["team-b"]);
    store.add_access_group_members("Z-empty", &[]).unwrap_err();
    store.add_access_group_members("empty-team", &[]).unwrap();
    assert_eq!(
        store.read_access_groups(None).unwrap(),
        json!([
            { "id": "empty-team", "members": [] },
            { "id": "team-a", "members": ["bob-example"] },
            { "id": "team-b", "members": ["alice-example", "bob-example"] },
        ])
    );
    assert_eq!(
        store.read_access_groups(Some("team-b")).unwrap(),
        json!([{ "id": "team-b", "members": ["alice-example", "bob-example"] }])
    );
    // Exactly the id: a member id, another case or a prefix names no group.
    for id in ["bob-example", "TEAM-A", "team", "team-a\0"] {
        assert_eq!(store.read_access_groups(Some(id)).unwrap(), json!([]));
    }
    // A removed member leaves its groups; a deleted group leaves the list.
    store.tombstone_access_member("bob-example").unwrap();
    store.delete_access_group("team-a").unwrap();
    assert_eq!(
        store.read_access_groups(None).unwrap(),
        json!([
            { "id": "empty-team", "members": [] },
            { "id": "team-b", "members": ["alice-example"] },
        ])
    );
}
