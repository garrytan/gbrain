//! The Git sync hold retry request. The three-arm case is in test/engine-parity/git-holds.test.ts;
//! this pins the union in byte order and the stamp of the latest request.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::sources::SourceInput;
use serde_json::{Map, Value, json};

fn source(store: &Store, id: &str, config: Value) -> String {
    let config: Map<String, Value> = serde_json::from_value(config).unwrap();
    store
        .upsert_source(&SourceInput {
            id: id.to_owned(),
            name: None,
            local_path: None,
            last_sync_at: None,
            config: Some(config),
        })
        .unwrap()
        .incarnation
}

#[test]
fn retry_paths_union_in_byte_order() {
    let dir = TempDir::new("git-holds-retry");
    let store = open(&dir);
    let inc = source(&store, "s", json!({}));
    let paths = |list: &[&str]| list.iter().map(|p| (*p).to_owned()).collect::<Vec<_>>();
    store
        .request_git_hold_retry("s", &inc, &paths(&["b.md", "B.md", "b.md"]), "t1")
        .unwrap();
    store
        .request_git_hold_retry("s", &inc, &paths(&["a.md", "b.md"]), "t2")
        .unwrap();
    let record = store
        .read_op_checkpoint_record("sync-hold-retry", &format!("s:{inc}"), None)
        .unwrap()["completed_keys"][0]
        .clone();
    assert_eq!(record["paths"], json!(["B.md", "a.md", "b.md"]));
    assert_eq!(record["requested_at"], json!("t2"));
    assert_eq!(record["version"], json!(1));
}
