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

fn lock(holder_pid: i64, token: &str) -> gbrain_store::jobs::LockAcquire {
    gbrain_store::jobs::LockAcquire {
        holder_pid,
        holder_host: Some("host-a".into()),
        acquisition_token: token.into(),
        ttl_minutes: 30.0,
        steal_grace_seconds: 0.0,
    }
}

#[test]
fn the_writer_admin_state_is_the_jsonb_text_of_the_topology_without_embedding_leases() {
    let dir = TempDir::new("worktrees-admin-state");
    let store = open(&dir);
    let brain = format!(
        "{{\"id\": \"{}\", \"enabled\": false, \"mode_epoch\": 1, \"skill_bundles_enabled\": false, \"writer_protocol_floor\": 1}}",
        store.brain_id()
    );
    let first = store.writer_admin_state_text().unwrap();
    let parsed: Value = serde_json::from_str(&first).unwrap();
    let sources = match parsed["sources"].as_array() {
        None => "null".to_string(),
        Some(rows) => {
            assert_eq!(rows.len(), 1, "{first}");
            let inc = rows[0][1].as_str().unwrap();
            format!(
                "[[\"{}\", \"{inc}\", false, null, null]]",
                rows[0][0].as_str().unwrap()
            )
        }
    };
    assert_eq!(
        first,
        format!(
            "{{\"brain\": {brain}, \"hosts\": null, \"sources\": {sources}, \"bindings\": null, \"fallback\": null, \"worktrees\": null, \"legacy_locks\": null}}"
        ),
    );
    // Byte order: "a-b" sorts before "ab" ('-' is 0x2d), whatever the server's locale.
    let ab = source(&store, "ab", json!({ "kind": "notes" }));
    let a_b = source(&store, "a-b", json!({ "kind": 7 }));
    seed(&store, "ab", &ab);
    store.set_config("sync.repo_path", "/var/tmp/repo").unwrap();
    store
        .acquire_cycle_lock(
            "gbrain-cycle",
            &lock(42, "d0000000-0000-4000-8000-0000000000d1"),
        )
        .unwrap()
        .unwrap();
    store
        .acquire_cycle_lock(
            "embed-page:7",
            &lock(43, "d0000000-0000-4000-8000-0000000000d2"),
        )
        .unwrap()
        .unwrap();
    let text = store.writer_admin_state_text().unwrap();
    let state: Value = serde_json::from_str(&text).unwrap();
    let sources = state["sources"].as_array().unwrap();
    let ids: Vec<&str> = sources.iter().map(|s| s[0].as_str().unwrap()).collect();
    assert_eq!(
        ids.iter()
            .filter(|id| **id != "default")
            .collect::<Vec<_>>(),
        [&"a-b", &"ab"]
    );
    assert_eq!(sources[0], json!(["a-b", a_b, false, null, "7"]));
    assert_eq!(sources[1], json!(["ab", ab, false, null, "notes"]));
    assert_eq!(state["fallback"], json!("/var/tmp/repo"));
    assert_eq!(
        state["worktrees"],
        json!([[WORKTREE, HOST_A, "7", "3", "draining", { "prepared_at": "2026-01-02T03:04:05Z" }]])
    );
    assert_eq!(
        state["bindings"],
        json!([["ab", ab, WORKTREE, "notes", "3"]])
    );
    assert_eq!(
        state["hosts"],
        json!([[
            WORKTREE,
            HOST_A,
            "/var/tmp/work-root",
            "/var/tmp/work-coord",
            "enabled"
        ]])
    );
    let locks = state["legacy_locks"].as_array().unwrap();
    assert_eq!(locks.len(), 1, "the page embedding lease is left out");
    assert_eq!(
        locks[0].as_array().unwrap()[..4],
        [
            json!("gbrain-cycle"),
            json!(42),
            json!("host-a"),
            json!("d0000000-0000-4000-8000-0000000000d1")
        ]
    );
    let at = locks[0][4].as_str().unwrap();
    assert!(at.ends_with("+00:00") && at.as_bytes()[10] == b'T', "{at}");
    assert!(
        text.starts_with(&format!("{{\"brain\": {brain}, \"hosts\": [[")),
        "{text}"
    );
    assert_eq!(
        store.writer_admin_state_text().unwrap(),
        text,
        "a second read is the same text"
    );
}

