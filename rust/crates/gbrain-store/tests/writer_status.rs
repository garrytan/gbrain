//! The reads of `gbrain sources writer status` (rust/docs/store/persistence.md, "Writer status"):
//! the writer diagnostics row sets, the status bindings, the onboarding sources and the
//! blocking effects.

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

fn source(store: &Store, id: &str, local_path: Option<&str>, config: Value) -> String {
    let input: SourceInput = serde_json::from_value(
        json!({ "id": id, "name": id, "local_path": local_path, "config": config }),
    )
    .unwrap();
    store.upsert_source(&input).unwrap().incarnation
}

/// A worktree owned by HOST_A at epoch 7, generation 3, with a prepared manifest, bound on
/// HOST_A with git durability on.
fn seed(store: &Store, source_id: &str, incarnation: &str) {
    let worktree: WorktreeInsert = serde_json::from_value(json!({
        "id": WORKTREE,
        "ownerHostId": HOST_A,
        "ownerEpoch": 7,
        "topologyGeneration": 3,
        "manifest": { "prepared_at": "2026-01-02T03:04:05Z", "digest": "sha256:example" },
    }))
    .unwrap();
    store.insert_worktree(&worktree).unwrap();
    let host: HostBindingInsert = serde_json::from_value(json!({
        "worktreeId": WORKTREE,
        "hostId": HOST_A,
        "localPath": "/var/tmp/work-root",
        "coordinationPath": "/var/tmp/work-coord",
        "gitDurability": "enabled",
    }))
    .unwrap();
    store.insert_host_binding(&host).unwrap();
    let binding: SourceBindingInsert = serde_json::from_value(json!({
        "sourceId": source_id,
        "incarnation": incarnation,
        "worktreeId": WORKTREE,
        "relativePath": "notes",
        "topologyGeneration": 3,
    }))
    .unwrap();
    store.insert_source_binding(&binding).unwrap();
}

#[test]
fn the_status_bindings_carry_this_hosts_path_and_durability_and_none_elsewhere() {
    let dir = TempDir::new("writer-status-bindings");
    let store = open(&dir);
    let incarnation = source(&store, "work", Some("/var/tmp/work-root"), json!({}));
    assert_eq!(
        store.writer_status_rows(Some(HOST_A), None).unwrap(),
        json!({ "bindings": [], "topology_requests": [] })
    );
    seed(&store, "work", &incarnation);
    let mine = store
        .writer_status_rows(Some(HOST_A), Some("work"))
        .unwrap();
    assert_eq!(
        mine,
        json!({
            "bindings": [{
                "source_id": "work",
                "source_incarnation": incarnation,
                "worktree_id": WORKTREE,
                "relative_path": "notes",
                "topology_generation": "3",
                "owner_host_id": HOST_A,
                "owner_epoch": "7",
                "state": "active",
                "manifest_digest": "sha256:example",
                "prepared_at": "2026-01-02T03:04:05Z",
                "local_path": "/var/tmp/work-root",
                "git_durability": "enabled",
                "git_durability_state": "on",
            }],
            "topology_requests": [],
        })
    );
    // Another host, or no host, reads the binding without this host's columns.
    for other in [Some(HOST_B), None] {
        let rows = store.writer_status_rows(other, None).unwrap();
        let row = &rows["bindings"][0];
        assert_eq!(row["local_path"], Value::Null);
        assert_eq!(row["git_durability"], Value::Null);
        assert_eq!(row["git_durability_state"], "unknown");
        assert_eq!(row["owner_epoch"], "7");
    }
    assert_eq!(
        store
            .writer_status_rows(Some(HOST_A), Some("other"))
            .unwrap()["bindings"],
        json!([])
    );
    assert_eq!(
        store
            .writer_status_rows(Some("not-a-uuid"), None)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}

#[test]
fn the_diagnostics_list_each_worktree_with_zero_counts_when_nothing_is_queued() {
    let dir = TempDir::new("writer-status-diagnostics");
    let store = open(&dir);
    let incarnation = source(&store, "work", None, json!({}));
    seed(&store, "work", &incarnation);
    let rows = store
        .writer_diagnostic_rows(Some("2026-01-01T00:00:00.000Z"), &["fence".to_string()])
        .unwrap();
    assert_eq!(
        rows["worktrees"],
        json!([{
            "id": WORKTREE,
            "owner_host_id": HOST_A,
            "owner_epoch": "7",
            "topology_generation": "3",
            "state": "active",
            "heartbeat_at": null,
            "queued": 0,
            "running": 0,
            "recovering": 0,
            "oldest_request_at": null,
            "last_completed_sequence": null,
            "recovery_bytes": "0",
            "recovering_effects": 0,
        }])
    );
    for set in ["blockers", "queue", "effects", "failures"] {
        assert_eq!(rows[set], json!([]), "{set}");
    }
    assert!(rows["counters"].is_array());
    assert_eq!(
        store
            .writer_diagnostic_rows(Some("yesterday"), &[])
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    assert!(store.writer_diagnostic_rows(None, &[]).is_ok());
}

#[test]
fn the_onboarding_sources_are_the_active_sources_in_byte_order() {
    let dir = TempDir::new("writer-status-onboarding");
    let store = open(&dir);
    let work = source(
        &store,
        "work-2",
        Some("/var/tmp/w2"),
        json!({ "kind": "git" }),
    );
    source(&store, "work", None, json!({}));
    let all = store.onboarding_sources(None).unwrap();
    let ids: Vec<&str> = all.iter().map(|s| s["id"].as_str().unwrap()).collect();
    let mut sorted = ids.clone();
    sorted.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    assert_eq!(ids, sorted);
    assert!(ids.contains(&"work") && ids.contains(&"work-2"));
    assert_eq!(
        store.onboarding_sources(Some("work-2")).unwrap(),
        vec![
            json!({ "id": "work-2", "local_path": "/var/tmp/w2", "incarnation": work, "kind": "git" })
        ]
    );
    assert_eq!(
        store.onboarding_sources(Some("missing")).unwrap(),
        Vec::<Value>::new()
    );
}

#[test]
fn no_effect_blocks_a_brain_with_no_effects() {
    let dir = TempDir::new("writer-status-blocking");
    let store = open(&dir);
    assert!(
        store
            .blocking_effect_rows(None, 20, false)
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .blocking_effect_rows(Some("work"), 20, true)
            .unwrap()
            .is_empty()
    );
}
