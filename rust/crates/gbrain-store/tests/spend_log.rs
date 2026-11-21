//! The spend ledger and the client budgets on the store (`reserveClientSpend`, `reserveGroupSpend`,
//! `readGroupSpendTotals`, `settleSpendWithLog`, `insertSpendLog`, `sumClientSpendSince`, `readAgentClientSpend`,
//! `insertOauthClient`, `updateOauthClientBudget`, `readClientBudgetUsd`), and the open-hold index they read.
//! What the parity file cannot see lives here: the ledger columns, the `agent` scope token and the index upkeep.

mod memory_env;

use gbrain_store::env::iso;
use gbrain_store::jobs::{
    AdmitSpec, ClientInsert, ClientReserve, ExpireScope, GroupReserve, LogInsert,
};
use memory_env::{Brain, T0, brain};
use serde_json::{Value, json};

const SEC: i64 = 1_000_000;
const HOUR: i64 = 3_600 * SEC;
const DAY: i64 = 24 * HOUR;
const FAR: &str = "2099-01-01T00:00:00.000Z";

fn uuid(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

/// 00:00 UTC of the day `micros` falls in.
fn day_start(micros: i64) -> String {
    iso(micros.div_euclid(DAY) * DAY)
}

fn client(b: &Brain, id: &str, name: &str, extra: Value) {
    let mut row = json!({ "client_id": id, "client_name": name });
    for (k, v) in extra.as_object().unwrap() {
        row[k] = v.clone();
    }
    let row: ClientInsert = serde_json::from_value(row).unwrap();
    b.insert_oauth_client(&row).unwrap();
}

/// What the table's agent-grant constraint asks of a client with the `agent` scope word.
fn agent_grant() -> Value {
    json!({
        "bound_tools": ["search"], "source_id": "default", "bound_source_id": "default",
        "federated_read": ["default"], "bound_max_concurrent": 1, "delegated_namespace": "job",
    })
}

fn agent_scope(b: &Brain, id: &str, name: &str, scope: &str, extra: Value) {
    let mut row = agent_grant();
    row["scope"] = json!(scope);
    for (k, v) in extra.as_object().unwrap() {
        row[k] = v.clone();
    }
    client(b, id, name, row);
}

fn reserve(b: &Brain, n: u32, cid: &str, cents: f64, extra: Value) -> Value {
    let mut spec = json!({
        "reservation_id": uuid(n), "client_id": cid, "estimated_cents": cents,
        "estimate_known": true, "model": "anthropic:claude", "provider": "anthropic",
        "expires_at": FAR, "day_start": day_start(b.clock.now()),
    });
    for (k, v) in extra.as_object().unwrap() {
        spec[k] = v.clone();
    }
    let spec: ClientReserve = serde_json::from_value(spec).unwrap();
    b.reserve_client_spend(&spec).unwrap()
}

fn group(b: &Brain, n: u32, key: &str, cents: f64, cap: Option<f64>, extra: Value) -> Value {
    let mut spec = json!({
        "reservation_id": uuid(n), "budget_key": key, "estimated_cents": cents, "cap_cents": cap,
        "estimate_known": true, "model": "anthropic:claude", "provider": "anthropic",
        "expires_at": FAR,
    });
    for (k, v) in extra.as_object().unwrap() {
        spec[k] = v.clone();
    }
    let spec: GroupReserve = serde_json::from_value(spec).unwrap();
    b.reserve_group_spend(&spec).unwrap()
}

fn outcome(v: &Value) -> &str {
    v["outcome"].as_str().unwrap()
}

fn code(r: Result<impl std::fmt::Debug, gbrain_store::error::StoreError>) -> &'static str {
    r.expect_err("an error").code
}

fn add_job(b: &Brain, name: &str, data: Value) -> i64 {
    let insert = json!({
        "name": name, "queue": "default", "status": "waiting", "priority": 0, "data": data,
        "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000,
        "backoff_jitter": 0.2, "on_child_fail": "fail_parent", "remove_on_complete": false,
        "remove_on_fail": false, "submission_authority": {"version": 1, "kind": "application"},
    });
    let spec: AdmitSpec =
        serde_json::from_value(json!({ "insert": insert, "maxSpawnDepth": 40 })).unwrap();
    b.admit_job(&spec).unwrap().row["id"].as_i64().unwrap()
}

fn log(b: &Brain) -> Vec<Value> {
    b.spend_log_rows().unwrap()
}

