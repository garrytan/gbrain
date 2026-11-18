//! The spend reservations and the lease-pressure log on the store (`readJobSpendTree`, `insertSpendReservation`,
//! `expireSpendReservations`, `settleSpendReservation`, `markSpendUsageUnknown`, `insertLeasePressure`,
//! `countLeasePressure`, `listRecentLeasePressure`).

mod memory_env;

use gbrain_store::env::iso;
use gbrain_store::jobs::{
    AdmitSpec, ExpireScope, LeaseFilter, LeaseInsert, SpendInsert, SpendTreeSpec,
};
use memory_env::{Brain, T0, brain};
use serde_json::{Value, json};

const SEC: i64 = 1_000_000;
const FAR: &str = "2099-01-01T00:00:00.000Z";

fn uuid(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn add(b: &Brain, name: &str, extra: Value) -> i64 {
    let mut insert = json!({
        "name": name, "queue": "default", "status": "waiting", "priority": 0, "data": {},
        "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000,
        "backoff_jitter": 0.2, "on_child_fail": "fail_parent", "remove_on_complete": false,
        "remove_on_fail": false, "submission_authority": {"version": 1, "kind": "application"},
    });
    for (k, v) in extra.as_object().unwrap() {
        insert[k] = v.clone();
    }
    let spec: AdmitSpec =
        serde_json::from_value(json!({ "insert": insert, "maxSpawnDepth": 40 })).unwrap();
    let id = b.admit_job(&spec).unwrap().row["id"].as_i64().unwrap();
    b.clock.advance(SEC);
    id
}

fn hold(n: u32, extra: Value) -> SpendInsert {
    let mut row = json!({
        "reservation_id": uuid(n), "client_id": "client-a", "estimated_cents": 5.0,
        "model": "anthropic:claude", "provider": "anthropic", "expires_at": FAR,
        "estimate_known": true,
    });
    for (k, v) in extra.as_object().unwrap() {
        row[k] = v.clone();
    }
    serde_json::from_value(row).unwrap()
}

fn insert(b: &Brain, n: u32, extra: Value) {
    b.insert_spend_reservation(&hold(n, extra)).unwrap();
}

fn settle(b: &Brain, n: u32, cents: f64) -> Value {
    b.settle_spend_reservation(&uuid(n), cents).unwrap()
}

fn row(b: &Brain, n: u32) -> Value {
    b.spend_reservation_row(&uuid(n)).unwrap().expect("a row")
}

fn tree(b: &Brain, jobs: &[i64], owner: Option<&str>) -> Vec<(i64, bool, Value, i64, i64)> {
    let spec: SpendTreeSpec =
        serde_json::from_value(json!({ "jobIds": jobs, "owner": owner })).unwrap();
    b.read_job_spend_tree(&spec)
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["root"].as_i64().unwrap(),
                r["self"].as_bool().unwrap(),
                r["settled_cents"].clone(),
                r["priced"].as_i64().unwrap(),
                r["unsettled"].as_i64().unwrap(),
            )
        })
        .collect()
}

fn bounce(b: &Brain, job: Option<i64>, key: &str) {
    let row: LeaseInsert = serde_json::from_value(
        json!({ "job_id": job, "lease_key": key, "active_at_bounce": 3, "max_concurrent": 3 }),
    )
    .unwrap();
    b.insert_lease_pressure(&row).unwrap();
}

fn count(b: &Brain, filter: Value) -> i64 {
    let f: LeaseFilter = serde_json::from_value(filter).unwrap();
    b.count_lease_pressure(&f).unwrap()
}

fn expire(b: &Brain, scope: Value) -> i64 {
    let s: ExpireScope = serde_json::from_value(scope).unwrap();
    b.expire_spend_reservations(&s).unwrap()
}

fn code(r: Result<impl std::fmt::Debug, gbrain_store::error::StoreError>) -> &'static str {
    r.expect_err("a refusal").code
}

