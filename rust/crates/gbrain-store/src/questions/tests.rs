//! Unit tests of the evidence side of the pinned-question family: the key layout (evidence under `~q 0x03`; the pin rows
//! are main's, `jobs/pinned_questions.rs`, with their own tests), the publication's evidence rewrite inside a transaction
//! (and its rollback), and the two joined reads over main's pin records and pages.

use super::*;
use crate::env::{Env, iso};
use crate::error::INVALID_ARGUMENT;
use crate::jobs::PinInsert;
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
fn evidence_sits_under_the_two_byte_family_tag_and_the_pin_sub_tags_stay_unused() {
    let tag = QUESTIONS;
    assert_eq!(tag, [b'~', b'q']);
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
    // The pin is main's (`m 0x2F`, `m 0x30`): the family holds the evidence row and nothing else.
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].0[2], 0x03);
    assert!(all[0].0.starts_with(&evidence_prefix(id_of(&a) as u64)));
    // Nothing leaks outside the family: the one-byte `q` link and wanted-link family is not touched.
    assert!(collect_prefix(&*read, b"q", false, 100).unwrap().is_empty());
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