#[test]
fn the_day_sum_starts_at_the_utc_midnight_the_caller_names() {
    let b = brain("sp-day");
    client(&b, "c1", "C one", json!({}));
    // Paid just before midnight: counted today at 23:00, not tomorrow.
    b.clock.set(T0 - 8 * HOUR + 23 * HOUR); // 23:00 UTC on T0's day
    b.insert_spend_log(&LogInsert {
        client_id: Some("c1".into()),
        token_name: None,
        operation: "x".into(),
        spend_cents: 40.0,
        provider: None,
        model: None,
    })
    .unwrap();
    let today = day_start(b.clock.now());
    assert_eq!(b.sum_client_spend_since("c1", &today).unwrap(), 40.0);
    b.clock.advance(2 * HOUR); // 01:00 UTC next day
    let tomorrow = day_start(b.clock.now());
    assert_eq!(b.sum_client_spend_since("c1", &tomorrow).unwrap(), 0.0);
    assert_eq!(b.sum_client_spend_since("c1", &today).unwrap(), 40.0);
    // The admission counts the ledger from the day the caller names, so yesterday's spend does not refuse today.
    let r = reserve(&b, 1, "c1", 50.0, json!({ "cap_cents": 60.0 }));
    assert_eq!(outcome(&r), "reserved");
    let r = reserve(
        &b,
        2,
        "c1",
        30.0,
        json!({ "cap_cents": 60.0, "day_start": today }),
    );
    assert_eq!(outcome(&r), "refused", "{r}");
    assert_eq!(r["committed_cents"], json!(40.0));
    assert_eq!(r["pending_cents"], json!(50.0));
}

