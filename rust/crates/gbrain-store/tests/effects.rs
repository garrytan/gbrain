//! The effect journal: queue, claim, completion, release, mirror gates and the re-arm probe.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::effects::{EffectClaimRef, EffectQueue};
use gbrain_store::error::CONSTRAINT_VIOLATION;
use gbrain_store::journal::WriteAdmission;
use serde_json::{Value, json};

const TOKEN: &str = "44444444-4444-4444-8444-444444444444";

fn admit(store: &Store, request: &str) -> String {
    let admission: WriteAdmission = serde_json::from_value(json!({
        "principal": {"kind": "local_cli", "id": "writer-1"},
        "operation": "put_page",
        "requestId": request,
        "slug": "a",
        "callerIntent": {},
    }))
    .unwrap();
    store.admit_write(&admission, None).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

fn queue(request_id: &str, queued: Value) -> EffectQueue {
    serde_json::from_value(json!({
        "requestId": request_id,
        "revision": null,
        "sourceId": "default",
        "sourceIncarnation": "55555555-5555-4555-8555-555555555555",
        "worktreeId": null,
        "queued": queued,
    }))
    .unwrap()
}

fn owner(pid: u64) -> String {
    json!({"token": TOKEN, "owner": {"pid": pid, "nonce": "n", "start": "s"}}).to_string()
}

#[test]
fn queued_effects_keep_order_skip_existing_kinds_and_gated_rows_while_links_are_off() {
    let dir = TempDir::new("effects-queue");
    let store = open(&dir);
    let request = admit(&store, "11111111-1111-4111-8111-111111111111");
    let kinds = store
        .queue_effects(&queue(
            &request,
            json!([
                {"kind": "git", "data": {"slug": "a"}},
                {"kind": "links", "data": {"slug": "a"}, "gated": true},
            ]),
        ))
        .unwrap();
    assert_eq!(kinds, ["git", "links"]);
    let again = store
        .queue_effects(&queue(
            &request,
            json!([{"kind": "git", "data": {}}, {"kind": "embedding", "data": {}}]),
        ))
        .unwrap();
    assert_eq!(again, ["embedding"]);

    let other = admit(&store, "22222222-2222-4222-8222-222222222222");
    store
        .set_config("mcp.remote_auto_links", " OFF\u{00A0}")
        .unwrap();
    let gated = store
        .queue_effects(&queue(
            &other,
            json!([{"kind": "links", "data": {}, "gated": true}, {"kind": "git", "data": {}}]),
        ))
        .unwrap();
    assert_eq!(gated, ["git"]);

    let missing = store
        .queue_effects(&queue(
            "99999999-9999-4999-8999-999999999999",
            json!([{"kind": "git", "data": {}}]),
        ))
        .unwrap_err();
    assert_eq!(missing.code, CONSTRAINT_VIOLATION);
}

#[test]
fn a_claim_stamps_the_lease_and_a_completion_needs_its_token() {
    let dir = TempDir::new("effects-claim");
    let store = open(&dir);
    let request = admit(&store, "11111111-1111-4111-8111-111111111111");
    store
        .queue_effects(&queue(
            &request,
            json!([{"kind": "git", "data": {"target_failures": 2, "slug": "a"}}]),
        ))
        .unwrap();
    let candidate = store.select_claimable_effect("host", &[]).unwrap().unwrap();
    assert_eq!(candidate["state"], "queued");
    let id = candidate["id"].clone();
    let claimed = store.claim_effect(&id, TOKEN, &owner(7)).unwrap().unwrap();
    assert_eq!(claimed["state"], "running");
    assert_eq!(claimed["attempts"], 1);
    assert_eq!(claimed["execution_token"], TOKEN);
    assert_eq!(claimed["claim_owner"]["owner"]["pid"], 7);
    assert!(claimed["claim_expires_at"].is_string());
    // A live claim is not claimable; one whose owner is dead is.
    assert!(
        store
            .select_claimable_effect("host", &[])
            .unwrap()
            .is_none()
    );
    let dead = store
        .select_claimable_effect("host", &["7:n:s".into()])
        .unwrap()
        .unwrap();
    assert_eq!(dead["id"], id);

    assert!(
        !store
            .complete_effect(&id, Some("other"), &json!({}))
            .unwrap()
    );
    assert!(!store.complete_effect(&id, None, &json!({})).unwrap());
    assert!(
        store
            .complete_effect(&id, Some(TOKEN), &json!({"git": "pushed"}))
            .unwrap()
    );
    let unknown = json!("424242");
    assert!(
        store
            .claim_effect(&unknown, TOKEN, &owner(1))
            .unwrap()
            .is_none()
    );
    // Completed: committed, retry keys stripped, the claim cleared.
    let row = store.claim_effect(&id, TOKEN, &owner(1)).unwrap().unwrap();
    assert_eq!(row["attempts"], 2);
    assert_eq!(row["data"], json!({"slug": "a"}));
    assert_eq!(row["outcome"], json!({"git": "pushed"}));
}

#[test]
fn completion_with_parked_targets_fails_and_the_batch_counts_held_claims() {
    let dir = TempDir::new("effects-batch");
    let store = open(&dir);
    let request = admit(&store, "11111111-1111-4111-8111-111111111111");
    store
        .queue_effects(&queue(
            &request,
            json!([
                {"kind": "git", "data": {"parked": [{"slug": "a", "error_code": "x"}]}},
                {"kind": "embedding", "data": {}},
            ]),
        ))
        .unwrap();
    let git = store
        .claim_effect(&json!(1), TOKEN, &owner(1))
        .unwrap()
        .unwrap();
    store.claim_effect(&json!(2), TOKEN, &owner(1)).unwrap();
    let refs: Vec<EffectClaimRef> = serde_json::from_value(json!([
        {"id": git["id"], "token": TOKEN}, {"id": "2", "token": TOKEN}, {"id": 3, "token": TOKEN},
    ]))
    .unwrap();
    assert_eq!(
        store
            .complete_effects(&refs, &json!({"done": true}))
            .unwrap(),
        2
    );
    assert_eq!(store.complete_effects(&refs, &json!({})).unwrap(), 0);
    assert!(
        store
            .select_claimable_effect("host", &[])
            .unwrap()
            .is_none()
    );
    let failed = store
        .claim_effect(&json!(1), TOKEN, &owner(1))
        .unwrap()
        .unwrap();
    assert_eq!(
        failed["error_code"], "targets_parked",
        "a claim leaves error_code as it was"
    );
}

#[test]
fn abandoned_claims_return_to_the_queue() {
    let dir = TempDir::new("effects-release");
    let store = open(&dir);
    let request = admit(&store, "11111111-1111-4111-8111-111111111111");
    store
        .queue_effects(&queue(&request, json!([{"kind": "git", "data": {}}])))
        .unwrap();
    store.claim_effect(&json!(1), TOKEN, &owner(1)).unwrap();
    assert_eq!(
        store
            .release_abandoned_effect_claims("2000-01-01T00:00:00.000Z")
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .release_abandoned_effect_claims("2999-01-01T00:00:00.000Z")
            .unwrap(),
        1
    );
    let row = store.select_claimable_effect("host", &[]).unwrap().unwrap();
    assert_eq!(row["state"], "queued");
    assert_eq!(row["execution_token"], Value::Null);
    assert_eq!(row["claim_owner"], Value::Null);
    assert!(store.release_abandoned_effect_claims("yesterday").is_err());
}

#[test]
fn an_open_withdrawal_mirror_gates_its_request_until_it_commits() {
    let dir = TempDir::new("effects-mirror");
    let store = open(&dir);
    let request = admit(&store, "11111111-1111-4111-8111-111111111111");
    store
        .queue_effects(&queue(&request, json!([
            {"kind": "git", "data": {"parked": [{"slug": "a", "error_code": "withdrawal_mirror_failed"}]}},
            {"kind": "withdrawal-mirror", "data": {}},
        ])))
        .unwrap();
    let first = store.select_claimable_effect("host", &[]).unwrap().unwrap();
    assert_eq!(first["kind"], "withdrawal-mirror");
    let gates = store
        .list_mirror_gates(&[request.clone(), request.clone()])
        .unwrap();
    assert_eq!(
        gates,
        [json!({"request_id": request, "state": "queued", "data": {}})]
    );
    assert!(
        !store
            .has_rearmable_effects(std::slice::from_ref(&request))
            .unwrap()
    );

    store.claim_effect(&first["id"], TOKEN, &owner(1)).unwrap();
    assert!(
        store
            .complete_effect(&first["id"], Some(TOKEN), &json!({}))
            .unwrap()
    );
    assert!(
        store
            .list_mirror_gates(std::slice::from_ref(&request))
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .has_rearmable_effects(std::slice::from_ref(&request))
            .unwrap()
    );
    assert_eq!(
        store.select_claimable_effect("host", &[]).unwrap().unwrap()["kind"],
        "git"
    );
    assert!(!store.has_rearmable_effects(&["nope".into()]).unwrap());
}
