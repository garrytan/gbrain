//! Access members and groups: the writes with their constraints and trigger halves (restrictions
//! flag, serves keys), the member and group reads, the pages-naming read, and the member check of
//! a Wakeshift forget.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::access_members::{AccessMemberInsert, AccessMemberLookup};
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::{Value, json};

fn insert(store: &Store, spec: Value) -> gbrain_store::error::Result<Value> {
    let spec: AccessMemberInsert = serde_json::from_value(spec).unwrap();
    store.insert_access_member(&spec)
}

fn members(store: &Store, lookup: Value) -> Vec<Value> {
    let lookup: AccessMemberLookup = serde_json::from_value(lookup).unwrap();
    store
        .read_access_members(&lookup)
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

fn ids(rows: &[Value]) -> Vec<&str> {
    rows.iter().map(|r| r["id"].as_str().unwrap()).collect()
}

fn config(store: &Store, key: &str) -> Option<String> {
    store.get_config(key).unwrap()
}

fn refusal(result: gbrain_store::error::Result<impl std::fmt::Debug>) -> String {
    let err = result.unwrap_err();
    assert_eq!(err.code, "constraint_violation");
    err.message
}

#[test]
fn insert_creates_missing_groups_marks_the_brain_and_refuses_as_the_constraints_do() {
    let dir = TempDir::new("access-members-insert");
    let store = open(&dir);
    assert_eq!(config(&store, "access.restrictions_present"), None);
    let spec = json!({"id": "alice", "email": "a@example.test", "groups": ["team-b", "team-a"]});
    assert_eq!(
        insert(&store, spec).unwrap(),
        json!({"groupsCreated": ["team-b", "team-a"]})
    );
    let again = json!({"id": "bob", "groups": ["team-a", "team-c"]});
    assert_eq!(
        insert(&store, again).unwrap(),
        json!({"groupsCreated": ["team-c"]})
    );
    assert_eq!(
        config(&store, "access.restrictions_present").as_deref(),
        Some("1")
    );
    let refused = |spec: Value| refusal(insert(&store, spec));
    assert_eq!(
        refused(json!({"id": "alice"})),
        "duplicate key value violates unique constraint \"access_members_pkey\""
    );
    assert_eq!(
        refused(json!({"id": "carol", "email": "a@example.test"})),
        "duplicate key value violates unique constraint \"access_members_email_key\""
    );
    assert_eq!(
        refused(json!({"id": "Carol"})),
        "new row for relation \"access_members\" violates check constraint \"access_members_id_check\""
    );
    assert_eq!(
        refused(json!({"id": "carol", "kind": "robot"})),
        "new row for relation \"access_members\" violates check constraint \"access_members_kind_check\""
    );
    assert_eq!(
        refused(json!({"id": "carol", "groups": ["Team"]})),
        "new row for relation \"access_groups\" violates check constraint \"access_groups_id_check\""
    );
    // A refused insert writes nothing, its member and its groups alike.
    assert_eq!(
        ids(&members(&store, json!({"includeRemoved": true}))),
        ["alice", "bob"]
    );
    let bind = insert(&store, json!({"id": "carol", "bindTokenId": "t-1"})).unwrap_err();
    assert_eq!(bind.code, "invalid_argument");
    let rows = members(&store, json!({"id": "alice"}));
    assert_eq!(rows[0]["groups"], json!(["team-a", "team-b"]));
    assert_eq!(rows[0]["kind"], "person");
    assert_eq!(rows[0]["labelled_only"], false);
}

#[test]
fn member_writes_skip_a_removed_member_and_tombstones_drop_groups() {
    let dir = TempDir::new("access-members-writes");
    let store = open(&dir);
    insert(
        &store,
        json!({"id": "alice", "email": "a@example.test", "groups": ["team-a"]}),
    )
    .unwrap();
    insert(&store, json!({"id": "bob"})).unwrap();
    assert_eq!(
        refusal(store.set_access_member_email("bob", Some("a@example.test"))),
        "duplicate key value violates unique constraint \"access_members_email_key\""
    );
    assert!(
        store
            .set_access_member_email("bob", Some("b@example.test"))
            .unwrap()
    );
    store.set_access_member_kind("bob", "audience").unwrap();
    store.set_access_member_labelled_only("bob", true).unwrap();
    store.set_access_member_disabled("bob", true).unwrap();
    let disabled_at = members(&store, json!({"id": "bob"}))[0]["disabled_at"].clone();
    store.set_access_member_disabled("bob", true).unwrap();
    assert_eq!(
        members(&store, json!({"id": "bob"}))[0]["disabled_at"],
        disabled_at
    );
    store.tombstone_access_member("alice").unwrap();
    let alice = &members(&store, json!({"id": "alice"}))[0];
    assert_eq!(
        (alice["email"].clone(), alice["groups"].clone()),
        (Value::Null, json!([]))
    );
    assert!(alice["tombstoned_at"].is_string() && alice["disabled_at"].is_string());
    assert!(
        !store
            .set_access_member_email("alice", Some("x@example.test"))
            .unwrap()
    );
    store
        .set_access_member_labelled_only("alice", true)
        .unwrap();
    assert_eq!(
        members(&store, json!({"id": "alice"}))[0]["labelled_only"],
        false
    );
    assert_eq!(
        ids(&members(&store, json!({"includeRemoved": false}))),
        ["bob"]
    );
    assert_eq!(
        ids(&members(&store, json!({"email": "a@example.test"}))),
        Vec::<&str>::new()
    );
    assert_eq!(
        members(&store, json!({"id": "bo\u{0}b"})),
        Vec::<Value>::new()
    );
    assert_eq!(
        store.read_access_groups(Some("team-a")).unwrap(),
        json!([{"id": "team-a", "members": []}])
    );
}

#[test]
fn groups_add_drop_and_delete_with_their_members() {
    let dir = TempDir::new("access-members-groups");
    let store = open(&dir);
    insert(&store, json!({"id": "alice"})).unwrap();
    insert(&store, json!({"id": "bob"})).unwrap();
    assert!(
        store
            .add_access_group_members("team-a", &["bob".into(), "alice".into()])
            .unwrap()
    );
    assert!(
        !store
            .add_access_group_members("team-a", &["alice".into()])
            .unwrap()
    );
    assert_eq!(
        refusal(store.add_access_group_members("team-b", &["nobody".into()])),
        "insert or update on table \"access_group_members\" violates foreign key constraint \"access_group_members_member_id_fkey\""
    );
    assert_eq!(
        store.read_access_groups(None).unwrap(),
        json!([{"id": "team-a", "members": ["alice", "bob"]}])
    );
    store
        .remove_access_group_members("team-a", &["bob".into()])
        .unwrap();
    assert_eq!(
        store.read_access_groups(Some("team-a")).unwrap()[0]["members"],
        json!(["alice"])
    );
    assert_eq!(store.read_access_groups(Some("team")).unwrap(), json!([]));
    store.delete_access_group("team-a").unwrap();
    assert_eq!(store.read_access_groups(None).unwrap(), json!([]));
    assert!(store.add_access_group_members("team-a", &[]).unwrap());
    assert_eq!(
        store.read_access_groups(None).unwrap(),
        json!([{"id": "team-a", "members": []}])
    );
}

#[test]
fn serves_keys_follow_the_enabled_members_and_the_explicit_setting() {
    let dir = TempDir::new("access-members-serves");
    let store = open(&dir);
    insert(&store, json!({"id": "alice"})).unwrap();
    assert_eq!(
        (
            config(&store, "access.serves_derived"),
            config(&store, "access.serves_since")
        ),
        (None, None)
    );
    insert(&store, json!({"id": "bob"})).unwrap();
    assert_eq!(
        config(&store, "access.serves_derived").as_deref(),
        Some("several")
    );
    let since = config(&store, "access.serves_since").unwrap();
    assert_eq!((since.len(), &since[19..20], &since[26..]), (27, ".", "Z"));
    store.set_access_member_disabled("bob", true).unwrap();
    assert_eq!(
        config(&store, "access.serves_derived").as_deref(),
        Some("one")
    );
    store.set_access_member_disabled("bob", false).unwrap();
    store.tombstone_access_member("bob").unwrap();
    assert_eq!(
        config(&store, "access.serves_derived").as_deref(),
        Some("one")
    );
    assert_eq!(config(&store, "access.serves_since"), Some(since));

    let explicit = TempDir::new("access-members-serves-explicit");
    let store = open(&explicit);
    store.set_config("access.serves", " One ").unwrap();
    assert_eq!(config(&store, "access.serves_since"), None);
    store.set_config("access.serves", " Several ").unwrap();
    assert!(config(&store, "access.serves_since").is_some());
    assert_eq!(config(&store, "access.serves_derived"), None);
}

#[test]
fn pages_naming_a_reader_list_every_source_in_byte_order_and_live_leaves_deleted_out() {
    let dir = TempDir::new("access-members-pages");
    let store = open(&dir);
    let put = |slug: &str, readers: Value| {
        let input: PageInput = serde_json::from_value(
            json!({"type": "note", "title": slug, "compiled_truth": "body", "frontmatter": {"readable_by": readers}}),
        )
        .unwrap();
        let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
        store.put_page(slug, &input, &opts).unwrap();
    };
    put("notes/b", json!(["group:team-a"]));
    put("notes/a", json!(" GROUP:Team-A "));
    put("notes/gone", json!(["group:team-a", "alice"]));
    put("notes/other", json!(["group:team-b"]));
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    let slugs = |principal: &str, live: bool| -> Vec<String> {
        let rows = store.list_pages_naming_reader(principal, live).unwrap();
        rows.as_array()
            .unwrap()
            .iter()
            .map(|r| r["slug"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(
        slugs("group:team-a", false),
        ["notes/a", "notes/b", "notes/gone"]
    );
    assert_eq!(slugs("group:team-a", true), ["notes/a", "notes/b"]);
    assert_eq!(slugs("member:alice", false), ["notes/gone"]);
    assert_eq!(slugs("alice", false), Vec::<String>::new());
}

#[test]
fn the_write_probe_and_the_wake_forget_read_the_members() {
    let dir = TempDir::new("access-members-probe");
    let store = open(&dir);
    let policy = PrivacyPolicy::default();
    let probe = |store: &Store| {
        store
            .read_write_visibility_probe("default", "notes/x", &policy)
            .unwrap()
            .any_labelled
    };
    insert(&store, json!({"id": "alice"})).unwrap();
    assert!(!probe(&store));
    store
        .set_access_member_labelled_only("alice", true)
        .unwrap();
    store.set_access_member_disabled("alice", true).unwrap();
    assert!(probe(&store));
    let user = "0".repeat(31) + "1";
    store.queue_wake_forget(&user, Some("alice")).unwrap();
    assert_eq!(store.count_pending_wake_forgets().unwrap(), 0);
    store.tombstone_access_member("alice").unwrap();
    store.queue_wake_forget(&user, Some("alice")).unwrap();
    assert_eq!(store.count_pending_wake_forgets().unwrap(), 1);
}
