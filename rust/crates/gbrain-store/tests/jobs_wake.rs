//! The Wakeshift report-back tables (`src/core/engine-sql/jobs-wake.ts`): what the parity file
//! (`test/engine-parity/jobs-wake.test.ts`) cannot reach because it cannot move the clock or write a
//! journal column no typed member writes (a write request committed with a recovery record), and the
//! places this store differs from Postgres on purpose.

use gbrain_store::access_members::AccessMemberInsert;
use gbrain_store::env::{Env, uuid_from_bytes};
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::jobs::{
    CronRunInput, EndSpec, ForgetClaimSpec, ForgetSettle, WatchFilter, WatchInsert, WatchSettle,
};
use gbrain_store::keys;
use gbrain_store::kv::Kv;
use gbrain_store::persistence::{ClaimStamp, WriteCompletion, WriteRequestInsert};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{OpenOptions, Store};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};

/// 2027-01-15T08:00:00Z.
const T0: i64 = 1_800_000_000_000_000;
const SECOND: i64 = 1_000_000;
const DAY: i64 = 86_400 * SECOND;
const FAR: &str = "2099-01-01T00:00:00.000000Z";

static NEXT: AtomicU32 = AtomicU32::new(0);

struct Clock {
    now: AtomicI64,
    ids: AtomicU64,
}

impl Env for Clock {
    fn now_micros(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        let n = self.ids.fetch_add(1, Ordering::SeqCst);
        let mut bytes = [0u8; 16];
        bytes[8..].copy_from_slice(&n.to_be_bytes());
        uuid_from_bytes(bytes)
    }
}

/// A store on a clock the test moves, and the key-value file under it (to write a record the
/// store's members cannot).
struct Brain {
    store: Store,
    clock: Arc<Clock>,
    kv: Arc<RedbKv>,
    dir: PathBuf,
}

impl Brain {
    fn advance(&self, micros: i64) {
        self.clock.now.fetch_add(micros, Ordering::SeqCst);
    }
}

impl std::ops::Deref for Brain {
    type Target = Store;
    fn deref(&self) -> &Store {
        &self.store
    }
}

impl Drop for Brain {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn brain(name: &str) -> Brain {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "wake-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let clock = Arc::new(Clock {
        now: AtomicI64::new(T0),
        ids: AtomicU64::new(1),
    });
    let kv = Arc::new(RedbKv::open_path(&dir.join("records.redb")).unwrap());
    let store = Store::open_kv(kv.clone(), clock.clone(), OpenOptions::default()).unwrap();
    Brain {
        store,
        clock,
        kv,
        dir,
    }
}

fn user(n: u32) -> String {
    format!("{n:032x}")
}

fn watch(n: u32, extra: Value) -> WatchInsert {
    let mut base = json!({
        "event": "gbrain.job.finished", "target": "1", "targetRef": null, "principalKind": "local_stdio",
        "principalId": "me", "memberId": null, "wakeUser": user(1), "wsSubscriptionId": format!("ws-{n}"),
        "expiresAt": FAR,
    });
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    serde_json::from_value(base).unwrap()
}

fn open(b: &Brain, n: u32, extra: Value) -> i64 {
    b.open_wake_watch(&watch(n, extra)).unwrap()
}

fn end(reason: &str, id: Option<i64>) -> EndSpec {
    serde_json::from_value(json!({ "reason": reason, "id": id })).unwrap()
}

fn filter(scope: &str) -> WatchFilter {
    serde_json::from_value(json!({
        "principalKind": "local_stdio", "principalId": "me", "memberId": null, "scope": scope,
    }))
    .unwrap()
}

fn settle(id: i64, lease: &str, state: &str, extra: Value) -> WatchSettle {
    let mut base = json!({ "id": id, "lease": lease, "state": state });
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    serde_json::from_value(base).unwrap()
}

fn ids(rows: &[Value]) -> Vec<i64> {
    rows.iter().map(|r| r["id"].as_i64().unwrap()).collect()
}

fn run(name: &str, status: &str, at: Option<&str>) -> CronRunInput {
    serde_json::from_value(json!({ "name": name, "status": status, "finishedAt": at })).unwrap()
}

fn code(e: gbrain_store::StoreError) -> String {
    e.code.to_string()
}

