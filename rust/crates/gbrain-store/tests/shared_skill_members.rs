//! Shared-skill membership (`shared_skill_members.rs`): each write family against the Postgres
//! behavior it mirrors, on a clock the test moves.

mod memory_env;

use gbrain_store::shared_skill_members::{
    SharedSkillBatchAcknowledge, SharedSkillBatchIssue, SharedSkillMemberEnroll,
    SharedSkillMemberLookup,
};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const MEMBER: &str = "11111111-1111-4111-8111-111111111111";
const BRAIN: &str = "22222222-2222-4222-8222-222222222222";
const HOUR: i64 = 3_600_000_000;

fn token(n: u8) -> String {
    format!("{n:08x}-0000-4000-8000-000000000000")
}

fn enroll(b: &Brain, id: &str, adapter: &str) -> gbrain_store::Result<()> {
    let spec: SharedSkillMemberEnroll = serde_json::from_value(json!({
        "installationId": id, "principalKind": "token", "principalId": "p1", "adapter": adapter,
        "brainId": BRAIN, "followPolicy": {"source_ids": ["default"]},
    }))
    .unwrap();
    b.enroll_shared_skill_member(&spec)
}

fn member(b: &Brain) -> Value {
    let by: SharedSkillMemberLookup = serde_json::from_value(json!({
        "installationId": MEMBER, "principalKind": "token", "principalId": "p1",
    }))
    .unwrap();
    b.read_shared_skill_member(&by).unwrap()
}

fn issue(
    b: &Brain,
    epoch: i64,
    issued: i64,
    view: &str,
    tok: &str,
    retained: i64,
) -> gbrain_store::Result<Value> {
    let spec: SharedSkillBatchIssue = serde_json::from_value(json!({
        "installationId": MEMBER, "epoch": epoch, "issuedSequence": issued, "viewToken": view,
        "authorityDigest": "a", "revisions": [], "token": tok, "retainedBatches": retained,
    }))
    .unwrap();
    b.issue_shared_skill_delivery_batch(&spec)
}

