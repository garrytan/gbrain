//! The managed-sync orphan reads: `listOpCheckpointRecords` and `listSourceRequestRows`
//! (rust/docs/store/repair-bookkeeping.md, "Managed-sync orphans").

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::persistence::WriteRequestInsert;
use serde_json::{Value, json};

const REQ_1: &str = "c0000000-0000-4000-8000-0000000000c1";
const REQ_2: &str = "c0000000-0000-4000-8000-0000000000c2";

fn incarnation(store: &Store) -> String {
    store.read_source_membership("default").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string()
}

fn request(store: &Store, request: &str, intent: Value) {
    let insert: WriteRequestInsert = serde_json::from_value(json!({
        "principalKind": "local_cli", "principalId": "parity-writer", "requestId": request,
        "operation": "put_page", "sourceId": "default", "sourceIncarnation": incarnation(store),
        "pageId": null, "slug": "a", "worktreeId": null, "topologyGeneration": null,
        "digest": "digest", "intent": intent, "authority": {}, "intentBytes": 10,
        "terminalReservation": 4096, "targetKind": "page", "protocolVersion": 1,
        "admitterVersion": "v-test", "admitterHostId": null,
        "counterKeys": ["principal:local_cli:parity-writer", "brain"], "clientRequestId": null,
        "state": "queued", "deferredRefreshId": null,
    }))
    .unwrap();
    store.insert_write_request(&insert).unwrap();
}

#[test]
fn op_checkpoint_listing_returns_one_ops_rows_in_fingerprint_order() {
    let dir = TempDir::new("sync-orphan-reads");
    let store = open(&dir);
    let keys = json!([{ "sourceId": "default", "done": false }]);
    store
        .write_op_checkpoint_record("managed-sync", "cursor-b", Some(&keys))
        .unwrap();
    store
        .write_op_checkpoint_record("managed-sync", "cursor-a", Some(&keys))
        .unwrap();
    store
        .write_op_checkpoint_record("managed-sync-pass", "default:x", Some(&keys))
        .unwrap();

    let rows = store.list_op_checkpoint_records("managed-sync").unwrap();
    let rows = rows.as_array().unwrap();
    let names: Vec<&str> = rows
        .iter()
        .map(|r| r["fingerprint"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["cursor-a", "cursor-b"]);
    assert_eq!(rows[0]["completed_keys"], keys);
    let stamp = rows[0]["updated_at"].as_str().unwrap();
    assert!(stamp.ends_with('Z') && stamp.len() == 24, "{stamp}");
    assert!(rows[0]["updated_at_us"].as_i64().unwrap() > 0);

    // An op is matched whole: `managed-sync` does not list `managed-sync-pass`.
    assert_eq!(
        store
            .list_op_checkpoint_records("managed-sync-pass")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store.list_op_checkpoint_records("managed").unwrap(),
        json!([])
    );
}

#[test]
fn source_request_rows_list_the_sources_requests_in_sequence_order() {
    let dir = TempDir::new("sync-orphan-reads");
    let store = open(&dir);
    request(
        &store,
        REQ_2,
        json!({ "kind": "managed_sync_checkpoint", "cursorKey": "cursor-a" }),
    );
    request(&store, REQ_1, json!({ "kind": "put_page" }));

    let rows = store.list_source_request_rows("default").unwrap();
    let rows = rows.as_array().unwrap();
    let ids: Vec<&str> = rows
        .iter()
        .map(|r| r["request_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [REQ_2, REQ_1]);
    let first = &rows[0];
    assert_eq!(first["state"], "queued");
    assert_eq!(first["recovery"], false);
    assert_eq!(first["error_code"], Value::Null);
    assert_eq!(first["intent"]["cursorKey"], "cursor-a");
    assert_eq!(first["principal_kind"], "local_cli");
    assert_eq!(first["principal_id"], "parity-writer");
    assert_eq!(first["source_incarnation"], incarnation(&store));
    assert!(first["sequence"].as_u64().unwrap() < rows[1]["sequence"].as_u64().unwrap());

    assert_eq!(store.list_source_request_rows("other").unwrap(), json!([]));
}
