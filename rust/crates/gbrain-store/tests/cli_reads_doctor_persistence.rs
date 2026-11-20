//! The doctor persistence reads (`cli_reads/doctor_persistence.rs`): the PGLite answer of each, over the
//! request journal and the counters.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::persistence::{TopologyChangeInsert, WriteCompletion, WriteRequestInsert};
use serde_json::{Value, json};

const REQ_1: &str = "b0000000-0000-4000-8000-0000000000b1";
const REQ_2: &str = "b0000000-0000-4000-8000-0000000000b2";
const REQ_3: &str = "b0000000-0000-4000-8000-0000000000b3";
const WRITER: &str = "e0000000-0000-4000-8000-0000000000e1";
const KEY: &str = "principal:local_cli:parity-writer";

fn keys() -> Vec<String> {
    vec![KEY.into(), "brain".into()]
}

fn incarnation(store: &Store) -> String {
    store.read_source_membership("default").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string()
}

fn insert(store: &Store, request: &str, slug: &str, operation: &str, intent: Value) -> String {
    let input: WriteRequestInsert = serde_json::from_value(json!({
        "principalKind": "local_cli",
        "principalId": "parity-writer",
        "requestId": request,
        "operation": operation,
        "sourceId": "default",
        "sourceIncarnation": incarnation(store),
        "pageId": null,
        "slug": slug,
        "worktreeId": null,
        "topologyGeneration": null,
        "digest": "digest",
        "intent": intent,
        "authority": {},
        "intentBytes": 10,
        "terminalReservation": 4096,
        "targetKind": "page",
        "protocolVersion": 1,
        "admitterVersion": "v-test",
        "admitterHostId": null,
        "counterKeys": keys(),
        "clientRequestId": null,
        "state": "queued",
        "deferredRefreshId": null,
    }))
    .unwrap();
    let row = store.insert_write_request(&input).unwrap();
    row["id"].as_str().unwrap().to_string()
}

fn complete(
    store: &Store,
    id: &str,
    state: &str,
    code: Option<&str>,
    detail: Value,
    outcome: Value,
) {
    let done: WriteCompletion = serde_json::from_value(json!({
        "id": id,
        "state": state,
        "outcome": outcome,
        "errorCode": code,
        "errorMessage": code.map(|c| format!("{c} message")),
        "consumerVersion": "v-consumer",
        "consumerHostId": null,
        "errorDetail": detail,
        "resultBytes": 100,
        "counterKeys": keys(),
        "intentBytes": 10,
        "retainedBytes": 512,
        "terminalReservation": 4096,
        "probePurges": true,
    }))
    .unwrap();
    store.complete_write_row(&done).unwrap().unwrap();
}

#[test]
fn an_empty_journal_answers_the_empty_state_of_every_read() {
    let dir = TempDir::new("per-empty");
    let store = open(&dir);
    assert_eq!(store.list_capacity_counters().unwrap(), Vec::<Value>::new());
    assert_eq!(store.list_lifetime_counters().unwrap(), Vec::<Value>::new());
    assert_eq!(
        store.count_persistence_request_rows().unwrap(),
        json!({ "rows": "0" })
    );
    assert_eq!(
        store.read_admission_sample(None).unwrap(),
        json!({ "admissions": 0, "oldest": null })
    );
    assert!(store.list_outstanding_holders(None).unwrap().is_empty());
    assert!(
        store
            .list_running_request_stalls(600_000.0)
            .unwrap()
            .is_empty()
    );
    assert_eq!(store.read_max_request_sequence().unwrap(), None);
    assert!(
        store
            .list_recent_drift_receipt_slugs("default", "0", "m")
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list_older_drift_receipt_slugs("default", "0", "m")
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list_refusal_breaker_rows("default", 24.0, 1, 20)
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .read_counter_drift("persistence.true_up.clamped")
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.read_publication_refusals().unwrap(),
        json!({ "guard": 0, "trigger": 0, "opaque": 0 })
    );
    assert!(store.list_running_claim_owners().unwrap().is_empty());
    assert!(store.list_local_edit_adoptions().unwrap().is_empty());
    let ids = vec!["default".to_string()];
    let ops = vec!["put_page".to_string()];
    assert!(
        store
            .list_caller_refusal_rows(&ids, &ops)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.count_compacted_caller_refusals(&ids, &ops).unwrap(),
        0
    );
    assert!(store.list_recent_writer_versions(7.0).unwrap().is_empty());
}