#[test]
fn token_secret_is_seeded_hex_and_stable() {
    let b = brain("ssm-secret");
    let secret = b.shared_skill_token_secret().unwrap();
    assert_eq!(secret.len(), 64);
    assert!(secret.bytes().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(b.shared_skill_token_secret().unwrap(), secret);
}

#[test]
fn enroll_inserts_then_rejoins_at_the_next_epoch_and_refuses_a_second_installation() {
    let b = brain("ssm-enroll");
    enroll(&b, MEMBER, "codex").unwrap();
    let m = member(&b);
    assert_eq!(m["epoch"], 1);
    assert_eq!(m["join_count"], 1);
    assert_eq!(m["active"], true);
    assert_eq!(b.count_shared_skill_members().unwrap(), 1);

    issue(&b, 1, 0, "v1", &token(1), 4).unwrap();
    b.leave_shared_skill_member(MEMBER).unwrap();
    assert_eq!(member(&b)["active"], false);

    b.clock.advance(HOUR / 2);
    enroll(&b, &MEMBER.to_uppercase(), "codex").unwrap();
    let m = member(&b);
    assert_eq!(m["epoch"], 2);
    assert_eq!(m["join_count"], 2);
    assert_eq!(m["active"], true);
    assert_eq!(m["issued_sequence"], 0);
    assert_eq!(m["desired_view"], Value::Null);

    // A join window older than an hour restarts the count.
    b.clock.advance(2 * HOUR);
    enroll(&b, MEMBER, "codex").unwrap();
    assert_eq!(member(&b)["join_count"], 1);

    let other = "33333333-3333-4333-8333-333333333333";
    let err = enroll(&b, other, "codex").unwrap_err();
    assert!(
        err.to_string()
            .contains("shared_skill_members_principal_kind_principal_id_adapter_key"),
        "{err}"
    );
    enroll(&b, other, "claude").unwrap();
    assert_eq!(b.count_shared_skill_members().unwrap(), 2);

    b.rebind_shared_skill_member(MEMBER, &json!({"source_ids": []}), 7)
        .unwrap();
    let m = member(&b);
    assert_eq!(m["epoch"], 7);
    assert_eq!(m["follow_policy"], json!({"source_ids": []}));
}

#[test]
fn issue_reuses_advances_retains_and_acknowledges_with_the_greater_sequence() {
    let b = brain("ssm-issue");
    enroll(&b, MEMBER, "codex").unwrap();
    let first = issue(&b, 1, 0, "v1", &token(1), 2).unwrap();
    assert_eq!(first["created"], true);
    assert_eq!(first["batch"]["sequence"], 1);
    let again = issue(&b, 1, 1, "v1", &token(9), 2).unwrap();
    assert_eq!(again["created"], false);
    assert_eq!(again["batch"]["token"], token(1));
    issue(&b, 1, 1, "v2", &token(2), 2).unwrap();
    issue(&b, 1, 2, "v3", &token(3), 2).unwrap();
    let kept: Vec<bool> = (1..=3)
        .map(|n| {
            !b.read_shared_skill_delivery_batch(&token(n), MEMBER, 1)
                .unwrap()
                .is_null()
        })
        .collect();
    assert_eq!(kept, vec![false, true, true]);
    assert_eq!(member(&b)["issued_sequence"], 3);

    let ack = |tok: &str, seq: i64, view: &str| {
        let spec: SharedSkillBatchAcknowledge = serde_json::from_value(json!({
            "token": tok, "evidence": {"state": "installed"}, "installationId": MEMBER,
            "advance": {"sequence": seq, "viewToken": view},
        }))
        .unwrap();
        b.acknowledge_shared_skill_delivery_batch(&spec).unwrap();
    };
    ack(&token(3), 3, "v3");
    ack(&token(2), 2, "v2");
    let m = member(&b);
    assert_eq!(m["acknowledged_sequence"], 3);
    assert_eq!(m["acknowledged_view"], "v2");
    let batch = b
        .read_shared_skill_delivery_batch(&token(2), MEMBER, 1)
        .unwrap();
    assert_eq!(batch["evidence"], json!({"state": "installed"}));
    assert!(batch["acknowledged_at"].is_string());

    // A new epoch drops the old epoch's batches.
    issue(&b, 2, 0, "v1", &token(4), 2).unwrap();
    assert!(
        b.read_shared_skill_delivery_batch(&token(3), MEMBER, 1)
            .unwrap()
            .is_null()
    );

    let named: SharedSkillBatchIssue = serde_json::from_value(json!({
        "installationId": MEMBER, "epoch": 2, "issuedSequence": 1, "viewToken": "v9",
        "authorityDigest": "a", "revisions": ["r1"], "token": token(5), "retainedBatches": 2,
    }))
    .unwrap();
    let err = b.issue_shared_skill_delivery_batch(&named).unwrap_err();
    assert!(err.to_string().contains("revision_unavailable"), "{err}");
    // The refused issue rolled back as one write.
    assert_eq!(member(&b)["issued_sequence"], 1);

    let stranger = "44444444-4444-4444-8444-444444444444";
    let spec: SharedSkillBatchIssue = serde_json::from_value(json!({
        "installationId": stranger, "epoch": 1, "issuedSequence": 0, "viewToken": "v1",
        "authorityDigest": "a", "revisions": [], "token": token(6), "retainedBatches": 2,
    }))
    .unwrap();
    let err = b.issue_shared_skill_delivery_batch(&spec).unwrap_err();
    assert!(
        err.to_string()
            .contains("shared_skill_delivery_batches_installation_id_fkey"),
        "{err}"
    );
}

#[test]
fn delivery_batch_outside_the_replay_window_is_unread_and_pruned() {
    let b = brain("ssm-window");
    enroll(&b, MEMBER, "codex").unwrap();
    issue(&b, 1, 0, "v1", &token(1), 4).unwrap();
    assert!(
        !b.read_shared_skill_delivery_batch(&token(1), MEMBER, 1)
            .unwrap()
            .is_null()
    );
    b.clock.advance(25 * HOUR);
    assert!(
        b.read_shared_skill_delivery_batch(&token(1), MEMBER, 1)
            .unwrap()
            .is_null()
    );
    // The reissue at the same view finds no prior batch: the old one is pruned, the next issued.
    let next = issue(&b, 1, 1, "v1", &token(2), 4).unwrap();
    assert_eq!(next["created"], true);
    assert_eq!(next["batch"]["sequence"], 2);
    b.clock.advance(-25 * HOUR);
    assert!(
        b.read_shared_skill_delivery_batch(&token(1), MEMBER, 1)
            .unwrap()
            .is_null()
    );
}

#[test]
fn follow_sources_skip_archived_and_filter_by_both_lists() {
    let b = brain("ssm-sources");
    let all = b.list_shared_skill_follow_sources(None, None).unwrap();
    assert_eq!(
        all,
        json!([{"id": "default", "incarnation": all[0]["incarnation"]}])
    );
    let none = b
        .list_shared_skill_follow_sources(Some(&["other".to_string()]), None)
        .unwrap();
    assert_eq!(none, json!([]));
}
