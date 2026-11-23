//! Read-back tests of the wake relations: each reads the rows back through the family's own public
//! reads, and checks a retry, the conflicts, and the next row the family's own writer takes.

use crate::env::iso;
use crate::error::CONSTRAINT_VIOLATION;
use crate::seed::{ImportResult, SeedRow};
use crate::test_support::store;
use crate::{Store, keys};
use serde_json::{Value, json};

const SEED: &str = "seed-1";
const USER: &str = "0123456789abcdef0123456789abcdef";
const OTHER_USER: &str = "fedcba9876543210fedcba9876543210";

fn row(pairs: &[(&str, &str)]) -> SeedRow {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), Some((*v).to_owned())))
        .collect()
}

fn import(s: &Store, relation: &str, rows: Vec<SeedRow>) -> ImportResult {
    s.import_relation(SEED, relation, rows).unwrap()
}

fn us(text: &str) -> i64 {
    crate::seed::decode::timestamp_us(text).unwrap()
}

/// The `wake_cron_run` sequence, as the jobs family keeps it (`m 0x00 name`, JSON).
fn sequence(s: &Store, name: &str) -> i64 {
    let read = s.read().unwrap();
    let mut key = vec![keys::JOBS, 0x00];
    key.extend_from_slice(name.as_bytes());
    serde_json::from_slice(&read.get(&key).unwrap().unwrap()).unwrap()
}

#[test]
fn wake_crons_keep_the_name_and_time() {
    let s = store();
    let rows = vec![
        row(&[
            ("name", "nightly"),
            ("created_at", "2026-03-01 00:00:00.5+00"),
        ]),
        row(&[("name", "hourly"), ("created_at", "2026-03-02 00:00:00+00")]),
    ];
    let r = import(&s, "wake_crons", rows.clone());
    assert_eq!((r.imported, r.skipped), (2, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    assert!(s.has_wake_cron("nightly").unwrap());
    let listed = s.list_wake_crons().unwrap();
    assert_eq!(listed[0]["name"], "hourly");
    assert_eq!(listed[1]["name"], "nightly");
    assert_eq!(listed[1]["created_at"], iso(us("2026-03-01T00:00:00.5Z")));
    assert_eq!(import(&s, "wake_crons", rows).skipped, 2);
    // The family's writer leaves a registered name as it is.
    s.add_wake_cron("nightly").unwrap();
    assert_eq!(
        s.list_wake_crons().unwrap()[1]["created_at"],
        iso(us("2026-03-01T00:00:00.5Z"))
    );
}

fn run_row(id: &str, name: &str, status: &str, at: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("name", name),
        ("status", status),
        ("finished_at", at),
    ])
}

#[test]
fn wake_cron_runs_keep_ids_times_and_raise_the_sequence() {
    let s = store();
    import(
        &s,
        "wake_crons",
        vec![row(&[
            ("name", "nightly"),
            ("created_at", "2026-03-01 00:00:00+00"),
        ])],
    );
    let rows = vec![
        run_row("5", "nightly", "ok", "2026-03-02 00:00:00+00"),
        run_row("9", "nightly", "failed", "2026-03-03 00:00:00.25+00"),
    ];
    let r = import(&s, "wake_cron_runs", rows.clone());
    assert_eq!((r.imported, r.skipped), (2, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    let listed = s.list_wake_crons().unwrap();
    assert_eq!(listed[0]["last_status"], "failed");
    assert_eq!(
        listed[0]["last_finished_at"],
        iso(us("2026-03-03T00:00:00.25Z"))
    );
    assert_eq!(import(&s, "wake_cron_runs", rows).skipped, 2);
    assert_eq!(sequence(&s, "wake_cron_run"), 9);
    // The family's writer takes the next id, and still skips the spooled run it already holds.
    let input = |status: &str, at: &str| -> Value {
        json!({ "name": "nightly", "status": status, "finishedAt": at })
    };
    let run = |v: Value| {
        s.record_wake_cron_run(&serde_json::from_value(v).unwrap())
            .unwrap()
    };
    assert_eq!(
        run(input("failed", "2026-03-03T00:00:00.25Z"))["registered"],
        true
    );
    assert_eq!(sequence(&s, "wake_cron_run"), 9);
    run(input("ok", "2026-03-04T00:00:00Z"));
    assert_eq!(sequence(&s, "wake_cron_run"), 10);
}

fn forget_row(id: &str, user: &str, state: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("wake_user", user),
        ("state", state),
        ("attempts", "2"),
        ("next_attempt_at", "2026-03-01 00:00:00+00"),
        ("last_error", "boom"),
        ("created_at", "2026-02-01 00:00:00+00"),
        ("updated_at", "2026-02-02 00:00:00+00"),
    ])
}

