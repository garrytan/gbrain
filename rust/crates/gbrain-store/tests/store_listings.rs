//! Byte-order listings the store serves for the engine-parity collate cases (lane 17): the shared-skill
//! member migration rows, the derivation claim needles and the markdown page slugs.

mod common;

use common::{TempDir, open};
use gbrain_store::facts::normalize_derivation_claims;
use gbrain_store::shared_skill_members::SharedSkillMemberEnroll;
use serde_json::json;

#[test]
fn derivation_claims_normalize_fold_dedupe_and_sort_by_byte() {
    let claims = ["ab", "a b", "A  B.", "a c", "", "...", "σς", "i\u{307}x"].map(String::from);
    // `A  B.` normalizes to `a b` (one space, the ending dot dropped); `...` and the empty claim drop out;
    // the final sigma folds to `σ`; `i` + combining dot folds to `i`.
    assert_eq!(
        normalize_derivation_claims(&claims),
        vec!["a b", "a c", "ab", "ix", "σσ"]
    );
}

#[test]
fn shared_member_migration_rows_match_object_keys_and_array_elements_by_adapter_bytes() {
    let dir = TempDir::new("store-listings-members");
    let store = open(&dir);
    let enroll = |id: &str, adapter: &str, policy: serde_json::Value| {
        store
            .enroll_shared_skill_member(&SharedSkillMemberEnroll {
                installation_id: id.into(),
                principal_kind: "client".into(),
                principal_id: "c".into(),
                adapter: adapter.into(),
                brain_id: "00000000-0000-4000-8000-0000000000ff".into(),
                follow_policy: policy,
            })
            .unwrap();
    };
    enroll(
        "00000000-0000-4000-8000-000000000001",
        "ab",
        json!({ "sources": { "s": "1" } }),
    );
    enroll(
        "00000000-0000-4000-8000-000000000002",
        "a/z",
        json!({ "sources": { "s": 7 } }),
    );
    enroll(
        "00000000-0000-4000-8000-000000000003",
        "a-z",
        json!({ "sources": ["s"] }),
    );
    enroll(
        "00000000-0000-4000-8000-000000000004",
        "zz",
        json!({ "sources": { "other": "1" } }),
    );
    let rows = store.list_shared_member_migration_rows("s").unwrap();
    let rows = rows.as_array().unwrap();
    let adapters: Vec<&str> = rows
        .iter()
        .map(|r| r["adapter"].as_str().unwrap())
        .collect();
    assert_eq!(adapters, vec!["a-z", "a/z", "ab"]);
    // `->>` reads a number as its text and finds nothing under a key of an array.
    let approved: Vec<_> = rows
        .iter()
        .map(|r| r["approved_incarnation"].clone())
        .collect();
    assert_eq!(approved, vec![json!(null), json!("7"), json!("1")]);
    assert!(
        rows.iter()
            .all(|r| r["stage"].is_null() && r["epoch"] == json!(1) && r["active"] == json!(true))
    );
}
