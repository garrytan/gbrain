//! Unit tests of the pinned-question family: the key layout, the idempotent insert and its unique index, the listing
//! filters and order, state changes, the lease logic on a clock the test sets, float arithmetic, the blocked record,
//! the publication inside a transaction (and its rollback), and the two joined reads over pages.

use super::*;
use crate::env::Env;
use crate::error::INVALID_ARGUMENT;
use crate::kv::collect_prefix;
use crate::pages::{PageInput, PutPageOptions, read_page};
use crate::test_support::store_with_env;
use serde_json::json;
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
        source_id: source.into(),
        slug: slug.into(),
        question: format!("Question of {slug}?"),
        scope_slug_prefix: Some("projects/".into()),
        scope_entity: None,
        state: "active".into(),
        inactive_reason: None,
        publish_mode: "publish".into(),
        created_by: "cli".into(),
    }
}

fn pin(s: &Store, source: &str, slug: &str) -> Value {
    s.insert_pin_row(&insert_row(source, slug))
        .unwrap()
        .unwrap()
}

fn id_of(v: &Value) -> i64 {
    v["id"].as_i64().unwrap()
}

fn row(s: &Store, source: &str, slug: &str) -> Value {
    s.read_pin_row(source, slug, false).unwrap().unwrap()
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

fn evidence_row(q: i64, revision: i32, sentence: &str, kind: &str) -> EvidenceInsert {
    EvidenceInsert {
        question_id: q,
        answer_revision: revision,
        sentence_id: sentence.into(),
        kind: kind.into(),
        source_id: "default".into(),
        page_id: None,
        page_slug: None,
        page_generation: None,
        page_revision: None,
        item_id: None,
        content_hash: None,
    }
}

#[test]
fn every_key_sits_under_the_two_byte_family_tag_and_reads_back_in_id_order() {
    let tag = QUESTIONS;
    assert_eq!(tag, [b'~', b'q']);
    assert_eq!(
        pin_key(7),
        [&tag[..], &[0x01], &7u64.to_be_bytes()].concat()
    );
    assert_eq!(
        slug_key("default", "questions/a"),
        [&tag[..], &[0x02], b"default", &[0x00], b"questions/a"].concat()
    );
    assert_eq!(
        evidence_key(7, 9),
        [&tag[..], &[0x03], &7u64.to_be_bytes(), &9u64.to_be_bytes()].concat()
    );
    let (s, _) = store();
    let a = pin(&s, "default", "questions/a");
    s.insert_question_evidence(&[evidence_row(id_of(&a), 1, "s1", "page")])
        .unwrap();
    let read = s.read().unwrap();
    let all = collect_prefix(&*read, &tag, false, 100).unwrap();
    // One pin, its slug index, one evidence row: every key of the family and nothing else.
    assert_eq!(all.len(), 3);
    assert!(all.iter().all(|(k, _)| k.starts_with(&tag)));
    // Nothing leaks outside the family: the one-byte `q` link and wanted-link family is not touched.
    assert!(collect_prefix(&*read, b"q", false, 100).unwrap().is_empty());
    assert_eq!(all[0].0[2], 0x01);
    assert_eq!(all[1].0[2], 0x02);
    assert_eq!(all[2].0[2], 0x03);
}

#[test]
fn a_pin_is_inserted_once_per_source_and_slug_with_the_table_defaults() {
    let (s, _) = store();
    let first = pin(&s, "default", "questions/a");
    assert_eq!(first["revision"], 1);
    assert_eq!(first["answer_revision"], 0);
    assert_eq!(first["origin"], "pin");
    assert_eq!(first["refresh_attempts"], 0);
    assert_eq!(first["spend_usd"], json!(0.0));
    assert_eq!(first["answer"], Value::Null);
    assert_eq!(first["created_at"], iso(T0));
    assert_eq!(first["lease_token"], Value::Null);
    let again = PinInsert {
        question: "A different question?".into(),
        ..insert_row("default", "questions/a")
    };
    assert_eq!(s.insert_pin_row(&again).unwrap(), None);
    assert_eq!(
        row(&s, "default", "questions/a")["question"],
        "Question of questions/a?"
    );
    let other = pin(&s, "work", "questions/a");
    assert_ne!(id_of(&other), id_of(&first));
    assert_eq!(id_of(&first), 1);
    assert_eq!(id_of(&other), 2);
    assert!(
        s.read_pin_row("default", "questions/never", true)
            .unwrap()
            .is_none()
    );
    assert!(
        s.read_pin_row("de\0fault", "questions/a", false)
            .unwrap()
            .is_none()
    );
}

#[test]
fn a_nul_byte_in_a_text_is_refused_and_writes_nothing() {
    let (s, _) = store();
    let mut bad = insert_row("default", "questions/a");
    bad.question = "no\0nul".into();
    assert_eq!(s.insert_pin_row(&bad).unwrap_err().code, INVALID_ARGUMENT);
    let mut bad = insert_row("de\0fault", "questions/a");
    bad.question = "fine".into();
    assert_eq!(s.insert_pin_row(&bad).unwrap_err().code, INVALID_ARGUMENT);
    assert_eq!(s.list_pin_rows(&PinFilter::default()).unwrap(), json!([]));
    assert_eq!(
        s.insert_pin_row(&insert_row("default", "questions/a"))
            .unwrap()
            .map(|r| id_of(&r)),
        Some(1)
    );
}

#[test]
fn the_listing_filters_and_orders_by_source_bytes_then_creation_then_id() {
    let (s, clock) = store();
    let a = pin(&s, "alpha", "questions/b");
    pin(&s, "Zed", "questions/z");
    clock.0.store(T0 + 1, Ordering::SeqCst);
    pin(&s, "alpha", "questions/a");
    clock.0.store(T0 + 2, Ordering::SeqCst);
    let c = pin(&s, "beta", "questions/c");
    s.update_pin_row_state(id_of(&c), &patch(Some("inactive")))
        .unwrap();
    s.update_pin_row_state(id_of(&a), &patch(Some("archived")))
        .unwrap();
    let names = |f: PinFilter| -> Vec<String> {
        s.list_pin_rows(&f)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                format!(
                    "{}:{}",
                    r["source_id"].as_str().unwrap(),
                    r["slug"].as_str().unwrap()
                )
            })
            .collect()
    };
    let list = |sources: Option<&[&str]>, states: Option<&[&str]>, archived: bool| PinFilter {
        source_ids: sources.map(|v| v.iter().map(|x| x.to_string()).collect()),
        states: states.map(|v| v.iter().map(|x| x.to_string()).collect()),
        include_archived: archived,
    };
    // Byte order: `Zed` (0x5A) before `alpha` (0x61).
    assert_eq!(
        names(list(None, None, false)),
        ["Zed:questions/z", "alpha:questions/a", "beta:questions/c"]
    );
    assert_eq!(
        names(list(None, None, true)),
        [
            "Zed:questions/z",
            "alpha:questions/b",
            "alpha:questions/a",
            "beta:questions/c"
        ]
    );
    assert_eq!(
        names(list(Some(&["alpha"]), None, false)),
        ["alpha:questions/a"]
    );
    assert_eq!(
        names(list(None, Some(&["archived", "inactive"]), false)),
        ["alpha:questions/b", "beta:questions/c"]
    );
    // `states` beats the archived flag, and an empty list matches nothing.
    assert_eq!(
        names(list(None, Some(&["active"]), true)),
        ["Zed:questions/z", "alpha:questions/a"]
    );
    assert!(names(list(Some(&[]), None, true)).is_empty());
    assert!(names(list(None, Some(&[]), true)).is_empty());
    assert!(names(list(Some(&["nowhere"]), None, true)).is_empty());
}

