//! `listClientsReferencingSource`: the clients of one source, soft-deleted ones too, by client id in byte order.

mod memory_env;

use gbrain_store::jobs::ClientInsert;
use memory_env::brain;
use serde_json::{Map, Value, json};

#[test]
fn clients_of_a_source_list_by_byte_of_client_id_with_deleted_rows_tagged() {
    let b = brain("oauth-client-reads");
    for id in ["guest-src", "other-src"] {
        b.insert_source(id, id, None, &Map::new()).unwrap();
    }
    // en_US puts `ab` before `a-z`; bytes put `a-z` (0x2D) first, `a/z` (0x2F) next, then `ab`.
    for (id, source) in [
        ("ab", "guest-src"),
        ("a/z", "guest-src"),
        ("a-z", "guest-src"),
        ("elsewhere", "other-src"),
    ] {
        let row: ClientInsert = serde_json::from_value(
            json!({ "client_id": id, "client_name": format!("name {id}"), "source_id": source }),
        )
        .unwrap();
        b.insert_oauth_client(&row).unwrap();
    }
    let row: ClientInsert = serde_json::from_value(json!({ "client_id": "A-gone", "client_name": "gone", "source_id": "guest-src", "deleted_at": "2026-01-01T00:00:00Z" })).unwrap();
    b.insert_oauth_client(&row).unwrap();

    let listed = b.list_clients_referencing_source("guest-src").unwrap();
    let ids: Vec<&str> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["clientId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["A-gone", "a-z", "a/z", "ab"]);
    assert_eq!(
        listed[0],
        json!({ "clientId": "A-gone", "clientName": "gone", "deleted": true })
    );
    assert_eq!(
        listed[1],
        json!({ "clientId": "a-z", "clientName": "name a-z", "deleted": false })
    );
    assert_eq!(
        b.list_clients_referencing_source("none-src").unwrap(),
        Value::Array(vec![])
    );
}

#[test]
fn owner_credentials_list_clients_by_byte_of_name_then_id_and_leave_out_deleted_rows() {
    let b = brain("owner-credential-reads");
    // en_US puts `ab` before `a-z`: bytes put `a-z` first, `a/z` next, then `ab`.
    for (id, name, member, deleted) in [
        ("c1", "ab", "owner-example", None),
        ("c2", "a-z", "owner-example", None),
        ("same-b", "same", "owner-example", None),
        ("same-a", "same", "owner-example", None),
        ("c3", "a/z", "owner-example", None),
        ("gone", "a", "owner-example", Some("2026-01-01T00:00:00Z")),
        ("theirs", "a", "someone-else", None),
    ] {
        let row: ClientInsert = serde_json::from_value(json!({
            "client_id": id, "client_name": name, "member_id": member, "deleted_at": deleted,
        }))
        .unwrap();
        b.insert_oauth_client(&row).unwrap();
    }
    let listed = b.read_owner_credentials("owner-example").unwrap();
    let names: Vec<(&str, &str)> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["name"].as_str().unwrap(), c["id"].as_str().unwrap()))
        .collect();
    assert_eq!(
        names,
        [
            ("a-z", "c2"),
            ("a/z", "c3"),
            ("ab", "c1"),
            ("same", "same-a"),
            ("same", "same-b")
        ]
    );
    assert_eq!(listed[0]["kind"], "client");
    // The whole row less the secret hash, as `to_jsonb(c) - 'client_secret_hash'`.
    assert!(listed[0]["row"].get("client_secret_hash").is_none());
    assert_eq!(listed[0]["row"]["member_id"], "owner-example");
    assert_eq!(listed[0]["row"]["client_id"], "c2");
    assert_eq!(
        b.read_owner_credentials("nobody").unwrap(),
        Value::Array(vec![])
    );
}
