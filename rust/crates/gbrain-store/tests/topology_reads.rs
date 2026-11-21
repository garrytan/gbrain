//! The topology store reads (rust/docs/store/persistence.md, "Topology store"): what a source
//! lifecycle change reads before its first write.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::persistence::{HostBindingInsert, SourceBindingInsert, WorktreeInsert};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

const HOST: &str = "00000000-0000-4000-8000-00000000000a";
const OTHER_HOST: &str = "00000000-0000-4000-8000-00000000000b";
const WORKTREE: &str = "e0000000-0000-4000-8000-0000000000e1";
const SECOND: &str = "e0000000-0000-4000-8000-0000000000e2";
const UNKNOWN: &str = "e0000000-0000-4000-8000-0000000000e9";
/// md5 of the empty string: the stamp of a worktree with no page (Postgres `md5('')`).
const EMPTY_STAMP: &str = "d41d8cd98f00b204e9800998ecf8427e";

fn source(store: &Store, id: &str) -> String {
    let input: SourceInput = serde_json::from_value(
        json!({ "id": id, "name": id, "config": { "remote_url": "https://example.invalid/x.git" }, "local_path": "/var/tmp/work" }),
    )
    .unwrap();
    store.upsert_source(&input).unwrap().incarnation
}

fn claim(
    store: &Store,
    worktree: &str,
    host: &str,
    path: &str,
    source_id: &str,
    incarnation: &str,
) {
    let w: WorktreeInsert = serde_json::from_value(json!({ "id": worktree, "ownerHostId": host, "ownerEpoch": 4, "topologyGeneration": 2, "state": "active" })).unwrap();
    store.insert_worktree(&w).unwrap();
    let h: HostBindingInsert = serde_json::from_value(json!({ "worktreeId": worktree, "hostId": host, "localPath": path, "coordinationPath": format!("{path}-coord") })).unwrap();
    store.insert_host_binding(&h).unwrap();
    let b: SourceBindingInsert = serde_json::from_value(json!({ "sourceId": source_id, "incarnation": incarnation, "worktreeId": worktree, "relativePath": "" })).unwrap();
    store.insert_source_binding(&b).unwrap();
}

#[test]
fn the_topology_reads_answer_a_claimed_worktree_and_nothing_for_an_unknown_one() {
    let dir = TempDir::new("topology-reads");
    let store = open(&dir);
    assert_eq!(store.topology_source("work").unwrap(), None);
    let work = source(&store, "work");
    let other = source(&store, "other");
    claim(
        &store,
        SECOND,
        OTHER_HOST,
        "/var/tmp/other",
        "other",
        &other,
    );
    claim(&store, WORKTREE, HOST, "/var/tmp/work", "work", &work);

    let row = store.topology_source("work").unwrap().unwrap();
    assert_eq!(row["incarnation"], json!(work));
    assert_eq!(
        row["config"]["remote_url"],
        json!("https://example.invalid/x.git")
    );
    assert_eq!(row["last_commit"], Value::Null);

    let host_rows = store.topology_host_worktrees(HOST).unwrap();
    assert_eq!(
        host_rows,
        vec![
            json!({ "worktree_id": WORKTREE, "owner_host_id": HOST, "owner_epoch": "4", "state": "active",
            "topology_generation": "2", "local_path": "/var/tmp/work", "coordination_path": "/var/tmp/work-coord" })
        ]
    );

    let ids = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(
        store.topology_members(&ids(&[SECOND, WORKTREE])).unwrap(),
        vec!["other", "work"]
    );
    assert!(store.topology_members(&ids(&[UNKNOWN])).unwrap().is_empty());
    let owners = store
        .topology_owners(&ids(&[SECOND, UNKNOWN, WORKTREE]))
        .unwrap();
    let owner_ids: Vec<&Value> = owners.iter().map(|o| &o["id"]).collect();
    assert_eq!(owner_ids, vec![&json!(WORKTREE), &json!(SECOND)]);
    assert_eq!(
        store.topology_canonical_stamp(WORKTREE).unwrap(),
        EMPTY_STAMP
    );
    assert_eq!(
        store.topology_canonical_stamp(UNKNOWN).unwrap(),
        EMPTY_STAMP
    );
    assert!(
        store
            .topology_unsettled_requests(&ids(&["work"]), &ids(&[WORKTREE]))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .topology_blocking_effect(&ids(&["work"]), &ids(&[WORKTREE]))
            .unwrap(),
        None
    );
}

#[test]
fn a_worktree_id_that_is_not_a_uuid_refuses() {
    let dir = TempDir::new("topology-reads-uuid");
    let store = open(&dir);
    assert!(store.topology_canonical_stamp("not-a-uuid").is_err());
    assert!(store.topology_members(&["not-a-uuid".to_string()]).is_err());
}

#[test]
fn the_lifecycle_read_answers_the_source_row_and_none_for_an_unknown_source() {
    let dir = TempDir::new("topology-lifecycle-source");
    let store = open(&dir);
    assert_eq!(store.topology_lifecycle_source("work").unwrap(), None);
    assert_eq!(store.topology_lifecycle_source("bad\0id").unwrap(), None);
    let work = source(&store, "work");
    assert_eq!(
        store.topology_lifecycle_source("work").unwrap(),
        Some(json!({
            "id": "work",
            "incarnation": work,
            "archived": false,
            "local_path": "/var/tmp/work",
            "config": { "remote_url": "https://example.invalid/x.git" },
            "name": "work",
            "last_commit": Value::Null,
        }))
    );
    assert!(store.set_source_archived("work", true).unwrap());
    let archived = store.topology_lifecycle_source("work").unwrap().unwrap();
    assert_eq!(archived["archived"], json!(true));
    assert_eq!(archived["incarnation"], json!(work));
}
