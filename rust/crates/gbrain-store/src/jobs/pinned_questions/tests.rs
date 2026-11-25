//! Unit tests of the pin members beyond main's insert, read and listing: each writes and reads main's records
//! (`m 0x2F id`, `m 0x30 source_id 0x00 slug`) and nothing under the `~q` pin sub-tags, with the lease logic on a clock the
//! test sets, double-precision spend, the blocked record, the state change and a publication inside a transaction.

use super::*;
use crate::env::Env;
use crate::error::INVALID_ARGUMENT;
use crate::kv::collect_prefix;
use crate::questions::{Float8, PinAnswerPublish, PinStatePatch};
use crate::test_support::store_with_env;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

const T0: i64 = 1_790_000_000_000_000;

/// A clock the test sets.
struct Clock(AtomicI64);

impl Env for Clock {
    fn now_micros(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        "00000000-0000-4000-8000-000000000000".to_string()
    }
}

fn store() -> (Store, Arc<Clock>) {
    let clock = Arc::new(Clock(AtomicI64::new(T0)));
    (store_with_env(clock.clone()), clock)
}

fn insert_row(source: &str, slug: &str) -> PinInsert {
    PinInsert {
        source_id: Some(source.into()),
        slug: Some(slug.into()),
        question: Some(format!("Question of {slug}?")),
        scope_slug_prefix: Some("projects/".into()),
        scope_entity: None,
        state: Some("active".into()),
        inactive_reason: None,
        publish_mode: Some("publish".into()),
        created_by: Some("cli".into()),
    }
}

fn pin(s: &Store, source: &str, slug: &str) -> Value {
    s.insert_pinned_question(&insert_row(source, slug))
        .unwrap()
        .unwrap()
}

fn id_of(v: &Value) -> i64 {
    v["id"].as_i64().unwrap()
}

fn row(s: &Store, source: &str, slug: &str) -> Value {
    s.read_pinned_question(source, slug).unwrap().unwrap()
}

fn f8(x: f64) -> Float8 {
    Float8(x)
}

fn patch(state: Option<&str>) -> PinStatePatch {
    PinStatePatch {
        state: state.map(Into::into),
        set_inactive_reason: false,
        inactive_reason: None,
        publish_mode: None,
    }
}

/// The record at `m 0x2F id`, as stored.
fn stored(s: &Store, id: i64) -> PinRecord {
    get_json::<PinRecord>(&*s.read().unwrap(), &pin_key(id))
        .unwrap()
        .unwrap()
}

fn put_stored(s: &Store, rec: &PinRecord) {
    s.write(|tx| put_json(tx, &pin_key(rec.id), rec)).unwrap();
}

#[test]
fn every_write_lands_on_mains_two_keys_and_nothing_under_the_question_family_pin_tags() {
    let (s, _) = store();
    let a = pin(&s, "default", "questions/a");
    let id = id_of(&a);
    s.update_pin_row_state(id, &patch(Some("inactive")))
        .unwrap()
        .unwrap();
    s.acquire_pin_lease(id, "tok", "w", f8(1000.0))
        .unwrap()
        .unwrap();
    s.add_pin_spend(id, f8(0.5)).unwrap();
    s.record_pin_blocked(id, "x").unwrap();
    s.release_pin_lease(id, "tok", None, f8(0.25)).unwrap();
    s.publish_pin_answer(id, &answer()).unwrap();
    let read = s.read().unwrap();
    let pins = collect_prefix(&*read, &[crate::keys::JOBS, 0x2F], false, 100).unwrap();
    let slugs = collect_prefix(&*read, &[crate::keys::JOBS, 0x30], false, 100).unwrap();
    assert_eq!((pins.len(), slugs.len()), (1, 1));
    assert_eq!(pins[0].0, pin_key(id));
    assert_eq!(slugs[0].0, slug_key("default", "questions/a"));
    // `~q 0x01` and `~q 0x02` are reserved and unused: pin rows live here.
    for sub in [0x01u8, 0x02] {
        let tag = [crate::keys::QUESTIONS[0], crate::keys::QUESTIONS[1], sub];
        assert!(
            collect_prefix(&*read, &tag, false, 10).unwrap().is_empty(),
            "~q {sub:#04x}"
        );
    }
    // The state, the lease, the spend and the answer are in main's record.
    let rec = stored(&s, id);
    assert_eq!(
        (
            rec.state.as_str(),
            rec.answer_revision,
            rec.refresh_attempts
        ),
        ("inactive", 1, 1)
    );
    assert_eq!(rec.spend_usd, 0.5 + 0.25 + 0.125);
    assert_eq!(rec.id, id);
}

