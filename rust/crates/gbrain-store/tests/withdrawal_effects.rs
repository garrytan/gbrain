//! Withdrawal effects: what `insertWithdrawalEffects` stores for a forget under a write request.
//!
//! A managed-request withdrawal queues one `withdrawal-mirror`, `git` and `embedding` row for its
//! source (`WITHDRAWAL_EFFECTS_SQL`, src/core/engine-sql/persistence-journal.ts). The rows carry the
//! source's incarnation and the withdrawal's data; an unknown source queues none, and a kind already
//! queued for the request keeps its data.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::persistence::{WithdrawalEffectsSpec, WriteRequestInsert};
use serde_json::{Value, json};

const REQ: &str = "b0000000-0000-4000-8000-0000000000c1";
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
        "operation": "forget_fact", "sourceId": "default", "sourceIncarnation": incarnation(store),
        "pageId": null, "slug": "people/a", "worktreeId": null, "topologyGeneration": null,
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

fn spec(request: &str, source: &str, data: Value) -> WithdrawalEffectsSpec {
    serde_json::from_value(json!({ "requestId": request, "sourceId": source, "data": data }))
        .unwrap()
}

fn data() -> Value {
    json!({ "version": 2, "targets": [{ "slug": "people/a", "page_id": 1, "revision": "e0000000-0000-4000-8000-0000000000e1" }] })
}

#[test]
fn a_withdrawal_queues_its_three_effects_for_its_source() {
    let dir = TempDir::new("withdrawal-effects");
    let store = open(&dir);
    let id = admit(&store, REQ);
    let kinds = store
        .insert_withdrawal_effects(&spec(&id, "default", data()))
        .unwrap();
    assert_eq!(kinds, ["withdrawal-mirror", "git", "embedding"]);
    let rows = store.read_request_effects(&id).unwrap();
    let stored: Vec<&str> = rows.iter().map(|r| r["kind"].as_str().unwrap()).collect();
    assert_eq!(stored, ["withdrawal-mirror", "git", "embedding"]);
    let inc = incarnation(&store);
    for row in &rows {
        assert_eq!(row["state"], "queued");
        assert_eq!(row["revision"], Value::Null);
        assert_eq!(row["data"], data());
        assert_eq!(row["source_id"], "default");
        assert_eq!(row["source_incarnation"], inc.as_str());
        assert_eq!(row["worktree_id"], Value::Null);
        assert_eq!(row["attempts"], 0);
    }
    // A kind already queued keeps its data (ON CONFLICT DO NOTHING).
    let again = store
        .insert_withdrawal_effects(&spec(
            &id,
            "default",
            json!({ "version": 2, "targets": [] }),
        ))
        .unwrap();
    assert!(again.is_empty());
    let rows = store.read_request_effects(&id).unwrap();
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().all(|r| r["data"] == data()));
}

#[test]
fn an_unknown_source_queues_nothing_and_a_missing_request_refuses() {
    let dir = TempDir::new("withdrawal-effects-refusals");
    let store = open(&dir);
    // No source row: the SELECT yields no row, so nothing is inserted, even for a request that does not exist.
    assert!(
        store
            .insert_withdrawal_effects(&spec(REQ, "no-such-source", data()))
            .unwrap()
            .is_empty()
    );
    // A known source and a request that does not exist: the foreign key refuses.
    let err = store
        .insert_withdrawal_effects(&spec(REQ, "default", data()))
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION, "{err:?}");
    // A request id that is not a uuid refuses as `$1::uuid` does.
    let err = store
        .insert_withdrawal_effects(&spec("not-a-uuid", "default", data()))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT, "{err:?}");
    assert!(store.read_request_effects(REQ).unwrap().is_empty());
}

#[test]
fn a_remirror_queues_its_mirror_and_git_effects_and_reads_them_in_kind_order() {
    let dir = TempDir::new("remirror-effects");
    let store = open(&dir);
    let id = admit(&store, REQ);
    let parked = json!({ "version": 2, "parked": true, "skipped": [{ "slug": "people/a", "reason": "preview_changed" }] });
    assert_eq!(
        store
            .insert_remirror_effects(&spec(&id, "default", parked))
            .unwrap(),
        ["withdrawal-mirror", "git"]
    );
    assert!(
        store
            .insert_remirror_effects(&spec(&id, "default", data()))
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .insert_remirror_effects(&spec(&id, "no-such-source", data()))
            .unwrap()
            .is_empty()
    );
    let states = store.read_remirror_effects(&id).unwrap();
    let kinds: Vec<&str> = states.iter().map(|r| r["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["git", "withdrawal-mirror"]);
    for row in &states {
        assert_eq!(row["state"], "queued");
        assert_eq!(row["recovering"], false);
        assert_eq!(row["parked"], true);
        assert_eq!(
            row["skipped"],
            json!([{ "slug": "people/a", "reason": "preview_changed" }])
        );
    }
    assert!(
        store
            .read_remirror_effects("b0000000-0000-4000-8000-0000000000c9")
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.read_remirror_effects("not-a-uuid").unwrap_err().code,
        INVALID_ARGUMENT
    );
}

/// Postgres stores a uuid in canonical lowercase whatever case the caller sends, so a withdrawal
/// queued under an uppercase request id is found by the mirror gate under either spelling, and its
/// rows read back with the lowercase id.
#[test]
fn an_uppercase_request_id_is_stored_and_found_as_postgres_reads_a_uuid() {
    let dir = TempDir::new("withdrawal-effects-case");
    let store = open(&dir);
    let id = admit(&store, REQ);
    let upper = id.to_uppercase();
    let kinds = store
        .insert_withdrawal_effects(&spec(&upper, "default", data()))
        .unwrap();
    assert_eq!(kinds.len(), 3);
    let ids: Vec<String> = store
        .read_request_effects(&id)
        .unwrap()
        .iter()
        .map(|e| e["request_id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, vec![id.clone(), id.clone(), id.clone()]);
    for lookup in [id.clone(), upper.clone()] {
        let gate = store.read_mirror_gate_rows(&[lookup]).unwrap();
        assert_eq!(gate.len(), 1, "the mirror gate finds the withdrawal mirror");
        assert_eq!(gate[0]["request_id"], json!(id));
    }
    // A second insert under the other spelling queues nothing new.
    assert!(
        store
            .insert_withdrawal_effects(&spec(&id, "default", data()))
            .unwrap()
            .is_empty()
    );
}
