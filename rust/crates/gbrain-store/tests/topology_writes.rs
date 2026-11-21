//! The topology store writes (rust/docs/store/persistence.md, "Topology store"): what a managed
//! clone and its receipts write in their transactions.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::persistence::{
    CloneSourceInsert, HostBindingInsert, SourceBindingInsert, TopologyChangeInsert,
    TopologyChangeUpdate, WorktreeInsert, WorktreeUpdate,
};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

const HOST: &str = "00000000-0000-4000-8000-00000000000a";
const WORKTREE: &str = "e0000000-0000-4000-8000-0000000000e1";
const SECOND: &str = "e0000000-0000-4000-8000-0000000000e2";
const UNKNOWN: &str = "e0000000-0000-4000-8000-0000000000e9";
const PRINCIPAL: &str = "c0000000-0000-4000-8000-0000000000c1";
const INCARNATION: &str = "b0000000-0000-4000-8000-0000000000b1";

fn source(store: &Store, id: &str) -> String {
    let input: SourceInput = serde_json::from_value(
        json!({ "id": id, "name": id, "config": {}, "local_path": "/var/tmp/work" }),
    )
    .unwrap();
    store.upsert_source(&input).unwrap().incarnation
}

fn worktree(store: &Store, id: &str, generation: i64) {
    let w: WorktreeInsert =
        serde_json::from_value(json!({ "id": id, "ownerHostId": HOST, "ownerEpoch": 1,
        "topologyGeneration": generation, "state": "active" }))
        .unwrap();
    store.insert_worktree(&w).unwrap();
    let h: HostBindingInsert = serde_json::from_value(json!({ "worktreeId": id, "hostId": HOST,
        "localPath": format!("/var/tmp/{id}"), "coordinationPath": format!("/var/tmp/{id}-coord") }))
    .unwrap();
    store.insert_host_binding(&h).unwrap();
}

fn bind(store: &Store, source_id: &str, incarnation: &str, worktree_id: &str) {
    let b: SourceBindingInsert =
        serde_json::from_value(json!({ "sourceId": source_id, "incarnation": incarnation,
        "worktreeId": worktree_id, "relativePath": "" }))
        .unwrap();
    store.insert_source_binding(&b).unwrap();
}

fn update(value: Value) -> WorktreeUpdate {
    serde_json::from_value(value).unwrap()
}

fn change_update(value: Value) -> TopologyChangeUpdate {
    serde_json::from_value(value).unwrap()
}