#[test]
fn a_pin_made_by_mains_insert_is_found_by_every_new_member_and_the_id_comes_from_its_sequence() {
    let (s, _) = store();
    let a = pin(&s, "default", "questions/a");
    let b = pin(&s, "work", "questions/a");
    assert_eq!((id_of(&a), id_of(&b)), (1, 2));
    assert_eq!(
        s.read_pinned_question_for_update("default", "questions/a")
            .unwrap()
            .unwrap()["id"],
        1
    );
    assert!(
        s.read_pinned_question_for_update("default", "questions/never")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        s.lock_pin_row_for_publish(2).unwrap().unwrap(),
        json!({ "revision": 1, "lease_token": null, "state": "active" })
    );
    assert!(s.lock_pin_row_for_publish(999).unwrap().is_none());
    assert!(s.lock_pin_row_for_publish(-1).unwrap().is_none());
    assert_eq!(
        s.update_pin_row_state(2, &patch(Some("archived")))
            .unwrap()
            .unwrap()["slug"],
        "questions/a"
    );
    assert!(s.update_pin_row_state(999, &patch(None)).unwrap().is_none());
    assert_eq!(
        read_seq(&*s.read().unwrap(), "pinned_questions").unwrap(),
        2
    );
}

#[test]
fn a_state_change_bumps_the_revision_and_archiving_drops_the_lease_and_stamps_archived_at_once() {
    let (s, clock) = store();
    let id = id_of(&pin(&s, "default", "questions/s"));
    s.acquire_pin_lease(id, "tok", "worker", f8(600_000.0))
        .unwrap()
        .unwrap();
    let archived = s
        .update_pin_row_state(id, &patch(Some("archived")))
        .unwrap()
        .unwrap();
    assert_eq!(archived["revision"], 2);
    assert_eq!(archived["archived_at"], iso(T0));
    assert_eq!(archived["lease_token"], Value::Null);
    assert_eq!(archived["lease_expires_at"], Value::Null);
    // The owner column stays (the statement clears the token and the expiry only).
    assert_eq!(stored(&s, id).lease_owner.as_deref(), Some("worker"));
    clock.0.store(T0 + 5, Ordering::SeqCst);
    let again = PinStatePatch {
        state: Some("archived".into()),
        set_inactive_reason: true,
        inactive_reason: Some("migrated_disabled".into()),
        publish_mode: Some("draft".into()),
    };
    let still = s.update_pin_row_state(id, &again).unwrap().unwrap();
    assert_eq!(still["archived_at"], iso(T0), "archived_at is stamped once");
    assert_eq!(
        (
            still["inactive_reason"].as_str(),
            still["publish_mode"].as_str(),
            still["revision"].as_i64()
        ),
        (Some("migrated_disabled"), Some("draft"), Some(3))
    );
    let back = s
        .update_pin_row_state(id, &patch(Some("active")))
        .unwrap()
        .unwrap();
    assert_eq!(back["archived_at"], Value::Null);
    // No patch keeps the reason.
    let kept = s.update_pin_row_state(id, &patch(None)).unwrap().unwrap();
    assert_eq!(
        (kept["inactive_reason"].as_str(), kept["revision"].as_i64()),
        (Some("migrated_disabled"), Some(5))
    );
    let no_nul = PinStatePatch {
        state: Some("a\0b".into()),
        ..patch(None)
    };
    assert_eq!(
        s.update_pin_row_state(id, &no_nul).unwrap_err().code,
        INVALID_ARGUMENT
    );
}

