//! The daily budget ledger (`budget_ledger.rs`): the paid-call protocol's writes and the day read,
//! as `src/core/engine-sql/budget-ledger-writes.ts` and `daily-ledger.ts readDay` run them.

mod memory_env;

use gbrain_store::budget_ledger::BudgetReservationSpec;
use memory_env::brain;
use serde_json::{Value, json};

const SCOPE: &str = "llm_repair";
const RES: &str = "parity";
const DAY: &str = "2026-11-21";

fn spec(id: &str, estimate: &str) -> BudgetReservationSpec {
    serde_json::from_value(
        json!({ "day": DAY, "estimate": estimate, "cap": "1.0000", "id": id,
        "at": "2026-11-21T10:00:00.000Z", "expiresAt": "2026-11-21T10:10:00.000Z" }),
    )
    .unwrap()
}

#[test]
fn the_protocol_holds_within_the_cap_settles_once_releases_and_reclaims() {
    let b = brain("budget-ledger");
    assert_eq!(
        b.read_budget_ledger_day(SCOPE, RES, DAY).unwrap(),
        Value::Null
    );
    assert!(
        b.reserve_budget_reservation(SCOPE, RES, &spec("r1", "0.4000"))
            .unwrap()
    );
    assert!(
        b.reserve_budget_reservation(SCOPE, RES, &spec("r2", "0.3000"))
            .unwrap()
    );
    assert!(
        !b.reserve_budget_reservation(SCOPE, RES, &spec("r3", "0.5000"))
            .unwrap()
    );
    assert!(
        b.reserve_budget_reservation(SCOPE, RES, &spec("r1", "0.0100"))
            .is_err()
    );
    let later = "2026-11-21T10:05:00.000Z";
    assert!(
        b.dispatch_budget_reservation(SCOPE, RES, "r1", later)
            .unwrap()
    );
    assert!(
        !b.dispatch_budget_reservation(SCOPE, RES, "r1", later)
            .unwrap()
    );
    assert_eq!(
        b.settle_budget_reservation(SCOPE, RES, "r1", "0.4500")
            .unwrap(),
        json!({ "prior": "dispatched", "estimate": "0.4000", "day": DAY, "current": "dispatched" })
    );
    assert_eq!(
        b.settle_budget_reservation(SCOPE, RES, "r1", "0.4500")
            .unwrap(),
        json!({ "prior": null, "estimate": null, "day": null, "current": "overrun" })
    );
    assert_eq!(
        b.settle_budget_reservation(SCOPE, RES, "nope", "0.1000")
            .unwrap(),
        json!({ "prior": null, "estimate": null, "day": null, "current": null })
    );
    assert!(b.release_budget_reservation(SCOPE, RES, "r2").unwrap());
    assert!(!b.release_budget_reservation(SCOPE, RES, "r2").unwrap());
    assert!(
        b.reserve_budget_reservation(SCOPE, RES, &spec("r4", "0.1000"))
            .unwrap()
    );
    assert!(
        b.reserve_budget_reservation(SCOPE, RES, &spec("r5", "0.1000"))
            .unwrap()
    );
    assert!(
        b.dispatch_budget_reservation(SCOPE, RES, "r5", later)
            .unwrap()
    );
    assert_eq!(
        b.reclaim_budget_reservations(SCOPE, RES, "2026-11-21T11:00:00.000Z")
            .unwrap(),
        json!({ "released": 1, "uncertain": 1 })
    );
    assert_eq!(
        b.read_budget_ledger_day(SCOPE, RES, DAY).unwrap(),
        json!({ "reserved": "0.0000", "committed": "0.5500", "cap": "1.0000" })
    );
    // Another ledger shares nothing.
    assert_eq!(
        b.read_budget_ledger_day(SCOPE, "other", DAY).unwrap(),
        Value::Null
    );
    assert!(b.read_budget_ledger_day(SCOPE, RES, "2026-13-01").is_err());
}
