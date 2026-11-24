//! The page embedding ledger's settle (`settlePageEmbeddingReservation`) with an amount that is
//! not a finite number. PGLite and Postgres keep it (DOUBLE PRECISION); the Rust ledger must store
//! it bit-exact and read it back, never leave a row no read can parse.

mod memory_env;

use gbrain_store::Store;
use gbrain_store::page_embedding_budget::{ReserveInput, SettleInput};
use gbrain_store::pages::{PageInput, PutPageOptions};
use memory_env::brain;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// A page with a granted reservation of 0.5; returns (page id, reservation window).
fn granted(store: &Store, slug: &str) -> (u64, String) {
    let input: PageInput =
        de(json!({"type": "note", "title": slug, "compiled_truth": "body text"}));
    let row = store
        .put_page(slug, &input, &de::<PutPageOptions>(json!({"index": false})))
        .unwrap();
    let id = row["id"].as_u64().unwrap();
    let reserve: ReserveInput = de(json!({
        "approved": false, "approvedCapUsd": null, "configuredCapUsd": 2.0, "signature": "model-a:1536",
        "chunks": [{"chunkIndex": 0, "costUsd": 0.5}], "junk": {"reason": null},
    }));
    let grant = store.reserve_page_embedding(id, &reserve).unwrap();
    let window = grant["window"].as_str().unwrap().to_string();
    (id, window)
}

fn settle(window: &str, booked: f64) -> SettleInput {
    SettleInput {
        window: Some(window.to_string()),
        reserved_usd: 0.5,
        booked_usd: booked,
        unpriced_calls: 0,
    }
}

#[test]
fn a_non_finite_booking_is_kept_exactly_and_the_ledger_stays_readable() {
    // PGLite and Postgres store DOUBLE PRECISION: `spent_usd + Math.max(0, bookedUsd)` keeps
    // Infinity and NaN, and -Infinity books 0. The Rust ledger stores and reads back the same.
    let b = brain("budget-non-finite");
    for (slug, booked, spent) in [
        ("notes/inf", f64::INFINITY, json!("Infinity")),
        ("notes/neg-inf", f64::NEG_INFINITY, json!(0.0)),
        ("notes/nan", f64::NAN, json!("NaN")),
    ] {
        let (id, window) = granted(&b, slug);
        b.settle_page_embedding_reservation(id, &settle(&window, booked))
            .unwrap_or_else(|e| panic!("{slug}: the settle books as PGLite does: {e}"));
        let row = b
            .read_page_embedding_budget(id)
            .unwrap_or_else(|e| panic!("{slug}: the ledger row stays readable: {e}"));
        assert_eq!(row["spent_usd"], spent, "{slug}: spent_usd");
        assert_eq!(
            row["reserved_usd"],
            json!(0.0),
            "{slug}: the hold is settled"
        );
        assert_eq!(
            row["reservation_window"],
            Value::Null,
            "{slug}: the window closes"
        );
    }
}

#[test]
fn a_non_finite_reserved_amount_is_kept_exactly() {
    // `reserved_usd - reservedUsd`: minus NaN is NaN, minus -Infinity is Infinity (both stay held).
    let b = brain("budget-non-finite-reserved");
    for (slug, reserved, kept) in [
        ("notes/r-nan", f64::NAN, json!("NaN")),
        ("notes/r-neg-inf", f64::NEG_INFINITY, json!("Infinity")),
    ] {
        let (id, window) = granted(&b, slug);
        let mut s = settle(&window, 0.25);
        s.reserved_usd = reserved;
        b.settle_page_embedding_reservation(id, &s).unwrap();
        let row = b.read_page_embedding_budget(id).unwrap();
        assert_eq!(row["reserved_usd"], kept, "{slug}: reserved_usd");
        assert_eq!(row["spent_usd"], json!(0.25), "{slug}: spent_usd");
    }
}

#[test]
fn a_finite_booking_still_settles() {
    let b = brain("budget-finite");
    let (id, window) = granted(&b, "notes/ok");
    b.settle_page_embedding_reservation(id, &settle(&window, 0.25))
        .unwrap();
    let row = b.read_page_embedding_budget(id).unwrap();
    assert_eq!(row["spent_usd"], json!(0.25));
    assert_eq!(row["reserved_usd"], json!(0.0));
}