#[test]
fn a_live_lease_refuses_a_second_taker_and_an_expired_one_is_taken_over() {
    let (s, clock) = store();
    let id = id_of(&pin(&s, "default", "questions/l"));
    let first = s
        .acquire_pin_lease(id, "tok-1", "w1", f8(1000.0))
        .unwrap()
        .unwrap();
    assert_eq!(first["lease_expires_at"], iso(T0 + 1_000_000));
    assert_eq!(
        (
            first["refresh_attempts"].as_i64(),
            first["last_attempt_at"].as_str()
        ),
        (Some(1), Some(iso(T0).as_str()))
    );
    // Live: refused. At the expiry instant the lease is still live (`lease_expires_at < now()`).
    clock.0.store(T0 + 1_000_000, Ordering::SeqCst);
    assert!(
        s.acquire_pin_lease(id, "tok-2", "w2", f8(1000.0))
            .unwrap()
            .is_none()
    );
    // The wrong token releases nothing.
    s.release_pin_lease(id, "wrong", Some("ignored".into()), f8(5.0))
        .unwrap();
    let held = row(&s, "default", "questions/l");
    assert_eq!(
        (
            held["lease_token"].as_str(),
            held["last_error"].clone(),
            held["spend_usd"].clone()
        ),
        (Some("tok-1"), Value::Null, json!(0.0))
    );
    // One microsecond later it is expired and taken over.
    clock.0.store(T0 + 1_000_001, Ordering::SeqCst);
    let second = s
        .acquire_pin_lease(id, "tok-2", "w2", f8(0.0005))
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            second["lease_token"].as_str(),
            second["refresh_attempts"].as_i64()
        ),
        (Some("tok-2"), Some(2))
    );
    // 0.0005 ms is half a microsecond: it rounds to even (0).
    assert_eq!(second["lease_expires_at"], iso(T0 + 1_000_001));
    // A lease with a token and no expiry is free for the lease statement.
    let mut raw = stored(&s, id);
    raw.lease_expires_at = None;
    put_stored(&s, &raw);
    assert!(
        s.acquire_pin_lease(id, "tok-3", "w3", f8(10.0))
            .unwrap()
            .is_some()
    );
    // Archived pins and unknown ids are never leased; a non-finite or huge ttl is refused.
    s.update_pin_row_state(id, &patch(Some("archived")))
        .unwrap();
    assert!(
        s.acquire_pin_lease(id, "tok-4", "w4", f8(10.0))
            .unwrap()
            .is_none()
    );
    assert!(
        s.acquire_pin_lease(999, "t", "w", f8(10.0))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        s.acquire_pin_lease(id, "t", "w", f8(f64::NAN))
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        s.acquire_pin_lease(id, "t", "w", f8(1e300))
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}

#[test]
fn a_release_records_the_cause_and_spend_and_spend_adds_as_doubles() {
    let (s, _) = store();
    let id = id_of(&pin(&s, "default", "questions/m"));
    s.add_pin_spend(id, f8(0.1)).unwrap();
    s.add_pin_spend(id, f8(0.2)).unwrap();
    assert_eq!(
        row(&s, "default", "questions/m")["spend_usd"],
        json!(0.1 + 0.2)
    );
    s.acquire_pin_lease(id, "tok", "w", f8(1000.0)).unwrap();
    s.release_pin_lease(id, "tok", Some("refresh_failed:parse".into()), f8(1e-7))
        .unwrap();
    let r = row(&s, "default", "questions/m");
    assert_eq!(r["spend_usd"], json!(0.1 + 0.2 + 1e-7));
    assert_eq!(
        (
            r["lease_token"].clone(),
            r["lease_owner"].clone(),
            r["last_error"].as_str()
        ),
        (Value::Null, Value::Null, Some("refresh_failed:parse"))
    );
    // Spend on an unknown pin writes nothing and is not an error.
    s.add_pin_spend(999, f8(1.0)).unwrap();
}