#[test]
fn tree_sums_the_job_and_its_descendants_and_fences_by_owner() {
    let b = brain("spend-tree");
    let root = add(
        &b,
        "root",
        json!({ "data": {"__owner_client_id": "client-a"} }),
    );
    let a1 = add(
        &b,
        "a1",
        json!({ "parent_job_id": root, "data": {"__owner_client_id": "agent-a"} }),
    );
    let b1 = add(
        &b,
        "b1",
        json!({ "parent_job_id": root, "data": {"__owner_client_id": "agent-b"} }),
    );
    let a2 = add(
        &b,
        "a2",
        json!({ "parent_job_id": a1, "data": {"__owner_client_id": "agent-a"} }),
    );
    let bare = add(&b, "bare", json!({ "parent_job_id": root }));
    let other = add(&b, "other", json!({}));

    insert(&b, 1, json!({ "job_id": root }));
    settle(&b, 1, 1.5);
    insert(&b, 2, json!({ "job_id": root }));
    insert(&b, 3, json!({ "job_id": a1 }));
    settle(&b, 3, 0.25);
    for (n, cents) in [(4, 3.1234), (5, 0.0001), (6, 0.12345)] {
        insert(&b, n, json!({ "job_id": a2 }));
        settle(&b, n, cents);
    }
    insert(
        &b,
        7,
        json!({ "job_id": b1, "client_id": null, "budget_key": "g" }),
    );
    insert(&b, 8, json!({ "job_id": bare }));
    settle(&b, 8, 7.0);
    insert(&b, 9, json!({ "job_id": other }));
    settle(&b, 9, 99.0);

    // By job id, descendants (`self` false) before the job itself; 0.12345 settles as 0.1235.
    assert_eq!(
        tree(&b, &[a1, root, a1, 9999], None),
        vec![
            (root, false, json!(10.497), 5, 1),
            (root, true, json!(1.5), 1, 1),
            (a1, false, json!(3.247), 3, 0),
            (a1, true, json!(0.25), 1, 0),
        ],
        "a repeated id counts once, a missing id has no row"
    );
    // Fenced to agent-a: the root's own part always counts, `b1` and the unowned `bare` do not.
    assert_eq!(
        tree(&b, &[root], Some("agent-a")),
        vec![
            (root, false, json!(3.497), 4, 0),
            (root, true, json!(1.5), 1, 1)
        ]
    );
    // A job with only unsettled holds has a count and no sum; a part with no hold has no row.
    assert_eq!(tree(&b, &[b1], None), vec![(b1, true, Value::Null, 0, 1)]);
    assert_eq!(
        tree(&b, &[other], Some("nobody")),
        vec![(other, true, json!(99.0), 1, 0)]
    );
    assert!(tree(&b, &[], None).is_empty());
}

#[test]
fn a_reservation_is_inserted_settled_once_and_marked_unknown_while_open() {
    let b = brain("spend-settle");
    let job = add(&b, "j", json!({}));
    insert(
        &b,
        1,
        json!({ "job_id": job, "usage_unknown_reason": "pricing_or_bound_unknown", "estimate_known": false }),
    );
    let r = row(&b, 1);
    assert_eq!(r["status"], "pending");
    assert_eq!(r["estimated_cents"], json!(5.0));
    assert_eq!(r["actual_cents"], Value::Null);
    assert_eq!(r["estimate_known"], false);
    assert_eq!(r["usage_unknown_reason"], "pricing_or_bound_unknown");
    assert_eq!(r["job_id"], job);
    assert_eq!(r["created_at"], iso(b.clock.now()));

    assert!(b.mark_spend_usage_unknown(&uuid(1), "no_usage").unwrap());
    assert_eq!(row(&b, 1)["usage_unknown_reason"], "no_usage");
    assert!(
        !b.mark_spend_usage_unknown(&uuid(99), "x").unwrap(),
        "no such hold"
    );

    b.clock.advance(SEC);
    let out = settle(&b, 1, 2.34567);
    assert_eq!(
        out,
        json!({"outcome": "settled", "client_id": "client-a", "budget_key": null,
               "model": "anthropic:claude", "provider": "anthropic"})
    );
    let r = row(&b, 1);
    assert_eq!(r["status"], "settled");
    assert_eq!(r["actual_cents"], json!(2.3457), "four decimals");
    assert_eq!(
        r["usage_unknown_reason"],
        Value::Null,
        "a settle clears the reason"
    );
    assert_eq!(r["settled_at"], iso(b.clock.now()));

    b.clock.advance(SEC);
    assert_eq!(settle(&b, 1, 50.0), json!({"outcome": "already_settled"}));
    assert_eq!(
        row(&b, 1)["actual_cents"],
        json!(2.3457),
        "a second settle changes nothing"
    );
    assert!(
        !b.mark_spend_usage_unknown(&uuid(1), "late").unwrap(),
        "a settled hold keeps no reason"
    );
    assert_eq!(row(&b, 1)["usage_unknown_reason"], Value::Null);
    assert_eq!(settle(&b, 77, 1.0), json!({"outcome": "missing"}));

    // An expired hold still settles and still takes a reason.
    insert(
        &b,
        2,
        json!({ "client_id": null, "budget_key": "g", "expires_at": iso(T0) }),
    );
    assert_eq!(expire(&b, json!({})), 1);
    assert_eq!(row(&b, 2)["status"], "expired");
    assert!(b.mark_spend_usage_unknown(&uuid(2), "x").unwrap());
    assert_eq!(settle(&b, 2, 0.0)["budget_key"], "g");
    assert_eq!(row(&b, 2)["status"], "settled");
}