#[test]
fn a_transfer_prepare_drains_the_worktree_and_a_cancel_reactivates_it() {
    let dir = TempDir::new("worktrees-transfer");
    let store = open(&dir);
    store
        .insert_worktree(&worktree(
            json!({ "id": OTHER_WORKTREE, "ownerHostId": HOST_B, "ownerEpoch": 1 }),
        ))
        .unwrap();
    assert_eq!(store.prepared_transfer_worktree().unwrap(), None);
    assert_eq!(
        store.read_worktree_owner(OTHER_WORKTREE).unwrap(),
        Some(
            json!({ "owner_host_id": HOST_B, "owner_epoch": "1", "state": "active", "manifest": null })
        )
    );
    assert_eq!(store.read_worktree_owner(STALE).unwrap(), None);
    assert!(!store.worktree_publication_pending(OTHER_WORKTREE).unwrap());

    store
        .mark_worktree_draining(OTHER_WORKTREE, &json!({ "file_count": 1 }))
        .unwrap();
    assert_eq!(
        store.prepared_transfer_worktree().unwrap().as_deref(),
        Some(OTHER_WORKTREE)
    );
    let state: Value = serde_json::from_str(&store.writer_admin_state_text().unwrap()).unwrap();
    let row = &state["worktrees"][0];
    assert_eq!(row[4], json!("draining"));
    assert_eq!(row[5]["file_count"], json!(1));
    let at = row[5]["prepared_at"].as_str().unwrap();
    assert!(at.ends_with("+00:00"), "{at}");
    assert_eq!(
        store.read_worktree_owner(OTHER_WORKTREE).unwrap().unwrap()["state"],
        json!("draining")
    );
    assert!(
        store
            .mark_worktree_draining(OTHER_WORKTREE, &json!([1]))
            .is_err(),
        "a manifest is an object"
    );

    store.reactivate_worktree(OTHER_WORKTREE).unwrap();
    assert_eq!(store.prepared_transfer_worktree().unwrap(), None);
    let state: Value = serde_json::from_str(&store.writer_admin_state_text().unwrap()).unwrap();
    assert_eq!(state["worktrees"][0][4], json!("active"));
    assert_eq!(state["worktrees"][0][5], Value::Null);
    // A missing worktree changes nothing, as an UPDATE that matches no row.
    store.reactivate_worktree(STALE).unwrap();
    store.mark_worktree_draining(STALE, &json!({})).unwrap();
    assert_eq!(store.read_worktree_owner(STALE).unwrap(), None);
}

#[test]
fn a_source_delete_removes_the_binding_of_its_incarnation_and_keeps_the_worktree() {
    let dir = TempDir::new("worktrees-source-delete");
    let store = open(&dir);
    let incarnation = source(&store, "work", json!({}));
    seed(&store, "work", &incarnation);
    assert!(store.delete_source_record("work", false).unwrap());
    assert!(store.get_worktree_binding("work", None).unwrap().is_none());
    assert!(store.read_worktree(WORKTREE).unwrap().is_some());
    assert!(store.read_host_binding(WORKTREE, HOST_A).unwrap().is_some());
    let reborn = source(&store, "work", json!({}));
    store
        .insert_source_binding(&binding("work", &reborn, WORKTREE))
        .unwrap();

    // A binding of another incarnation is an orphan already: the delete leaves it for repair.
    let stale = TempDir::new("worktrees-source-delete-stale");
    let store = open(&stale);
    source(&store, "work", json!({}));
    seed(&store, "work", STALE);
    assert!(store.delete_source_record("work", false).unwrap());
    assert!(store.get_worktree_binding("work", None).unwrap().is_some());
}