#[test]
fn a_non_finite_spend_is_stored_and_read_back_as_its_postgres_text_and_old_records_still_read() {
    let (s, _) = store();
    let id = id_of(&pin(&s, "default", "questions/n"));
    s.add_pin_spend(id, f8(f64::INFINITY)).unwrap();
    assert_eq!(
        row(&s, "default", "questions/n")["spend_usd"],
        json!("Infinity")
    );
    s.add_pin_spend(id, f8(f64::NEG_INFINITY)).unwrap();
    assert_eq!(row(&s, "default", "questions/n")["spend_usd"], json!("NaN"));
    assert_eq!(
        s.list_pinned_questions(&PinFilter::default()).unwrap()[0]["spend_usd"],
        json!("NaN")
    );
    // A record an older build wrote holds a plain number (or null where a non-finite one was lost): both still read.
    let plain: PinRecord = serde_json::from_value({
        let mut v = serde_json::to_value(stored(&s, id)).unwrap();
        v["spend_usd"] = json!(1.5);
        v
    })
    .unwrap();
    assert_eq!(plain.spend_usd, 1.5);
    let lost: PinRecord = serde_json::from_value({
        let mut v = serde_json::to_value(stored(&s, id)).unwrap();
        v["spend_usd"] = Value::Null;
        v
    })
    .unwrap();
    assert!(lost.spend_usd.is_nan());
    let finite = serde_json::to_value(&plain).unwrap();
    assert_eq!(
        finite["spend_usd"],
        json!(1.5),
        "a finite spend is stored as the number it always was"
    );
}

#[test]
fn the_blocked_record_stamps_unless_a_live_lease_holds_the_pin() {
    let (s, clock) = store();
    let id = id_of(&pin(&s, "default", "questions/k"));
    s.record_pin_blocked(id, "budget_exhausted").unwrap();
    let free = row(&s, "default", "questions/k");
    assert_eq!(
        (
            free["last_error"].as_str(),
            free["last_attempt_at"].as_str()
        ),
        (Some("budget_exhausted"), Some(iso(T0).as_str()))
    );
    clock.0.store(T0 + 10, Ordering::SeqCst);
    s.acquire_pin_lease(id, "tok", "w", f8(1.0)).unwrap();
    clock.0.store(T0 + 20, Ordering::SeqCst);
    s.record_pin_blocked(id, "while_live").unwrap();
    assert_eq!(
        row(&s, "default", "questions/k")["last_error"],
        "budget_exhausted"
    );
    // Past the expiry the lease no longer holds the pin.
    clock.0.store(T0 + 10 + 1000 + 1, Ordering::SeqCst);
    s.record_pin_blocked(id, "after_expiry").unwrap();
    assert_eq!(
        row(&s, "default", "questions/k")["last_error"],
        "after_expiry"
    );
    // A token with no expiry holds the pin here (`NULL < now()` is not true).
    let mut raw = stored(&s, id);
    raw.lease_expires_at = None;
    put_stored(&s, &raw);
    s.record_pin_blocked(id, "never_written").unwrap();
    assert_eq!(
        row(&s, "default", "questions/k")["last_error"],
        "after_expiry"
    );
    s.record_pin_blocked(999, "unknown").unwrap();
}

fn answer() -> PinAnswerPublish {
    PinAnswerPublish {
        answer: "[]".into(),
        answer_model: "m".into(),
        watermark_generation: 12,
        watermark_fact_id: 99,
        spend_usd: f8(0.125),
    }
}