#[test]
fn a_version_7_id_is_kept_whole_and_found_again() {
    let b = brain("spend-v7");
    let id = "01a1efa3-9ee6-701e-ada3-d202d5776740";
    b.insert_spend_reservation(&hold(1, json!({ "reservation_id": id })))
        .unwrap();
    assert_eq!(
        b.spend_reservation_row(id).unwrap().expect("a row")["reservation_id"],
        id
    );
    assert!(b.mark_spend_usage_unknown(id, "pricing_unknown").unwrap());
    assert_eq!(
        b.settle_spend_reservation(id, 1.0).unwrap()["outcome"],
        "settled"
    );
    assert_eq!(
        b.settle_spend_reservation(id, 9.0).unwrap()["outcome"],
        "already_settled"
    );
}

#[test]
fn the_sweep_marks_only_overdue_pending_holds_in_the_scope_asked() {
    let b = brain("spend-expire");
    let soon = iso(T0 + 100 * SEC);
    insert(&b, 1, json!({ "expires_at": soon }));
    insert(
        &b,
        2,
        json!({ "client_id": "client-b", "expires_at": soon }),
    );
    insert(
        &b,
        3,
        json!({ "client_id": null, "budget_key": "g", "expires_at": soon }),
    );
    insert(
        &b,
        4,
        json!({ "client_id": null, "budget_key": "h", "expires_at": soon }),
    );
    insert(&b, 5, json!({ "expires_at": soon }));
    settle(&b, 5, 1.0);
    insert(&b, 6, json!({}));
    assert_eq!(expire(&b, json!({})), 0, "nothing is due yet");

    // `expires_at < now` is strict: at the instant it is not expired.
    b.clock.set(T0 + 100 * SEC);
    assert_eq!(expire(&b, json!({})), 0);
    b.clock.set(T0 + 100 * SEC + 1);
    assert_eq!(expire(&b, json!({ "clientId": "client-b" })), 1);
    assert_eq!(row(&b, 2)["status"], "expired");
    assert_eq!(row(&b, 1)["status"], "pending");
    assert_eq!(expire(&b, json!({ "budgetKey": "g" })), 1);
    assert_eq!(row(&b, 4)["status"], "pending");
    assert_eq!(
        expire(&b, json!({ "clientId": "client-a", "budgetKey": "g" })),
        0,
        "both fields must match"
    );
    assert_eq!(expire(&b, json!({})), 2, "the rest that are due");
    assert_eq!(
        row(&b, 5)["status"],
        "settled",
        "a settled hold stays settled"
    );
    assert_eq!(row(&b, 6)["status"], "pending", "the far expiry is not due");
    assert_eq!(
        expire(&b, json!({})),
        0,
        "an expired hold is not swept again"
    );
}

#[test]
fn an_insert_that_breaks_a_constraint_is_refused_and_leaves_no_row() {
    let b = brain("spend-refuse");
    insert(&b, 1, json!({}));
    let refuse = |n: u32, extra: Value| code(b.insert_spend_reservation(&hold(n, extra)));
    assert_eq!(
        refuse(1, json!({})),
        "constraint_violation",
        "a reservation id is taken"
    );
    assert_eq!(
        refuse(2, json!({ "client_id": null })),
        "constraint_violation",
        "an owner is needed"
    );
    assert_eq!(
        refuse(3, json!({ "budget_key": "g" })),
        "constraint_violation",
        "one owner only"
    );
    assert_eq!(
        refuse(4, json!({ "job_id": 9999 })),
        "constraint_violation",
        "no such job"
    );
    assert_eq!(
        refuse(5, json!({ "estimated_cents": 100_000_000.0 })),
        "constraint_violation",
        "NUMERIC(12,4) overflow"
    );
    assert_eq!(
        refuse(6, json!({ "expires_at": "tomorrow" })),
        "invalid_argument"
    );
    let bad: SpendInsert = serde_json::from_value(json!({
        "reservation_id": "nope", "client_id": "c", "estimated_cents": 1.0, "model": "m", "provider": "p",
        "expires_at": FAR, "estimate_known": true })).unwrap();
    assert_eq!(
        code(b.insert_spend_reservation(&bad)),
        "invalid_argument",
        "not a uuid"
    );
    for n in 2..=6 {
        assert!(
            b.spend_reservation_row(&uuid(n)).unwrap().is_none(),
            "reservation {n} left no row"
        );
    }
    assert_eq!(
        code(b.settle_spend_reservation(&uuid(1), 100_000_000.0)),
        "constraint_violation"
    );
    assert_eq!(
        row(&b, 1)["status"],
        "pending",
        "a refused settle changes nothing"
    );
    // Either spelling of a UUID names the same hold.
    assert_eq!(settle(&b, 1, 1.0)["outcome"], "settled");
    assert_eq!(
        b.settle_spend_reservation(&uuid(1).to_uppercase(), 1.0)
            .unwrap(),
        json!({"outcome": "already_settled"})
    );
}

