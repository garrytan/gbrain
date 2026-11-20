//! The fence-repair checkpoint reads and the candidate part upsert (fence_checkpoints.rs).

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::fence_checkpoints::FenceCandidatePartWrite;
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

const OP: &str = "fence-candidate";
const SLUGS: [&str; 3] = ["ab", "a0", "a-z"];
const BYTE_SLUGS: [&str; 3] = ["a-z", "a0", "ab"];

fn add_source(store: &Store, id: &str) -> String {
    let source: SourceInput = serde_json::from_value(json!({ "id": id })).unwrap();
    store.upsert_source(&source).unwrap();
    store
        .read_source_incarnation(id)
        .unwrap()
        .unwrap()
        .incarnation
}

fn part(
    source: &str,
    incarnation: &str,
    key: &str,
    part: &str,
    finding: Value,
) -> FenceCandidatePartWrite {
    FenceCandidatePartWrite {
        op: OP.into(),
        fingerprint: format!("{source}:{incarnation}:{key}"),
        source_id: source.into(),
        incarnation: incarnation.into(),
        key: key.into(),
        part: part.into(),
        finding,
    }
}

fn keys_of(records: &[Value]) -> Vec<&str> {
    records.iter().map(|r| r["key"].as_str().unwrap()).collect()
}

#[test]
fn candidates_list_by_fingerprint_byte() {
    let dir = TempDir::new("fence-candidates-order");
    let store = open(&dir);
    let inc = add_source(&store, "census-src");
    for key in SLUGS {
        store
            .upsert_fence_candidate_part(&part(
                "census-src",
                &inc,
                key,
                "page",
                json!({ "findings": [key] }),
            ))
            .unwrap();
    }
    let ids = ["census-src".to_string()];
    let records = store.read_fence_candidate_records(OP, Some(&ids)).unwrap();
    assert_eq!(keys_of(&records), BYTE_SLUGS);
    assert_eq!(records[0]["version"], 1);
    assert_eq!(records[0]["page"], json!({ "findings": ["a-z"] }));
    assert_eq!(
        store.read_fence_candidate_records(OP, None).unwrap().len(),
        3
    );
}

#[test]
fn a_second_part_keeps_the_first() {
    let dir = TempDir::new("fence-candidates-parts");
    let store = open(&dir);
    let inc = add_source(&store, "src");
    store
        .upsert_fence_candidate_part(&part("src", &inc, "k", "page", json!({ "p": 1 })))
        .unwrap();
    store
        .upsert_fence_candidate_part(&part("src", &inc, "k", "file", json!({ "f": 2 })))
        .unwrap();
    store
        .upsert_fence_candidate_part(&part("src", &inc, "k", "page", json!({ "p": 3 })))
        .unwrap();
    let records = store.read_fence_candidate_records(OP, None).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["page"], json!({ "p": 3 }));
    assert_eq!(records[0]["file"], json!({ "f": 2 }));
}

#[test]
fn candidates_of_a_replaced_or_unknown_source_are_dropped() {
    let dir = TempDir::new("fence-candidates-live");
    let store = open(&dir);
    let inc = add_source(&store, "live");
    add_source(&store, "other");
    store
        .upsert_fence_candidate_part(&part("live", &inc, "k", "page", json!({})))
        .unwrap();
    store
        .upsert_fence_candidate_part(&part("live", "stale", "k", "page", json!({})))
        .unwrap();
    store
        .upsert_fence_candidate_part(&part("gone", "1", "k", "page", json!({})))
        .unwrap();
    let all = store.read_fence_candidate_records(OP, None).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0]["source_id"], "live");
    let other = ["other".to_string()];
    assert!(
        store
            .read_fence_candidate_records(OP, Some(&other))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn op_records_list_by_fingerprint_byte_and_scope_by_source() {
    let dir = TempDir::new("fence-op-records");
    let store = open(&dir);
    for path in SLUGS {
        let notice = json!({ "source_id": "src", "incarnation": "1", "path": path });
        store
            .write_op_checkpoint_values(
                "fence-repair-uncommitted",
                &format!("src:1:{path}"),
                &[notice],
            )
            .unwrap();
    }
    store
        .write_op_checkpoint_values(
            "fence-repair-uncommitted",
            "z:1:p",
            &[json!({ "source_id": "z", "incarnation": "1", "path": "p" })],
        )
        .unwrap();
    store
        .write_op_checkpoint_values("other-op", "src:1:x", &[json!({ "source_id": "src" })])
        .unwrap();
    let ids = ["src".to_string()];
    let rows = store
        .read_op_checkpoint_records("fence-repair-uncommitted", Some(&ids))
        .unwrap();
    let fingerprints: Vec<&str> = rows
        .iter()
        .map(|r| r["fingerprint"].as_str().unwrap())
        .collect();
    assert_eq!(fingerprints, ["src:1:a-z", "src:1:a0", "src:1:ab"]);
    assert_eq!(rows[0]["record"]["path"], "a-z");
    assert_eq!(
        store
            .read_op_checkpoint_records("fence-repair-uncommitted", None)
            .unwrap()
            .len(),
        4
    );
    assert!(
        store
            .read_op_checkpoint_records("none", None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn an_op_with_nul_is_refused() {
    let dir = TempDir::new("fence-op-nul");
    let store = open(&dir);
    assert!(store.read_op_checkpoint_records("a\0b", None).is_err());
    assert!(store.read_fence_candidate_records("a\0b", None).is_err());
}
