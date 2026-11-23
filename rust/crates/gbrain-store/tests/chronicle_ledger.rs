//! `upsertChronicleRow`, `reserveChronicleJudgeSlot` and `readChronicleLedger`: the guards of an upsert, the 24-hour
//! limit of a reservation, and the rollup's windows and byte order.

mod memory_env;

use gbrain_store::Store;
use gbrain_store::chronicle_ledger::{ChronicleJudgeKey, ChronicleRowInput};
use gbrain_store::pages::{PageInput, PutPageOptions};
use memory_env::brain;
use serde_json::{Value, json};

const DAY: i64 = 86_400_000_000;

fn row(
    page: i64,
    hash: &str,
    state: &str,
    trigger: &str,
    reason: Option<&str>,
    principal: Option<&str>,
) -> ChronicleRowInput {
    serde_json::from_value(json!({
        "sourceId": "default", "pageId": page, "contentHash": hash, "extractorVersion": 2, "slug": format!("p{page}"),
        "state": state, "reason": reason, "trigger": trigger, "principalKind": principal.map(|_| "client"),
        "principalId": principal,
    }))
    .unwrap()
}

/// Pages `p1` to `p10` in `default`, ids 1 to 10: a ledger row names a page (`chronicle_page_state` references
/// `pages(id)`).
fn seed_pages(store: &Store) {
    for n in 1..=10u64 {
        let input = PageInput {
            page_type: "note".into(),
            title: format!("p{n}"),
            compiled_truth: format!("body {n}"),
            ..PageInput::default()
        };
        let row = store
            .put_page(&format!("p{n}"), &input, &PutPageOptions::default())
            .unwrap();
        assert_eq!(row["id"].as_u64(), Some(n));
    }
}

fn key(page: i64, hash: &str) -> ChronicleJudgeKey {
    serde_json::from_value(json!({ "sourceId": "default", "pageId": page, "contentHash": hash }))
        .unwrap()
}

#[test]
fn an_automatic_decision_leaves_a_pending_backfill_row() {
    let b = brain("chronicle-guard-backfill");
    seed_pages(&b);
    assert!(
        b.upsert_chronicle_row(&row(1, "h", "pending", "backfill", None, None))
            .unwrap()
    );
    assert!(
        !b.upsert_chronicle_row(&row(1, "h", "skipped", "auto", Some("r"), None))
            .unwrap()
    );
    assert!(
        b.upsert_chronicle_row(&row(1, "h", "skipped", "backfill", Some("r"), None))
            .unwrap()
    );
    // The skipped backfill row is no longer guarded.
    assert!(
        b.upsert_chronicle_row(&row(1, "h", "skipped", "auto", Some("r"), None))
            .unwrap()
    );
}

#[test]
fn an_unknown_state_or_trigger_refuses() {
    let b = brain("chronicle-bad-enum");
    assert!(
        b.upsert_chronicle_row(&row(1, "h", "done", "auto", None, None))
            .is_err()
    );
    assert!(
        b.upsert_chronicle_row(&row(1, "h", "pending", "manual", None, None))
            .is_err()
    );
}

#[test]
fn the_rollup_counts_reasons_and_principals_by_byte() {
    let b = brain("chronicle-rollup");
    seed_pages(&b);
    for (i, name) in ["b", "B", "a", "A"].iter().enumerate() {
        let page = i as i64 + 1;
        b.upsert_chronicle_row(&row(page, "h", "skipped", "auto", Some(name), Some(name)))
            .unwrap();
        assert!(
            b.reserve_chronicle_judge_slot(100, &key(page, "h"))
                .unwrap()
        );
    }
    b.upsert_chronicle_row(&row(9, "h", "pending", "auto", None, None))
        .unwrap();
    b.upsert_chronicle_row(&row(10, "h", "skipped", "backfill", Some("ignored"), None))
        .unwrap();
    let r = b.read_chronicle_ledger().unwrap();
    assert_eq!(r["counts"]["pending"], 1);
    assert_eq!(r["counts"]["skipped"], 4);
    assert_eq!(r["counts"]["known_usd"], Value::Null);
    let reasons: Vec<&str> = r["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["reason"].as_str().unwrap())
        .collect();
    assert_eq!(reasons, ["A", "B", "a", "b"]);
    assert_eq!(r["calls"], 4);
    let principals: Vec<&str> = r["principals"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["principal"].as_str().unwrap())
        .collect();
    assert_eq!(principals, ["client:A", "client:B", "client:a", "client:b"]);
}

#[test]
fn a_reservation_stops_at_the_limit_and_ages_out_after_a_day() {
    let b = brain("chronicle-limit");
    assert!(b.reserve_chronicle_judge_slot(2, &key(1, "h")).unwrap());
    assert!(b.reserve_chronicle_judge_slot(2, &key(2, "h")).unwrap());
    assert!(!b.reserve_chronicle_judge_slot(2, &key(3, "h")).unwrap());
    b.clock.advance(DAY + 1);
    assert!(b.reserve_chronicle_judge_slot(2, &key(3, "h")).unwrap());
    let r = b.read_chronicle_ledger().unwrap();
    assert_eq!(r["calls"], 1);
    // A reservation with no ledger row is attributed to no principal.
    assert_eq!(
        r["principals"],
        json!([{ "principal": "unattributed", "calls": 1 }])
    );
}

#[test]
fn a_row_older_than_a_week_leaves_the_counts_and_pending_stays() {
    let b = brain("chronicle-week");
    seed_pages(&b);
    b.upsert_chronicle_row(&row(1, "h", "skipped", "auto", Some("r"), None))
        .unwrap();
    b.upsert_chronicle_row(&row(2, "h", "pending", "auto", None, None))
        .unwrap();
    b.clock.advance(7 * DAY + 1);
    let r = b.read_chronicle_ledger().unwrap();
    assert_eq!(r["counts"]["skipped"], 0);
    assert_eq!(r["counts"]["pending"], 1);
    assert_eq!(r["reasons"], json!([]));
}

#[test]
fn a_row_for_a_missing_page_refuses_on_the_foreign_key() {
    let b = brain("chronicle-fk");
    let err = b
        .upsert_chronicle_row(&row(1, "h", "pending", "auto", None, None))
        .unwrap_err();
    assert!(err.to_string().contains("foreign key"), "{err}");
}
