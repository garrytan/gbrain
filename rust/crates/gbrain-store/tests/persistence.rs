//! The TypeScript journal members: counters, admission, the claim, renewal, expiry and completion.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::journal::Principal;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::persistence::{
    ClaimRelease, ClaimStamp, ClaimableSpec, ExpireClaims, HousekeepingClaim, HousekeepingTurn,
    IncarnationRequestFilter, ProjectionWindowCursor, SegmentedProjectionFilter,
    TopologyChangeInsert, WriteCancellation, WriteCompletion, WriteRequestInsert,
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
fn a_group_insert_is_one_write_and_a_later_refusal_keeps_no_row_or_charge() {
    let dir = TempDir::new("persist-insert-group");
    let store = open(&dir);
    store.lock_persistence_counters(&["brain".into()]).unwrap();
    let rows = store
        .insert_write_request_group(&[
            insert_input(&store, REQ_1, "notes/a", json!({"kind": "put_page"})),
            insert_input(&store, REQ_2, "notes/b", json!({"kind": "put_page"})),
        ])
        .unwrap();
    let sequences: Vec<_> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["sequence"].clone())
        .collect();
    assert_eq!(
        sequences,
        vec![json!(1), json!(2)],
        "one row per item, in item order"
    );
    let charged = counter(&store, "brain");
    assert_eq!(charged["outstanding_count"], 2);
    // The second item repeats an admitted request id: the store refuses it, and the new first item is not kept.
    const REQ_3: &str = "b0000000-0000-4000-8000-0000000000b3";
    let refused = store
        .insert_write_request_group(&[
            insert_input(&store, REQ_3, "notes/c", json!({"kind": "put_page"})),
            insert_input(&store, REQ_1, "notes/a", json!({"kind": "put_page"})),
        ])
        .unwrap_err();
    assert_eq!(refused.code, CONSTRAINT_VIOLATION, "{refused:?}");
    assert!(
        store
            .read_write_request(&principal(), REQ_3)
            .unwrap()
            .is_none(),
        "the first item is dropped with the write"
    );
    assert_eq!(
        counter(&store, "brain"),
        charged,
        "no counter charge is kept"
    );
    assert_eq!(store.insert_write_request_group(&[]).unwrap(), json!([]));
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
fn completion_stores_the_outcome_and_error_detail_in_jsonb_key_order() {
    let dir = TempDir::new("persist-complete-order");
    let store = open(&dir);
    store.lock_persistence_counters(&keys()).unwrap();
    let text = |v: &Value| serde_json::to_string(v).unwrap();
    let mut ids = Vec::new();
    for request in [REQ_1, "b0000000-0000-4000-8000-0000000000b9"] {
        let row = store
            .insert_write_request(&insert_input(&store, request, "notes/a", json!({})))
            .unwrap();
        ids.push(row["id"].as_str().unwrap().to_string());
    }
    let mut committed = completion(&ids[0], "committed", 512);
    committed.outcome = json!({"status": "ok", "zz": 1, "fact": {"kind": "fact", "id": 7}});
    let done = store.complete_write_row(&committed).unwrap().unwrap();
    // Shorter keys first, then bytes: not the caller's order, and not plain byte order either.
    let ordered = r#"{"zz":1,"fact":{"id":7,"kind":"fact"},"status":"ok"}"#;
    assert_eq!(text(&done["outcome"]), ordered);
    let read = store.read_write_request_by_id(&ids[0]).unwrap().unwrap();
    assert_eq!(text(&read["outcome"]), ordered);
    let mut failed = completion(&ids[1], "failed", 0);
    failed.outcome = Value::Null;
    failed.error_detail = json!({"retryable": false, "at": "publish"});
    let done = store.complete_write_row(&failed).unwrap().unwrap();
    assert_eq!(
        text(&done["error_detail"]),
        r#"{"at":"publish","retryable":false}"#
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

fn cancellation(id: &str, expect_state: &str, token: Option<&str>) -> WriteCancellation {
    let mut completion = completion(id, "cancelled", 0);
    completion.outcome = json!({});
    completion.error_code = Some("cancelled".into());
    completion.error_message = Some("Cancelled before publication.".into());
    WriteCancellation {
        completion,
        expect_state: expect_state.into(),
        expect_execution_token: token.map(str::to_string),
    }
}

#[test]
fn a_cancel_ends_a_queued_request_once_and_keeps_what_it_may_not_end() {
    let dir = TempDir::new("persist-cancel");
    let store = open(&dir);
    store.lock_persistence_counters(&keys()).unwrap();
    let row = store
        .insert_write_request(&insert_input(&store, REQ_1, "notes/a", json!({})))
        .unwrap();
    let id = row["id"].as_str().unwrap().to_string();
    assert_eq!(
        store
            .cancel_write_row(&cancellation(REQ_2, "queued", None))
            .unwrap(),
        None
    );
    let stale = store
        .cancel_write_row(&cancellation(&id, "running", None))
        .unwrap()
        .unwrap();
    assert_eq!(stale["status"], "kept");
    assert_eq!(stale["row"]["state"], "queued");
    assert_eq!(counter(&store, "brain")["outstanding_count"], 1);
    let done = store
        .cancel_write_row(&cancellation(&id, "queued", None))
        .unwrap()
        .unwrap();
    assert_eq!(done["status"], "cancelled");
    assert_eq!(done["row"]["state"], "cancelled");
    assert_eq!(done["row"]["error_code"], "cancelled");
    assert_eq!(done["row"]["outcome"], json!({}));
    for key in keys() {
        assert_eq!(counter(&store, &key)["outstanding_count"], 0);
    }
    let again = store
        .cancel_write_row(&cancellation(&id, "queued", None))
        .unwrap()
        .unwrap();
    assert_eq!(again["status"], "kept");
    assert_eq!(again["row"]["state"], "cancelled");
    assert_eq!(counter(&store, "brain")["outstanding_count"], 0);
}

#[test]
fn a_cancel_keeps_a_request_claimed_under_another_token_and_one_too_large_to_record() {
    let dir = TempDir::new("persist-cancel-kept");
    let store = open(&dir);
    store.lock_persistence_counters(&keys()).unwrap();
    let row = store
        .insert_write_request(&insert_input(&store, REQ_1, "notes/a", json!({})))
        .unwrap();
    let id = row["id"].as_str().unwrap().to_string();
    store.stamp_write_claim(&stamp(&id, 1000.0, None)).unwrap();
    let other = store
        .cancel_write_row(&cancellation(&id, "running", None))
        .unwrap()
        .unwrap();
    assert_eq!(other["status"], "kept");
    let mut big = cancellation(&id, "running", Some(TOKEN));
    big.completion.result_bytes = 5000;
    let too_large = store.cancel_write_row(&big).unwrap().unwrap();
    assert_eq!(too_large["status"], "too_large");
    assert_eq!(too_large["row"]["state"], "running");
    assert_eq!(counter(&store, "brain")["outstanding_count"], 1);
    let mut wrong = cancellation(&id, "running", Some(TOKEN));
    wrong.completion.state = "failed".into();
    assert!(store.cancel_write_row(&wrong).is_err());
    let done = store
        .cancel_write_row(&cancellation(&id, "running", Some(TOKEN)))
        .unwrap()
        .unwrap();
    assert_eq!(done["status"], "cancelled");
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

/// Admits, claims and settles `request` with `intent` as `state`.
fn settled(store: &Store, request: &str, slug: &str, intent: Value, state: &str) -> Value {
    store.lock_persistence_counters(&keys()).unwrap();
    let row = store
        .insert_write_request(&insert_input(store, request, slug, intent))
        .unwrap();
    let id = row["id"].as_str().unwrap().to_string();
    store.stamp_write_claim(&stamp(&id, 1000.0, None)).unwrap();
    store
        .complete_write_row(&completion(&id, state, 512))
        .unwrap()
        .unwrap()
}

#[test]
fn a_receipt_compaction_lists_settled_receipts_before_its_cutoff_outside_an_open_sync_run() {
    let dir = TempDir::new("persist-receipt-compaction");
    let store = open(&dir);
    let empty = store.read_receipt_compaction_window(0.0).unwrap();
    assert_eq!(empty["max_sequence"], Value::Null);
    let done = settled(
        &store,
        REQ_1,
        "notes/a",
        json!({ "runId": "run-1" }),
        "committed",
    );
    let failed = settled(&store, REQ_2, "notes/b", json!({}), "failed");
    // A cutoff an hour ahead takes both receipts; one an hour back takes neither.
    let ahead = store.read_receipt_compaction_window(-1.0).unwrap();
    let cutoff = ahead["cutoff"].as_str().unwrap().to_string();
    assert_eq!(cutoff.len(), "2026-01-01T00:00:00.000000Z".len());
    assert_eq!(ahead["max_sequence"], "2");
    let behind = store.read_receipt_compaction_window(1.0).unwrap();
    let behind = behind["cutoff"].as_str().unwrap();
    let list = |states: &[&str], cutoff: &str, max: &str| -> Vec<String> {
        let states: Vec<String> = states.iter().map(|s| s.to_string()).collect();
        store
            .list_receipt_compaction_candidates(&states, cutoff, max)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_string())
            .collect()
    };
    let both = vec![
        done["id"].as_str().unwrap().to_string(),
        failed["id"].as_str().unwrap().to_string(),
    ];
    assert_eq!(list(&["committed", "failed"], &cutoff, "2"), both);
    assert_eq!(list(&["committed"], &cutoff, "2"), both[..1].to_vec());
    assert!(list(&["committed", "failed"], behind, "2").is_empty());
    // The sequence the preview saw bounds the set.
    assert_eq!(
        list(&["committed", "failed"], &cutoff, "1"),
        both[..1].to_vec()
    );
    let row = &store
        .list_receipt_compaction_candidates(&["committed".to_string()], &cutoff, "2")
        .unwrap()[0];
    assert_eq!(row["sequence"], "1");
    assert_eq!(row["request_id"], REQ_1);
    assert_eq!(row["source_id"], "default");
    assert!(row["terminal_reservation"].is_string());
    // A managed-sync cursor of the run that is not done keeps its receipt.
    let open = json!([{ "runId": "run-1", "done": false }]);
    store
        .write_op_checkpoint_record("managed-sync", "fp-1", Some(&open))
        .unwrap();
    assert_eq!(
        list(&["committed", "failed"], &cutoff, "2"),
        both[1..].to_vec()
    );
    let closed = json!([{ "runId": "run-1", "done": true }]);
    store
        .write_op_checkpoint_record("managed-sync", "fp-1", Some(&closed))
        .unwrap();
    assert_eq!(list(&["committed", "failed"], &cutoff, "2"), both);
    assert_eq!(store.count_kept_failed_receipts(&cutoff).unwrap(), json!(1));
    assert_eq!(store.count_kept_failed_receipts(behind).unwrap(), json!(0));
    assert!(
        store
            .list_receipt_compaction_candidates(&[], "yesterday", "2")
            .is_err()
    );
    assert!(
        store
            .list_receipt_compaction_candidates(&[], &cutoff, "two")
            .is_err()
    );
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

#[test]
fn incarnation_requests_filter_by_slug_sequence_state_operation_and_request_id() {
    let dir = TempDir::new("persist-incarnation");
    let store = open(&dir);
    store.lock_persistence_counters(&keys()).unwrap();
    let first = store
        .insert_write_request(&insert_input(&store, REQ_1, "notes/a", json!({})))
        .unwrap();
    let second = store
        .insert_write_request(&insert_input(&store, REQ_2, "notes/a", json!({})))
        .unwrap();
    let id2 = second["id"].as_str().unwrap();
    store.stamp_write_claim(&stamp(id2, 1000.0, None)).unwrap();
    store
        .complete_write_row(&completion(id2, "committed", 512))
        .unwrap()
        .unwrap();
    let filter = |extra: Value| -> IncarnationRequestFilter {
        let mut base = json!({"sourceId": "default", "incarnation": incarnation(&store)});
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    };
    let seqs = |rows: Vec<Value>| -> Vec<String> {
        rows.iter()
            .map(|r| r["request_id"].as_str().unwrap().to_string())
            .collect()
    };
    let after_first = first["sequence"].to_string();
    // Later rows on the slug, oldest first; the first row is not after itself.
    assert_eq!(
        seqs(
            store
                .list_incarnation_requests(&filter(
                    json!({"slug": "notes/a", "afterSequence": after_first})
                ))
                .unwrap()
        ),
        vec![REQ_2]
    );
    assert_eq!(
        seqs(
            store
                .list_incarnation_requests(&filter(json!({"slug": "notes/b"})))
                .unwrap()
        ),
        Vec::<String>::new()
    );
    // Committed put_page rows by request id, newest first; an upper-case id matches as a uuid does.
    let committed = json!({"requestIds": [REQ_1, REQ_2.to_uppercase()], "states": ["committed"], "operation": "put_page", "newestFirst": true});
    assert_eq!(
        seqs(store.list_incarnation_requests(&filter(committed)).unwrap()),
        vec![REQ_2]
    );
    let both = json!({"requestIds": [REQ_1, REQ_2], "newestFirst": true});
    assert_eq!(
        seqs(store.list_incarnation_requests(&filter(both)).unwrap()),
        vec![REQ_2, REQ_1]
    );
    assert_eq!(
        seqs(
            store
                .list_incarnation_requests(&filter(json!({"requestIds": []})))
                .unwrap()
        ),
        Vec::<String>::new()
    );
    // Another incarnation gives no row.
    let other: IncarnationRequestFilter =
        serde_json::from_value(json!({"sourceId": "default", "incarnation": "other"})).unwrap();
    assert!(store.list_incarnation_requests(&other).unwrap().is_empty());
    // A request id that is not a uuid and a sequence that is not a u64 refuse, as the casts do.
    let bad_id = filter(json!({"requestIds": ["not-a-uuid"]}));
    assert_eq!(
        store.list_incarnation_requests(&bad_id).unwrap_err().code,
        INVALID_ARGUMENT
    );
    let bad_seq = filter(json!({"afterSequence": "x"}));
    assert_eq!(
        store.list_incarnation_requests(&bad_seq).unwrap_err().code,
        INVALID_ARGUMENT
    );
}

/// A committed request with `operation` and `outcome`, as the consumer leaves one.
fn committed_with(store: &Store, request: &str, operation: &str, outcome: Value) {
    store.lock_persistence_counters(&keys()).unwrap();
    let mut input = insert_input(store, request, "notes/a", json!({}));
    input.operation = operation.into();
    let id = store.insert_write_request(&input).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    store.stamp_write_claim(&stamp(&id, 1000.0, None)).unwrap();
    let mut done = completion(&id, "committed", 0);
    done.outcome = outcome;
    store.complete_write_row(&done).unwrap().unwrap();
}

#[test]
fn attribution_backfill_targets_the_rows_exactly_one_committed_request_proves() {
    let dir = TempDir::new("persist-attribution-backfill");
    let store = open(&dir);
    let input: PageInput = serde_json::from_value(
        json!({ "type": "note", "title": "A", "compiled_truth": "a", "timeline": "" }),
    )
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({})).unwrap();
    store.put_page("notes/a", &input, &options).unwrap();
    let scope = gbrain_store::pages::ReadScope {
        source_id: Some("default".into()),
        ..Default::default()
    };
    let snapshot = store
        .read_page_snapshot("notes/a", &scope)
        .unwrap()
        .unwrap();
    let revision = snapshot["page"]["knowledge_revision"].clone();
    let page_id = snapshot["page"]["id"].as_u64().unwrap();
    let facts: gbrain_store::facts::InsertFactsArgs = serde_json::from_value(json!({
        "rows": [
            { "fact": "fenced", "source": "parity", "source_markdown_slug": "notes/a", "row_num": 1 },
            { "fact": "twice", "source": "parity" },
        ],
        "sourceId": "default",
    }))
    .unwrap();
    let ids = store.insert_facts(&facts).unwrap()["ids"].clone();
    let (fenced, twice) = (ids[0].as_u64().unwrap(), ids[1].as_u64().unwrap());
    // A fenced remember proves the page revision it reports and the fact it inserted.
    committed_with(
        &store,
        REQ_1,
        "remember",
        json!({ "status": "inserted", "id": fenced.to_string(), "revision": revision }),
    );
    // Two requests name the second fact, so neither proves it; a 19-digit id names no fact.
    for request in [REQ_2, "b0000000-0000-4000-8000-0000000000b3"] {
        committed_with(
            &store,
            request,
            "remember",
            json!({ "status": "superseded", "id": twice }),
        );
    }
    committed_with(
        &store,
        "b0000000-0000-4000-8000-0000000000b4",
        "remember",
        json!({ "status": "inserted", "id": "1234567890123456789" }),
    );
    let scope = vec!["default".to_string()];
    let list = |table: &str| {
        store
            .list_proven_attribution_targets(table, &scope)
            .unwrap()
    };
    let count = |table: &str| store.count_unfilled_attribution(table, &scope).unwrap();
    assert_eq!(list("pages"), json!([page_id]));
    assert_eq!(list("facts"), json!([fenced]));
    assert_eq!(list("page_versions"), json!([]));
    assert_eq!(count("pages"), json!(1));
    assert_eq!(count("facts"), json!(2));
    assert_eq!(
        store
            .list_proven_attribution_targets("pages", &["other".to_string()])
            .unwrap(),
        json!([])
    );
    let err = store
        .list_proven_attribution_targets("takes", &scope)
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

/// A request on `slug` settled `state` with `code` and `message`, as the consumer leaves one.
#[allow(clippy::too_many_arguments)]
fn settled_with(
    store: &Store,
    request: &str,
    operation: &str,
    slug: &str,
    intent: Value,
    state: &str,
    code: Option<&str>,
    message: Option<&str>,
    detail: Value,
) -> String {
    store.lock_persistence_counters(&keys()).unwrap();
    let mut input = insert_input(store, request, slug, intent);
    input.operation = operation.into();
    let id = store.insert_write_request(&input).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    store.stamp_write_claim(&stamp(&id, 1000.0, None)).unwrap();
    let done: WriteCompletion = serde_json::from_value(json!({
        "id": id, "state": state, "outcome": {}, "errorCode": code, "errorMessage": message,
        "consumerVersion": "v-consumer", "consumerHostId": HOST, "errorDetail": detail, "resultBytes": 0,
        "counterKeys": keys(), "intentBytes": 10, "retainedBytes": 0, "terminalReservation": 4096,
        "probePurges": false,
    }))
    .unwrap();
    store.complete_write_row(&done).unwrap().unwrap();
    id
}

#[test]
fn failed_writes_lists_guard_drift_and_moved_fact_refusals_less_the_recovered_ones() {
    let dir = TempDir::new("persist-failed-writes");
    let store = open(&dir);
    let moved = "The fact entity changed after extraction admission.";
    let req = |n: u8| format!("b0000000-0000-4000-8000-0000000000{n:02x}");
    let guard = settled_with(
        &store,
        &req(0xb1),
        "put_page",
        "notes/a",
        json!({ "slug": "notes/a" }),
        "failed",
        Some("writer_coordinator_required"),
        None,
        json!({ "origin": "pending_import" }),
    );
    let drift = settled_with(
        &store,
        &req(0xb2),
        "put_page",
        "notes/a",
        json!({ "kind": "managed_sync_import" }),
        "conflict",
        Some("source_changed"),
        None,
        Value::Null,
    );
    let publication = settled_with(
        &store,
        &req(0xb3),
        "remember",
        "notes/a",
        json!({}),
        "failed",
        Some("storage_error"),
        Some("Publication failed (P0001): guard"),
        Value::Null,
    );
    settled_with(
        &store,
        &req(0xb4),
        "remember",
        "notes/a",
        json!({}),
        "failed",
        Some("storage_error"),
        Some("disk full"),
        Value::Null,
    );
    let open_fact = settled_with(
        &store,
        &req(0xb5),
        "extract_facts",
        "people/a",
        json!({ "inputDigest": "d1", "batchKey": "k1" }),
        "conflict",
        Some("revision_conflict"),
        Some(moved),
        Value::Null,
    );
    let recovered = settled_with(
        &store,
        &req(0xb6),
        "extract_facts",
        "people/a",
        json!({ "inputDigest": "d2", "batchKey": "k1" }),
        "conflict",
        Some("revision_conflict"),
        Some(moved),
        Value::Null,
    );
    settled_with(
        &store,
        &req(0xb7),
        "extract_facts",
        "people/a",
        json!({ "inputDigest": "d2", "batchKey": "k2" }),
        "committed",
        None,
        None,
        Value::Null,
    );
    let scope = vec!["default".to_string()];
    let replayable: Vec<String> = ["put_page", "add_timeline_entry", "remember"]
        .map(String::from)
        .to_vec();
    let messages = vec![moved.to_string()];
    let ids = |facts: Option<&[String]>, id: Option<&str>| -> Vec<String> {
        store
            .list_failed_write_requests(&scope, &replayable, facts, id)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(
        ids(None, None),
        vec![guard.clone(), drift.clone(), publication.clone()]
    );
    assert_eq!(
        ids(Some(&messages), None),
        vec![guard, drift, publication, open_fact]
    );
    // One request by id skips the recovery check, as the SQL's early return does.
    assert_eq!(
        ids(Some(&messages), Some(&recovered.to_uppercase())),
        vec![recovered]
    );
    assert!(
        store
            .list_failed_write_requests(&["other".to_string()], &replayable, None, None)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    let rows = store
        .list_failed_write_requests(&scope, &replayable, None, None)
        .unwrap();
    assert_eq!(rows[0]["producer"], Value::Null);
    assert_eq!(rows[0]["origin"], json!("pending_import"));
    assert_eq!(rows[0]["page_id"], Value::Null);
    assert!(
        rows[0]["created_at"].as_str().unwrap().ends_with('Z')
            && rows[0]["created_at"].as_str().unwrap().len() == 20
    );
    assert_eq!(rows[1]["producer"], json!("put_page:managed_sync_import"));
    assert_eq!(rows[2]["producer"], Value::Null);
    let refused = store
        .list_failed_write_requests(&scope, &replayable, None, Some("not-a-uuid"))
        .unwrap_err();
    assert_eq!(refused.code, INVALID_ARGUMENT);
}

#[test]
fn drift_conflicts_group_source_changed_receipts_by_slug_inside_the_window() {
    use gbrain_store::drift_conflicts::DriftConflictQuery;
    let dir = TempDir::new("persist-drift-conflicts");
    let store = open(&dir);
    let drift = "The canonical file contains an uncoordinated local edit.";
    assert_eq!(
        store.read_drift_conflict_bounds("missing").unwrap(),
        Value::Null
    );
    let empty = store.read_drift_conflict_bounds("default").unwrap();
    assert_eq!(
        (empty["top"].clone(), empty["bottom"].clone()),
        (Value::Null, Value::Null)
    );
    put_unsealed(&store, "notes/a", "a");
    let req = |n: u8| format!("d0000000-0000-4000-8000-0000000000{n:02x}");
    let settle = |n: u8,
                  slug: &str,
                  intent: Value,
                  state: &str,
                  code: Option<&str>,
                  message: Option<&str>| {
        settled_with(
            &store,
            &req(n),
            "put_page",
            slug,
            intent,
            state,
            code,
            message,
            Value::Null,
        )
    };
    settle(0xd1, "notes/a", json!({}), "committed", None, None);
    settle(
        0xd2,
        "notes/a",
        json!({ "kind": "managed_sync_import" }),
        "conflict",
        Some("source_changed"),
        Some(drift),
    );
    settle(
        0xd3,
        "notes/a",
        json!({}),
        "conflict",
        Some("source_changed"),
        Some("other"),
    );
    settle(
        0xd4,
        "people/b",
        json!({}),
        "conflict",
        Some("source_changed"),
        Some(drift),
    );
    settle(
        0xd5,
        "notes/a",
        json!({}),
        "conflict",
        Some("revision_conflict"),
        Some(drift),
    );
    let bounds = store.read_drift_conflict_bounds("default").unwrap();
    let top: i64 = bounds["top"].as_str().unwrap().parse().unwrap();
    let query = |floor: i64, prefixes: Option<Vec<String>>, live: bool, after: &str, limit: u64| {
        DriftConflictQuery {
            incarnation: bounds["incarnation"].as_str().unwrap().into(),
            floor: floor.to_string(),
            through: top.to_string(),
            slug_prefixes: prefixes,
            require_live_page: live,
            exclude_private: None,
            after: after.into(),
            limit,
            drift_message: drift.into(),
        }
    };
    let all = store
        .list_drift_conflict_groups("default", &query(0, None, false, "", 10))
        .unwrap();
    assert_eq!(
        (all["slugs"].clone(), all["receipts"].clone()),
        (json!(2), json!(3))
    );
    let rows = all["rows"].as_array().unwrap();
    assert_eq!(rows[0]["slug"], json!("notes/a"));
    assert_eq!(rows[0]["receipts"], json!(2));
    assert_eq!(rows[0]["drift_receipts"], json!(1));
    assert_eq!(
        rows[0]["producers"],
        json!(["put_page", "put_page:managed_sync_import"])
    );
    assert_eq!(rows[0]["last_request_id"], json!(req(0xd3)));
    assert_eq!(rows[0]["first_seen"].as_str().unwrap().len(), 20);
    assert_eq!(rows[1]["slug"], json!("people/b"));
    let paged = store
        .list_drift_conflict_groups("default", &query(0, None, false, "notes/a", 1))
        .unwrap();
    assert_eq!(paged["rows"].as_array().unwrap().len(), 1);
    assert_eq!(paged["rows"][0]["slug"], json!("people/b"));
    let window = store
        .list_drift_conflict_groups("default", &query(top - 2, None, false, "", 10))
        .unwrap();
    assert_eq!(window["receipts"], json!(1));
    let fenced = store
        .list_drift_conflict_groups(
            "default",
            &query(0, Some(vec!["people/b".into()]), false, "", 10),
        )
        .unwrap();
    assert_eq!(fenced["slugs"], json!(1));
    let live = store
        .list_drift_conflict_groups("default", &query(0, None, true, "", 10))
        .unwrap();
    assert_eq!(
        (live["slugs"].clone(), live["receipts"].clone()),
        (json!(1), json!(2))
    );
    let refused = store
        .list_drift_conflict_groups(
            "default",
            &DriftConflictQuery {
                floor: "x".into(),
                ..query(0, None, false, "", 1)
            },
        )
        .unwrap_err();
    assert_eq!(refused.code, INVALID_ARGUMENT);
    let details = store
        .read_drift_conflict_details("default", &["notes/a".into(), "people/b".into()], true)
        .unwrap();
    assert_eq!(details["committed"].as_array().unwrap().len(), 1);
    assert_eq!(details["committed"][0]["request_id"], json!(req(0xd1)));
    assert_eq!(
        details["recorded"],
        json!([{ "slug": "notes/a", "source_path": null, "source_uri": null }])
    );
    let no_paths = store
        .read_drift_conflict_details("default", &["notes/a".into()], false)
        .unwrap();
    assert_eq!(no_paths["recorded"], json!([]));
}

#[test]
fn requests_by_request_id_span_principals_and_stop_at_two() {
    let dir = TempDir::new("persist-by-request-id");
    let store = open(&dir);
    assert!(
        store
            .list_write_requests_by_request_id(REQ_1)
            .unwrap()
            .is_empty()
    );
    let mine = store
        .insert_write_request(&insert_input(&store, REQ_1, "notes/a", json!({})))
        .unwrap();
    let one = store
        .list_write_requests_by_request_id(&REQ_1.to_uppercase())
        .unwrap();
    assert_eq!(one, vec![mine.clone()]);
    // A second principal admits the same request id: the read is ambiguous and says so.
    let mut theirs = insert_input(&store, REQ_1, "notes/b", json!({}));
    theirs.principal_id = "other-writer".into();
    store.insert_write_request(&theirs).unwrap();
    let mut third = insert_input(&store, REQ_1, "notes/c", json!({}));
    third.principal_id = "third-writer".into();
    store.insert_write_request(&third).unwrap();
    let rows = store.list_write_requests_by_request_id(REQ_1).unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r["request_id"] == REQ_1));
    assert!(
        store
            .list_write_requests_by_request_id(REQ_2)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .list_write_requests_by_request_id("nope")
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}

#[test]
fn pending_write_health_counts_in_flight_writes_and_the_named_pending_writes_that_later_failed() {
    use gbrain_store::telemetry::McpRequestLogInput;
    let dir = TempDir::new("persist-health");
    let store = open(&dir);
    let empty = store.read_pending_write_health().unwrap();
    assert_eq!(
        empty,
        json!({ "pending_writes": 0, "oldest_pending_write_age_seconds": 0, "pending_writes_later_failed": 0 })
    );
    store.lock_persistence_counters(&keys()).unwrap();
    store
        .insert_write_request(&insert_input(&store, REQ_1, "notes/a", json!({})))
        .unwrap();
    let failed = store
        .insert_write_request(&insert_input(&store, REQ_2, "notes/b", json!({})))
        .unwrap();
    let id = failed["id"].as_str().unwrap();
    store.stamp_write_claim(&stamp(id, 1000.0, None)).unwrap();
    store
        .complete_write_row(&completion(id, "failed", 0))
        .unwrap()
        .unwrap();
    let log = |status: &str, params: Option<Value>| McpRequestLogInput {
        operation: Some("put_page".into()),
        status: Some(status.into()),
        params,
        ..McpRequestLogInput::default()
    };
    for (status, params) in [
        (
            "accepted_pending",
            Some(json!({ "write_request_id": REQ_1 })),
        ),
        (
            "accepted_pending",
            Some(json!({ "write_request_id": REQ_2 })),
        ),
        (
            "accepted_pending",
            Some(json!({ "write_request_id": REQ_2 })),
        ),
        ("success", Some(json!({ "write_request_id": REQ_2 }))),
        ("accepted_pending", None),
    ] {
        store.log_mcp_request(&log(status, params)).unwrap();
    }
    let health = store.read_pending_write_health().unwrap();
    assert_eq!(
        health["pending_writes"], 1,
        "the queued request is in flight"
    );
    assert_eq!(
        health["pending_writes_later_failed"], 1,
        "the failed request counts once, however many rows name it"
    );
    assert!(health["oldest_pending_write_age_seconds"].as_i64().unwrap() >= 0);
}
