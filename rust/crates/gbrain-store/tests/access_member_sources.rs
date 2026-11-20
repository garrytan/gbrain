//! Personal sources (`access_member_sources.rs`): the `access_member_sources` rows of v299, against
//! the Postgres constraint they mirror and the byte order PGLite sorts in.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::access_members::AccessMemberInsert;
use serde_json::{Value, json};

fn add(store: &Store, id: &str) {
    let spec: AccessMemberInsert = serde_json::from_value(json!({ "id": id })).unwrap();
    store.insert_access_member(&spec).unwrap();
}

fn pairs(rows: &Value) -> Vec<(String, String)> {
    rows.as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["member_id"].as_str().unwrap().to_owned(),
                r["source_id"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[test]
fn a_binding_is_read_listed_in_byte_order_and_removed_once() {
    let dir = TempDir::new("member-sources");
    let store = open(&dir);
    for m in ["ab", "a_b", "a-z", "a.b"] {
        add(&store, m);
    }
    for (m, s) in [
        ("ab", "dm-b"),
        ("a_b", "ab"),
        ("a-z", "a-z"),
        ("a.b", "ab"),
        ("ab", "a-z"),
    ] {
        store.insert_access_member_source(m, s).unwrap();
    }
    // A second bind of the same pair changes nothing (`ON CONFLICT DO NOTHING`).
    let first = store
        .read_access_member_source("ab", "dm-b")
        .unwrap()
        .unwrap();
    store.insert_access_member_source("ab", "dm-b").unwrap();
    assert_eq!(
        store
            .read_access_member_source("ab", "dm-b")
            .unwrap()
            .unwrap(),
        first
    );
    assert!(first["created_at"].as_str().unwrap().ends_with('Z'));

    let all = pairs(&store.list_access_member_sources(None).unwrap());
    let want: Vec<(String, String)> = [
        ("a-z", "a-z"),
        ("a.b", "ab"),
        ("a_b", "ab"),
        ("ab", "a-z"),
        ("ab", "dm-b"),
    ]
    .iter()
    .map(|(m, s)| ((*m).to_owned(), (*s).to_owned()))
    .collect();
    assert_eq!(all, want);
    assert_eq!(
        pairs(&store.list_access_member_sources(Some("ab")).unwrap()),
        vec![
            ("ab".to_owned(), "a-z".to_owned()),
            ("ab".to_owned(), "dm-b".to_owned())
        ]
    );
    assert_eq!(
        store.list_access_member_source_owners("ab").unwrap(),
        vec!["a.b", "a_b"]
    );
    assert!(
        store
            .list_access_member_source_owners("nobody")
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .read_member_source_bindings(&["ab".to_owned(), "a-z".to_owned(), "none".to_owned()])
            .unwrap(),
        json!([
            { "source_id": "a-z", "member_id": "a-z" }, { "source_id": "a-z", "member_id": "ab" },
            { "source_id": "ab", "member_id": "a.b" }, { "source_id": "ab", "member_id": "a_b" },
        ])
    );

    store.delete_access_member_source("ab", "dm-b").unwrap();
    store.delete_access_member_source("ab", "dm-b").unwrap();
    assert!(
        store
            .read_access_member_source("ab", "dm-b")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .list_access_member_sources(Some("ab"))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn a_binding_to_an_unknown_member_is_refused_by_the_member_reference() {
    let dir = TempDir::new("member-sources-fkey");
    let store = open(&dir);
    let err = store
        .insert_access_member_source("ghost", "dm-ghost")
        .unwrap_err();
    assert_eq!(err.code, "constraint_violation");
    assert!(
        err.message.contains("access_member_sources_member_id_fkey"),
        "{}",
        err.message
    );
    assert!(
        store
            .list_access_member_sources(None)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    // A source id is not checked against the sources (no foreign key, as on Postgres); a NUL is refused by name.
    add(&store, "alice-example");
    store
        .insert_access_member_source("alice-example", "not-a-source-yet")
        .unwrap();
    let nul = store
        .insert_access_member_source("alice-example", "a\0b")
        .unwrap_err();
    assert_eq!(nul.code, "constraint_violation");
    assert!(
        nul.message.contains("access_member_sources.source_id"),
        "{}",
        nul.message
    );
}