#[test]
fn a_second_open_watch_of_one_subscription_spends_a_sequence_value_and_a_refused_one_does_not() {
    let b = brain("sequence");
    assert_eq!(open(&b, 1, json!({})), 1);
    assert_eq!(open(&b, 1, json!({ "target": "2" })), 1);
    // The Postgres sequence moved for the conflicting insert: the next row is 3.
    assert_eq!(open(&b, 2, json!({})), 3);
    // A refused row rolls its sequence value back here (Postgres keeps it spent): documented in
    // rust/docs/store/jobs-wake.md.
    let refused = b
        .open_wake_watch(&watch(3, json!({ "event": "job.finished" })))
        .unwrap_err();
    assert_eq!(code(refused), CONSTRAINT_VIOLATION);
    assert_eq!(open(&b, 4, json!({})), 4);
    // The first row kept its target and took the new expiry.
    let rows = b.list_wake_watches(&filter("open")).unwrap();
    let first = rows.iter().find(|r| r["id"] == 1).unwrap();
    assert_eq!(first["target"], "1");
}

#[test]
fn a_time_that_is_not_iso_or_text_with_a_nul_is_an_invalid_argument() {
    let b = brain("invalid");
    let bad_time = b
        .open_wake_watch(&watch(1, json!({ "expiresAt": "next tuesday" })))
        .unwrap_err();
    assert_eq!(code(bad_time), INVALID_ARGUMENT);
    let nul = b
        .open_wake_watch(&watch(1, json!({ "target": "a\u{0}b" })))
        .unwrap_err();
    assert_eq!(code(nul), INVALID_ARGUMENT);
    assert_eq!(
        code(b.add_wake_cron("bad\u{0}name").unwrap_err()),
        INVALID_ARGUMENT
    );
    assert_eq!(
        code(
            b.record_wake_cron_run(&run("c", "ok", Some("not a time")))
                .unwrap_err()
        ),
        INVALID_ARGUMENT
    );
    assert_eq!(
        code(b.list_wake_watches(&filter("sometimes")).unwrap_err()),
        INVALID_ARGUMENT
    );
    assert_eq!(
        code(b.end_wake_watches(&end("unwatched", None)).unwrap_err()),
        INVALID_ARGUMENT
    );
    assert_eq!(
        code(b.end_wake_watches(&end("sleepy", None)).unwrap_err()),
        INVALID_ARGUMENT
    );
    assert!(b.list_wake_watches(&filter("open")).unwrap().is_empty());
}

#[test]
fn the_list_holds_open_watches_and_those_updated_in_the_last_day() {
    let b = brain("recent");
    let delivered = open(&b, 1, json!({}));
    let open_one = open(&b, 2, json!({}));
    let lease = b.claim_wake_watch(delivered, 60).unwrap().unwrap()["lease"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        b.settle_wake_watch(&settle(delivered, &lease, "delivered", json!({})))
            .unwrap()
    );
    let both = ids(&b.list_wake_watches(&filter("open_or_recent")).unwrap());
    assert_eq!(both, vec![open_one, delivered]);
    b.advance(DAY - SECOND);
    assert_eq!(
        ids(&b.list_wake_watches(&filter("open_or_recent")).unwrap()),
        vec![open_one, delivered]
    );
    b.advance(2 * SECOND);
    assert_eq!(
        ids(&b.list_wake_watches(&filter("open_or_recent")).unwrap()),
        vec![open_one]
    );
    assert_eq!(
        ids(&b.list_wake_watches(&filter("open")).unwrap()),
        vec![open_one]
    );
}

#[test]
fn a_watch_past_its_expiry_ends_as_expired_and_keeps_its_lease() {
    let b = brain("expired");
    let soon = open(
        &b,
        1,
        json!({ "expiresAt": gbrain_store::env::iso(T0 + 10 * SECOND) }),
    );
    let later = open(&b, 2, json!({}));
    let lease = b.claim_wake_watch(soon, 3600).unwrap().unwrap()["lease"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        b.end_wake_watches(&end("expired", None))
            .unwrap()
            .is_empty()
    );
    b.advance(11 * SECOND);
    let ended = b.end_wake_watches(&end("expired", None)).unwrap();
    assert_eq!(ids(&ended), vec![soon]);
    // The ended row is not open, so its settle loses; the live one is untouched.
    assert!(
        !b.settle_wake_watch(&settle(soon, &lease, "delivered", json!({})))
            .unwrap()
    );
    let rows = b.list_wake_watches(&filter("open_or_recent")).unwrap();
    let states: Vec<_> = rows
        .iter()
        .map(|r| {
            (
                r["id"].as_i64().unwrap(),
                r["state"].clone(),
                r["last_error"].clone(),
            )
        })
        .collect();
    assert_eq!(
        states,
        vec![
            (later, json!("open"), Value::Null),
            (soon, json!("ended"), json!("expired")),
        ]
    );
}