#[test]
fn a_transfer_accept_moves_the_owner_binding_and_content_receipt_to_the_successor() {
    let dir = TempDir::new("worktrees-accept");
    let store = open(&dir);
    let incarnation = source(&store, "work", json!({}));
    let other = source(&store, "other", json!({}));
    seed(&store, "work", &incarnation);
    store
        .insert_source_binding(&binding("other", &other, OTHER_WORKTREE))
        .expect_err("an unknown worktree is refused");
    let key = format!("shared_skills.content.v1.work.{incarnation}");
    store.set_config(&key, "{\"root\":\"/old\"}").unwrap();

    assert_eq!(
        store.read_worktree_manifest(WORKTREE).unwrap(),
        Some(json!({ "prepared_at": "2026-01-02T03:04:05Z" }))
    );
    assert_eq!(store.read_worktree_manifest(STALE).unwrap(), None);
    assert_eq!(
        store.read_worktree_owner(WORKTREE).unwrap().unwrap()["manifest"],
        json!({ "prepared_at": "2026-01-02T03:04:05Z" })
    );

    // The successor host has no binding yet: no receipt row for it.
    let ids = vec![WORKTREE.to_string()];
    assert!(
        store
            .content_receipt_rows(&ids, HOST_B, None)
            .unwrap()
            .is_empty()
    );
    store
        .upsert_host_binding(&host(WORKTREE, HOST_B, "/var/tmp/successor"))
        .unwrap();
    let rows = store.content_receipt_rows(&ids, HOST_B, None).unwrap();
    assert_eq!(
        rows,
        vec![json!({
            "source_id": "work",
            "incarnation": incarnation,
            "relative_path": "notes",
            "local_path": "/var/tmp/successor",
            "brain_id": store.brain_id(),
            "key": key,
            "value": "{\"root\":\"/old\"}",
        })]
    );
    assert!(
        store
            .content_receipt_rows(&ids, HOST_B, Some(&["other".to_string()]))
            .unwrap()
            .is_empty(),
        "the source filter applies"
    );

    // A rebind of an existing binding keeps its Git durability.
    store
        .upsert_host_binding(&host(WORKTREE, HOST_A, "/var/tmp/moved"))
        .unwrap();
    let state: Value = serde_json::from_str(&store.writer_admin_state_text().unwrap()).unwrap();
    assert_eq!(
        state["hosts"][0],
        json!([
            WORKTREE,
            HOST_A,
            "/var/tmp/moved",
            "/var/tmp/moved-coord",
            "enabled"
        ])
    );
    assert_eq!(state["hosts"][1][4], Value::Null);
    assert!(
        store
            .upsert_host_binding(&host(STALE, HOST_B, "/var/tmp/x"))
            .is_err(),
        "an unknown worktree is refused"
    );

    assert!(!store.swap_config_value(&key, "{}", "stale").unwrap());
    assert!(
        store
            .swap_config_value(&key, "{}", "{\"root\":\"/old\"}")
            .unwrap()
    );
    assert_eq!(store.get_config(&key).unwrap().as_deref(), Some("{}"));

    store.accept_worktree_owner(WORKTREE, HOST_B).unwrap();
    let owner = store.read_worktree_owner(WORKTREE).unwrap().unwrap();
    assert_eq!(owner["owner_host_id"], json!(HOST_B));
    assert_eq!(owner["owner_epoch"], json!("8"));
    assert_eq!(owner["state"], json!("active"));
    assert_eq!(
        owner["manifest"],
        json!({ "prepared_at": "2026-01-02T03:04:05Z" }),
        "the manifest is kept"
    );
    assert!(store.read_worktree_heartbeat(WORKTREE).unwrap().is_some());
    store.accept_worktree_owner(STALE, HOST_B).unwrap();
    assert_eq!(store.read_worktree_owner(STALE).unwrap(), None);
}

