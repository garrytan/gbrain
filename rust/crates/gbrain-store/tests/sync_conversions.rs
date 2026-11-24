//! The managed sync conversion log. The three-arm case is in test/engine-parity/git-holds.test.ts;
//! this pins the first record, the newest-first bound, the kept keys and the jsonb key order.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use serde_json::{Value, json};

const OP: &str = "sync-conversions";

fn conversion(id: &str) -> Value {
    json!({ "request_id": id, "path": null, "slug": null, "run_id": "run-1", "outcome": "held", "converted_at": "t" })
}

fn stored(store: &Store, fingerprint: &str) -> String {
    let record = store
        .read_op_checkpoint_record(OP, fingerprint, None)
        .unwrap();
    serde_json::to_string(&record["completed_keys"]).unwrap()
}

#[test]
fn the_log_keeps_the_newest_first_in_jsonb_key_order() {
    let dir = TempDir::new("sync-conversions-log");
    let store = open(&dir);
    for i in 0..4 {
        store
            .record_sync_conversion("s", "inc", &conversion(&format!("r{i}")), 3)
            .unwrap();
    }
    let entry = |id: &str| {
        format!(
            r#"{{"path":null,"slug":null,"run_id":"run-1","outcome":"held","request_id":"{id}","converted_at":"t"}}"#
        )
    };
    assert_eq!(
        stored(&store, "s:inc"),
        format!(
            r#"[{{"source_id":"s","conversions":[{},{},{}],"incarnation":"inc"}}]"#,
            entry("r3"),
            entry("r2"),
            entry("r1")
        )
    );
}

#[test]
fn a_later_write_keeps_the_record_keys_and_takes_a_non_array_log_as_one_entry() {
    let dir = TempDir::new("sync-conversions-kept");
    let store = open(&dir);
    store
        .write_op_checkpoint_record(
            OP,
            "s:inc",
            Some(&json!([{ "source_id": "s", "incarnation": "inc", "note": "kept", "conversions": "old" }])),
        )
        .unwrap();
    store
        .record_sync_conversion("s", "inc", &conversion("r1"), 20)
        .unwrap();
    let value: Value = serde_json::from_str(&stored(&store, "s:inc")).unwrap();
    assert_eq!(value[0]["note"], json!("kept"));
    assert_eq!(value[0]["conversions"][1], json!("old"));
    assert_eq!(value[0]["conversions"][0]["request_id"], json!("r1"));

    // A record that is not the first array element reads as SQL NULL, and jsonb_build_array(NULL) is [null].
    store
        .write_op_checkpoint_record(OP, "s:empty", Some(&json!([])))
        .unwrap();
    store
        .record_sync_conversion("s", "empty", &conversion("r1"), 20)
        .unwrap();
    assert_eq!(stored(&store, "s:empty"), "[null]");
}