#[test]
fn requests_counters_and_the_admission_sample_are_read_as_postgres_reads_them() {
    let dir = TempDir::new("per-requests");
    let store = open(&dir);
    store.lock_persistence_counters(&keys()).unwrap();
    let first = insert(&store, REQ_1, "notes/a", "put_page", json!({}));
    let second = insert(&store, REQ_2, "notes/b", "put_page", json!({}));
    assert_eq!(
        store.count_persistence_request_rows().unwrap(),
        json!({ "rows": "2" })
    );
    assert_eq!(
        store.read_max_request_sequence().unwrap().as_deref(),
        Some("2")
    );

    let counters = store.list_capacity_counters().unwrap();
    assert_eq!(counters.len(), 2);
    assert_eq!(counters[0]["key"], "brain");
    assert_eq!(counters[0]["lifetime_ids"], "2");
    assert_eq!(counters[1]["key"], KEY);
    assert_eq!(
        store.list_lifetime_counters().unwrap()[1]["lifetime_ids"],
        "2"
    );

    let sample = store
        .read_admission_sample(Some(("local_cli", "parity-writer")))
        .unwrap();
    assert_eq!(sample["admissions"], 2);
    assert!(sample["oldest"].as_str().unwrap().contains('+'));
    assert_eq!(
        store
            .read_admission_sample(Some(("local_cli", "other")))
            .unwrap()["admissions"],
        0
    );

    // Two outstanding requests on one source, none ten minutes old.
    let holders = store.list_outstanding_holders(None).unwrap();
    assert_eq!(
        holders,
        vec![json!({ "source_id": "default", "n": 2, "stalled": 0 })]
    );
    assert!(
        store
            .list_outstanding_holders(Some(("local_cli", "other")))
            .unwrap()
            .is_empty()
    );

    // A running request with a root that settled nothing is a stall candidate, and the queue waits behind it
    // only on a worktree (none here).
    let stamp = serde_json::from_value(json!({
        "id": first, "token": "c0000000-0000-4000-8000-0000000000c1", "leaseMs": 60000.0,
        "phaseJson": json!({ "phase": "claimed", "owner": { "pid": 7 } }).to_string(),
    }))
    .unwrap();
    store.stamp_write_claim(&stamp).unwrap();
    let stalls = store.list_running_request_stalls(600_000.0).unwrap();
    assert_eq!(stalls.len(), 1);
    assert_eq!(stalls[0]["request_id"], REQ_1);
    assert_eq!(stalls[0]["claim_lapsed"], false);
    assert_eq!(stalls[0]["no_root_progress"], true);
    assert_eq!(stalls[0]["waiting"], 0);
    assert_eq!(stalls[0]["worktree_id"], Value::Null);
    let owners = store.list_running_claim_owners().unwrap();
    assert_eq!(owners.len(), 1);
    assert_eq!(owners[0]["owner"], json!({ "pid": 7 }));
    assert_eq!(owners[0]["lapsed"], false);

    // Settling the other request on the same root is progress.
    complete(
        &store,
        &second,
        "committed",
        None,
        Value::Null,
        json!({ "slug": "notes/b" }),
    );
    let stalls = store.list_running_request_stalls(600_000.0).unwrap();
    assert_eq!(stalls[0]["no_root_progress"], false);
}

#[test]
fn refusals_the_database_made_are_counted_and_listed() {
    let dir = TempDir::new("per-refusals");
    let store = open(&dir);
    store.lock_persistence_counters(&keys()).unwrap();
    let id = insert(
        &store,
        REQ_1,
        "notes/a",
        "put_page",
        json!({ "expected_revision": "r1" }),
    );
    complete(
        &store,
        &id,
        "failed",
        Some("writer_coordinator_required"),
        json!({ "origin": "database_guard" }),
        Value::Null,
    );
    let drift = insert(&store, REQ_2, "notes/b", "remember", json!({}));
    complete(
        &store,
        &drift,
        "conflict",
        Some("source_changed"),
        Value::Null,
        Value::Null,
    );

    assert_eq!(
        store.read_publication_refusals().unwrap(),
        json!({ "guard": 1, "trigger": 0, "opaque": 0 })
    );
    let ids = vec!["default".to_string()];
    let ops = vec!["put_page".to_string(), "remember".to_string()];
    let rows = store.list_caller_refusal_rows(&ids, &ops).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["reason"], "writer_guard");
    assert_eq!(rows[0]["operation"], "put_page");
    assert_eq!(rows[0]["sequence"], "1");
    // The page does not exist, so the revision the caller read is no longer the page's.
    assert_eq!(rows[0]["stale_revision"], true);
    assert_eq!(rows[0]["unpinned"], false);
    assert_eq!(rows[1]["reason"], "source_changed");
    assert_eq!(rows[1]["unpinned"], true);
    assert_eq!(rows[1]["stale_revision"], false);
    // Only the first operation is asked for.
    let only = store.list_caller_refusal_rows(&ids, &ops[..1]).unwrap();
    assert_eq!(only.len(), 1);
    assert_eq!(
        store.count_compacted_caller_refusals(&ids, &ops).unwrap(),
        0
    );
    assert!(
        store
            .list_caller_refusal_rows(&["other".to_string()], &ops)
            .unwrap()
            .is_empty()
    );

    let slugs = store
        .list_recent_drift_receipt_slugs("default", "0", "source_changed message")
        .unwrap();
    assert_eq!(slugs, vec![json!({ "slug": "notes/b", "total": 1 })]);
    assert!(
        store
            .list_recent_drift_receipt_slugs("default", "2", "source_changed message")
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .list_older_drift_receipt_slugs("default", "2", "source_changed message")
            .unwrap(),
        vec![json!({ "slug": "notes/b" })]
    );
    assert!(
        store
            .list_recent_drift_receipt_slugs("default", "0", "another message")
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list_recent_drift_receipt_slugs("default", "nope", "m")
            .is_err()
    );
}

