//! The TypeScript journal members: counters, admission, the claim, renewal, expiry and completion.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::journal::Principal;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::persistence::{
    ClaimRelease, ClaimStamp, ClaimableSpec, ExpireClaims, HousekeepingClaim, HousekeepingTurn,
    ProjectionWindowCursor, SegmentedProjectionFilter, TopologyChangeInsert, WriteCompletion,
    WriteRequestInsert,
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
fn a_principal_id_with_a_nul_byte_is_refused_before_a_duplicate_could_slip_in() {
    let dir = TempDir::new("persist-insert-nul");
    let store = open(&dir);
    let mut input = insert_input(&store, REQ_1, "people/a", json!({}));
    input.principal_id = "a\0b".into();
    for _ in 0..2 {
        assert_eq!(
            store.insert_write_request(&input).unwrap_err().code,
            INVALID_ARGUMENT
        );
    }
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

fn turn_claim(host: &str, interval_ms: i64, lease_ms: i64) -> HousekeepingClaim {
    serde_json::from_value(json!({
        "op": "persistence.housekeeping",
        "hostId": host,
        "intervalMs": interval_ms,
        "leaseMs": lease_ms,
        "consumerKinds": ["serve", "sync"],
        "consumerLiveMs": 30000,
    }))
    .unwrap()
}

fn committed(store: &Store, request: &str, slug: &str) -> Value {
    store.lock_persistence_counters(&keys()).unwrap();
    let row = store
        .insert_write_request(&insert_input(store, request, slug, json!({})))
        .unwrap();
    let id = row["id"].as_str().unwrap().to_string();
    store.stamp_write_claim(&stamp(&id, 1000.0, None)).unwrap();
    store
        .complete_write_row(&completion(&id, "committed", 512))
        .unwrap()
        .unwrap()
}

#[test]
fn the_housekeeping_turn_is_leased_then_waits_out_its_interval() {
    let dir = TempDir::new("persist-turn");
    let store = open(&dir);
    assert!(
        store
            .claim_housekeeping_turn(&turn_claim(HOST, 60_000, 60_000))
            .unwrap()
    );
    // Leased: a second claim waits out the lease.
    assert!(
        !store
            .claim_housekeeping_turn(&turn_claim(HOST, 60_000, 60_000))
            .unwrap()
    );
    // Another host has its own turn.
    let other = "d0000000-0000-4000-8000-0000000000d2";
    assert!(
        store
            .claim_housekeeping_turn(&turn_claim(other, 60_000, 60_000))
            .unwrap()
    );
    let turn = HousekeepingTurn {
        op: "persistence.housekeeping".into(),
        host_id: HOST.into(),
    };
    store.complete_housekeeping_turn(&turn).unwrap();
    // Done: the interval applies, not the lease.
    assert!(
        !store
            .claim_housekeeping_turn(&turn_claim(HOST, 60_000, 0))
            .unwrap()
    );
    assert!(
        store
            .claim_housekeeping_turn(&turn_claim(HOST, 0, 60_000))
            .unwrap()
    );
    // A lapsed lease is taken over.
    assert!(
        store
            .claim_housekeeping_turn(&turn_claim(HOST, 60_000, 0))
            .unwrap()
    );
    // Completing a turn nobody holds changes nothing.
    store
        .complete_housekeeping_turn(&HousekeepingTurn {
            op: "persistence.housekeeping".into(),
            host_id: "d0000000-0000-4000-8000-0000000000d3".into(),
        })
        .unwrap();
    assert!(
        store
            .claim_housekeeping_turn(&turn_claim("not-a-uuid", 0, 0))
            .is_err()
    );
}

#[test]
fn the_receipt_budget_reads_retention_used_bytes_and_the_cutoff() {
    let dir = TempDir::new("persist-budget");
    let store = open(&dir);
    let empty = store
        .read_receipt_budget("persistence.receipt_retention_days", 1.0)
        .unwrap();
    assert_eq!(empty["retention"], Value::Null);
    assert_eq!(empty["used"], Value::Null);
    assert!(empty["cutoff"].as_str().unwrap().ends_with('Z'));
    committed(&store, REQ_1, "notes/a");
    store
        .set_config("persistence.receipt_retention_days", "3")
        .unwrap();
    let budget = store
        .read_receipt_budget("persistence.receipt_retention_days", 1.0)
        .unwrap();
    assert_eq!(budget["retention"], "3");
    assert_eq!(budget["used"], "512");
}

#[test]
fn the_reservation_window_walks_the_sequence_past_a_cursor() {
    let dir = TempDir::new("persist-window");
    let store = open(&dir);
    let first = committed(&store, REQ_1, "notes/a");
    committed(&store, REQ_2, "notes/b");
    let all = store.list_reservations_after("0", 10).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0]["id"], first["id"]);
    assert_eq!(all[0]["compacted"], false);
    let seq = all[0]["sequence"].as_str().unwrap().to_string();
    let rest = store.list_reservations_after(&seq, 10).unwrap();
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0]["id"], all[1]["id"]);
    assert_eq!(store.list_reservations_after("0", 1).unwrap().len(), 1);
    assert!(store.list_reservations_after("x", 1).is_err());
    assert!(store.list_reservations_after("0", -1).is_err());
}

