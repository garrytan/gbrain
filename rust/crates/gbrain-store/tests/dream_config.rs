//! The dream map config rows: the PGLite semantics of ensureDreamMapConfigRow, lockDreamMapConfigRow,
//! writeDreamMapConfigRow and recordDreamBreakerReset.

mod memory_env;

use gbrain_store::dream_config::{DreamBreakerResetArgs, DreamMapKeyArgs, DreamMapWriteArgs};
use gbrain_store::env::iso;
use gbrain_store::error::INVALID_ARGUMENT;
use memory_env::{T0, brain};
use serde_json::json;

fn key(k: &str) -> DreamMapKeyArgs {
    DreamMapKeyArgs { key: k.into() }
}

fn write(k: &str, v: &str) -> DreamMapWriteArgs {
    DreamMapWriteArgs {
        key: k.into(),
        value: v.into(),
    }
}

fn reset(resets: &str, base: &str) -> DreamBreakerResetArgs {
    DreamBreakerResetArgs {
        resets_key: resets.into(),
        base_key: base.into(),
    }
}

/// `to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` of `micros`.
fn ms(micros: i64) -> String {
    let full = iso(micros);
    format!("{}Z", &full[..full.len() - 4])
}

#[test]
fn ensure_inserts_an_empty_map_only_for_a_missing_key_and_write_updates_only_a_row() {
    let b = brain("dc-ensure");
    b.write_dream_map_config_row(&write("m", "ignored"))
        .unwrap();
    assert_eq!(b.get_config("m").unwrap(), None);
    b.ensure_dream_map_config_row(&key("m")).unwrap();
    assert_eq!(b.get_config("m").unwrap().as_deref(), Some("{}"));
    b.write_dream_map_config_row(&write("m", "{\"a\": \"b\"}"))
        .unwrap();
    b.ensure_dream_map_config_row(&key("m")).unwrap();
    assert_eq!(
        b.get_config("m").unwrap().as_deref(),
        Some("{\"a\": \"b\"}")
    );
}

#[test]
fn lock_returns_the_value_and_the_clock_in_milliseconds_or_null() {
    let b = brain("dc-lock");
    assert_eq!(b.lock_dream_map_config_row(&key("m")).unwrap(), None);
    b.ensure_dream_map_config_row(&key("m")).unwrap();
    b.clock.advance(1_234_567);
    assert_eq!(
        b.lock_dream_map_config_row(&key("m")).unwrap(),
        Some(json!({ "value": "{}", "now": ms(T0 + 1_234_567) }))
    );
    assert!(
        b.lock_dream_map_config_row(&key("m")).unwrap().unwrap()["now"]
            .as_str()
            .unwrap()
            .ends_with(".234Z")
    );
}

#[test]
fn a_reset_keeps_only_recent_dated_entries_and_dates_the_base_key_a_millisecond_ahead() {
    let b = brain("dc-reset");
    let old = ms(T0 - 25 * 3_600_000_000);
    let fresh = ms(T0 - 3_600_000_000);
    let stored =
        json!({ "fresh": fresh, "old": old, "plain": "x", "number": 5, "base": ms(T0 - 1) });
    b.set_config("r", &stored.to_string()).unwrap();
    b.record_dream_breaker_reset(&reset("r", "base")).unwrap();
    assert_eq!(
        b.get_config("r").unwrap().unwrap(),
        format!(
            "{{\"base\": \"{}\", \"fresh\": \"{fresh}\"}}",
            ms(T0 + 1_000)
        )
    );
}

#[test]
fn a_reset_reads_a_missing_row_and_a_value_that_is_not_an_object_as_empty() {
    let b = brain("dc-reset-empty");
    let expected = format!("{{\"a\": \"{}\"}}", ms(T0 + 1_000));
    b.record_dream_breaker_reset(&reset("r", "a")).unwrap();
    assert_eq!(b.get_config("r").unwrap().unwrap(), expected);
    for bad in ["[1]", "not json", "\"2030-01-01T00:00:00.000Z\"", "null"] {
        b.set_config("r", bad).unwrap();
        b.record_dream_breaker_reset(&reset("r", "a")).unwrap();
        assert_eq!(b.get_config("r").unwrap().unwrap(), expected, "{bad}");
    }
}

#[test]
fn a_dated_entry_that_is_not_an_instant_fails_the_reset_and_changes_nothing() {
    let b = brain("dc-reset-bad");
    b.set_config("r", "{\"x\": \"2026-garbage\"}").unwrap();
    let err = b.record_dream_breaker_reset(&reset("r", "a")).unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    assert_eq!(
        b.get_config("r").unwrap().as_deref(),
        Some("{\"x\": \"2026-garbage\"}")
    );
}

#[test]
fn a_key_with_a_nul_byte_is_refused() {
    let b = brain("dc-nul");
    assert_eq!(
        b.ensure_dream_map_config_row(&key("a\0b"))
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}
