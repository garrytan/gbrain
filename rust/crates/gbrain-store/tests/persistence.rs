//! The TypeScript journal members: counters, admission, the claim, renewal, expiry and completion.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::journal::Principal;
use gbrain_store::persistence::{
    ClaimStamp, ClaimableSpec, ExpireClaims, WriteCompletion, WriteRequestInsert,
};
use serde_json::{Value, json};

const REQ_1: &str = "b0000000-0000-4000-8000-0000000000b1";
const REQ_2: &str = "b0000000-0000-4000-8000-0000000000b2";
const TOKEN: &str = "c0000000-0000-4000-8000-0000000000c1";
const HOST: &str = "d0000000-0000-4000-8000-0000000000d1";
const PRINCIPAL_KEY: &str = "principal:local_cli:parity-writer";

fn keys() -> Vec<String> {
    vec![PRINCIPAL_KEY.into(), "brain".into()]
}

fn incarnation(store: &Store) -> String {
    store.read_source_membership("default").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string()
}

fn insert_input(store: &Store, request: &str, slug: &str, intent: Value) -> WriteRequestInsert {
    serde_json::from_value(json!({
        "principalKind": "local_cli",
        "principalId": "parity-writer",
        "requestId": request,
        "operation": "put_page",
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
    .unwrap()
}

fn stamp(id: &str, lease_ms: f64, phase: Option<Value>) -> ClaimStamp {
    ClaimStamp {
        id: id.into(),
        token: TOKEN.into(),
        lease_ms,
        phase_json: phase.map(|p| p.to_string()),
    }
}

fn completion(id: &str, state: &str, retained: i64) -> WriteCompletion {
    serde_json::from_value(json!({
        "id": id,
        "state": state,
        "outcome": {"slug": "notes/a"},
        "errorCode": null,
        "errorMessage": null,
        "consumerVersion": "v-consumer",
        "consumerHostId": HOST,
        "errorDetail": null,
        "resultBytes": 100,
        "counterKeys": keys(),
        "intentBytes": 10,
        "retainedBytes": retained,
        "terminalReservation": 4096,
        "probePurges": true,
    }))
    .unwrap()
}

fn counter(store: &Store, key: &str) -> Value {
    store
        .lock_persistence_counters(&[key.to_string()])
        .unwrap()
        .remove(0)
}

fn principal() -> Principal {
    Principal {
        kind: "local_cli".into(),
        id: "parity-writer".into(),
    }
}

#[test]
fn counters_are_created_at_zero_deduplicated_and_in_key_order() {
    let dir = TempDir::new("persist-counters");
    let store = open(&dir);
    let rows = store
        .lock_persistence_counters(&[PRINCIPAL_KEY.into(), "brain".into(), "brain".into()])
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["key"], "brain");
    assert_eq!(rows[1]["key"], PRINCIPAL_KEY);
    for row in &rows {
        for column in [
            "outstanding_count",
            "intent_bytes",
            "lifetime_ids",
            "terminal_bytes",
            "recovery_bytes",
        ] {
            assert_eq!(row[column], 0, "{column}");
        }
    }
    let err = store
        .lock_persistence_counters(&["a\0b".into()])
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

#[test]
fn an_inserted_request_has_every_column_and_charges_only_existing_counters() {
    let dir = TempDir::new("persist-insert");
    let store = open(&dir);
    store.lock_persistence_counters(&["brain".into()]).unwrap();
    let row = store
        .insert_write_request(&insert_input(
            &store,
            REQ_1,
            "notes/a",
            json!({"kind": "put_page"}),
        ))
        .unwrap();
    assert_eq!(row["state"], "queued");
    assert_eq!(row["sequence"], 1);
    assert_eq!(row["intent_bytes"], 10);
    assert_eq!(row["terminal_reservation"], 4096);
    assert_eq!(row["admitter_version"], "v-test");
    assert_eq!(row["admitter_segment_reader"], true);
    assert_eq!(row["consumer_segment_reader"], Value::Null);
    assert_eq!(row["compacted"], false);
    assert_eq!(row["publication_started"], false);
    assert_eq!(row["target_kind"], "page");
    assert_eq!(row["protocol_version"], 1);
    assert_eq!(row["worktree_id"], Value::Null);
    assert_eq!(row["deferred_import_from"], Value::Null);

    let brain = counter(&store, "brain");
    assert_eq!(brain["outstanding_count"], 1);
    assert_eq!(brain["intent_bytes"], 10);
    assert_eq!(brain["lifetime_ids"], 1);
    assert_eq!(brain["terminal_bytes"], 4096);
    // The principal row did not exist at admission, so nothing charged it.
    assert_eq!(counter(&store, PRINCIPAL_KEY)["outstanding_count"], 0);

    let by_request = store
        .read_write_request(&principal(), &REQ_1.to_uppercase())
        .unwrap()
        .unwrap();
    assert_eq!(by_request, row);
    let by_id = store
        .read_write_request_by_id(row["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(by_id, row);
    assert_eq!(store.read_write_request(&principal(), REQ_2).unwrap(), None);
    assert_eq!(
        store
            .read_write_request(&principal(), "nope")
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}

#[test]
fn an_insert_refuses_what_the_table_constraints_refuse() {
    let dir = TempDir::new("persist-insert-refuse");
    let store = open(&dir);
    let base = insert_input(&store, REQ_1, "notes/a", json!({}));
    store.insert_write_request(&base).unwrap();
    let duplicate = store.insert_write_request(&base).unwrap_err();
    assert_eq!(duplicate.code, CONSTRAINT_VIOLATION);

    let mut bad_kind = insert_input(&store, REQ_2, "notes/b", json!({}));
    bad_kind.principal_kind = "robot".into();
    assert_eq!(
        store.insert_write_request(&bad_kind).unwrap_err().code,
        CONSTRAINT_VIOLATION
    );
    let mut worktree = insert_input(&store, REQ_2, "notes/b", json!({}));
    worktree.worktree_id = Some(TOKEN.into());
    assert_eq!(
        store.insert_write_request(&worktree).unwrap_err().code,
        CONSTRAINT_VIOLATION
    );
    let mut no_slug = insert_input(&store, REQ_2, "notes/b", json!({}));
    no_slug.slug = None;
    assert_eq!(
        store.insert_write_request(&no_slug).unwrap_err().code,
        CONSTRAINT_VIOLATION
    );
    // Nothing of a refused insert stays: the next admission takes sequence 2.
    let row = store
        .insert_write_request(&insert_input(&store, REQ_2, "notes/b", json!({})))
        .unwrap();
    assert_eq!(row["sequence"], 2);
}

#[test]
fn a_claim_stamps_the_token_lease_and_phase() {
    let dir = TempDir::new("persist-claim");
    let store = open(&dir);
    let row = store
        .insert_write_request(&insert_input(
            &store,
            REQ_1,
            "notes/a",
            json!({"kind": "put_page"}),
        ))
        .unwrap();
    let id = row["id"].as_str().unwrap();
    let claimed = store
        .stamp_write_claim(&stamp(id, 60_000.0, Some(json!({"phase": "claimed"}))))
        .unwrap()
        .unwrap();
    assert_eq!(claimed["state"], "running");
    assert_eq!(claimed["execution_token"], TOKEN);
    assert_eq!(claimed["claim_phase"], json!({"phase": "claimed"}));
    assert_eq!(claimed["passed_sync"], false);
    assert_eq!(claimed["seen_sequence"], Value::Null);
    assert!(
        claimed["claim_expires_at"].as_str().unwrap() > claimed["updated_at"].as_str().unwrap()
    );
    let missing = "e0000000-0000-4000-8000-0000000000e1";
    assert_eq!(
        store.stamp_write_claim(&stamp(missing, 1.0, None)).unwrap(),
        None
    );

    let sync = store
        .insert_write_request(&insert_input(
            &store,
            REQ_2,
            "notes/b",
            json!({"kind": "managed_sync_pass"}),
        ))
        .unwrap();
    let claimed = store
        .stamp_write_claim(&stamp(sync["id"].as_str().unwrap(), 1000.0, None))
        .unwrap()
        .unwrap();
    assert_eq!(claimed["seen_sequence"], "2");
}

#[test]
fn renewal_holds_only_under_the_claim_token() {
    let dir = TempDir::new("persist-renew");
    let store = open(&dir);
    let row = store
        .insert_write_request(&insert_input(&store, REQ_1, "notes/a", json!({})))
        .unwrap();
    let id = row["id"].as_str().unwrap();
    assert!(!store.renew_write_claim(&stamp(id, 1000.0, None)).unwrap());
    store
        .stamp_write_claim(&stamp(id, 1000.0, Some(json!({"phase": "claimed"}))))
        .unwrap();
    assert!(store.renew_write_claim(&stamp(id, 5000.0, None)).unwrap());
    let after = store.read_write_request_by_id(id).unwrap().unwrap();
    assert_eq!(after["claim_phase"], json!({"phase": "claimed"}));
    let mut other = stamp(id, 1000.0, None);
    other.token = "c0000000-0000-4000-8000-0000000000c2".into();
    assert!(!store.renew_write_claim(&other).unwrap());
}

#[test]
fn completion_releases_counters_and_records_the_outcome() {
    let dir = TempDir::new("persist-complete");
    let store = open(&dir);
    store.lock_persistence_counters(&keys()).unwrap();
    let row = store
        .insert_write_request(&insert_input(&store, REQ_1, "notes/a", json!({})))
        .unwrap();
    let id = row["id"].as_str().unwrap();
    store.stamp_write_claim(&stamp(id, 1000.0, None)).unwrap();
    let done = store
        .complete_write_row(&completion(id, "committed", 512))
        .unwrap()
        .unwrap();
    assert_eq!(done["state"], "committed");
    assert_eq!(done["outcome"], json!({"slug": "notes/a"}));
    assert_eq!(done["terminal_reservation"], 512);
    assert_eq!(done["consumer_version"], "v-consumer");
    assert_eq!(done["consumer_host_id"], HOST);
    assert_eq!(done["consumer_segment_reader"], true);
    assert_eq!(done["claim_expires_at"], Value::Null);
    assert_eq!(done["purge_has_facts"], false);
    assert!(done["completed_at"].is_string());
    assert!(done["published_at"].is_string());
    for key in keys() {
        let c = counter(&store, &key);
        assert_eq!(c["outstanding_count"], 0);
        assert_eq!(c["intent_bytes"], 0);
        assert_eq!(c["lifetime_ids"], 1);
        assert_eq!(c["terminal_bytes"], 512);
    }
    assert_eq!(
        store.get_config("persistence.true_up.clamped").unwrap(),
        None
    );
}

#[test]
fn completion_that_overflows_the_reservation_changes_nothing() {
    let dir = TempDir::new("persist-complete-overflow");
    let store = open(&dir);
    store.lock_persistence_counters(&keys()).unwrap();
    let row = store
        .insert_write_request(&insert_input(&store, REQ_1, "notes/a", json!({})))
        .unwrap();
    let id = row["id"].as_str().unwrap();
    let mut big = completion(id, "committed", 0);
    big.result_bytes = 5000;
    assert_eq!(store.complete_write_row(&big).unwrap(), None);
    assert_eq!(
        store.read_write_request_by_id(id).unwrap().unwrap()["state"],
        "queued"
    );
    assert_eq!(counter(&store, "brain")["outstanding_count"], 1);
}

#[test]
fn completion_that_would_drive_a_counter_below_zero_changes_nothing() {
    let dir = TempDir::new("persist-complete-negative");
    let store = open(&dir);
    let row = store
        .insert_write_request(&insert_input(&store, REQ_1, "notes/a", json!({})))
        .unwrap();
    // The counters appear after admission, so they hold none of this request's charge.
    store.lock_persistence_counters(&["brain".into()]).unwrap();
    let id = row["id"].as_str().unwrap();
    let err = store
        .complete_write_row(&completion(id, "failed", 0))
        .unwrap_err();
    // outstanding_count would go below zero: the CHECK refuses and nothing is kept.
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    assert_eq!(
        store.read_write_request_by_id(id).unwrap().unwrap()["state"],
        "queued"
    );
    assert_eq!(
        store.get_config("persistence.true_up.clamped").unwrap(),
        None
    );
}

#[test]
fn completion_clamps_a_short_terminal_counter_and_counts_it() {
    let dir = TempDir::new("persist-complete-clamp");
    let store = open(&dir);
    store.lock_persistence_counters(&keys()).unwrap();
    let row = store
        .insert_write_request(&insert_input(&store, REQ_1, "notes/a", json!({})))
        .unwrap();
    let id = row["id"].as_str().unwrap();
    // The caller releases 8192 bytes against counters that hold 4096: each counter stops at zero and is counted.
    let mut short = completion(id, "committed", 0);
    short.terminal_reservation = 8192;
    let done = store.complete_write_row(&short).unwrap().unwrap();
    assert_eq!(done["terminal_reservation"], 0);
    for key in keys() {
        assert_eq!(counter(&store, &key)["terminal_bytes"], 0);
        assert_eq!(counter(&store, &key)["outstanding_count"], 0);
    }
    assert_eq!(
        store.get_config("persistence.true_up.clamped").unwrap(),
        Some(keys().len().to_string())
    );
    // A second clamp adds to the stored count.
    let again = store
        .insert_write_request(&insert_input(&store, REQ_2, "notes/b", json!({})))
        .unwrap();
    let mut short = completion(again["id"].as_str().unwrap(), "committed", 0);
    short.terminal_reservation = 8192;
    store.complete_write_row(&short).unwrap().unwrap();
    assert_eq!(
        store.get_config("persistence.true_up.clamped").unwrap(),
        Some((2 * keys().len()).to_string())
    );
}

#[test]
fn expired_claims_go_back_to_queued() {
    let dir = TempDir::new("persist-expire");
    let store = open(&dir);
    let row = store
        .insert_write_request(&insert_input(&store, REQ_1, "notes/a", json!({})))
        .unwrap();
    let id = row["id"].as_str().unwrap();
    store
        .stamp_write_claim(&stamp(
            id,
            -1000.0,
            Some(json!({"phase": "preparing", "token": TOKEN})),
        ))
        .unwrap();
    let spec = ExpireClaims {
        host_id: HOST.into(),
        charge: true,
        dead_owners: vec![],
    };
    assert_eq!(store.expire_stale_write_claims(&spec).unwrap(), 1);
    let after = store.read_write_request_by_id(id).unwrap().unwrap();
    assert_eq!(after["state"], "queued");
    assert_eq!(after["execution_token"], Value::Null);
    assert_eq!(after["preparation_attempts"], 1);
    assert_eq!(store.expire_stale_write_claims(&spec).unwrap(), 0);
}

#[test]
fn a_dead_owner_releases_a_live_lease() {
    let dir = TempDir::new("persist-expire-owner");
    let store = open(&dir);
    let row = store
        .insert_write_request(&insert_input(&store, REQ_1, "notes/a", json!({})))
        .unwrap();
    let id = row["id"].as_str().unwrap();
    let phase = json!({"phase": "claimed", "token": TOKEN, "owner": {"pid": 42, "nonce": "n"}});
    store
        .stamp_write_claim(&stamp(id, 60_000.0, Some(phase)))
        .unwrap();
    let mut spec = ExpireClaims {
        host_id: HOST.into(),
        charge: true,
        dead_owners: vec!["41:n".into()],
    };
    assert_eq!(store.expire_stale_write_claims(&spec).unwrap(), 0);
    spec.dead_owners = vec!["42:n".into()];
    assert_eq!(store.expire_stale_write_claims(&spec).unwrap(), 1);
    let after = store.read_write_request_by_id(id).unwrap().unwrap();
    assert_eq!(after["preparation_attempts"], 0);
}

#[test]
fn the_claimable_write_is_the_oldest_queued_one_and_foreground_passes_sync() {
    let dir = TempDir::new("persist-claimable");
    let store = open(&dir);
    let spec = ClaimableSpec::default();
    assert!(!store.has_claimable_write(&spec).unwrap());
    assert_eq!(store.select_claimable_write(&spec).unwrap(), None);
    let sync = store
        .insert_write_request(&insert_input(
            &store,
            REQ_1,
            "notes/sync",
            json!({"kind": "managed_sync_pass"}),
        ))
        .unwrap();
    let write = store
        .insert_write_request(&insert_input(
            &store,
            REQ_2,
            "notes/b",
            json!({"kind": "put_page"}),
        ))
        .unwrap();
    assert!(store.has_claimable_write(&spec).unwrap());
    // Foreground priority on (no config row): the page write goes ahead of the queued sync.
    assert_eq!(
        store.select_claimable_write(&spec).unwrap().unwrap()["id"],
        write["id"]
    );
    // Off: strict sequence order.
    store
        .set_config("sync.foreground_priority", " FALSE")
        .unwrap();
    assert_eq!(
        store.select_claimable_write(&spec).unwrap().unwrap()["id"],
        sync["id"]
    );
    // A root the caller excludes has nothing to claim.
    let excluded = ClaimableSpec {
        exclude_roots: vec![format!("db:{}", incarnation(&store))],
        ..ClaimableSpec::default()
    };
    assert!(!store.has_claimable_write(&excluded).unwrap());
}

#[test]
fn a_foreground_write_waits_behind_a_sync_that_names_its_page() {
    let dir = TempDir::new("persist-claimable-names");
    let store = open(&dir);
    let sync = store
        .insert_write_request(&insert_input(
            &store,
            REQ_1,
            "notes/b",
            json!({"kind": "managed_sync_pass"}),
        ))
        .unwrap();
    store
        .insert_write_request(&insert_input(
            &store,
            REQ_2,
            "notes/b",
            json!({"kind": "put_page"}),
        ))
        .unwrap();
    let spec = ClaimableSpec {
        priority: Some(true),
        ..ClaimableSpec::default()
    };
    assert_eq!(
        store.select_claimable_write(&spec).unwrap().unwrap()["id"],
        sync["id"]
    );
}

#[test]
fn source_membership_is_the_incarnation_and_archive_flag() {
    let dir = TempDir::new("persist-membership");
    let store = open(&dir);
    let membership = store.read_source_membership("default").unwrap().unwrap();
    assert_eq!(membership["archived"], false);
    assert_eq!(store.read_source_membership("nope").unwrap(), None);
}