#[test]
fn wake_forgets_keep_ids_state_and_the_pending_index() {
    let s = store();
    let rows = vec![
        forget_row("3", USER, "done"),
        forget_row("8", USER, "pending"),
        forget_row("9", OTHER_USER, "dead"),
    ];
    let r = import(&s, "wake_forgets", rows.clone());
    assert_eq!((r.imported, r.skipped), (3, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    // Only the pending row is claimable; it keeps its id and attempts.
    let claimed = s
        .claim_wake_forgets(
            &serde_json::from_value(json!({ "leaseSeconds": 60, "limit": 10 })).unwrap(),
        )
        .unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0]["id"], 8);
    assert_eq!(claimed[0]["wake_user"], USER);
    assert_eq!(claimed[0]["attempts"], 2);
    assert_eq!(sequence(&s, "wake_forget"), 9);
    assert_eq!(import(&s, "wake_forgets", rows).skipped, 3);
    // A second pending forget of the same user is the unique index's conflict.
    let err = s
        .import_relation(
            SEED,
            "wake_forgets",
            vec![forget_row("10", USER, "pending")],
        )
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
}

#[test]
fn wake_forget_queue_meets_a_seeded_pending_row_and_takes_the_next_id() {
    let s = store();
    import(&s, "wake_forgets", vec![forget_row("8", USER, "pending")]);
    // The user already has a pending forget: the writer queues nothing, but takes an id.
    s.queue_wake_forget(USER, None).unwrap();
    assert_eq!(sequence(&s, "wake_forget"), 9);
    s.queue_wake_forget(OTHER_USER, None).unwrap();
    assert_eq!(sequence(&s, "wake_forget"), 10);
    let claimed = s
        .claim_wake_forgets(
            &serde_json::from_value(json!({ "leaseSeconds": 60, "limit": 10 })).unwrap(),
        )
        .unwrap();
    let ids: Vec<_> = claimed.iter().map(|c| c["id"].clone()).collect();
    assert_eq!(ids, [json!(8), json!(10)]);
}

#[test]
fn wake_terms_acceptances_keep_the_time() {
    let s = store();
    let rows = vec![row(&[
        ("principal_key", "member:alice"),
        ("terms_version", "0123456789abcdef"),
        ("accepted_at", "2026-03-01 00:00:00+00"),
    ])];
    let r = import(&s, "wake_terms_acceptances", rows.clone());
    assert_eq!((r.imported, r.skipped), (1, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    assert!(
        s.has_wake_terms_acceptance("member:alice", "0123456789abcdef")
            .unwrap()
    );
    assert!(
        !s.has_wake_terms_acceptance("member:alice", "fedcba9876543210")
            .unwrap()
    );
    assert_eq!(import(&s, "wake_terms_acceptances", rows).skipped, 1);
    // The family's writer leaves a recorded acceptance as it is.
    s.record_wake_terms_acceptance("member:alice", "0123456789abcdef")
        .unwrap();
    assert!(
        s.has_wake_terms_acceptance("member:alice", "0123456789abcdef")
            .unwrap()
    );
}

#[test]
fn mcp_request_log_rollup_keeps_the_tally_and_keys_no_token_as_empty() {
    let s = store();
    let rows = vec![
        row(&[
            ("token_name", "alice"),
            ("requests", "40"),
            ("last_used_at", "2026-03-01 00:00:00+00"),
            ("pruned_through", "2026-02-20 00:00:00.5+00"),
        ]),
        SeedRow::from([
            ("token_name".to_owned(), None),
            ("requests".to_owned(), Some("7".to_owned())),
            (
                "last_used_at".to_owned(),
                Some("2026-03-02 00:00:00+00".to_owned()),
            ),
            ("pruned_through".to_owned(), None),
        ]),
    ];
    let r = import(&s, "mcp_request_log_rollup", rows.clone());
    assert_eq!((r.imported, r.skipped), (2, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    let usage = s
        .read_mcp_lifetime_usage(Some(&[Some("alice".into()), Some(String::new())]))
        .unwrap();
    assert_eq!(usage.len(), 2);
    assert_eq!(usage[0]["token_name"], "");
    assert_eq!(usage[0]["requests"], 7);
    assert_eq!(usage[1]["token_name"], "alice");
    assert_eq!(usage[1]["requests"], 40);
    assert_eq!(usage[1]["last_used_at"], iso(us("2026-03-01T00:00:00Z")));
    // The newest pruned row of any token.
    assert_eq!(
        s.read_mcp_rollup_pruned_before().unwrap()["pruned_before"],
        iso(us("2026-02-20T00:00:00.5Z"))
    );
    assert_eq!(import(&s, "mcp_request_log_rollup", rows).skipped, 2);
}

#[test]
fn the_wake_relations_import_in_order_after_the_decide_relations() {
    let names: Vec<_> = crate::seed::plan()
        .relations
        .iter()
        .map(|p| p.relation)
        .collect();
    let wake = [
        "wake_crons",
        "wake_cron_runs",
        "wake_forgets",
        "wake_terms_acceptances",
        "mcp_request_log_rollup",
    ];
    let at = |name: &str| names.iter().position(|n| *n == name).unwrap();
    for pair in wake.windows(2) {
        assert!(at(pair[0]) < at(pair[1]), "{pair:?}");
    }
    assert!(!names.contains(&"wake_subscriptions"));
}
