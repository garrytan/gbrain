//! Git sync hold writes and reads. The three-arm cases are in test/engine-parity/git-holds.test.ts;
//! these pin the compare-and-set misses, the summary clamp at zero, numeric-text counters and NUL.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::persistence::GitHoldSummaryDelta;
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

fn delta(value: Value) -> GitHoldSummaryDelta {
    serde_json::from_value(value).unwrap()
}

fn summary(store: &Store, inc: &str) -> Value {
    store
        .read_op_checkpoint_record("sync-hold-summary", &format!("s:{inc}"), None)
        .unwrap()["completed_keys"][0]
        .clone()
}

#[test]
fn swap_inserts_updates_and_clears_with_counters() {
    let dir = TempDir::new("git-holds-swap");
    let store = open(&dir);
    let inc = source(&store, "s", json!({}));
    let first = json!([{"source_id": "s", "incarnation": inc, "path": "a.md", "n": 1}]);
    let second = json!([{"source_id": "s", "incarnation": inc, "path": "a.md", "n": 2}]);
    let insert = delta(json!({"count": 1, "stale": 1}));
    assert!(
        store
            .swap_git_hold("s", &inc, "a.md", None, Some(&first), Some(&insert))
            .unwrap()
    );
    assert_eq!(summary(&store, &inc)["count"], json!(1));
    assert_eq!(summary(&store, &inc)["stale"], json!(1));
    assert_eq!(summary(&store, &inc)["drift"], json!(0));
    // A second insert misses: the row exists.
    assert!(
        !store
            .swap_git_hold("s", &inc, "a.md", None, Some(&first), Some(&insert))
            .unwrap()
    );
    assert_eq!(summary(&store, &inc)["count"], json!(1));
    // An update over a record the row no longer holds misses.
    assert!(
        !store
            .swap_git_hold("s", &inc, "a.md", Some(&second), Some(&first), None)
            .unwrap()
    );
    assert!(
        store
            .swap_git_hold("s", &inc, "a.md", Some(&first), Some(&second), None)
            .unwrap()
    );
    let read = store
        .read_git_hold_record("s", &inc, "a.md")
        .unwrap()
        .unwrap();
    assert_eq!(read.record["n"], json!(2));
    assert!(!read.mirror_read_only);
    // A clear below zero clamps.
    let clear = delta(json!({"count": -1, "stale": -3}));
    assert!(
        store
            .swap_git_hold("s", &inc, "a.md", Some(&second), None, Some(&clear))
            .unwrap()
    );
    assert_eq!(summary(&store, &inc)["count"], json!(0));
    assert_eq!(summary(&store, &inc)["stale"], json!(0));
    assert!(
        store
            .read_git_hold_record("s", &inc, "a.md")
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .swap_git_hold("s", &inc, "a.md", None, None, None)
            .is_err()
    );
}

#[test]
fn counters_read_numeric_text_and_mirror_flag() {
    let dir = TempDir::new("git-holds-text");
    let store = open(&dir);
    let inc = source(&store, "s", json!({"mirror_read_only": true}));
    store
        .write_op_checkpoint_record(
            "sync-hold-summary",
            &format!("s:{inc}"),
            Some(&json!([{"source_id": "s", "incarnation": inc, "count": "4", "stale": 2}])),
        )
        .unwrap();
    let hold = json!([{"path": "b.md"}]);
    assert!(
        store
            .swap_git_hold(
                "s",
                &inc,
                "b.md",
                None,
                Some(&hold),
                Some(&delta(json!({"count": 1})))
            )
            .unwrap()
    );
    assert_eq!(summary(&store, &inc)["count"], json!(5));
    assert_eq!(summary(&store, &inc)["stale"], json!(2));
    assert!(
        store
            .read_git_hold_record("s", &inc, "b.md")
            .unwrap()
            .unwrap()
            .mirror_read_only
    );
    assert!(
        store
            .swap_git_hold("s", &inc, "b\0.md", None, Some(&hold), None)
            .is_err()
    );
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
