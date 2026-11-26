//! The order an effect settle statement checks its input in (lane L5, G14: with no fence and multi-user off the
//! store must answer exactly as it did before the lane).
//!
//! Postgres binds every parameter before it reads a row, so the payload and delay are checked first and the effect id
//! and token are cast last. A call with a malformed id and a missing payload therefore says the payload is missing,
//! never that the id is bad. The expected errors below are what `4ca2fa285e` (before L5) returns for each call.

mod common;

use common::{TempDir, open};
use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::persistence::{EffectSettle, Settle};
use serde_json::{Value, json};

fn settle(fields: Value) -> EffectSettle {
    serde_json::from_value(fields).unwrap()
}

fn refused(action: Settle, fields: Value) -> String {
    let dir = TempDir::new("effect-settle-validation");
    let store = open(&dir);
    let error = store.settle_effect(action, &settle(fields)).unwrap_err();
    assert_eq!(error.code, INVALID_ARGUMENT);
    error.message
}

#[test]
fn a_missing_payload_is_refused_before_a_malformed_effect_id_is_read() {
    let token = "c0000000-0000-4000-8000-0000000000c1";
    assert_eq!(
        refused(
            Settle::Complete,
            json!({ "id": "not-a-number", "token": token })
        ),
        "outcome is required"
    );
    for action in [Settle::Requeue, Settle::Park, Settle::RetryBusy] {
        assert_eq!(
            refused(action, json!({ "id": "not-a-number", "token": token })),
            "data is required"
        );
    }
}

#[test]
fn a_missing_payload_is_refused_before_a_malformed_token_is_read() {
    assert_eq!(
        refused(
            Settle::Complete,
            json!({ "id": "7", "token": "not-a-uuid" })
        ),
        "outcome is required"
    );
}

#[test]
fn a_malformed_effect_id_is_still_refused_when_the_payload_is_whole() {
    assert_eq!(
        refused(
            Settle::Complete,
            json!({ "id": "not-a-number", "outcomeJson": "{}" })
        ),
        "invalid input syntax for type bigint: \"not-a-number\""
    );
}
