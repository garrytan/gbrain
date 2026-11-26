//! Read-back tests of the spend relations: each imports rows and reads them back through the
//! spend members, then retries the batch and writes the next row the family's own way.

use super::super::decode::timestamp_us;
use super::super::{ImportResult, SeedRow};
use crate::Store;
use crate::env::iso;
use crate::jobs::{ExpireScope, LogInsert, SpendInsert};
use serde_json::{Value, json};

const SEED: &str = "seed-1";

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
    timestamp_us(text).unwrap()
}

fn log_row(id: &str, owner: (&str, &str), spend: &str, created_at: &str) -> SeedRow {
    row(&[
        ("id", id),
        owner,
        ("token_name", "tok"),
        ("operation", "image_query"),
        ("spend_cents", spend),
        ("provider", "openai"),
        ("model", "gpt-image"),
        ("created_at", created_at),
    ])
}

#[test]
fn mcp_spend_log_keeps_ids_times_and_the_owner_sums() {
    let s = crate::test_support::store();
    let rows = || {
        vec![
            log_row(
                "41",
                ("client_id", "c1"),
                "12.5000",
                "2026-05-01 10:00:00.5+00",
            ),
            log_row(
                "50",
                ("budget_key", "grp:1"),
                "3.0000",
                "2026-05-01 11:00:00+00",
            ),
            log_row(
                "60",
                ("client_id", "c1"),
                "1.0000",
                "2026-05-02 09:00:00+00",
            ),
        ]
    };
    let r = import(&s, "mcp_spend_log", rows());
    assert_eq!((r.imported, r.skipped), (3, 0));
    assert!(r.unmapped_columns.is_empty());
    let log = s.spend_log_rows().unwrap();
    let ids: Vec<i64> = log.iter().map(|l| l["id"].as_i64().unwrap()).collect();
    assert_eq!(ids, [41, 50, 60]);
    assert_eq!(log[0]["created_at"], iso(us("2026-05-01 10:00:00.5+00")));
    assert_eq!(log[0]["spend_cents"], 12.5);
    assert_eq!(log[0]["token_name"], "tok");
    assert_eq!(log[0]["client_id"], "c1");
    assert_eq!(log[1]["budget_key"], "grp:1");
    assert_eq!(log[1]["client_id"], Value::Null);
    // The owner indexes: a sum by client from an instant on, and a group's committed total.
    assert_eq!(
        s.sum_client_spend_since("c1", "2026-05-01T00:00:00Z")
            .unwrap(),
        13.5
    );
    assert_eq!(
        s.sum_client_spend_since("c1", "2026-05-02T00:00:00Z")
            .unwrap(),
        1.0
    );
    assert_eq!(
        s.read_group_spend_totals("grp:1").unwrap()["committed_cents"],
        3.0
    );
    let again = import(&s, "mcp_spend_log", rows());
    assert_eq!((again.imported, again.skipped), (0, 3));
    // The next row the family writes takes an id above the copied ones.
    s.insert_spend_log(&LogInsert {
        client_id: Some("c1".into()),
        token_name: None,
        operation: "image_query".into(),
        spend_cents: 2.0,
        provider: None,
        model: None,
    })
    .unwrap();
    let log = s.spend_log_rows().unwrap();
    assert_eq!(log.last().unwrap()["id"], 61);
}

const R_LIVE: &str = "01a1efa3-9ee6-701e-ada3-d202d5776740";
const R_OVERDUE: &str = "00000000-0000-4000-8000-00000000000b";
const R_SETTLED: &str = "00000000-0000-4000-8000-00000000000c";
const R_GROUP: &str = "00000000-0000-4000-8000-00000000000d";

fn reservation_rows() -> Vec<SeedRow> {
    vec![
        row(&[
            ("reservation_id", &R_LIVE.to_uppercase()),
            ("client_id", "c-agent"),
            ("estimated_cents", "10.0000"),
            ("model", "m"),
            ("provider", "p"),
            ("status", "pending"),
            ("created_at", "2026-05-01 10:00:00+00"),
            ("expires_at", "2999-01-01 00:00:00+00"),
            ("estimate_known", "t"),
        ]),
        row(&[
            ("reservation_id", R_OVERDUE),
            ("client_id", "c-agent"),
            ("job_id", "77"),
            ("estimated_cents", "5.0000"),
            ("model", "m"),
            ("provider", "p"),
            ("status", "pending"),
            ("created_at", "2026-05-01 10:00:00+00"),
            ("expires_at", "2000-01-01 00:00:00+00"),
            ("estimate_known", "f"),
            ("usage_unknown_reason", "pricing_or_bound_unknown"),
        ]),
        row(&[
            ("reservation_id", R_SETTLED),
            ("client_id", "c-agent"),
            ("estimated_cents", "2.0000"),
            ("actual_cents", "1.5000"),
            ("model", "m"),
            ("provider", "p"),
            ("status", "settled"),
            ("created_at", "2026-05-01 10:00:00+00"),
            ("settled_at", "2026-05-01 10:05:00.25+00"),
            ("expires_at", "2000-01-01 00:00:00+00"),
            ("estimate_known", "t"),
        ]),
        row(&[
            ("reservation_id", R_GROUP),
            ("budget_key", "grp:1"),
            ("estimated_cents", "4.0000"),
            ("model", "m"),
            ("provider", "p"),
            ("status", "expired"),
            ("created_at", "2026-05-01 10:00:00+00"),
            ("expires_at", "2000-01-01 00:00:00+00"),
            ("estimate_known", "t"),
        ]),
    ]
}

