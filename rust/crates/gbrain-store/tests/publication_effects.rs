//! Publication effects: what `insertPublicationEffects` stores, and that a stored effect waits.
//!
//! The store keeps every effect kind a publication queues, so a receipt that says an effect is queued names a row
//! that exists. No effect is claimable on this engine yet (`selectClaimableEffect` answers null), so every kind,
//! embedding included, stays queued with nothing run and nothing lost, and a completed write keeps its whole
//! reservation while one of its effects is unfinished.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::persistence::{PublicationEffectsSpec, WriteCompletion, WriteRequestInsert};
use serde_json::{Value, json};

const REQ: &str = "b0000000-0000-4000-8000-0000000000b1";
const REVISION: &str = "e0000000-0000-4000-8000-0000000000e1";
const HOST: &str = "d0000000-0000-4000-8000-0000000000d1";
const KEYS: [&str; 2] = ["principal:local_cli:parity-writer", "brain"];

fn incarnation(store: &Store) -> String {
    store.read_source_membership("default").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string()
}

fn admit(store: &Store, request: &str) -> String {
    let insert: WriteRequestInsert = serde_json::from_value(json!({
        "principalKind": "local_cli", "principalId": "parity-writer", "requestId": request,
        "operation": "put_page", "sourceId": "default", "sourceIncarnation": incarnation(store),
        "pageId": null, "slug": "notes/a", "worktreeId": null, "topologyGeneration": null,
        "digest": "digest", "intent": {}, "authority": {}, "intentBytes": 10,
        "terminalReservation": 4096, "targetKind": "page", "protocolVersion": 1,
        "admitterVersion": "v-test", "admitterHostId": null, "counterKeys": KEYS,
        "clientRequestId": null, "state": "queued", "deferredRefreshId": null,
    }))
    .unwrap();
    store
        .lock_persistence_counters(&KEYS.map(String::from))
        .unwrap();
    store.insert_write_request(&insert).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

fn spec(store: &Store, request: &str, effects: Value) -> PublicationEffectsSpec {
    serde_json::from_value(json!({
        "requestId": request, "revision": REVISION, "sourceId": "default",
        "sourceIncarnation": incarnation(store), "worktreeId": null, "effects": effects,
    }))
    .unwrap()
}

fn every_kind() -> Value {
    let page = json!({ "slug": "notes/a", "page_id": 1 });
    json!([
        { "kind": "embedding", "data": page },
        { "kind": "git", "data": { "relative_path": "notes/a.md" } },
        { "kind": "facts-backstop", "data": page },
        { "kind": "links", "data": page, "gated": true },
        { "kind": "withdrawal-mirror", "data": { "targets": [] } },
    ])
}

#[test]
fn every_kind_is_stored_queued_in_queue_order() {
    let dir = TempDir::new("effects-store");
    let store = open(&dir);
    let id = admit(&store, REQ);
    let kinds = store
        .insert_publication_effects(&spec(&store, &id, every_kind()))
        .unwrap();
    assert_eq!(
        kinds,
        [
            "embedding",
            "git",
            "facts-backstop",
            "links",
            "withdrawal-mirror"
        ]
    );
    let rows = store.read_request_effects(&id).unwrap();
    let stored: Vec<(&str, &str)> = rows
        .iter()
        .map(|r| (r["kind"].as_str().unwrap(), r["state"].as_str().unwrap()))
        .collect();
    assert_eq!(
        stored,
        [
            ("embedding", "queued"),
            ("git", "queued"),
            ("facts-backstop", "queued"),
            ("links", "queued"),
            ("withdrawal-mirror", "queued")
        ]
    );
    let ids: Vec<i64> = rows
        .iter()
        .map(|r| r["id"].as_str().unwrap().parse().unwrap())
        .collect();
    assert!(
        ids.windows(2).all(|w| w[0] < w[1]),
        "ids follow queue order: {ids:?}"
    );
    for row in &rows {
        assert_eq!(row["revision"], REVISION);
        assert_eq!(row["attempts"], 0);
        assert_eq!(row["execution_token"], Value::Null);
        assert!(row["next_attempt_at"].is_string());
    }
    // A kind already queued for the request is kept (ON CONFLICT DO NOTHING): its data is not replaced.
    let again = store
        .insert_publication_effects(&spec(
            &store,
            &id,
            json!([{ "kind": "embedding", "data": { "retry": true } }]),
        ))
        .unwrap();
    assert!(again.is_empty());
    assert_eq!(
        store.read_request_effects(&id).unwrap()[0]["data"],
        json!({ "slug": "notes/a", "page_id": 1 })
    );
}

#[test]
fn no_stored_kind_is_claimable_so_every_effect_waits() {
    let dir = TempDir::new("effects-wait");
    let store = open(&dir);
    let id = admit(&store, REQ);
    store
        .insert_publication_effects(&spec(&store, &id, every_kind()))
        .unwrap();
    assert_eq!(store.select_claimable_effect(HOST).unwrap(), Value::Null);
    let rows = store.read_request_effects(&id).unwrap();
    assert!(
        rows.iter()
            .all(|r| r["state"] == "queued" && r["attempts"] == 0)
    );
}

#[test]
fn an_effect_for_a_missing_request_or_a_bad_uuid_refuses_and_stores_nothing() {
    let dir = TempDir::new("effects-refuse");
    let store = open(&dir);
    let missing = store
        .insert_publication_effects(&spec(&store, REQ, every_kind()))
        .unwrap_err();
    assert_eq!(missing.code, CONSTRAINT_VIOLATION);
    assert!(store.read_request_effects(REQ).unwrap().is_empty());
    let id = admit(&store, REQ);
    let mut bad = spec(&store, &id, every_kind());
    bad.revision = Some("not-a-uuid".into());
    assert_eq!(
        store.insert_publication_effects(&bad).unwrap_err().code,
        INVALID_ARGUMENT
    );
    let no_data = store
        .insert_publication_effects(&spec(&store, &id, json!([{ "kind": "embedding" }])))
        .unwrap_err();
    assert_eq!(no_data.code, CONSTRAINT_VIOLATION);
    assert!(store.read_request_effects(&id).unwrap().is_empty());
}

#[test]
fn a_gated_kind_is_left_out_while_auto_linking_is_off() {
    let dir = TempDir::new("effects-gate");
    let store = open(&dir);
    let id = admit(&store, REQ);
    store.set_config("mcp.remote_auto_links", " OFF ").unwrap();
    let kinds = store
        .insert_publication_effects(&spec(&store, &id, every_kind()))
        .unwrap();
    assert_eq!(
        kinds,
        ["embedding", "git", "facts-backstop", "withdrawal-mirror"]
    );
}

#[test]
fn a_write_with_an_unfinished_effect_keeps_its_whole_reservation() {
    let dir = TempDir::new("effects-complete");
    let store = open(&dir);
    let id = admit(&store, REQ);
    store
        .insert_publication_effects(&spec(
            &store,
            &id,
            json!([{ "kind": "embedding", "data": {} }]),
        ))
        .unwrap();
    let completion: WriteCompletion = serde_json::from_value(json!({
        "id": id, "state": "committed", "outcome": {}, "errorCode": null, "errorMessage": null,
        "consumerVersion": "v-consumer", "consumerHostId": HOST, "errorDetail": null, "resultBytes": 100,
        "counterKeys": KEYS, "intentBytes": 10, "retainedBytes": 0, "terminalReservation": 4096,
        "probePurges": true,
    }))
    .unwrap();
    let done = store.complete_write_row(&completion).unwrap().unwrap();
    assert_eq!(done["state"], "committed");
    assert_eq!(done["terminal_reservation"], 4096);
}

#[test]
fn a_receipt_reads_each_effect_state_in_kind_order_or_only_the_git_effect() {
    let dir = TempDir::new("effects-receipt");
    let store = open(&dir);
    let id = admit(&store, REQ);
    store
        .insert_publication_effects(&spec(&store, &id, every_kind()))
        .unwrap();
    let waiting = |kind: &str| json!({ "kind": kind, "state": "queued", "error_code": null, "outcome": null, "recovering": false });
    assert_eq!(
        store.read_request_effect_states(&id, None).unwrap(),
        [
            "embedding",
            "facts-backstop",
            "git",
            "links",
            "withdrawal-mirror"
        ]
        .map(waiting)
    );
    assert_eq!(
        store.read_request_effect_states(&id, Some("git")).unwrap(),
        [waiting("git")]
    );
    assert!(
        store
            .read_request_effect_states(REQ, None)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .read_request_effect_states("nope", None)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}

#[test]
fn an_uppercase_request_id_names_the_same_effects_as_its_lowercase_spelling() {
    let dir = TempDir::new("effects-case");
    let store = open(&dir);
    let id = admit(&store, REQ);
    let upper = id.to_uppercase();
    let first = store
        .insert_publication_effects(&spec(
            &store,
            &upper,
            json!([{ "kind": "embedding", "data": {} }]),
        ))
        .unwrap();
    assert_eq!(first, ["embedding"]);
    let again = store
        .insert_publication_effects(&spec(
            &store,
            &id,
            json!([{ "kind": "embedding", "data": {} }]),
        ))
        .unwrap();
    assert!(
        again.is_empty(),
        "the lowercase spelling queued a second row"
    );
    let rows = store.read_request_effects(&id).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["request_id"], json!(id));
    assert_eq!(store.read_request_effects(&upper).unwrap().len(), 1);
}

#[test]
fn a_true_up_listing_counts_a_queued_effect_as_unfinished_work() {
    let dir = TempDir::new("effects-true-up");
    let store = open(&dir);
    let id = admit(&store, REQ);
    store
        .insert_publication_effects(&spec(
            &store,
            &id,
            json!([{ "kind": "embedding", "data": {} }]),
        ))
        .unwrap();
    let completion: WriteCompletion = serde_json::from_value(json!({
        "id": id, "state": "committed", "outcome": {}, "errorCode": null, "errorMessage": null,
        "consumerVersion": "v-consumer", "consumerHostId": HOST, "errorDetail": null, "resultBytes": 100,
        "counterKeys": KEYS, "intentBytes": 10, "retainedBytes": 0, "terminalReservation": 4096,
        "probePurges": true,
    }))
    .unwrap();
    store.complete_write_row(&completion).unwrap().unwrap();
    let rows = store.list_true_up_requests(&[id]).unwrap();
    assert_eq!(rows.len(), 1);
    // `{}` (2) + "embedding" (9) + the 1024 every effect row carries
    assert_eq!(rows[0]["effect_bytes"], json!("1035"), "{rows:?}");
    assert_eq!(rows[0]["unfinished"], json!(true), "{rows:?}");
}

#[test]
fn an_effect_naming_a_worktree_refuses_but_a_duplicate_or_gated_one_does_not() {
    let dir = TempDir::new("effects-worktree");
    let store = open(&dir);
    let id = admit(&store, REQ);
    let named = |effects: Value| {
        let mut s = spec(&store, &id, effects);
        s.worktree_id = Some("11111111-1111-4111-8111-111111111111".into());
        s
    };
    let err = store
        .insert_publication_effects(&named(json!([{ "kind": "embedding", "data": {} }])))
        .unwrap_err();
    assert!(
        err.message.contains("persistence_effects_worktree_id_fkey"),
        "{err:?}"
    );
    assert!(store.read_request_effects(&id).unwrap().is_empty());
    // an effect already stored is skipped before the worktree matters
    store
        .insert_publication_effects(&spec(
            &store,
            &id,
            json!([{ "kind": "embedding", "data": {} }]),
        ))
        .unwrap();
    assert!(
        store
            .insert_publication_effects(&named(json!([{ "kind": "embedding", "data": {} }])))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_completion_whose_bytes_overflow_is_refused_not_wrapped_into_a_fit() {
    let dir = TempDir::new("effects-completion-overflow");
    let store = open(&dir);
    let id = admit(&store, REQ);
    store
        .insert_publication_effects(&spec(
            &store,
            &id,
            json!([{ "kind": "embedding", "data": {} }]),
        ))
        .unwrap();
    for (result, retained, reservation, intent) in [
        (i64::MAX, 0, 4096, 10),
        (100, 0, i64::MIN, 10),
        // exactly i64::MIN once the reservation is subtracted: only the counter subtraction can refuse it
        (100, 0, i64::MIN + 4096, 10),
        (100, 0, 4096, i64::MIN),
    ] {
        let completion: WriteCompletion = serde_json::from_value(json!({
            "id": id, "state": "committed", "consumerVersion": "v-consumer", "resultBytes": result,
            "counterKeys": KEYS, "intentBytes": intent, "retainedBytes": retained,
            "terminalReservation": reservation,
        }))
        .unwrap();
        // refused (None) or an error, never a committed request
        assert!(
            !matches!(store.complete_write_row(&completion), Ok(Some(_))),
            "{result} {retained} {reservation} {intent}"
        );
    }
}
