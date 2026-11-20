//! Worktree bindings: the rows an unmanaged writer claim records and the reads of them.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::persistence::{HostBindingInsert, SourceBindingInsert, WorktreeInsert};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

const HOST_A: &str = "00000000-0000-4000-8000-00000000000a";
const HOST_B: &str = "00000000-0000-4000-8000-00000000000b";
const WORKTREE: &str = "e0000000-0000-4000-8000-0000000000e1";
const OTHER_WORKTREE: &str = "e0000000-0000-4000-8000-0000000000e2";
const STALE: &str = "f0000000-0000-4000-8000-0000000000f1";

fn source(store: &Store, id: &str, config: Value) -> String {
    let input: SourceInput =
        serde_json::from_value(json!({ "id": id, "name": id, "config": config })).unwrap();
    store.upsert_source(&input).unwrap().incarnation
}

fn worktree(value: Value) -> WorktreeInsert {
    serde_json::from_value(value).unwrap()
}

fn host(worktree_id: &str, host_id: &str, path: &str) -> HostBindingInsert {
    serde_json::from_value(json!({
        "worktreeId": worktree_id,
        "hostId": host_id,
        "localPath": path,
        "coordinationPath": format!("{path}-coord"),
    }))
    .unwrap()
}

fn binding(source_id: &str, incarnation: &str, worktree_id: &str) -> SourceBindingInsert {
    serde_json::from_value(json!({
        "sourceId": source_id,
        "incarnation": incarnation,
        "worktreeId": worktree_id,
        "relativePath": "notes",
    }))
    .unwrap()
}

/// The parity seed: worktree owned by HOST_A at epoch 7, generation 3, draining, prepared.
fn seed(store: &Store, source_id: &str, incarnation: &str) {
    store
        .insert_worktree(&worktree(json!({
            "id": WORKTREE,
            "ownerHostId": HOST_A,
            "ownerEpoch": 7,
            "topologyGeneration": 3,
            "state": "draining",
            "manifest": { "prepared_at": "2026-01-02T03:04:05Z" },
        })))
        .unwrap();
    let mut h = host(WORKTREE, HOST_A, "/var/tmp/work-root");
    h.coordination_path = "/var/tmp/work-coord".into();
    h.git_durability = Some("enabled".into());
    store.insert_host_binding(&h).unwrap();
    let mut b = binding(source_id, incarnation, WORKTREE);
    b.topology_generation = Some(3);
    store.insert_source_binding(&b).unwrap();
}