#[test]
fn mcp_spend_reservations_keep_status_times_and_every_index() {
    let s = crate::test_support::store();
    import(
        &s,
        "oauth_clients",
        vec![row(&[
            ("client_id", "c-agent"),
            ("client_name", "Agent"),
            ("scope", "agent"),
        ])],
    );
    let r = import(&s, "mcp_spend_reservations", reservation_rows());
    assert_eq!((r.imported, r.skipped, r.dropped), (4, 0, 0));
    assert!(r.unmapped_columns.is_empty());
    assert_eq!(r.losses["spend_hold_job_dropped"], 1);
    assert_eq!(r.losses.len(), 1);

    let live = s.spend_reservation_row(R_LIVE).unwrap().unwrap();
    assert_eq!(live["reservation_id"], R_LIVE);
    assert_eq!(live["status"], "pending");
    assert_eq!(live["estimated_cents"], 10.0);
    assert_eq!(live["created_at"], iso(us("2026-05-01 10:00:00+00")));
    assert_eq!(live["expires_at"], iso(us("2999-01-01 00:00:00+00")));
    let overdue = s.spend_reservation_row(R_OVERDUE).unwrap().unwrap();
    assert_eq!(overdue["job_id"], Value::Null);
    assert_eq!(overdue["estimate_known"], false);
    assert_eq!(overdue["usage_unknown_reason"], "pricing_or_bound_unknown");
    let settled = s.spend_reservation_row(R_SETTLED).unwrap().unwrap();
    assert_eq!(settled["status"], "settled");
    assert_eq!(settled["actual_cents"], 1.5);
    assert_eq!(settled["settled_at"], iso(us("2026-05-01 10:05:00.25+00")));
    let group = s.spend_reservation_row(R_GROUP).unwrap().unwrap();
    assert_eq!(group["budget_key"], "grp:1");
    assert_eq!(group["client_id"], Value::Null);

    // The open-hold index holds the pending and expired holds, not the settled one.
    let spend = s.read_agent_client_spend().unwrap();
    assert_eq!(spend[0]["pending_cents"], 15.0);
    assert_eq!(spend[0]["unknown_count"], 1);
    let totals = s.read_group_spend_totals("grp:1").unwrap();
    assert_eq!(totals["overdue_cents"], 4.0);
    // The expiry index holds the pending holds only: one is overdue.
    assert_eq!(
        s.expire_spend_reservations(&ExpireScope::default())
            .unwrap(),
        1
    );
    assert_eq!(
        s.spend_reservation_row(R_OVERDUE).unwrap().unwrap()["status"],
        "expired"
    );
    assert_eq!(
        s.settle_spend_reservation(R_SETTLED, 1.0).unwrap(),
        json!({ "outcome": "already_settled" })
    );
    assert_eq!(
        s.settle_spend_reservation(R_LIVE, 9.0).unwrap()["outcome"],
        "settled"
    );
}

#[test]
fn a_retried_reservation_is_skipped_and_a_held_id_still_refuses_a_new_hold() {
    let s = crate::test_support::store();
    import(&s, "mcp_spend_reservations", reservation_rows());
    let again = import(&s, "mcp_spend_reservations", reservation_rows());
    assert_eq!((again.imported, again.skipped), (0, 4));
    assert!(!again.losses.contains_key("spend_hold_job_dropped"));
    let err = s
        .insert_spend_reservation(&SpendInsert {
            reservation_id: R_LIVE.into(),
            client_id: Some("c-agent".into()),
            budget_key: None,
            job_id: None,
            estimated_cents: 1.0,
            model: "m".into(),
            provider: "p".into(),
            expires_at: "2999-01-01T00:00:00Z".into(),
            estimate_known: true,
            usage_unknown_reason: None,
        })
        .unwrap_err();
    assert_eq!(err.code, crate::error::CONSTRAINT_VIOLATION);
}