#[test]
fn true_up_candidates_are_terminal_requests_with_no_effect_bytes() {
    let dir = TempDir::new("persist-trueup");
    let store = open(&dir);
    let done = committed(&store, REQ_1, "notes/a");
    let queued = store
        .insert_write_request(&insert_input(&store, REQ_2, "notes/b", json!({})))
        .unwrap();
    let ids = vec![
        done["id"].as_str().unwrap().to_string(),
        queued["id"].as_str().unwrap().to_string(),
    ];
    let rows = store.list_true_up_requests(&ids).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], done["id"]);
    assert_eq!(rows[0]["effect_bytes"], "0");
    assert_eq!(rows[0]["unfinished"], false);
    assert_eq!(rows[0]["compacted"], false);
    assert_eq!(rows[0]["principal_id"], "parity-writer");
}

#[test]
fn compactable_receipts_are_terminal_receipts_past_the_retention() {
    let dir = TempDir::new("persist-compactable");
    let store = open(&dir);
    let done = committed(&store, REQ_1, "notes/a");
    store
        .insert_write_request(&insert_input(&store, REQ_2, "notes/b", json!({})))
        .unwrap();
    assert!(store.list_compactable_receipts(7.0).unwrap().is_empty());
    let rows = store.list_compactable_receipts(0.0).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], done["id"]);
    assert_eq!(rows[0]["state"], "committed");
}

#[test]
fn the_capacity_inputs_bucket_the_window_by_principal_and_day() {
    let dir = TempDir::new("persist-capacity");
    let store = open(&dir);
    let done = committed(&store, REQ_1, "notes/a");
    let inputs = store.read_capacity_forecast_inputs(false).unwrap();
    let counters = inputs["counters"].as_array().unwrap();
    assert_eq!(counters[0]["key"], "brain");
    assert_eq!(counters[0]["lifetime_ids"], "1");
    assert_eq!(counters[1]["key"], PRINCIPAL_KEY);
    let days = inputs["days"].as_array().unwrap();
    assert_eq!(days.len(), 1);
    assert_eq!(days[0]["scope"], PRINCIPAL_KEY);
    assert_eq!(days[0]["ids"], "1");
    assert_eq!(days[0]["gross"], "512");
    assert_eq!(days[0]["recent_ids"], "1");
    assert_eq!(inputs["history"]["first_id"], done["id"]);
    assert_eq!(inputs["reclaim"].as_array().unwrap().len(), 1);
    assert_eq!(inputs["reclaim"][0]["scope"], PRINCIPAL_KEY);
    assert_eq!(inputs["tableBytes"], Value::Null);
    let light = store.read_capacity_forecast_inputs(true).unwrap();
    assert!(light["reclaim"].as_array().unwrap().is_empty());
}

/// Writes `slug` as PGLite's `putPage` does (`index: false`): the page alone, its projection unsealed.
fn put_unsealed(store: &Store, slug: &str, body: &str) {
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": body,
    }))
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({ "index": false })).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