#[test]
fn a_state_change_bumps_the_revision_and_archiving_drops_the_lease_and_stamps_archived_at_once() {
    let (s, clock) = store();
    let p = pin(&s, "default", "questions/s");
    let id = id_of(&p);
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
    assert_eq!(
        read_pin(&*s.read().unwrap(), id as u64)
            .unwrap()
            .unwrap()
            .lease_owner
            .as_deref(),
        Some("worker")
    );
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
    // No patch keeps the reason; an unknown id is None.
    let kept = s.update_pin_row_state(id, &patch(None)).unwrap().unwrap();
    assert_eq!(
        (kept["inactive_reason"].as_str(), kept["revision"].as_i64()),
        (Some("migrated_disabled"), Some(5))
    );
    assert!(s.update_pin_row_state(999, &patch(None)).unwrap().is_none());
    assert!(s.update_pin_row_state(-1, &patch(None)).unwrap().is_none());
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
    // One microsecond later it is expired and taken over; acquiring does not touch `updated_at`.
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
    assert_eq!(
        read_pin(&*s.read().unwrap(), id as u64)
            .unwrap()
            .unwrap()
            .updated_at_us,
        T0
    );
    // A lease with a token and no expiry is free for the lease statement.
    let mut raw = read_pin(&*s.read().unwrap(), id as u64).unwrap().unwrap();
    raw.lease_expires_at_us = None;
    s.write(|tx| put_pin(tx, &raw)).unwrap();
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
fn a_non_finite_spend_is_stored_and_read_back_as_its_postgres_text() {
    let (s, _) = store();
    let id = id_of(&pin(&s, "default", "questions/n"));
    s.add_pin_spend(id, f8(f64::INFINITY)).unwrap();
    assert_eq!(
        row(&s, "default", "questions/n")["spend_usd"],
        json!("Infinity")
    );
    s.add_pin_spend(id, f8(f64::NEG_INFINITY)).unwrap();
    assert_eq!(row(&s, "default", "questions/n")["spend_usd"], json!("NaN"));
    let parsed: Float8 = serde_json::from_value(json!("-Infinity")).unwrap();
    assert_eq!(parsed.0, f64::NEG_INFINITY);
    assert!(serde_json::from_value::<Float8>(json!("lots")).is_err());
    assert!(serde_json::from_value::<Float8>(json!(true)).is_err());
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
    let mut raw = read_pin(&*s.read().unwrap(), id as u64).unwrap().unwrap();
    raw.lease_expires_at_us = None;
    s.write(|tx| put_pin(tx, &raw)).unwrap();
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
    // Rolled back: the answer, the evidence rewrite and the counters leave no trace.
    let tx = s.begin_transaction(false).unwrap();
    assert_eq!(
        tx.lock_pin_row_for_publish(id).unwrap().unwrap(),
        json!({ "revision": 1, "lease_token": "tok", "state": "active" })
    );
    tx.publish_pin_answer(id, &answer()).unwrap();
    tx.delete_question_evidence(id).unwrap();
    tx.insert_question_evidence(&[evidence_row(id, 1, "s1", "owner")])
        .unwrap();
    assert_eq!(
        tx.list_question_evidence_join(id, 1)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
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
    assert!(
        s.list_question_evidence_join(id, 1)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    // Committed: one clock for the whole transaction, as Postgres `now()` is the transaction start.
    clock.0.store(T0 + 100, Ordering::SeqCst);
    let tx = s.begin_transaction(false).unwrap();
    clock.0.store(T0 + 200, Ordering::SeqCst);
    tx.publish_pin_answer(id, &answer()).unwrap();
    tx.delete_question_evidence(id).unwrap();
    tx.insert_question_evidence(&[
        evidence_row(id, 1, "s1", "owner"),
        evidence_row(id, 1, "s1", "page"),
    ])
    .unwrap();
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
    assert_eq!(done["watermark_at"], iso(T0 + 100));
    assert_eq!(done["spend_usd"], json!(0.125));
    let join = s.list_question_evidence_join(id, 1).unwrap();
    let kinds: Vec<&str> = join
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["owner", "page"]);
    // A second publication replaces the first one's evidence; ids keep counting.
    s.delete_question_evidence(id).unwrap();
    s.insert_question_evidence(&[evidence_row(id, 2, "s2", "fact")])
        .unwrap();
    assert!(
        s.list_question_evidence_join(id, 1)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        s.list_question_evidence_join(id, 2)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        evidence_of(&*s.read().unwrap(), id as u64).unwrap()[0].id,
        4
    );
    assert!(s.lock_pin_row_for_publish(999).unwrap().is_none());
    // The evidence of another pin is not touched by a delete.
    let other = id_of(&pin(&s, "default", "questions/q"));
    s.insert_question_evidence(&[evidence_row(other, 1, "s1", "owner")])
        .unwrap();
    s.delete_question_evidence(id).unwrap();
    assert_eq!(
        s.list_question_evidence_join(other, 1)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // Publishing an unknown pin writes nothing; evidence for a negative pin id is refused whole.
    s.publish_pin_answer(999, &answer()).unwrap();
    let refused = s.insert_question_evidence(&[
        evidence_row(other, 1, "s9", "page"),
        evidence_row(-1, 1, "s9", "page"),
    ]);
    assert_eq!(refused.unwrap_err().code, INVALID_ARGUMENT);
    assert_eq!(
        s.list_question_evidence_join(other, 1)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

fn put(s: &Store, slug: &str) -> i64 {
    let input = PageInput {
        page_type: "note".into(),
        title: slug.into(),
        compiled_truth: format!("body of {slug}"),
        ..PageInput::default()
    };
    s.put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
    read_page(&*s.read().unwrap(), "default", slug)
        .unwrap()
        .unwrap()
        .id as i64
}

#[test]
fn the_join_reads_each_cited_page_and_the_published_answers_cite_the_current_revision() {
    let (s, _) = store();
    let live = put(&s, "projects/live");
    let gone = put(&s, "projects/gone");
    s.soft_delete_page("projects/gone", None).unwrap();
    let owner_page = put(&s, "questions/j");
    let id = id_of(&pin(&s, "default", "questions/j"));
    let mut page = evidence_row(id, 1, "s1", "page");
    page.page_id = Some(live);
    page.page_generation = Some(1);
    let mut deleted = evidence_row(id, 1, "s2", "page");
    deleted.page_id = Some(gone);
    let mut missing = evidence_row(id, 1, "s2", "page");
    missing.page_id = Some(99_999);
    let mut owner = evidence_row(id, 1, "s3", "owner");
    owner.page_id = Some(owner_page);
    let mut old = evidence_row(id, 0, "s0", "page");
    old.page_id = Some(gone);
    let mut fact_without_row = evidence_row(id, 1, "s4", "fact");
    fact_without_row.item_id = Some(7);
    s.insert_question_evidence(&[page, deleted, missing, owner, old, fact_without_row])
        .unwrap();
    let join = s.list_question_evidence_join(id, 1).unwrap();
    let rows = join.as_array().unwrap();
    assert_eq!(rows.len(), 5, "the older revision stays out");
    assert_eq!(
        (
            rows[0]["p_id"].as_i64(),
            rows[0]["p_generation"].as_i64(),
            rows[0]["p_deleted"].clone()
        ),
        (Some(live), Some(1), Value::Null)
    );
    assert_eq!(rows[0]["p_source_archived"], false);
    assert_eq!(
        rows[0]["p_body_hash"],
        crate::facts::md5_hex("body of projects/live")
    );
    assert!(
        rows[0]["p_revision"]
            .as_str()
            .is_some_and(|r| !r.is_empty())
    );
    assert!(
        rows[1]["p_deleted"].is_string(),
        "a soft-deleted page still joins"
    );
    assert_eq!(rows[2]["p_id"], Value::Null);
    assert_eq!(rows[2]["p_body_hash"], Value::Null);
    assert_eq!(rows[3]["p_id"].as_i64(), Some(owner_page));
    // A fact the store does not hold: its columns are null, the two booleans false.
    assert_eq!(rows[4]["f_id"], Value::Null);
    assert_eq!(
        (
            rows[4]["f_valid_until_passed"].clone(),
            rows[4]["f_source_quarantined"].clone()
        ),
        (json!(false), json!(false))
    );
    assert_eq!(
        (rows[4]["t_id"].clone(), rows[4]["k_active"].clone()),
        (Value::Null, Value::Null)
    );
    assert!(
        s.list_question_evidence_join(-5, 1)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    // Published answers: pins of the source with an answer; the page ids of the current revision only.
    let unanswered = id_of(&pin(&s, "default", "questions/u"));
    let elsewhere = id_of(&pin(&s, "work", "questions/w"));
    assert!(
        s.list_published_question_answers("default")
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    s.publish_pin_answer(id, &answer()).unwrap();
    s.publish_pin_answer(elsewhere, &answer()).unwrap();
    let published = s.list_published_question_answers("default").unwrap();
    assert_eq!(published.as_array().unwrap().len(), 1);
    assert_eq!(published[0]["answer"], "[]");
    assert!(published[0]["published_at"].is_string());
    // The pin now reads revision 1: the three page evidence rows of revision 1 cite pages.
    assert_eq!(
        published[0]["cited"],
        json!([live, gone, 99_999, owner_page])
    );
    assert!(unanswered > 0);
    assert_eq!(
        s.list_published_question_answers("work").unwrap()[0]["cited"],
        json!([])
    );
    assert!(
        s.list_published_question_answers("nowhere")
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn the_shadow_seed_helpers_keep_ids_refuse_a_taken_slug_and_remove_their_index() {
    let (s, _) = store();
    let record = |id: u64, source: &str, slug: &str| PinRecord {
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
        cooldown_bits: Some(0.1f32.to_bits()),
        origin: "pin".into(),
        created_by: "cli".into(),
        revision: 3,
        answer_revision: 2,
        answer: None,
        answer_model: None,
        last_refresh_at_us: None,
        last_attempt_at_us: None,
        last_error: None,
        watermark_generation: None,
        watermark_fact_id: None,
        watermark_at_us: None,
        lease_token: None,
        lease_owner: None,
        lease_expires_at_us: None,
        refresh_attempts: 0,
        spend_bits: 0.0f64.to_bits(),
        created_at_us: T0,
        updated_at_us: T0,
        archived_at_us: None,
    };
    s.write(|tx| {
        assert!(seed_pin(tx, &record(41, "default", "questions/a"))?);
        assert!(!seed_pin(tx, &record(41, "default", "questions/a"))?);
        assert_eq!(
            seed_pin(tx, &record(42, "default", "questions/a"))
                .unwrap_err()
                .code,
            crate::error::CONSTRAINT_VIOLATION
        );
        Ok(())
    })
    .unwrap();
    // A REAL reads back as the shortest decimal of the f32, not the widened double.
    assert_eq!(
        row(&s, "default", "questions/a")["cooldown_days"],
        json!(0.1)
    );
    s.write(|tx| {
        assert!(remove_pin(tx, 41)?);
        assert!(!remove_pin(tx, 41)?);
        // The slug is free again.
        assert!(seed_pin(tx, &record(42, "default", "questions/a"))?);
        Ok(())
    })
    .unwrap();
    assert_eq!(id_of(&row(&s, "default", "questions/a")), 42);
    let ev = EvidenceRecord {
        id: 8,
        question_id: 42,
        answer_revision: 1,
        sentence_id: "s".into(),
        kind: "page".into(),
        source_id: "default".into(),
        page_id: None,
        page_slug: None,
        page_generation: None,
        page_revision: None,
        item_id: None,
        content_hash: None,
        created_at_us: T0,
    };
    s.write(|tx| {
        assert!(seed_evidence(tx, &ev)?);
        assert!(!seed_evidence(tx, &ev)?);
        assert!(!remove_evidence(tx, 41, 8)?, "the row is found by both ids");
        assert!(remove_evidence(tx, 42, 8)?);
        assert!(!remove_evidence(tx, 42, 8)?);
        Ok(())
    })
    .unwrap();
}