#[test]
fn a_lease_lapses_on_the_clock_and_the_old_holder_loses() {
    let b = brain("lease");
    let id = open(&b, 1, json!({ "target": "99999" }));
    let first = b.claim_wake_watch(id, 60).unwrap().unwrap();
    assert_eq!(first["lease"], (T0 + 60 * SECOND).to_string());
    assert!(b.claim_wake_watch(id, 60).unwrap().is_none());
    b.advance(60 * SECOND);
    // A lease is held until the instant it names has passed.
    assert!(b.claim_wake_watch(id, 60).unwrap().is_none());
    assert!(b.list_due_wake_watches(None).unwrap().is_empty());
    b.advance(1);
    assert_eq!(ids(&b.list_due_wake_watches(None).unwrap()), vec![id]);
    let second = b.claim_wake_watch(id, 60).unwrap().unwrap();
    let stale = settle(id, first["lease"].as_str().unwrap(), "delivered", json!({}));
    assert!(!b.settle_wake_watch(&stale).unwrap());
    let fresh = settle(
        id,
        second["lease"].as_str().unwrap(),
        "open",
        json!({ "attempts": 3, "delayS": 90, "error": "network" }),
    );
    assert!(b.settle_wake_watch(&fresh).unwrap());
    // Back to open with a delay: due again only after 90 seconds.
    b.advance(89 * SECOND);
    assert!(b.list_due_wake_watches(None).unwrap().is_empty());
    b.advance(SECOND);
    let due = b.list_due_wake_watches(None).unwrap();
    assert_eq!(ids(&due), vec![id]);
    assert_eq!(due[0]["attempts"], 3);
    assert_eq!(b.claim_wake_watch(id, 60).unwrap().unwrap()["attempts"], 3);
}