fn window(
    store: &Store,
    after: (&str, &str),
    high_water: Option<&str>,
    cooldown: bool,
) -> Vec<Value> {
    let cursor: ProjectionWindowCursor = serde_json::from_value(json!({
        "after": { "source_incarnation": after.0, "slug": after.1 }, "highWater": high_water,
    }))
    .unwrap();
    store
        .select_projection_window_jobs(&cursor, cooldown)
        .unwrap()
}

/// `(lane, ord, slug)` of each window row.
fn lanes(rows: &[Value]) -> Vec<(Value, Value, Value)> {
    rows.iter()
        .map(|r| (r["lane"].clone(), r["ord"].clone(), r["slug"].clone()))
        .collect()
}

const NIL: &str = "00000000-0000-0000-0000-000000000000";

#[test]
fn an_empty_brain_has_an_empty_projection_queue() {
    let dir = TempDir::new("persist-projq");
    let store = open(&dir);
    assert!(store.projection_queue_empty().unwrap());
    let rows = window(&store, (NIL, ""), None, true);
    assert_eq!(
        rows,
        vec![json!({
            "lane": null, "ord": null, "source_incarnation": null, "slug": null, "revision": null,
            "high_water": null,
        })]
    );
}

#[test]
fn page_writes_keep_the_projection_queue_as_the_trigger_does() {
    let dir = TempDir::new("persist-projq-writes");
    let store = open(&dir);
    let inc = incarnation(&store);
    for slug in ["notes/a", "notes/b", "notes/c", "notes/d", "notes/e"] {
        put_unsealed(&store, slug, &format!("{slug} body"));
    }
    // A sealed write (the default put indexes and seals) drops the job.
    let sealed: PageInput = serde_json::from_value(json!({
        "type": "note", "title": "notes/e", "compiled_truth": "notes/e body",
    }))
    .unwrap();
    store
        .put_page("notes/e", &sealed, &PutPageOptions::default())
        .unwrap();
    store.soft_delete_page("notes/c", None).unwrap();
    store.delete_page("notes/d", None).unwrap();
    store.restore_page("notes/c", None).unwrap();
    store.update_slug("notes/b", "notes/b2", None).unwrap();
    assert!(!store.projection_queue_empty().unwrap());

    let rows = window(&store, (NIL, ""), None, true);
    let high_water = rows[0]["high_water"].as_str().unwrap().to_owned();
    assert!(high_water.ends_with("+00"), "{high_water}");
    let mut recent: Vec<_> = rows
        .iter()
        .filter(|r| r["lane"] == "recent")
        .map(|r| r["slug"].clone())
        .collect();
    recent.sort_by_key(|s| s.to_string());
    let window_lane: Vec<_> = lanes(&rows)
        .into_iter()
        .filter(|r| r.0 == "window")
        .collect();
    // A rename drops the old key's job and queues the new key at a new revision. The soft delete
    // dropped notes/c's job; the restore gives it a new revision, so it is queued again.
    let slugs: Vec<_> = window_lane
        .iter()
        .map(|r| r.2.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(slugs, ["notes/a", "notes/b2", "notes/c"]);
    assert_eq!(recent.len(), slugs.len());
    for (i, row) in window_lane.iter().enumerate() {
        assert_eq!(row.1, json!(i + 1));
    }
    assert!(rows.iter().all(|r| r["source_incarnation"] == inc.as_str()));

    // The key window starts after the cursor and wraps to the start.
    let wrapped = window(&store, (&inc, "notes/a"), Some(&high_water), true);
    let order: Vec<_> = lanes(&wrapped)
        .into_iter()
        .filter(|r| r.0 == "window")
        .map(|r| r.2)
        .collect();
    assert_eq!(order.last(), Some(&json!("notes/a")));
    // A high water 11 minutes later leaves the recency lane empty.
    let later = window(&store, (NIL, ""), Some("2999-01-01 00:00:00+00"), true);
    assert!(later.iter().all(|r| r["lane"] == "window"));
}

#[test]
fn the_window_refuses_a_cursor_that_is_not_a_uuid_or_time() {
    let dir = TempDir::new("persist-projq-bad");
    let store = open(&dir);
    let cursor: ProjectionWindowCursor = serde_json::from_value(json!({
        "after": { "source_incarnation": "nope", "slug": "" }, "highWater": null,
    }))
    .unwrap();
    assert_eq!(
        store
            .select_projection_window_jobs(&cursor, true)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    let cursor: ProjectionWindowCursor = serde_json::from_value(json!({
        "after": { "source_incarnation": NIL, "slug": "" }, "highWater": "yesterday",
    }))
    .unwrap();
    assert_eq!(
        store
            .select_projection_window_jobs(&cursor, true)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}

#[test]
fn no_inline_page_is_a_pending_segmented_projection() {
    let dir = TempDir::new("persist-projq-seg");
    let store = open(&dir);
    put_unsealed(&store, "notes/a", "body");
    let filter: SegmentedProjectionFilter = serde_json::from_value(json!({ "limit": 10 })).unwrap();
    assert!(
        store
            .list_pending_segmented_projections(&filter)
            .unwrap()
            .is_empty()
    );
    let filter: SegmentedProjectionFilter =
        serde_json::from_value(json!({ "limit": 10, "notAfter": "soon" })).unwrap();
    assert_eq!(
        store
            .list_pending_segmented_projections(&filter)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}

const WRITER: &str = "e0000000-0000-4000-8000-0000000000e1";
const OTHER_WRITER: &str = "e0000000-0000-4000-8000-0000000000e2";

fn topology(principal: &str, request: &str) -> TopologyChangeInsert {
    TopologyChangeInsert {
        principal_id: principal.into(),
        request_id: request.into(),
        digest: "sha256:lifecycle".into(),
        operation: "remove".into(),
        source_id: "default".into(),
        source_incarnation: None,
        worktree_ids: Vec::new(),
        state: "recovering".into(),
        recovery: None,
        recovery_bytes: 0,
        intent_bytes: 0,
        terminal_bytes: 4096,
        outcome: Some(json!({ "operation": "remove", "source_id": "default" })),
    }
}

#[test]
fn a_topology_change_is_stored_with_every_column_and_read_back() {
    let dir = TempDir::new("persist-topology");
    let store = open(&dir);
    assert!(store.read_topology_change(WRITER, REQ_1).unwrap().is_none());
    let mut input = topology(WRITER, REQ_1);
    input.source_incarnation = Some(incarnation(&store));
    input.recovery = Some(json!({ "step": 1 }));
    input.recovery_bytes = 12;
    input.intent_bytes = 34;
    let row = store.insert_topology_change(&input).unwrap();
    assert_eq!(row["principal_id"], WRITER);
    assert_eq!(row["request_id"], REQ_1);
    assert_eq!(row["state"], "recovering");
    assert_eq!(row["worktree_ids"], json!([]));
    assert_eq!(row["recovery"], json!({ "step": 1 }));
    assert_eq!(row["recovery_bytes"], 12);
    assert_eq!(row["intent_bytes"], 34);
    assert_eq!(row["terminal_bytes"], 4096);
    assert_eq!(row["outcome"]["operation"], "remove");
    assert_eq!(row["created_at"], row["updated_at"]);
    assert_eq!(row["id"].as_str().unwrap().len(), 36);
    let read = store.read_topology_change(WRITER, REQ_1).unwrap().unwrap();
    assert_eq!(read, row);
    // The row belongs to (principal, request id): another writer's id is another row.
    assert!(
        store
            .read_topology_change(OTHER_WRITER, REQ_1)
            .unwrap()
            .is_none()
    );
}

#[test]
fn a_topology_change_refuses_what_the_table_constraints_refuse() {
    let dir = TempDir::new("persist-topology-refuse");
    let store = open(&dir);
    store
        .insert_topology_change(&topology(WRITER, REQ_1))
        .unwrap();
    let duplicate = store
        .insert_topology_change(&topology(WRITER, REQ_1))
        .unwrap_err();
    assert_eq!(duplicate.code, CONSTRAINT_VIOLATION);
    let mut state = topology(WRITER, REQ_2);
    state.state = "queued".into();
    assert_eq!(
        store.insert_topology_change(&state).unwrap_err().code,
        CONSTRAINT_VIOLATION
    );
    let mut negative = topology(WRITER, REQ_2);
    negative.terminal_bytes = -1;
    assert_eq!(
        store.insert_topology_change(&negative).unwrap_err().code,
        CONSTRAINT_VIOLATION
    );
    let mut not_uuid = topology(WRITER, REQ_2);
    not_uuid.request_id = "not-a-uuid".into();
    assert!(store.insert_topology_change(&not_uuid).is_err());
    // Nothing of a refused insert stays.
    assert!(store.read_topology_change(WRITER, REQ_2).unwrap().is_none());
    // The same request id under another writer is a different row.
    store
        .insert_topology_change(&topology(OTHER_WRITER, REQ_1))
        .unwrap();
}

#[test]
fn the_topology_probe_finds_a_used_lifecycle_id_of_the_writer_only() {
    let dir = TempDir::new("persist-topology-find");
    let store = open(&dir);
    let ids = vec![REQ_1.to_string(), REQ_2.to_string()];
    assert!(
        store
            .find_topology_changes(WRITER, &ids)
            .unwrap()
            .is_empty()
    );
    store
        .insert_topology_change(&topology(WRITER, REQ_2))
        .unwrap();
    assert_eq!(
        store.find_topology_changes(WRITER, &ids).unwrap(),
        vec![json!({ "request_id": REQ_2 })]
    );
    assert!(
        store
            .find_topology_changes(OTHER_WRITER, &ids)
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .find_topology_changes(WRITER, &[REQ_1.to_string()])
            .unwrap()
            .is_empty()
    );
    assert!(store.find_topology_changes(WRITER, &[]).unwrap().is_empty());
}

#[test]
fn the_capacity_forecast_counts_topology_changes_per_writer_and_day() {
    let dir = TempDir::new("persist-topology-capacity");
    let store = open(&dir);
    store
        .insert_topology_change(&topology(WRITER, REQ_1))
        .unwrap();
    store
        .insert_topology_change(&topology(WRITER, REQ_2))
        .unwrap();
    let inputs = store.read_capacity_forecast_inputs(true).unwrap();
    let scope = format!("principal:local_cli:{WRITER}");
    let days: Vec<_> = inputs["days"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["scope"] == scope.as_str())
        .collect();
    assert_eq!(days.len(), 1);
    let day = days[0];
    assert_eq!(day["day"].as_str().unwrap().len(), 10);
    assert_eq!(day["ids"], "2");
    assert_eq!(day["gross"], "8192");
    assert_eq!(day["net"], "8192");
    assert_eq!(day["recent_ids"], "2");
    assert_eq!(day["recent_gross"], "8192");
    assert_eq!(day["recent_net"], "8192");
}

#[test]
fn outstanding_requests_are_counted_per_source_for_one_principal() {
    let dir = TempDir::new("persist-outstanding-by-source");
    let store = open(&dir);
    store.lock_persistence_counters(&keys()).unwrap();
    assert!(
        store
            .count_outstanding_by_source("local_cli", "parity-writer")
            .unwrap()
            .is_empty()
    );
    for request in [REQ_1, REQ_2] {
        store
            .insert_write_request(&insert_input(&store, request, "notes/a", json!({})))
            .unwrap();
    }
    let done = store
        .insert_write_request(&insert_input(
            &store,
            "b0000000-0000-4000-8000-0000000000b3",
            "notes/b",
            json!({}),
        ))
        .unwrap();
    let id = done["id"].as_str().unwrap();
    store.stamp_write_claim(&stamp(id, 1000.0, None)).unwrap();
    store
        .complete_write_row(&completion(id, "committed", 512))
        .unwrap()
        .unwrap();
    assert_eq!(
        store
            .count_outstanding_by_source("local_cli", "parity-writer")
            .unwrap(),
        vec![json!({ "source_id": "default", "n": 2 })]
    );
    assert!(
        store
            .count_outstanding_by_source("local_cli", "other-writer")
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .count_outstanding_by_source("mcp_client", "parity-writer")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn counter_rows_are_read_without_creating_any() {
    let dir = TempDir::new("persist-read-counters");
    let store = open(&dir);
    assert!(store.read_counter_rows(&keys()).unwrap().is_empty());
    store.lock_persistence_counters(&keys()).unwrap();
    store
        .insert_write_request(&insert_input(&store, REQ_1, "notes/a", json!({})))
        .unwrap();
    let rows = store
        .read_counter_rows(&[
            PRINCIPAL_KEY.into(),
            "brain".into(),
            "brain".into(),
            "missing".into(),
        ])
        .unwrap();
    let names: Vec<&str> = rows.iter().map(|r| r["key"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["brain", PRINCIPAL_KEY]);
    assert_eq!(rows[0]["outstanding_count"], json!(1));
    assert_eq!(rows[0]["terminal_bytes"], json!(4096));
    assert!(
        store
            .read_counter_rows(&["missing".into()])
            .unwrap()
            .is_empty()
    );
}

#[test]
fn admission_rate_samples_the_latest_requests_of_one_principal_or_the_brain() {
    let dir = TempDir::new("persist-admission-rate");
    let store = open(&dir);
    let empty = store.read_admission_rate(None).unwrap();
    assert_eq!(
        empty,
        json!({ "first_request_id": null, "admissions": 0, "age_seconds": null, "gross": null, "net": null })
    );
    store.lock_persistence_counters(&keys()).unwrap();
    let first = store
        .insert_write_request(&insert_input(&store, REQ_1, "notes/a", json!({})))
        .unwrap();
    store
        .insert_write_request(&insert_input(&store, REQ_2, "notes/b", json!({})))
        .unwrap();
    let brain = store.read_admission_rate(None).unwrap();
    assert_eq!(brain["first_request_id"], first["id"]);
    assert_eq!(brain["admissions"], json!(2));
    assert!(brain["age_seconds"].as_f64().unwrap() >= 0.0);
    assert_eq!(brain["gross"], json!(4096.0));
    // `{}` is 2 bytes of authority, plus the 1 KiB compaction headroom; no outcome, detail or client id.
    assert_eq!(brain["net"], json!(1026.0));
    let own = store
        .read_admission_rate(Some(("local_cli", "parity-writer")))
        .unwrap();
    assert_eq!(own["admissions"], json!(2));
    let other = store
        .read_admission_rate(Some(("local_cli", "other-writer")))
        .unwrap();
    assert_eq!(other["first_request_id"], first["id"]);
    assert_eq!(other["admissions"], json!(0));
    assert!(other["gross"].is_null() && other["age_seconds"].is_null());
}

#[test]
fn release_requeues_only_under_the_claim_token() {
    let dir = TempDir::new("persist-release");
    let store = open(&dir);
    let row = store
        .insert_write_request(&insert_input(&store, REQ_1, "notes/a", json!({})))
        .unwrap();
    let id = row["id"].as_str().unwrap();
    let release = |token: &str, reason: &str, charge: bool| ClaimRelease {
        id: id.into(),
        token: Some(token.into()),
        reason: reason.into(),
        charge,
    };
    assert!(
        !store
            .release_unpublished_claim(&release(TOKEN, "claim_lost", false))
            .unwrap()
    );
    store
        .stamp_write_claim(&stamp(id, 1000.0, Some(json!({"phase": "preparing"}))))
        .unwrap();
    let other = "c0000000-0000-4000-8000-0000000000c2";
    assert!(
        !store
            .release_unpublished_claim(&release(other, "claim_lost", false))
            .unwrap()
    );
    assert!(
        store
            .release_unpublished_claim(&release(TOKEN, "database_contention", false))
            .unwrap()
    );
    let after = store.read_write_request_by_id(id).unwrap().unwrap();
    assert_eq!(after["state"], "queued");
    assert_eq!(after["execution_token"], Value::Null);
    assert_eq!(after["claim_phase"], Value::Null);
    assert_eq!(after["blocked_reason"], "database_contention");
    store
        .stamp_write_claim(&stamp(id, 1000.0, Some(json!({"phase": "preparing"}))))
        .unwrap();
    assert!(
        store
            .release_unpublished_claim(&release(TOKEN, "preparation_deadline", true))
            .unwrap()
    );
    let charged = store.read_write_request_by_id(id).unwrap().unwrap();
    assert_eq!(charged["preparation_attempts"], 1);
    assert_eq!(charged["claim_phase"], json!({"phase": "preparing"}));
}