#[test]
fn the_refusal_breaker_groups_by_slug_write_and_code() {
    let dir = TempDir::new("per-breaker");
    let store = open(&dir);
    store.lock_persistence_counters(&keys()).unwrap();
    for (n, request) in [REQ_1, REQ_2].into_iter().enumerate() {
        let id = insert(&store, request, "notes/a", "submit_job", json!({ "n": n }));
        complete(
            &store,
            &id,
            "failed",
            Some("writer_coordinator_required"),
            json!({ "origin": "canonical_file_missing" }),
            Value::Null,
        );
    }
    let other = insert(&store, REQ_3, "notes/b", "submit_job", json!({}));
    complete(
        &store,
        &other,
        "failed",
        Some("storage_error"),
        Value::Null,
        Value::Null,
    );
    let rows = store
        .list_refusal_breaker_rows("default", 24.0, 2, 20)
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["slug"], "notes/a");
    assert_eq!(rows[0]["refusals"], "2");
    assert_eq!(rows[0]["last_request_id"], REQ_2);
    assert_eq!(rows[0]["cause"], "canonical_file_missing");
    assert_eq!(
        store
            .list_refusal_breaker_rows("default", 24.0, 1, 20)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        store
            .list_refusal_breaker_rows("default", 24.0, 1, 1)
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .list_refusal_breaker_rows("other", 24.0, 1, 20)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn the_counter_drift_read_counts_receipts_and_topology_changes() {
    let dir = TempDir::new("per-drift");
    let store = open(&dir);
    let writer_key = format!("principal:local_cli:{WRITER}");
    store
        .lock_persistence_counters(&[KEY.into(), writer_key.clone(), "brain".into()])
        .unwrap();
    let id = insert(&store, REQ_1, "notes/a", "put_page", json!({}));
    complete(
        &store,
        &id,
        "committed",
        None,
        Value::Null,
        json!({ "slug": "notes/a" }),
    );
    let topology: TopologyChangeInsert = serde_json::from_value(json!({
        "principalId": WRITER, "requestId": REQ_2, "digest": "d", "operation": "remove",
        "sourceId": "default", "sourceIncarnation": null, "worktreeIds": [], "state": "recovering",
        "recovery": null, "recoveryBytes": 0, "intentBytes": 0, "terminalBytes": 4096, "outcome": null,
    }))
    .unwrap();
    store.insert_topology_change(&topology).unwrap();
    store
        .set_config("persistence.true_up.clamped", "3")
        .unwrap();

    let rows = store
        .read_counter_drift("persistence.true_up.clamped")
        .unwrap();
    let keyed = |key: &str| rows.iter().find(|r| r["key"] == key).unwrap().clone();
    let shape = |row: &Value| {
        [
            "req_rows",
            "req_bytes",
            "topo_rows",
            "topo_bytes",
            "clamped",
        ]
        .map(|k| row[k].as_str().unwrap().to_string())
    };
    assert_eq!(rows.len(), 3);
    assert_eq!(shape(&keyed("brain")), ["1", "512", "1", "4096", "3"]);
    assert_eq!(shape(&keyed(KEY)), ["1", "512", "0", "0", "3"]);
    assert_eq!(shape(&keyed(&writer_key)), ["0", "0", "1", "4096", "3"]);
}

#[test]
fn local_edit_adoptions_and_writer_versions_are_read_from_committed_writes() {
    let dir = TempDir::new("per-adoptions");
    let store = open(&dir);
    store.lock_persistence_counters(&keys()).unwrap();
    for (request, slug, path) in [(REQ_1, "notes/a", "b.md"), (REQ_2, "notes/b", "a.md")] {
        let id = insert(&store, request, slug, "put_page", json!({}));
        complete(
            &store,
            &id,
            "committed",
            None,
            Value::Null,
            json!({ "adopted_local_edit": { "path": path } }),
        );
    }
    let rows = store.list_local_edit_adoptions().unwrap();
    assert_eq!(
        rows,
        vec![json!({ "source_id": "default", "adoptions": 2, "paths": ["a.md", "b.md"] })]
    );

    let versions = store.list_recent_writer_versions(7.0).unwrap();
    let admitters: Vec<&Value> = versions
        .iter()
        .filter(|v| v["role"] == "admitter")
        .collect();
    assert_eq!(admitters.len(), 1);
    assert_eq!(admitters[0]["version"], "v-test");
    assert_eq!(admitters[0]["principal"], "local_cli:parity-writer");
    assert_eq!(admitters[0]["requests"], 2);
    let consumers: Vec<&Value> = versions
        .iter()
        .filter(|v| v["role"] == "consumer")
        .collect();
    assert_eq!(consumers[0]["version"], "v-consumer");
    assert_eq!(consumers[0]["requests"], 2);
    assert!(store.list_recent_writer_versions(0.0).unwrap().is_empty());
}