#[test]
fn a_settle_keeps_the_marker_and_attempts_it_is_not_given_and_clears_the_error() {
    let b = brain("settle");
    let id = open(&b, 1, json!({ "target": "99999" }));
    let lease = |b: &Brain| {
        b.claim_wake_watch(id, 60).unwrap().unwrap()["lease"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let l = lease(&b);
    b.settle_wake_watch(&settle(
        id,
        &l,
        "open",
        json!({ "marker": "m-1", "attempts": 2, "error": "slow", "delayS": 0 }),
    ))
    .unwrap();
    let l = lease(&b);
    b.settle_wake_watch(&settle(id, &l, "delivered", json!({})))
        .unwrap();
    let row = &b.list_wake_watches(&filter("open_or_recent")).unwrap()[0];
    assert_eq!(row["attempts"], 2);
    assert!(row["last_error"].is_null());
    assert_eq!(row["state"], "delivered");
    assert_eq!(
        code(
            b.settle_wake_watch(&settle(id, "1", "sleeping", json!({})))
                .unwrap_err()
        ),
        CONSTRAINT_VIOLATION
    );
}

#[test]
fn the_doctor_counts_the_seven_day_watches_the_one_day_forgets_and_the_thirty_day_dead_ones() {
    let b = brain("doctor");
    let ended = open(&b, 1, json!({}));
    b.end_wake_watches(&end("unwatched", Some(ended))).unwrap();
    open(&b, 2, json!({}));
    b.queue_wake_forget(&user(1), None).unwrap();
    b.queue_wake_forget(&user(2), None).unwrap();
    let claims = b
        .claim_wake_forgets(
            &serde_json::from_value(json!({ "leaseSeconds": 60, "limit": 1 })).unwrap(),
        )
        .unwrap();
    let settle_dead = |c: &Value| -> ForgetSettle {
        serde_json::from_value(json!({
            "id": c["id"], "lease": c["lease"], "state": "dead", "attempts": 5, "error": "refused",
        }))
        .unwrap()
    };
    assert!(b.settle_wake_forget(&settle_dead(&claims[0])).unwrap());
    let watches = |b: &Brain| b.read_wake_doctor().unwrap()["watches"].clone();
    assert_eq!(
        watches(&b),
        json!([
            { "state": "ended", "id_reused": false, "n": 1 },
            { "state": "open", "id_reused": null, "n": 1 },
        ])
    );
    let doctor = b.read_wake_doctor().unwrap();
    assert_eq!(
        (
            doctor["stale_forgets"].clone(),
            doctor["dead_forgets"].clone()
        ),
        (json!(0), json!(1))
    );
    b.advance(DAY + SECOND);
    assert_eq!(b.read_wake_doctor().unwrap()["stale_forgets"], 1);
    b.advance(6 * DAY);
    // 7 days and a bit on: the ended watch drops out of the window, the open one stays.
    assert_eq!(
        watches(&b),
        json!([{ "state": "open", "id_reused": null, "n": 1 }])
    );
    b.advance(23 * DAY - 2 * SECOND);
    assert_eq!(b.read_wake_doctor().unwrap()["dead_forgets"], 1);
    b.advance(2 * SECOND);
    assert_eq!(b.read_wake_doctor().unwrap()["dead_forgets"], 0);
}

#[test]
fn a_cron_run_is_kept_seven_days_for_the_doctor_and_thirty_for_the_list() {
    let b = brain("runs");
    b.add_wake_cron("known").unwrap();
    // A second add of a registered name keeps the first registration time.
    let registered_at = b.list_wake_crons().unwrap()[0]["created_at"].clone();
    b.advance(SECOND);
    b.add_wake_cron("known").unwrap();
    assert_eq!(b.list_wake_crons().unwrap()[0]["created_at"], registered_at);
    // A watch on the cron waits for the first run at or after it began; it stays open, so the run it
    // is joined to shows which runs are still kept.
    let cron_watch = open(
        &b,
        7,
        json!({ "event": "gbrain.cron.finished", "target": "known" }),
    );
    b.record_wake_cron_run(&run("stray", "ok", None)).unwrap();
    b.record_wake_cron_run(&run("known", "failed", None))
        .unwrap();
    assert_eq!(
        b.read_wake_doctor().unwrap()["unregistered"],
        json!(["stray"])
    );
    b.advance(7 * DAY - SECOND);
    assert_eq!(
        b.read_wake_doctor().unwrap()["unregistered"],
        json!(["stray"])
    );
    b.advance(2 * SECOND);
    assert_eq!(b.read_wake_doctor().unwrap()["unregistered"], json!([]));
    // Thirty days on, the next run of a name drops that name's older runs, and only that name's.
    b.advance(23 * DAY);
    let reg = b.record_wake_cron_run(&run("known", "ok", None)).unwrap();
    assert_eq!(reg, json!({ "registered": true }));
    let list = b.list_wake_crons().unwrap();
    assert_eq!(list[0]["last_status"], "ok");
    b.record_wake_cron_run(&run("stray", "failed", None))
        .unwrap();
    // The failed run of `known` (30 days and 1 second old when `known` ran again) is gone: only the
    // `ok` run remains, so a run recorded with the old time is not a duplicate of anything.
    let again = b
        .record_wake_cron_run(&run("known", "failed", Some(&gbrain_store::env::iso(T0))))
        .unwrap();
    assert_eq!(again, json!({ "registered": true }));
    assert_eq!(b.list_wake_crons().unwrap()[0]["last_status"], "ok");
    // The failed run was dropped once it was past 30 days (a 31-day rule would still hold it), so the
    // watch is joined to the `ok` run, the first one left.
    let due = b.list_due_wake_watches(None).unwrap();
    assert_eq!(ids(&due), vec![cron_watch]);
    assert_eq!(due[0]["run_status"], "ok");
}

/// Writes `recovery` into the request's stored record, as the TypeScript journal does for a write
/// that still has recovery work.
fn set_recovery(b: &Brain, id: &str, recovery: Value) {
    let key = keys::request(id);
    let mut tx = b.kv.begin_write().unwrap();
    let mut record: Value = serde_json::from_slice(&tx.get(&key).unwrap().unwrap()).unwrap();
    record["recovery"] = recovery;
    tx.put(&key, &serde_json::to_vec(&record).unwrap()).unwrap();
    tx.commit().unwrap();
}

fn committed_request(b: &Brain) -> String {
    let keys_ = vec!["principal:local_cli:w".to_string(), "brain".to_string()];
    let incarnation = b.read_source_membership("default").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string();
    b.lock_persistence_counters(&keys_).unwrap();
    let insert: WriteRequestInsert = serde_json::from_value(json!({
        "principalKind": "local_cli", "principalId": "w", "requestId": "b0000000-0000-4000-8000-0000000000b1",
        "operation": "put_page", "sourceId": "default", "sourceIncarnation": incarnation, "pageId": null,
        "slug": "notes/a", "worktreeId": null, "topologyGeneration": null, "digest": "d", "intent": {},
        "authority": {}, "intentBytes": 10, "terminalReservation": 4096, "targetKind": "page",
        "protocolVersion": 1, "admitterVersion": "v", "admitterHostId": null, "counterKeys": keys_,
        "clientRequestId": null, "state": "queued", "deferredRefreshId": null,
    }))
    .unwrap();
    let id = b.insert_write_request(&insert).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let stamp = ClaimStamp {
        id: id.clone(),
        token: "c0000000-0000-4000-8000-0000000000c1".into(),
        lease_ms: 60_000.0,
        phase_json: None,
    };
    b.stamp_write_claim(&stamp).unwrap().unwrap();
    let done: WriteCompletion = serde_json::from_value(json!({
        "id": id, "state": "committed", "outcome": {}, "errorCode": null, "errorMessage": null,
        "consumerVersion": "v", "consumerHostId": null, "errorDetail": null, "resultBytes": 0,
        "counterKeys": keys_, "intentBytes": 10, "retainedBytes": 100, "terminalReservation": 4096,
        "probePurges": false,
    }))
    .unwrap();
    b.complete_write_row(&done).unwrap().unwrap();
    id
}

#[test]
fn a_write_committed_with_a_recovery_record_is_not_settled_until_the_recovery_is_gone() {
    let b = brain("recovery");
    let request = committed_request(&b);
    let w = open(
        &b,
        1,
        json!({ "event": "gbrain.write.settled", "target": request, "targetRef": request }),
    );
    let due = b.list_due_wake_watches(None).unwrap();
    assert_eq!(ids(&due), vec![w]);
    assert_eq!(due[0]["req_state"], "committed");
    assert_eq!(due[0]["req_id"], request);
    set_recovery(&b, &request, json!({ "step": 1 }));
    assert!(b.list_due_wake_watches(None).unwrap().is_empty());
    set_recovery(&b, &request, Value::Null);
    assert_eq!(ids(&b.list_due_wake_watches(None).unwrap()), vec![w]);
}

#[test]
fn the_due_batch_is_ordered_by_due_time_then_id() {
    let b = brain("order");
    let first = open(&b, 1, json!({ "target": "99999" }));
    let second = open(&b, 2, json!({ "target": "99999" }));
    b.advance(SECOND);
    let third = open(&b, 3, json!({ "target": "99999" }));
    let lease = b.claim_wake_watch(first, 60).unwrap().unwrap()["lease"]
        .as_str()
        .unwrap()
        .to_string();
    // Retried with no delay: due again at the current time, after the second row's earlier time.
    b.settle_wake_watch(&settle(first, &lease, "open", json!({ "delayS": 0 })))
        .unwrap();
    assert_eq!(
        ids(&b.list_due_wake_watches(None).unwrap()),
        vec![second, first, third]
    );
}

#[test]
fn a_watch_ended_by_unwatch_loses_its_lease_and_a_forget_for_a_member_queues_once_it_is_removed() {
    let b = brain("forget");
    let id = open(&b, 1, json!({ "target": "99999" }));
    let lease = b.claim_wake_watch(id, 60).unwrap().unwrap()["lease"]
        .as_str()
        .unwrap()
        .to_string();
    b.end_wake_watches(&end("unwatched", Some(id))).unwrap();
    assert!(
        !b.settle_wake_watch(&settle(id, &lease, "delivered", json!({})))
            .unwrap()
    );
    // A member id queues only while no access member with that id is still there: a disabled
    // member keeps its user, a removed one does not.
    let spec: AccessMemberInsert = serde_json::from_value(json!({ "id": "m-1" })).unwrap();
    b.insert_access_member(&spec).unwrap();
    b.set_access_member_disabled("m-1", true).unwrap();
    b.queue_wake_forget(&user(5), Some("m-1")).unwrap();
    assert_eq!(b.count_pending_wake_forgets().unwrap(), 0);
    assert_eq!(
        code(b.queue_wake_forget(&user(5), Some("m\0")).unwrap_err()),
        INVALID_ARGUMENT
    );
    b.tombstone_access_member("m-1").unwrap();
    b.queue_wake_forget(&user(5), Some("m-1")).unwrap();
    b.queue_wake_forget(&user(5), None).unwrap();
    assert_eq!(b.count_pending_wake_forgets().unwrap(), 1);
    // The second queue wrote no row: the doctor sees one stale forget, not two.
    b.advance(2 * DAY);
    assert_eq!(b.read_wake_doctor().unwrap()["stale_forgets"], 1);
    let claim: ForgetClaimSpec =
        serde_json::from_value(json!({ "leaseSeconds": 60, "limit": 10 })).unwrap();
    let claimed = b.claim_wake_forgets(&claim).unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(b.count_pending_wake_forgets().unwrap(), 1);
    // A claim that lapsed leaves the forget pending for the next claim.
    b.advance(60 * SECOND + 1);
    assert_eq!(b.claim_wake_forgets(&claim).unwrap().len(), 1);
    assert_eq!(
        code(b.queue_wake_forget("not-hex", None).unwrap_err()),
        CONSTRAINT_VIOLATION
    );
}

#[test]
fn forgetting_a_member_queues_its_users_ends_its_open_watches_and_drops_only_its_terms() {
    let b = brain("forget-member");
    let leased = open(&b, 1, json!({ "memberId": "m-1", "wakeUser": user(3) }));
    open(&b, 2, json!({ "memberId": "m-1", "wakeUser": user(2) }));
    let gone = open(&b, 3, json!({ "memberId": "m-1", "wakeUser": user(4) }));
    b.end_wake_watches(&end("unwatched", Some(gone))).unwrap();
    open(&b, 4, json!({ "memberId": "m-1", "wakeUser": user(5) }));
    b.queue_wake_forget(&user(5), None).unwrap();
    open(&b, 5, json!({ "memberId": "m-10", "wakeUser": user(6) }));
    let lease = b.claim_wake_watch(leased, 60).unwrap().unwrap()["lease"]
        .as_str()
        .unwrap()
        .to_string();
    let v = "a".repeat(16);
    for key in ["member:m-1", "member:m-10", "member:m-", "m-1"] {
        b.record_wake_terms_acceptance(key, &v).unwrap();
    }
    b.record_wake_terms_acceptance("member:m-1", &"b".repeat(16))
        .unwrap();
    assert_eq!(
        b.forget_wake_member("m-1").unwrap(),
        json!({ "ended": 3, "queued": 3 })
    );
    // The ended watch lost its lease; the holder can no longer settle it.
    assert!(
        !b.settle_wake_watch(&settle(leased, &lease, "delivered", json!({})))
            .unwrap()
    );
    // Users 2, 3 and 4 are queued in byte order. User 5 was pending already, and its candidate
    // still spent a sequence value, as ON CONFLICT DO NOTHING does on Postgres: the pending
    // forget is 1, the new ones 2, 3, 4, and the next queue takes 6.
    let claim: ForgetClaimSpec =
        serde_json::from_value(json!({ "leaseSeconds": 60, "limit": 10 })).unwrap();
    let claimed: Vec<(i64, String)> = b
        .claim_wake_forgets(&claim)
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["id"].as_i64().unwrap(),
                c["wake_user"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        claimed,
        vec![(1, user(5)), (2, user(2)), (3, user(3)), (4, user(4))]
    );
    b.queue_wake_forget(&user(9), None).unwrap();
    let next = b.claim_wake_forgets(&claim).unwrap();
    assert_eq!(next[0]["id"], 6);
    for (key, kept) in [
        ("member:m-1", false),
        ("member:m-10", true),
        ("member:m-", true),
        ("m-1", true),
    ] {
        assert_eq!(b.has_wake_terms_acceptance(key, &v).unwrap(), kept, "{key}");
    }
    assert!(
        !b.has_wake_terms_acceptance("member:m-1", &"b".repeat(16))
            .unwrap()
    );
    // Nothing left to do: a second call changes nothing.
    assert_eq!(
        b.forget_wake_member("m-1").unwrap(),
        json!({ "ended": 0, "queued": 0 })
    );
    let other = b
        .list_wake_watches(
            &serde_json::from_value(json!({
                "principalKind": "local_stdio", "principalId": "me", "memberId": "m-10", "scope": "open",
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(other.len(), 1);
}

#[test]
fn forgetting_a_credential_queues_its_memberless_users_ends_all_its_open_watches_and_drops_only_its_terms()
 {
    let b = brain("forget-credential");
    let client = |n: u32, member: Value, u: u32| {
        json!({ "target": n.to_string(), "principalKind": "oauth_client", "principalId": "client-A",
                "memberId": member, "wakeUser": user(u) })
    };
    let leased = open(&b, 1, client(1, Value::Null, 2));
    open(&b, 2, client(2, json!("m-1"), 3));
    let gone = open(&b, 3, client(3, Value::Null, 4));
    b.end_wake_watches(&end("unwatched", Some(gone))).unwrap();
    b.queue_wake_forget(&user(4), None).unwrap();
    open(
        &b,
        4,
        json!({ "target": "4", "principalKind": "oauth_client", "principalId": "client-a", "wakeUser": user(5) }),
    );
    open(
        &b,
        5,
        json!({ "target": "5", "principalKind": "legacy_token", "principalId": "client-A", "wakeUser": user(6) }),
    );
    open(
        &b,
        6,
        json!({ "target": "6", "principalKind": "legacy_token", "principalId": "abcd-ef", "wakeUser": user(7) }),
    );
    let lease = b.claim_wake_watch(leased, 60).unwrap().unwrap()["lease"]
        .as_str()
        .unwrap()
        .to_string();
    let v = "a".repeat(16);
    let keys = [
        "oauth_client:client-A",
        "oauth_client:client-AB",
        "oauth_client:client-a",
        "legacy_token:client-A",
        "legacy_token:abcd-ef",
    ];
    for key in keys {
        b.record_wake_terms_acceptance(key, &v).unwrap();
    }
    // Both open watches of the client end, the member's one too; only the member-less users
    // queue: user 2 new, user 4 pending already (its candidate still spends a sequence value).
    assert_eq!(
        b.forget_wake_credential("oauth_client", "client-A")
            .unwrap(),
        json!({ "ended": 2, "queued": 1 })
    );
    assert!(
        !b.settle_wake_watch(&settle(leased, &lease, "delivered", json!({})))
            .unwrap()
    );
    // A token id is matched in lower case; a client id is not.
    assert_eq!(
        b.forget_wake_credential("legacy_token", "ABCD-EF").unwrap(),
        json!({ "ended": 1, "queued": 1 })
    );
    let claim: ForgetClaimSpec =
        serde_json::from_value(json!({ "leaseSeconds": 60, "limit": 10 })).unwrap();
    let claimed: Vec<(i64, String)> = b
        .claim_wake_forgets(&claim)
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["id"].as_i64().unwrap(),
                c["wake_user"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(claimed, vec![(1, user(4)), (2, user(2)), (4, user(7))]);
    for (key, kept) in keys.into_iter().zip([false, true, true, true, false]) {
        assert_eq!(b.has_wake_terms_acceptance(key, &v).unwrap(), kept, "{key}");
    }
    for (kind, id) in [("oauth_client", "client-a"), ("legacy_token", "client-A")] {
        let open_rows = b
            .list_wake_watches(
                &serde_json::from_value(json!({
                    "principalKind": kind, "principalId": id, "memberId": null, "scope": "open",
                }))
                .unwrap(),
            )
            .unwrap();
        assert_eq!(open_rows.len(), 1, "{kind}:{id}");
    }
    assert_eq!(
        b.forget_wake_credential("oauth_client", "client-A")
            .unwrap(),
        json!({ "ended": 0, "queued": 0 })
    );
    assert_eq!(
        b.forget_wake_credential("legacy_token", "abc\0").unwrap(),
        json!({ "ended": 0, "queued": 0 })
    );
}
