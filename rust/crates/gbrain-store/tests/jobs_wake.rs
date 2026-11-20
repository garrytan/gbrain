//! The Wakeshift report-back tables (`src/core/engine-sql/jobs-wake.ts`): what the parity file
//! (`test/engine-parity/jobs-wake.test.ts`) cannot reach because it cannot move the clock or write a
//! journal column no typed member writes (a write request committed with a recovery record), and the
//! places this store differs from Postgres on purpose.

use gbrain_store::env::{Env, uuid_from_bytes};
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::jobs::{
    CronRunInput, EndSpec, ForgetClaimSpec, ForgetSettle, WatchFilter, WatchInsert, WatchSettle,
};
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

/// A store on a clock the test moves.
struct Brain {
    store: Store,
    clock: Arc<Clock>,
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
    Brain { store, clock, dir }
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
fn a_watch_ended_by_unwatch_loses_its_lease_and_a_forget_for_a_member_queues_here() {
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
    // This store keeps no access members, so the SQL's "no live member" test is true here.
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