fn change(
    store: &Store,
    request: &str,
    operation: &str,
    recovery: Value,
    outcome: Value,
) -> String {
    let input: TopologyChangeInsert = serde_json::from_value(json!({ "principalId": PRINCIPAL, "requestId": request,
        "digest": "e".repeat(64), "operation": operation, "sourceId": "work", "sourceIncarnation": INCARNATION,
        "worktreeIds": [WORKTREE], "state": "recovering", "recovery": recovery, "recoveryBytes": 12, "intentBytes": 34,
        "terminalBytes": 4096, "outcome": outcome }))
    .unwrap();
    store.insert_topology_change(&input).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn the_worktree_updates_set_state_and_manifest_and_skip_an_unknown_worktree() {
    let dir = TempDir::new("topology-writes-worktree");
    let store = open(&dir);
    worktree(&store, WORKTREE, 1);
    store
        .topology_update_worktree(UNKNOWN, &update(json!({ "kind": "recover" })))
        .unwrap();
    assert_eq!(store.read_worktree(UNKNOWN).unwrap(), None);

    store
        .topology_update_worktree(WORKTREE, &update(json!({ "kind": "recover" })))
        .unwrap();
    assert_eq!(
        store.read_worktree(WORKTREE).unwrap().unwrap(),
        json!({ "owner_host_id": HOST, "state": "recovering" })
    );
    store
        .topology_update_worktree(WORKTREE, &update(json!({ "kind": "activate" })))
        .unwrap();
    store
        .topology_update_worktree(
            WORKTREE,
            &update(json!({ "kind": "recover_with_manifest", "manifest": { "step": 1 } })),
        )
        .unwrap();
    assert_eq!(
        store.read_worktree(WORKTREE).unwrap().unwrap()["state"],
        json!("recovering")
    );
    assert_eq!(
        store.read_worktree_manifest(WORKTREE).unwrap(),
        Some(json!({ "step": 1 }))
    );
    store
        .topology_update_worktree(
            WORKTREE,
            &update(json!({ "kind": "manifest", "manifest": { "step": 2 } })),
        )
        .unwrap();
    assert_eq!(
        store.read_worktree_manifest(WORKTREE).unwrap(),
        Some(json!({ "step": 2 }))
    );
    assert_eq!(
        store.read_worktree(WORKTREE).unwrap().unwrap()["state"],
        json!("recovering"),
        "a manifest update keeps the state"
    );
    store
        .topology_update_worktree(
            WORKTREE,
            &update(json!({ "kind": "manifest", "manifest": null })),
        )
        .unwrap();
    assert_eq!(store.read_worktree_manifest(WORKTREE).unwrap(), None);
}

#[test]
fn advancing_the_generation_moves_each_worktree_once_and_its_source_bindings_with_it() {
    let dir = TempDir::new("topology-writes-generation");
    let store = open(&dir);
    let work = source(&store, "work");
    let other = source(&store, "other");
    worktree(&store, WORKTREE, 2);
    worktree(&store, SECOND, 7);
    bind(&store, "work", &work, WORKTREE);
    bind(&store, "other", &other, SECOND);
    let ids = vec![WORKTREE.to_string(), WORKTREE.to_string()];
    store.topology_advance_generation(&ids).unwrap();
    let generation = |id: &str| {
        store.get_worktree_binding(id, Some(HOST)).unwrap().unwrap()["topology_generation"].clone()
    };
    assert_eq!(
        generation("work"),
        json!("3"),
        "a repeated id advances once"
    );
    assert_eq!(
        generation("other"),
        json!("1"),
        "another worktree's binding keeps its own generation"
    );
}

#[test]
fn unbinding_a_source_needs_its_incarnation() {
    let dir = TempDir::new("topology-writes-unbind");
    let store = open(&dir);
    let work = source(&store, "work");
    worktree(&store, WORKTREE, 1);
    bind(&store, "work", &work, WORKTREE);
    store.topology_unbind_source("work", INCARNATION).unwrap();
    assert!(
        store
            .get_worktree_binding("work", Some(HOST))
            .unwrap()
            .is_some()
    );
    store.topology_unbind_source("work", &work).unwrap();
    assert_eq!(
        store.get_worktree_binding("work", Some(HOST)).unwrap(),
        None
    );
}

#[test]
fn a_clone_source_keeps_its_incarnation_and_refuses_a_taken_id_or_name() {
    let dir = TempDir::new("topology-writes-source");
    let store = open(&dir);
    let insert = |id: &str, name: &str| -> CloneSourceInsert {
        serde_json::from_value(json!({ "id": id, "name": name, "localPath": "/var/tmp/cloned",
            "config": { "remote_url": "https://example.invalid/x.git" }, "incarnation": INCARNATION }))
        .unwrap()
    };
    store
        .topology_insert_source(&insert("cloned", "cloned"))
        .unwrap();
    let row = store.topology_source("cloned").unwrap().unwrap();
    assert_eq!(row["incarnation"], json!(INCARNATION));
    assert_eq!(
        row["config"]["remote_url"],
        json!("https://example.invalid/x.git")
    );
    for (id, name) in [("cloned", "fresh"), ("fresh", "cloned")] {
        let error = store.topology_insert_source(&insert(id, name)).unwrap_err();
        assert_eq!(error.code, "constraint_violation", "{id}/{name}");
    }
    assert_eq!(store.topology_source("fresh").unwrap(), None);
}

#[test]
fn resetting_a_checkpoint_needs_the_incarnation() {
    let dir = TempDir::new("topology-writes-checkpoint");
    let store = open(&dir);
    let work = source(&store, "work");
    store.advance_source_commit("work", "abc123", None).unwrap();
    let last =
        |store: &Store| store.topology_source("work").unwrap().unwrap()["last_commit"].clone();
    let before = last(&store);
    assert_eq!(before, json!("abc123"));
    store
        .topology_reset_source_checkpoint("work", INCARNATION)
        .unwrap();
    assert_eq!(last(&store), before, "another incarnation changes nothing");
    store
        .topology_reset_source_checkpoint("work", &work)
        .unwrap();
    assert_eq!(last(&store), Value::Null);
}

#[test]
fn each_change_update_keeps_its_guard() {
    let dir = TempDir::new("topology-writes-change");
    let store = open(&dir);
    let request = |n: u8| format!("d0000000-0000-4000-8000-0000000000{n:02x}");
    assert_eq!(store.topology_change(UNKNOWN).unwrap(), None);
    assert_eq!(
        store
            .update_topology_change(UNKNOWN, &change_update(json!({ "kind": "clear_recovery" })))
            .unwrap(),
        None
    );

    let id = change(
        &store,
        &request(1),
        "add",
        json!({ "step": 1 }),
        Value::Null,
    );
    let saved = store
        .update_topology_change(
            &id,
            &change_update(json!({ "kind": "save_recovery", "recovery": { "step": 2 } })),
        )
        .unwrap()
        .unwrap();
    assert_eq!(saved["recovery"], json!({ "step": 2 }));
    let committed = store
        .update_topology_change(
            &id,
            &change_update(json!({ "kind": "commit", "outcome": { "cloned": true } })),
        )
        .unwrap()
        .unwrap();
    assert_eq!(committed["state"], json!("committed"));
    assert_eq!(committed["outcome"], Value::Null, "NULL || x stays NULL");
    assert_eq!(
        store
            .update_topology_change(
                &id,
                &change_update(json!({ "kind": "save_recovery", "recovery": { "step": 3 } })),
            )
            .unwrap(),
        None,
        "a committed change keeps its recovery"
    );
    assert_eq!(
        store.topology_change(&id).unwrap().unwrap()["recovery"],
        json!({ "step": 2 })
    );

    let id = change(
        &store,
        &request(2),
        "add",
        json!({ "step": 1 }),
        json!({ "a": 1, "b": 1 }),
    );
    let committed = store
        .update_topology_change(
            &id,
            &change_update(json!({ "kind": "commit", "outcome": { "b": 2, "c": 3 } })),
        )
        .unwrap()
        .unwrap();
    assert_eq!(committed["outcome"], json!({ "a": 1, "b": 2, "c": 3 }));

    let id = change(
        &store,
        &request(3),
        "add",
        json!({ "step": 1 }),
        Value::Null,
    );
    assert!(
        store
            .update_topology_change(
                &id,
                &change_update(json!({ "kind": "release", "state": "broken", "outcome": {} })),
            )
            .is_err(),
        "a state outside the list refuses"
    );
    let released = store
        .update_topology_change(
            &id,
            &change_update(
                json!({ "kind": "release", "state": "failed", "outcome": { "code": "x" } }),
            ),
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            &released["state"],
            &released["recovery"],
            &released["recovery_bytes"],
            &released["outcome"]
        ),
        (
            &json!("failed"),
            &Value::Null,
            &json!(0),
            &json!({ "code": "x" })
        )
    );

    let id = change(
        &store,
        &request(4),
        "add",
        json!({ "step": 1 }),
        Value::Null,
    );
    let cleared = store
        .update_topology_change(&id, &change_update(json!({ "kind": "clear_recovery" })))
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            &cleared["recovery"],
            &cleared["recovery_bytes"],
            &cleared["intent_bytes"],
            &cleared["state"]
        ),
        (&Value::Null, &json!(0), &json!(0), &json!("recovering"))
    );

    let settle = |state: &str, bytes: i64| {
        change_update(
            json!({ "kind": "settle_retire", "state": state, "outcome": { "removed": true }, "terminal_bytes": bytes }),
        )
    };
    let held = change(
        &store,
        &request(5),
        "remove",
        json!({ "step": 1 }),
        Value::Null,
    );
    assert_eq!(
        store
            .update_topology_change(&held, &settle("committed", 10))
            .unwrap(),
        None,
        "a change with a recovery record does not settle"
    );
    let retire = change(&store, &request(6), "remove", Value::Null, Value::Null);
    assert!(
        store
            .update_topology_change(&retire, &settle("committed", -1))
            .is_err()
    );
    let settled = store
        .update_topology_change(&retire, &settle("committed", 10))
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            &settled["state"],
            &settled["outcome"],
            &settled["terminal_bytes"]
        ),
        (&json!("committed"), &json!({ "removed": true }), &json!(10))
    );
    assert_eq!(
        store
            .update_topology_change(&retire, &settle("committed", 10))
            .unwrap(),
        None,
        "a settled change does not settle again"
    );
}

#[test]
fn retire_admissions_list_other_recovering_retires_in_id_order() {
    let dir = TempDir::new("topology-writes-admissions");
    let store = open(&dir);
    let request = |n: u8| format!("d0000000-0000-4000-8000-0000000000{n:02x}");
    let mine = change(&store, &request(1), "remove", Value::Null, Value::Null);
    let purge = change(&store, &request(2), "purge", Value::Null, Value::Null);
    let remove = change(&store, &request(3), "remove", Value::Null, Value::Null);
    change(
        &store,
        &request(4),
        "remove",
        json!({ "step": 1 }),
        Value::Null,
    );
    change(&store, &request(5), "add", Value::Null, Value::Null);
    let listed: Vec<String> = store
        .topology_retire_admissions("work", INCARNATION, PRINCIPAL, &request(1))
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_string())
        .collect();
    let mut expected = vec![purge, remove];
    expected.sort();
    assert_eq!(listed, expected);
    assert!(!listed.contains(&mine));
    assert!(
        store
            .topology_retire_admissions("other", INCARNATION, PRINCIPAL, &request(1))
            .unwrap()
            .is_empty()
    );
}