#[test]
fn a_publication_inside_a_transaction_commits_whole_and_a_rollback_keeps_nothing() {
    let (s, clock) = store();
    let id = id_of(&pin(&s, "default", "questions/p"));
    s.acquire_pin_lease(id, "tok", "w", f8(600_000.0)).unwrap();
    let tx = s.begin_transaction(false).unwrap();
    assert_eq!(
        tx.lock_pin_row_for_publish(id).unwrap().unwrap(),
        json!({ "revision": 1, "lease_token": "tok", "state": "active" })
    );
    tx.publish_pin_answer(id, &answer()).unwrap();
    tx.rollback_transaction().unwrap();
    let after = row(&s, "default", "questions/p");
    assert_eq!(
        (
            after["answer_revision"].as_i64(),
            after["answer"].clone(),
            after["lease_token"].as_str()
        ),
        (Some(0), Value::Null, Some("tok"))
    );
    // Committed: one clock for the whole transaction, as Postgres `now()` is the transaction start.
    clock.0.store(T0 + 100, Ordering::SeqCst);
    let tx = s.begin_transaction(false).unwrap();
    clock.0.store(T0 + 200, Ordering::SeqCst);
    tx.publish_pin_answer(id, &answer()).unwrap();
    tx.commit_transaction().unwrap();
    let done = row(&s, "default", "questions/p");
    assert_eq!(
        (
            done["answer"].as_str(),
            done["answer_revision"].as_i64(),
            done["revision"].as_i64()
        ),
        (Some("[]"), Some(1), Some(2))
    );
    assert_eq!(
        (
            done["lease_token"].clone(),
            done["last_error"].clone(),
            done["answer_model"].as_str()
        ),
        (Value::Null, Value::Null, Some("m"))
    );
    assert_eq!(
        (
            done["watermark_generation"].as_i64(),
            done["watermark_fact_id"].as_i64()
        ),
        (Some(12), Some(99))
    );
    assert_eq!(done["last_refresh_at"], iso(T0 + 100));
    assert_eq!(stored(&s, id).watermark_at, Some(T0 + 100));
    assert_eq!(done["spend_usd"], json!(0.125));
    // Publishing an unknown pin writes nothing.
    s.publish_pin_answer(999, &answer()).unwrap();
}

#[test]
fn the_shadow_seed_helpers_keep_ids_refuse_a_taken_slug_and_remove_their_index() {
    let (s, _) = store();
    let (a, dup) = (
        seed_record(41, "default", "questions/a"),
        seed_record(42, "default", "questions/a"),
    );
    s.write(|tx| {
        assert!(seed_pin(tx, &a)?);
        assert!(!seed_pin(tx, &a)?);
        assert_eq!(seed_pin(tx, &dup).unwrap_err().code, CONSTRAINT_VIOLATION);
        raise_seq(tx, SEQUENCE, 41)?;
        Ok(())
    })
    .unwrap();
    // A REAL reads back as the shortest decimal of the f32, not the widened double.
    assert_eq!(
        row(&s, "default", "questions/a")["cooldown_days"],
        json!(0.1)
    );
    assert_eq!(id_of(&pin(&s, "default", "questions/z")), 42);
    s.write(|tx| {
        assert!(remove_pin(tx, 41)?);
        assert!(!remove_pin(tx, 41)?);
        // The slug is free again.
        assert!(seed_pin(tx, &seed_record(50, "default", "questions/a"))?);
        Ok(())
    })
    .unwrap();
    assert_eq!(id_of(&row(&s, "default", "questions/a")), 50);
}

fn seed_record(id: i64, source: &str, slug: &str) -> PinRecord {
    PinRecord {
        id,
        source_id: source.into(),
        slug: slug.into(),
        question: "Q?".into(),
        scope_slug_prefix: None,
        scope_entity: None,
        state: "active".into(),
        inactive_reason: None,
        publish_mode: "publish".into(),
        model: None,
        cooldown_days: Some(0.1),
        origin: "pin".into(),
        created_by: "cli".into(),
        revision: 3,
        answer_revision: 2,
        answer: None,
        answer_model: None,
        last_refresh_at: None,
        last_attempt_at: None,
        last_error: None,
        watermark_generation: None,
        watermark_fact_id: None,
        watermark_at: None,
        lease_token: None,
        lease_owner: None,
        lease_expires_at: None,
        refresh_attempts: 0,
        spend_usd: 0.0,
        created_at: T0,
        archived_at: None,
    }
}
