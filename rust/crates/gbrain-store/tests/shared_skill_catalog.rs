//! Shared-skill catalog rows (`shared_skill_catalog.rs`): policies, heads, revisions and the
//! delivery leases a new batch takes, against the Postgres behavior they mirror.

mod memory_env;

use gbrain_store::shared_skill_catalog::{
    SharedSkillHeadQuery, SharedSkillPolicyWrite, SharedSkillRevisionKey, SharedSkillRevisionWrite,
};
use gbrain_store::shared_skill_members::{SharedSkillBatchIssue, SharedSkillMemberEnroll};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const MEMBER: &str = "11111111-1111-4111-8111-111111111111";
const BRAIN: &str = "22222222-2222-4222-8222-222222222222";
const REVISION: &str = "33333333-3333-4333-8333-333333333333";
const EPOCH: &str = "44444444-4444-4444-8444-444444444444";

fn incarnation(b: &Brain) -> String {
    b.list_shared_skill_follow_sources(None, None).unwrap()[0]["incarnation"]
        .as_str()
        .unwrap()
        .to_string()
}

fn revision(inc: &str, revision: &str, private: bool) -> SharedSkillRevisionWrite {
    serde_json::from_value(json!({
        "sourceId": "default", "incarnation": inc, "packId": "pack", "name": "notes", "revision": revision,
        "metadata": {"description": "d", "private": private, "audience": ["readers"]},
        "files": [{"path": "skills/notes/SKILL.md"}], "deleted": false, "policyEpoch": EPOCH,
        "requestId": "55555555-5555-4555-8555-555555555555",
    }))
    .unwrap()
}

fn heads(b: &Brain, hide_private: bool) -> Value {
    let q: SharedSkillHeadQuery = serde_json::from_value(json!({
        "sourceIds": null, "limit": 101, "sourceId": null, "sourceIncarnation": null, "packId": null,
        "name": null, "hidePrivate": hide_private,
    }))
    .unwrap();
    b.list_shared_skill_catalog_heads(&q).unwrap()
}

#[test]
fn policy_write_reads_back_and_joins_the_head_list() {
    let b = brain("ssc-policy");
    let inc = incarnation(&b);
    assert!(
        b.read_shared_skill_policy_row("default", &inc)
            .unwrap()
            .is_null()
    );
    let policy = json!({"version": 1, "enabled": true, "allow_follow": true});
    let w: SharedSkillPolicyWrite = serde_json::from_value(json!({
        "sourceId": "default", "incarnation": inc, "epoch": EPOCH, "policy": policy,
        "principalKind": "local_writer", "principalId": "w", "previousEpoch": "legacy-prose",
    }))
    .unwrap();
    b.write_shared_skill_policy(&w).unwrap();
    assert_eq!(
        b.read_shared_skill_policy_row("default", &inc).unwrap(),
        json!({"epoch": EPOCH, "policy": policy})
    );
    b.write_shared_skill_revision(&revision(&inc, REVISION, false))
        .unwrap();
    let rows = heads(&b, true);
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["revision"], json!(REVISION));
    assert_eq!(rows[0]["current_policy"], policy);
    assert_eq!(rows[0]["current_epoch"], json!(EPOCH));
}

#[test]
fn revision_reads_back_refuses_a_duplicate_and_hides_private_heads() {
    let b = brain("ssc-revision");
    let inc = incarnation(&b);
    b.write_shared_skill_revision(&revision(&inc, REVISION, true))
        .unwrap();
    let dup = b
        .write_shared_skill_revision(&revision(&inc, REVISION, true))
        .unwrap_err();
    assert!(dup.to_string().contains("shared_skill_revisions_pkey"));
    let key: SharedSkillRevisionKey = serde_json::from_value(json!({
        "sourceId": "default", "incarnation": inc, "packId": "pack", "name": "notes", "revision": REVISION,
    }))
    .unwrap();
    let row = b.read_shared_skill_revision(&key).unwrap();
    assert_eq!(row["files"], json!([{"path": "skills/notes/SKILL.md"}]));
    assert_eq!(heads(&b, true), json!([]));
    assert_eq!(heads(&b, false).as_array().unwrap().len(), 1);
    // No policy: the head reads null for both policy columns.
    assert!(heads(&b, false)[0]["current_policy"].is_null());
}

#[test]
fn a_batch_leases_a_retained_revision_and_a_missing_one_refuses_whole() {
    let b = brain("ssc-lease");
    let inc = incarnation(&b);
    b.write_shared_skill_revision(&revision(&inc, REVISION, false))
        .unwrap();
    let enroll: SharedSkillMemberEnroll = serde_json::from_value(json!({
        "installationId": MEMBER, "principalKind": "token", "principalId": "p1", "adapter": "generic",
        "brainId": BRAIN, "followPolicy": {},
    }))
    .unwrap();
    b.enroll_shared_skill_member(&enroll).unwrap();
    let brain_id = b.brain_id().to_string();
    let item = format!("{brain_id}/default/{inc}/pack/notes@{REVISION}");
    let issue = |seq: i64, view: &str, tok: &str, revisions: Vec<String>| {
        let spec: SharedSkillBatchIssue = serde_json::from_value(json!({
            "installationId": MEMBER, "epoch": 1, "issuedSequence": seq, "viewToken": view,
            "authorityDigest": "a", "revisions": revisions, "token": tok, "retainedBatches": 1,
        }))
        .unwrap();
        b.issue_shared_skill_delivery_batch(&spec)
    };
    let first = issue(
        0,
        "v1",
        "00000001-0000-4000-8000-000000000000",
        vec![item.clone()],
    )
    .unwrap();
    assert_eq!(first["created"], json!(true));
    let missing = item.replace(REVISION, "66666666-6666-4666-8666-666666666666");
    let refused = issue(
        1,
        "v2",
        "00000002-0000-4000-8000-000000000000",
        vec![missing],
    )
    .unwrap_err();
    assert!(refused.to_string().contains("revision_unavailable"));
    // The refused issue would have pruned the first batch (one retained); it is still there.
    assert!(
        !b.read_shared_skill_delivery_batch("00000001-0000-4000-8000-000000000000", MEMBER, 1)
            .unwrap()
            .is_null()
    );
}
