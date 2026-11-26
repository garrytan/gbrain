//! The engine graduation drain's blocker reads (`persistence/graduation_blockers.rs`): the PGLite answer of
//! each over the journal, topology, worktree and client records.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::persistence::{
    HostBindingInsert, SourceBindingInsert, TopologyChangeInsert, WorktreeInsert,
    WriteRequestInsert,
};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

const LOCAL: &str = "00000000-0000-4000-8000-00000000000a";
const FOREIGN: &str = "00000000-0000-4000-8000-00000000000b";
const OWNED: &str = "e0000000-0000-4000-8000-0000000000e1";
const UNOWNED: &str = "e0000000-0000-4000-8000-0000000000e2";

fn source(store: &Store, id: &str) -> String {
    let input: SourceInput =
        serde_json::from_value(json!({ "id": id, "name": id, "config": {} })).unwrap();
    store.upsert_source(&input).unwrap().incarnation
}

fn request(
    store: &Store,
    request_id: &str,
    source_id: &str,
    incarnation: &str,
    worktree: Option<&str>,
) {
    let input: WriteRequestInsert = serde_json::from_value(json!({
        "principalKind": "local_cli", "principalId": "graduation", "requestId": request_id, "operation": "put_page",
        "sourceId": source_id, "sourceIncarnation": incarnation, "pageId": null, "slug": "notes/x", "worktreeId": worktree,
        "topologyGeneration": null, "digest": "d", "intent": {}, "authority": {}, "intentBytes": 0, "terminalReservation": 0,
        "targetKind": "page", "protocolVersion": 1, "admitterVersion": "v-test", "admitterHostId": null, "counterKeys": [],
        "clientRequestId": null, "state": "queued", "deferredRefreshId": null,
    }))
    .unwrap();
    store.insert_write_request(&input).unwrap();
}

#[test]
fn the_blocker_reads_list_pending_requests_recoveries_and_foreign_bindings_as_postgres_does() {
    let dir = TempDir::new("graduation-blockers");
    let store = open(&dir);
    let worktree = |id: &str, owner: Option<&str>| -> WorktreeInsert {
        serde_json::from_value(json!({ "id": id, "ownerHostId": owner })).unwrap()
    };
    store
        .insert_worktree(&worktree(OWNED, Some(FOREIGN)))
        .unwrap();
    store.insert_worktree(&worktree(UNOWNED, None)).unwrap();
    // Three sources bound to the owned worktree, in an order a byte sort changes: `a-y` is the byte-first.
    for id in ["ab", "a-z", "a-y"] {
        let incarnation = source(&store, id);
        let binding: SourceBindingInsert = serde_json::from_value(json!({
            "sourceId": id, "incarnation": incarnation, "worktreeId": OWNED, "relativePath": id,
        }))
        .unwrap();
        store.insert_source_binding(&binding).unwrap();
    }
    for (worktree_id, host) in [(OWNED, FOREIGN), (OWNED, LOCAL), (UNOWNED, FOREIGN)] {
        let binding: HostBindingInsert = serde_json::from_value(json!({
            "worktreeId": worktree_id, "hostId": host, "localPath": format!("/r/{worktree_id}"), "coordinationPath": "/r/lock",
        }))
        .unwrap();
        store.insert_host_binding(&binding).unwrap();
    }
    let ab = store.read_source_membership("ab").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string();
    request(
        &store,
        "b0000000-0000-4000-8000-0000000000b2",
        "ab",
        &ab,
        Some(OWNED),
    );
    request(
        &store,
        "b0000000-0000-4000-8000-0000000000b1",
        "ab",
        &ab,
        None,
    );
    let topology: TopologyChangeInsert = serde_json::from_value(json!({
        "principalId": FOREIGN, "requestId": "c0000000-0000-4000-8000-0000000000c1", "digest": "d", "operation": "remove",
        "sourceId": "ab", "sourceIncarnation": null, "worktreeIds": [], "state": "recovering",
        "recovery": null, "recoveryBytes": 0, "intentBytes": 0, "terminalBytes": 0, "outcome": { "expired_only": true },
    }))
    .unwrap();
    store.insert_topology_change(&topology).unwrap();

    // In admission order; the first names the owned worktree, the second no worktree.
    let pending = store.list_graduation_pending_requests().unwrap();
    let shape: Vec<Value> = pending
        .iter()
        .map(|r| {
            json!([
                r["request_id"],
                r["state"],
                r["recovering"],
                r["owner_host_id"]
            ])
        })
        .collect();
    assert_eq!(
        shape,
        vec![
            json!([
                "b0000000-0000-4000-8000-0000000000b2",
                "queued",
                false,
                FOREIGN
            ]),
            json!([
                "b0000000-0000-4000-8000-0000000000b1",
                "queued",
                false,
                null
            ]),
        ]
    );

    let changes = store.list_graduation_topology_recoveries().unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(
        (
            &changes[0]["source_id"],
            &changes[0]["admission"],
            &changes[0]["automatic"]
        ),
        (&json!("ab"), &json!(true), &json!(true))
    );

    // No effect holds a recovery record.
    assert_eq!(
        store.list_graduation_effect_recoveries().unwrap(),
        Vec::<Value>::new()
    );

    // The local host's binding is left out; by worktree then host, each with its worktree's byte-first source.
    assert_eq!(
        store.list_foreign_host_bindings(LOCAL).unwrap(),
        vec![
            json!({ "worktree_id": OWNED, "host_id": FOREIGN, "source_id": "a-y" }),
            json!({ "worktree_id": UNOWNED, "host_id": FOREIGN, "source_id": null }),
        ]
    );
    assert!(store.list_foreign_host_bindings("not-a-uuid").is_err());

    // A store that clears a removed source's client bindings never holds a dangling one.
    assert_eq!(
        store.list_dangling_oauth_clients().unwrap(),
        Vec::<Value>::new()
    );
}