#[test]
fn an_agent_scope_token_or_a_tool_binding_lists_the_client_and_a_deleted_one_never() {
    let b = brain("sp-agent");
    agent_scope(&b, "a", "alpha", "read agent write", json!({}));
    client(&b, "b", "beta", json!({ "bound_tools": ["search"] }));
    client(&b, "c", "gamma", json!({ "scope": "read write" }));
    agent_scope(&b, "d", "delta", "agent", json!({ "deleted_at": iso(T0) }));
    client(&b, "e", "agentless", json!({ "scope": "agents" }));
    let rows = b.read_agent_client_spend().unwrap();
    let ids: Vec<&str> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["client_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["a", "b"]);
    assert_eq!(rows[0]["cap_usd_per_day"], Value::Null);
    // Names sort bytewise, ties by client id.
    client(&b, "z", "alpha", json!({ "bound_tools": [] }));
    client(&b, "Y", "Zed", json!({ "bound_tools": [] }));
    let rows = b.read_agent_client_spend().unwrap();
    let ids: Vec<&str> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["client_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["Y", "a", "z", "b"]);
}

#[test]
fn a_settled_hold_writes_a_ledger_row_with_its_operation_token_provider_and_model() {
    let b = brain("sp-columns");
    client(&b, "c1", "C one", json!({}));
    reserve(
        &b,
        1,
        "c1",
        12.0,
        json!({ "model": "openai:gpt", "provider": "openai" }),
    );
    b.clock.advance(SEC);
    let r = b
        .settle_spend_with_log(&uuid(1), 9.5, "think", Some("tok"))
        .unwrap();
    assert_eq!(outcome(&r), "settled");
    let rows = log(&b);
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row["client_id"], "c1");
    assert_eq!(row["budget_key"], Value::Null);
    assert_eq!(row["token_name"], "tok");
    assert_eq!(row["operation"], "think");
    assert_eq!(row["spend_cents"], json!(9.5));
    assert_eq!(row["provider"], "openai");
    assert_eq!(row["model"], "openai:gpt");
    assert_eq!(row["created_at"], iso(T0 + SEC));
    // A second settle, and a hold that is not there, write nothing.
    assert_eq!(
        outcome(
            &b.settle_spend_with_log(&uuid(1), 1.0, "think", None)
                .unwrap()
        ),
        "already_settled"
    );
    assert_eq!(
        outcome(
            &b.settle_spend_with_log(&uuid(99), 1.0, "think", None)
                .unwrap()
        ),
        "missing"
    );
    assert_eq!(log(&b).len(), 1);
    // A group hold settles under its budget key, not a client.
    group(&b, 2, "grp", 3.0, Some(100.0), json!({}));
    b.settle_spend_with_log(&uuid(2), 2.0, "g", None).unwrap();
    let rows = log(&b);
    assert_eq!(rows[1]["client_id"], Value::Null);
    assert_eq!(rows[1]["budget_key"], "grp");
    assert_eq!(rows[1]["token_name"], Value::Null);
    let t = b.read_group_spend_totals("grp").unwrap();
    assert_eq!(t["committed_cents"], json!(2.0));
}

#[test]
fn an_error_inside_an_admission_leaves_the_sweep_and_the_hold_unwritten() {
    let b = brain("sp-rollback");
    client(&b, "c1", "C one", json!({}));
    reserve(&b, 1, "c1", 5.0, json!({ "expires_at": iso(T0 + SEC) }));
    b.clock.advance(10 * SEC);
    // A job that does not exist breaks the insert after the sweep: nothing may stay, the sweep included.
    let bad = reserve_spec(&b, 2, "c1", json!({ "job_id": 424242 }));
    assert_eq!(code(b.reserve_client_spend(&bad)), "constraint_violation");
    let held = b.spend_reservation_row(&uuid(1)).unwrap().unwrap();
    assert_eq!(held["status"], "pending", "the sweep rolled back");
    assert!(b.spend_reservation_row(&uuid(2)).unwrap().is_none());
    // The same for a group admission.
    let spec: GroupReserve = serde_json::from_value(json!({
        "reservation_id": uuid(3), "budget_key": "g", "estimated_cents": 1.0, "cap_cents": 10.0,
        "estimate_known": true, "model": "m", "provider": "p", "expires_at": FAR, "job_id": 424242,
    }))
    .unwrap();
    assert_eq!(code(b.reserve_group_spend(&spec)), "constraint_violation");
    assert!(b.spend_reservation_row(&uuid(3)).unwrap().is_none());
    // A refusal is an outcome: it keeps the sweep it ran.
    client(&b, "c2", "C two", json!({ "budget_usd_per_day": 0.01 }));
    reserve(
        &b,
        4,
        "c2",
        1.0,
        json!({ "expires_at": iso(T0 + 11 * SEC) }),
    );
    b.clock.advance(2 * SEC);
    let r = reserve(&b, 5, "c2", 1.0, json!({}));
    assert_eq!(outcome(&r), "refused");
    assert_eq!(
        b.spend_reservation_row(&uuid(4)).unwrap().unwrap()["status"],
        "expired"
    );
}

fn reserve_spec(b: &Brain, n: u32, cid: &str, extra: Value) -> ClientReserve {
    let mut spec = json!({
        "reservation_id": uuid(n), "client_id": cid, "estimated_cents": 1.0,
        "estimate_known": true, "model": "m", "provider": "p", "expires_at": FAR,
        "day_start": day_start(b.clock.now()),
    });
    for (k, v) in extra.as_object().unwrap() {
        spec[k] = v.clone();
    }
    serde_json::from_value(spec).unwrap()
}

#[test]
fn the_open_hold_index_follows_a_hold_through_settle_expire_and_its_job_going_away() {
    let b = brain("sp-index");
    client(&b, "c1", "C one", json!({}));
    let job = add_job(&b, "j", json!({}));
    let cap = json!({ "cap_cents": 100.0 });
    let pending = |b: &Brain| -> Value {
        let spec = reserve_spec(
            b,
            90,
            "c1",
            json!({ "estimated_cents": 0.0, "cap_cents": 1000.0 }),
        );
        // A probe hold of nothing shows the totals through a refusal at a cap of zero.
        let probe = ClientReserve {
            cap_cents: Some(0.0),
            estimated_cents: 1.0,
            ..spec
        };
        b.reserve_client_spend(&probe).unwrap()
    };
    reserve(
        &b,
        1,
        "c1",
        10.0,
        json!({ "job_id": job, "cap_cents": 100.0 }),
    );
    reserve(&b, 2, "c1", 20.0, cap.clone());
    assert_eq!(pending(&b)["pending_cents"], json!(30.0));
    // Settled: leaves the pending total, enters the ledger.
    b.settle_spend_with_log(&uuid(1), 7.0, "x", None).unwrap();
    let r = pending(&b);
    assert_eq!(
        (r["pending_cents"].clone(), r["committed_cents"].clone()),
        (json!(20.0), json!(7.0))
    );
    // Expired by the sweep: still charged as pending (an overdue hold stays charged).
    b.clock.advance(SEC);
    reserve(
        &b,
        3,
        "c1",
        5.0,
        json!({ "expires_at": iso(b.clock.now() + SEC) }),
    );
    b.clock.advance(5 * SEC);
    let n = b
        .expire_spend_reservations(&ExpireScope {
            client_id: Some("c1".into()),
            budget_key: None,
        })
        .unwrap();
    assert_eq!(n, 1);
    assert_eq!(pending(&b)["pending_cents"], json!(25.0));
    // A job going away leaves its hold open and charged.
    let job2 = add_job(&b, "k", json!({}));
    reserve(&b, 4, "c1", 2.0, json!({ "job_id": job2 }));
    b.cancel_jobs(&[job2], &Default::default()).unwrap();
    assert!(b.delete_terminal_job(job2).unwrap());
    assert_eq!(pending(&b)["pending_cents"], json!(27.0));
    // A group hold is indexed under its own kind, not the client's.
    group(&b, 5, "c1", 50.0, Some(500.0), json!({}));
    assert_eq!(pending(&b)["pending_cents"], json!(27.0));
    assert_eq!(
        b.read_group_spend_totals("c1").unwrap()["live_cents"],
        json!(50.0)
    );
}

#[test]
fn a_budget_is_kept_to_two_decimals_rounded_half_away_and_printed_as_postgres_does() {
    let b = brain("sp-budget");
    client(&b, "c1", "C one", json!({ "budget_usd_per_day": 5.0 }));
    assert_eq!(
        b.read_client_budget_usd("c1").unwrap().as_deref(),
        Some("5.00")
    );
    assert!(b.update_oauth_client_budget("c1", Some(0.005)).unwrap());
    assert_eq!(
        b.read_client_budget_usd("c1").unwrap().as_deref(),
        Some("0.01")
    );
    assert!(b.update_oauth_client_budget("c1", Some(-0.5)).unwrap());
    assert_eq!(
        b.read_client_budget_usd("c1").unwrap().as_deref(),
        Some("-0.50")
    );
    assert!(b.update_oauth_client_budget("c1", Some(1234.567)).unwrap());
    assert_eq!(
        b.read_client_budget_usd("c1").unwrap().as_deref(),
        Some("1234.57")
    );
    assert!(b.update_oauth_client_budget("c1", None).unwrap());
    assert_eq!(b.read_client_budget_usd("c1").unwrap(), None);
    assert!(!b.update_oauth_client_budget("nobody", Some(1.0)).unwrap());
    assert_eq!(b.read_client_budget_usd("nobody").unwrap(), None);
    // A budget past eight integer digits overflows, and a repeated client id is a constraint violation.
    assert_eq!(
        code(b.update_oauth_client_budget("c1", Some(1e8))),
        "constraint_violation"
    );
    let dup: ClientInsert =
        serde_json::from_value(json!({ "client_id": "c1", "client_name": "again" })).unwrap();
    assert_eq!(code(b.insert_oauth_client(&dup)), "constraint_violation");
    let huge: ClientInsert = serde_json::from_value(
        json!({ "client_id": "c9", "client_name": "n", "budget_usd_per_day": 1e9 }),
    )
    .unwrap();
    assert_eq!(code(b.insert_oauth_client(&huge)), "constraint_violation");
    assert_eq!(
        b.read_client_budget_usd("c9").unwrap(),
        None,
        "nothing was inserted"
    );
}

#[test]
fn a_ledger_amount_past_its_scale_is_refused_and_a_fraction_is_rounded_to_four_decimals() {
    let b = brain("sp-log-edges");
    let row = |cents: f64| LogInsert {
        client_id: Some("c1".into()),
        token_name: None,
        operation: "op".into(),
        spend_cents: cents,
        provider: None,
        model: None,
    };
    assert_eq!(code(b.insert_spend_log(&row(1e8))), "constraint_violation");
    assert_eq!(code(b.insert_spend_log(&row(f64::NAN))), "invalid_argument");
    assert!(log(&b).is_empty());
    b.insert_spend_log(&row(0.12345)).unwrap();
    assert_eq!(log(&b)[0]["spend_cents"], json!(0.1235));
    // A direct insert keeps every column the caller named.
    b.insert_spend_log(&LogInsert {
        client_id: Some("c1".into()),
        token_name: Some("tok".into()),
        operation: "embed".into(),
        spend_cents: 1.0,
        provider: Some("prov".into()),
        model: Some("mod".into()),
    })
    .unwrap();
    let rows = log(&b);
    let last = &rows[rows.len() - 1];
    assert_eq!(last["operation"], json!("embed"));
    assert_eq!(last["token_name"], json!("tok"));
    assert_eq!(last["provider"], json!("prov"));
    assert_eq!(last["model"], json!("mod"));
}

/// Postgres refuses a NUL byte in text, and the owner index uses it as the owner separator: a client id
/// `owner\0other` must not be recorded, or the sum for `owner` would count its spend.
#[test]
fn a_client_id_with_a_nul_byte_is_refused_and_never_counted_for_another_owner() {
    let b = brain("sp-nul");
    let row = |client: &str| LogInsert {
        client_id: Some(client.into()),
        token_name: None,
        operation: "x".into(),
        spend_cents: 100.0,
        provider: None,
        model: None,
    };
    assert_eq!(
        code(b.insert_spend_log(&row("owner\u{0}other"))),
        "constraint_violation"
    );
    assert!(log(&b).is_empty(), "the refused write left no ledger row");
    b.insert_spend_log(&row("owner")).unwrap();
    assert_eq!(
        b.sum_client_spend_since("owner", &day_start(b.clock.now()))
            .unwrap(),
        100.0
    );
}