#[test]
fn a_cross_host_accept_carries_git_durability_and_a_plain_rebind_keeps_it() {
    // #10123: `carryDurability` takes the input value when it is set, else the existing one
    // (`COALESCE(EXCLUDED.git_durability, existing)`); without it an existing binding keeps its own.
    let dir = TempDir::new("worktrees-carry");
    let store = open(&dir);
    let incarnation = source(&store, "work", json!({}));
    seed(&store, "work", &incarnation);
    let hosts = |store: &Store| -> Value {
        let state: Value = serde_json::from_str(&store.writer_admin_state_text().unwrap()).unwrap();
        state["hosts"].clone()
    };
    let durability = |store: &Store, host_id: &str| -> Value {
        hosts(store)
            .as_array()
            .unwrap()
            .iter()
            .find(|h| h[1] == host_id)
            .map(|h| h[4].clone())
            .unwrap()
    };
    let with = |host_id: &str, path: &str, g: Option<&str>, carry: bool| -> HostBindingInsert {
        let mut h = host(WORKTREE, host_id, path);
        h.git_durability = g.map(str::to_owned);
        h.carry_durability = carry;
        h
    };

    // A new binding takes the carried value.
    store
        .upsert_host_binding(&with(HOST_B, "/var/tmp/b", Some("enabled"), true))
        .unwrap();
    assert_eq!(durability(&store, HOST_B), json!("enabled"));
    // A carry with no value keeps the existing one.
    store
        .upsert_host_binding(&with(HOST_B, "/var/tmp/b2", None, true))
        .unwrap();
    assert_eq!(durability(&store, HOST_B), json!("enabled"));
    // A carry with a value replaces it.
    store
        .upsert_host_binding(&with(HOST_B, "/var/tmp/b3", Some("disabled"), true))
        .unwrap();
    assert_eq!(durability(&store, HOST_B), json!("disabled"));
    // Without carry an existing binding keeps its own, whatever the input says.
    store
        .upsert_host_binding(&with(HOST_A, "/var/tmp/a2", Some("disabled"), false))
        .unwrap();
    assert_eq!(durability(&store, HOST_A), json!("enabled"));
    // A value the CHECK refuses is refused, and nothing changes.
    assert!(
        store
            .upsert_host_binding(&with(HOST_B, "/var/tmp/x", Some("sometimes"), true))
            .is_err()
    );
    assert_eq!(durability(&store, HOST_B), json!("disabled"));
}

#[test]
fn the_binding_reads_name_orphans_every_worktree_and_foreign_owners() {
    let dir = TempDir::new("worktrees-binding-reads");
    let store = open(&dir);
    let incarnation = source(&store, "work", json!({}));
    source(&store, "stale", json!({}));
    seed(&store, "work", &incarnation);
    store
        .insert_source_binding(&binding("stale", STALE, WORKTREE))
        .unwrap();
    store
        .insert_source_binding(&binding("gone", STALE, WORKTREE))
        .unwrap();
    let orphans = store.list_orphan_binding_rows(None).unwrap();
    let reasons: Vec<(String, String)> = orphans
        .iter()
        .map(|r| {
            (
                r["source_id"].as_str().unwrap().into(),
                r["reason"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(
        reasons,
        vec![
            ("gone".into(), "source_removed".into()),
            ("stale".into(), "incarnation_replaced".into())
        ]
    );
    assert_eq!(store.list_orphan_binding_rows(Some(1)).unwrap().len(), 1);
    assert_eq!(
        store.list_worktree_ids().unwrap(),
        vec![WORKTREE.to_string()]
    );
    // The seed's worktree is HOST_A's: another host sees it, HOST_A does not.
    let foreign = store.list_owner_bindings(HOST_B).unwrap();
    assert_eq!(foreign.len(), 1);
    assert_eq!(foreign[0]["local_path"], json!("/var/tmp/work-root"));
    assert_eq!(foreign[0]["source_ids"], json!(["gone", "stale", "work"]));
    assert!(store.list_owner_bindings(HOST_A).unwrap().is_empty());
}