#[test]
fn lease_pressure_is_counted_by_window_job_and_key_and_listed_newest_first() {
    let b = brain("spend-lease");
    let j1 = add(&b, "j1", json!({}));
    let j2 = add(&b, "j2", json!({}));
    let at = |us: i64| b.clock.set(T0 + us);
    at(10 * SEC);
    let full: LeaseInsert = serde_json::from_value(json!({
        "job_id": j1, "lease_key": "anthropic", "active_at_bounce": 2, "max_concurrent": 2,
        "queue_name": "default", "job_name": "j1", "model": "m", "provider": "p", "root_owner_id": 7 })).unwrap();
    b.insert_lease_pressure(&full).unwrap();
    at(20 * SEC);
    bounce(&b, Some(j1), "openai");
    at(30 * SEC);
    bounce(&b, Some(j2), "anthropic");
    bounce(&b, None, "anthropic");
    at(40 * SEC);

    assert_eq!(count(&b, json!({})), 4);
    assert_eq!(count(&b, json!({ "jobId": j1 })), 2);
    assert_eq!(count(&b, json!({ "leaseKey": "anthropic" })), 3);
    assert_eq!(
        count(&b, json!({ "jobId": j1, "leaseKey": "anthropic" })),
        1
    );
    // The window's edge is exclusive: a bounce exactly `windowMs` old is out.
    assert_eq!(
        count(&b, json!({ "windowMs": 20_000 })),
        2,
        "the bounce at 20 s is 20 s old"
    );
    assert_eq!(count(&b, json!({ "windowMs": 20_001 })), 3);
    assert_eq!(
        count(&b, json!({ "windowMs": 30_000 })),
        3,
        "the bounce at 10 s is 30 s old"
    );
    assert_eq!(count(&b, json!({ "windowMs": 30_001 })), 4);
    assert_eq!(
        count(&b, json!({ "windowMs": 15_000, "leaseKey": "openai" })),
        0
    );
    assert_eq!(count(&b, json!({ "windowMs": 0 })), 0);
    assert_eq!(count(&b, json!({ "windowMs": 30_001, "jobId": 9999 })), 0);

    let list = |window: f64, limit: i64| -> Vec<(i64, Value, Value)> {
        b.list_recent_lease_pressure(window, limit)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["id"].as_i64().unwrap(),
                    r["lease_key"].clone(),
                    r["job_id"].clone(),
                )
            })
            .collect()
    };
    // Newest first; equal times fall back to the highest id.
    assert_eq!(
        list(60_000.0, 10),
        vec![
            (4, json!("anthropic"), Value::Null),
            (3, json!("anthropic"), json!(j2)),
            (2, json!("openai"), json!(j1)),
            (1, json!("anthropic"), json!(j1)),
        ]
    );
    assert_eq!(list(60_000.0, 2).len(), 2);
    assert_eq!(list(60_000.0, 2)[0].0, 4);
    assert!(list(60_000.0, 0).is_empty());
    assert_eq!(list(20_000.0, 10).len(), 2);
    let all = b.list_recent_lease_pressure(60_000.0, 10).unwrap();
    let first = &all[3];
    assert_eq!(first["bounced_at"], iso(T0 + 10 * SEC));
    assert_eq!(
        (
            first["active_at_bounce"].clone(),
            first["max_concurrent"].clone(),
            first["queue_name"].clone(),
            first["job_name"].clone(),
            first["model"].clone(),
            first["provider"].clone(),
            first["root_owner_id"].clone()
        ),
        (
            json!(2),
            json!(2),
            json!("default"),
            json!("j1"),
            json!("m"),
            json!("p"),
            json!(7)
        )
    );
    assert_eq!(
        code(b.list_recent_lease_pressure(60_000.0, -1)),
        "invalid_argument"
    );
    assert_eq!(
        code(b.list_recent_lease_pressure(f64::NAN, 1)),
        "invalid_argument"
    );
}