#[test]
fn a_binding_reads_back_with_this_hosts_paths_and_null_host_columns_elsewhere() {
    let dir = TempDir::new("worktrees-read");
    let store = open(&dir);
    let incarnation = source(&store, "work", json!({ "canonical": "git" }));
    source(&store, "loose", json!({}));
    assert!(
        store
            .get_worktree_binding("work", Some(HOST_A))
            .unwrap()
            .is_none()
    );
    seed(&store, "work", &incarnation);
    let owner = store
        .get_worktree_binding("work", Some(HOST_A))
        .unwrap()
        .unwrap();
    assert_eq!(
        owner,
        json!({
            "source_id": "work",
            "source_incarnation": incarnation,
            "worktree_id": WORKTREE,
            "relative_path": "notes",
            "topology_generation": "3",
            "owner_host_id": HOST_A,
            "owner_epoch": "7",
            "state": "draining",
            "local_path": "/var/tmp/work-root",
            "coordination_path": "/var/tmp/work-coord",
            "git_durability": "enabled",
            "prepared_at": "2026-01-02T03:04:05Z",
            "canonical_git": true,
        })
    );
    for other in [Some(HOST_B), None] {
        let row = store.get_worktree_binding("work", other).unwrap().unwrap();
        assert_eq!(row["local_path"], Value::Null);
        assert_eq!(row["coordination_path"], Value::Null);
        assert_eq!(row["git_durability"], Value::Null);
        assert_eq!(row["owner_epoch"], "7");
    }
    assert!(
        store
            .get_worktree_binding("loose", Some(HOST_A))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .get_worktree_binding("work", Some("not-a-uuid"))
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}

#[test]
fn a_source_is_claimed_only_at_its_bound_incarnation() {
    let dir = TempDir::new("worktrees-claimed");
    let store = open(&dir);
    let incarnation = source(&store, "work", json!({}));
    source(&store, "stale", json!({}));
    source(&store, "loose", json!({}));
    seed(&store, "work", &incarnation);
    store
        .insert_source_binding(&binding("stale", STALE, WORKTREE))
        .unwrap();
    assert!(store.is_source_claimed("work").unwrap());
    assert!(!store.is_source_claimed("stale").unwrap());
    assert!(!store.is_source_claimed("loose").unwrap());
    assert!(!store.is_source_claimed("no-such-source").unwrap());
}

#[test]
fn the_inserts_refuse_what_the_table_keys_and_checks_refuse() {
    let dir = TempDir::new("worktrees-refuse");
    let store = open(&dir);
    let incarnation = source(&store, "work", json!({}));
    let code = |r: gbrain_store::error::Result<()>| r.unwrap_err().code;
    // A source or host binding needs its worktree (the foreign key).
    assert_eq!(
        code(store.insert_host_binding(&host(WORKTREE, HOST_A, "/r"))),
        CONSTRAINT_VIOLATION
    );
    assert_eq!(
        code(store.insert_source_binding(&binding("work", &incarnation, WORKTREE))),
        CONSTRAINT_VIOLATION
    );
    store
        .insert_worktree(&worktree(
            json!({ "id": WORKTREE, "ownerHostId": HOST_A, "ownerEpoch": 1 }),
        ))
        .unwrap();
    // The primary keys.
    assert_eq!(
        code(store.insert_worktree(&worktree(json!({ "id": WORKTREE })))),
        CONSTRAINT_VIOLATION
    );
    store
        .insert_host_binding(&host(WORKTREE, HOST_A, "/r"))
        .unwrap();
    assert_eq!(
        code(store.insert_host_binding(&host(WORKTREE, HOST_A, "/other"))),
        CONSTRAINT_VIOLATION
    );
    store
        .insert_source_binding(&binding("work", &incarnation, WORKTREE))
        .unwrap();
    assert_eq!(
        code(store.insert_source_binding(&binding("work", &incarnation, WORKTREE))),
        CONSTRAINT_VIOLATION
    );
    // The CHECKs.
    assert_eq!(
        code(store.insert_worktree(&worktree(json!({ "id": OTHER_WORKTREE, "state": "gone" })))),
        CONSTRAINT_VIOLATION
    );
    let mut bad = host(WORKTREE, HOST_B, "/r");
    bad.git_durability = Some("maybe".into());
    assert_eq!(code(store.insert_host_binding(&bad)), CONSTRAINT_VIOLATION);
    // The uuid casts.
    assert_eq!(
        code(store.insert_worktree(&worktree(json!({ "id": "not-a-uuid" })))),
        INVALID_ARGUMENT
    );
    // Nothing a refusal touched was kept.
    assert!(store.read_worktree(OTHER_WORKTREE).unwrap().is_none());
    assert!(store.read_host_binding(WORKTREE, HOST_B).unwrap().is_none());
}

#[test]
fn a_worktree_takes_the_column_defaults_and_the_claim_reads_answer_it() {
    let dir = TempDir::new("worktrees-defaults");
    let store = open(&dir);
    let incarnation = source(&store, "work", json!({}));
    store
        .insert_worktree(&worktree(
            json!({ "id": WORKTREE.to_uppercase(), "ownerHostId": HOST_A, "ownerEpoch": 1 }),
        ))
        .unwrap();
    store
        .insert_host_binding(&host(WORKTREE, HOST_A, "/var/tmp/r"))
        .unwrap();
    store
        .insert_source_binding(&binding("work", &incarnation, WORKTREE))
        .unwrap();
    assert_eq!(
        store.read_worktree(WORKTREE).unwrap().unwrap(),
        json!({ "owner_host_id": HOST_A, "state": "active" })
    );
    assert_eq!(
        store.read_host_binding(WORKTREE, HOST_A).unwrap().unwrap(),
        json!({ "local_path": "/var/tmp/r", "coordination_path": "/var/tmp/r-coord" })
    );
    let row = store
        .get_worktree_binding("work", Some(HOST_A))
        .unwrap()
        .unwrap();
    assert_eq!(row["topology_generation"], "1");
    assert_eq!(row["owner_epoch"], "1");
    assert_eq!(row["prepared_at"], Value::Null);
    assert_eq!(row["canonical_git"], false);
    assert_eq!(
        store.list_host_worktrees(HOST_A).unwrap(),
        vec![json!({
            "worktree_id": WORKTREE,
            "host_id": HOST_A,
            "local_path": "/var/tmp/r",
            "coordination_path": "/var/tmp/r-coord",
            "git_durability": null,
            "owner_host_id": HOST_A,
        })]
    );
    assert!(store.list_host_worktrees(HOST_B).unwrap().is_empty());
    assert_eq!(
        store.list_host_root_bindings(HOST_A).unwrap(),
        vec![json!({
            "local_path": "/var/tmp/r",
            "source_id": "work",
            "source_incarnation": incarnation,
            "worktree_id": WORKTREE,
            "topology_generation": "1",
        })]
    );
    assert!(store.list_host_root_bindings(HOST_B).unwrap().is_empty());
}

#[test]
fn the_heartbeat_stamp_touches_only_the_hosts_own_worktrees() {
    let dir = TempDir::new("worktrees-heartbeat");
    let store = open(&dir);
    store
        .insert_worktree(&worktree(
            json!({ "id": WORKTREE, "ownerHostId": HOST_A, "ownerEpoch": 1 }),
        ))
        .unwrap();
    store
        .insert_worktree(&worktree(
            json!({ "id": OTHER_WORKTREE, "ownerHostId": HOST_B, "ownerEpoch": 1 }),
        ))
        .unwrap();
    assert!(store.read_worktree_heartbeat(WORKTREE).unwrap().is_none());
    assert_eq!(store.stamp_worktree_heartbeats(HOST_A).unwrap(), 1);
    assert!(store.read_worktree_heartbeat(WORKTREE).unwrap().is_some());
    assert!(
        store
            .read_worktree_heartbeat(OTHER_WORKTREE)
            .unwrap()
            .is_none()
    );
    assert_eq!(store.stamp_worktree_heartbeats(STALE).unwrap(), 0);
    assert_eq!(
        store.stamp_worktree_heartbeats("nope").unwrap_err().code,
        INVALID_ARGUMENT
    );
}

#[test]
fn a_rolled_back_claim_keeps_no_row() {
    let dir = TempDir::new("worktrees-rollback");
    let store = open(&dir);
    let incarnation = source(&store, "work", json!({}));
    let tx = store.begin_transaction(false).unwrap();
    tx.insert_worktree(&worktree(
        json!({ "id": WORKTREE, "ownerHostId": HOST_A, "ownerEpoch": 1 }),
    ))
    .unwrap();
    tx.insert_source_binding(&binding("work", &incarnation, WORKTREE))
        .unwrap();
    assert!(tx.is_source_claimed("work").unwrap());
    tx.rollback_transaction().unwrap();
    assert!(!store.is_source_claimed("work").unwrap());
    assert!(store.read_worktree(WORKTREE).unwrap().is_none());
}