#[test]
fn a_bounce_for_a_missing_job_or_with_a_huge_count_is_refused_and_takes_no_id() {
    let b = brain("spend-lease-refuse");
    let job = add(&b, "j", json!({}));
    let mk = |extra: Value| -> LeaseInsert {
        let mut row = json!({ "lease_key": "k", "active_at_bounce": 1, "max_concurrent": 1 });
        for (k, v) in extra.as_object().unwrap() {
            row[k] = v.clone();
        }
        serde_json::from_value(row).unwrap()
    };
    assert_eq!(
        code(b.insert_lease_pressure(&mk(json!({ "job_id": 9999 })))),
        "constraint_violation"
    );
    assert_eq!(
        code(b.insert_lease_pressure(&mk(json!({ "active_at_bounce": 3_000_000_000_i64 })))),
        "invalid_argument"
    );
    assert_eq!(
        code(b.insert_lease_pressure(&mk(json!({ "max_concurrent": -3_000_000_000_i64 })))),
        "invalid_argument"
    );
    assert_eq!(count(&b, json!({})), 0);
    b.insert_lease_pressure(&mk(json!({ "job_id": job })))
        .unwrap();
    let rows = b.list_recent_lease_pressure(1000.0, 5).unwrap();
    assert_eq!(
        rows[0]["id"], 1,
        "a refused bounce takes no id on this engine"
    );
}

#[test]
fn deleting_a_job_keeps_its_spend_and_bounces_and_clears_their_job() {
    let b = brain("spend-delete");
    let job = add(&b, "j", json!({}));
    let keep = add(&b, "keep", json!({}));
    insert(&b, 1, json!({ "job_id": job }));
    settle(&b, 1, 4.0);
    insert(&b, 2, json!({ "job_id": keep }));
    bounce(&b, Some(job), "k");
    bounce(&b, Some(keep), "k");
    assert!(
        !b.delete_terminal_job(job).unwrap(),
        "a waiting job is not deleted"
    );
    b.cancel_jobs(&[job], &Default::default()).unwrap();
    assert!(b.delete_terminal_job(job).unwrap());

    assert_eq!(
        row(&b, 1)["job_id"],
        Value::Null,
        "the hold stays, with no job"
    );
    assert_eq!(row(&b, 1)["actual_cents"], json!(4.0));
    assert_eq!(
        row(&b, 2)["job_id"],
        keep,
        "another job's hold is untouched"
    );
    assert_eq!(count(&b, json!({})), 2, "both bounces stay");
    assert_eq!(count(&b, json!({ "jobId": job })), 0);
    assert_eq!(count(&b, json!({ "jobId": keep })), 1);
    let rows = b.list_recent_lease_pressure(60_000.0, 10).unwrap();
    assert_eq!(rows[1]["job_id"], Value::Null);
    assert_eq!(rows[0]["job_id"], keep);
    assert!(
        tree(&b, &[job], None).is_empty(),
        "a deleted job has no tree"
    );
    // Nothing is left under the deleted job: a new job (a new id) shows none of it.
    let next = add(&b, "next", json!({}));
    assert!(tree(&b, &[next], None).is_empty());
}

#[test]
fn a_chain_deeper_than_twenty_levels_is_cut_at_twenty() {
    let b = brain("spend-depth");
    let mut parent: Option<i64> = None;
    let mut ids = Vec::new();
    for n in 0..23 {
        let id = add(&b, &format!("n{n}"), json!({ "parent_job_id": parent }));
        ids.push(id);
        parent = Some(id);
    }
    for (n, id) in ids.iter().enumerate() {
        insert(&b, n as u32 + 1, json!({ "job_id": id }));
        settle(&b, n as u32 + 1, 1.0);
    }
    // From the top: itself plus 20 levels below, so 21 holds in all.
    let top = tree(&b, &[ids[0]], None);
    assert_eq!(
        top,
        vec![
            (ids[0], false, json!(20.0), 20, 0),
            (ids[0], true, json!(1.0), 1, 0)
        ]
    );
}
