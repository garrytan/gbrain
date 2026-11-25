//! Read-back tests of the pinned-question relations: each reads the rows back through the family's own public reads,
//! and checks a retry, the unique `(source_id, slug)` index, the defaults of a NULL and the next id the family's own
//! writer takes.

use crate::seed::{ImportResult, SeedRow};
use crate::test_support::store;
use crate::{Store, keys};
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

fn counter(s: &Store, name: &str) -> u64 {
    keys::be8(&s.read().unwrap().get(&keys::meta(name)).unwrap().unwrap()).unwrap()
}

fn pin(id: &str, source: &str, slug: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("source_id", source),
        ("slug", slug),
        ("question", "Who leads acme-example?"),
        ("created_by", "cli"),
        ("created_at", "2026-03-01 00:00:00.25+00"),
    ])
}

#[test]
fn pins_keep_their_ids_columns_and_the_defaults_of_a_null() {
    let s = store();
    let mut full = pin("31", "default", "questions/a");
    full.insert("scope_slug_prefix".into(), Some("projects/".into()));
    full.insert("state".into(), Some("inactive".into()));
    full.insert("inactive_reason".into(), Some("awaiting_consent".into()));
    full.insert("publish_mode".into(), Some("draft".into()));
    full.insert("cooldown_days".into(), Some("0.1".into()));
    full.insert("revision".into(), Some("4".into()));
    full.insert("answer_revision".into(), Some("2".into()));
    full.insert("answer".into(), Some(r#"[{"id":"s1"}]"#.into()));
    full.insert(
        "last_refresh_at".into(),
        Some("2026-03-02 00:00:00+00".into()),
    );
    full.insert("watermark_generation".into(), Some("9".into()));
    full.insert("lease_token".into(), Some("tok".into()));
    full.insert(
        "lease_expires_at".into(),
        Some("2026-03-03 00:00:00+00".into()),
    );
    full.insert("refresh_attempts".into(), Some("3".into()));
    full.insert("spend_usd".into(), Some("0.375".into()));
    full.insert("archived_at".into(), Some("2026-03-04 00:00:00+00".into()));
    let r = import(
        &s,
        "pinned_questions",
        vec![full, pin("32", "work", "questions/a")],
    );
    assert_eq!((r.imported, r.skipped, r.dropped), (2, 0, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    let a = s
        .read_pin_row("default", "questions/a", false)
        .unwrap()
        .unwrap();
    assert_eq!(a["id"], 31);
    assert_eq!(a["state"], "inactive");
    assert_eq!(a["publish_mode"], "draft");
    assert_eq!(a["cooldown_days"], json!(0.1));
    assert_eq!(
        (
            a["revision"].clone(),
            a["answer_revision"].clone(),
            a["refresh_attempts"].clone()
        ),
        (json!(4), json!(2), json!(3))
    );
    assert_eq!(a["spend_usd"], json!(0.375));
    assert_eq!(a["last_refresh_at"], "2026-03-02T00:00:00.000000Z");
    assert_eq!(a["created_at"], "2026-03-01T00:00:00.250000Z");
    assert_eq!(a["lease_token"], "tok");
    assert_eq!(a["archived_at"], "2026-03-04T00:00:00.000000Z");
    let w = s
        .read_pin_row("work", "questions/a", false)
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            w["state"].as_str(),
            w["publish_mode"].as_str(),
            w["origin"].as_str(),
            w["revision"].clone(),
            w["spend_usd"].clone()
        ),
        (
            Some("active"),
            Some("publish"),
            Some("pin"),
            json!(1),
            json!(0.0)
        )
    );
    assert_eq!(w["cooldown_days"], Value::Null);
    // A retried batch skips the rows it stored; the family's writer takes the next id.
    let again = import(
        &s,
        "pinned_questions",
        vec![pin("31", "default", "questions/a")],
    );
    assert_eq!((again.imported, again.skipped), (0, 1));
    assert_eq!(counter(&s, crate::questions::NEXT_PIN_ID), 33);
    let next = s
        .insert_pin_row(&crate::questions::PinInsert {
            source_id: "default".into(),
            slug: "questions/b".into(),
            question: "Q?".into(),
            scope_slug_prefix: None,
            scope_entity: None,
            state: "active".into(),
            inactive_reason: None,
            publish_mode: "publish".into(),
            created_by: "cli".into(),
        })
        .unwrap()
        .unwrap();
    assert_eq!(next["id"], 33);
}

#[test]
fn a_second_pin_on_a_taken_slug_is_the_unique_index_error_and_a_missing_column_names_itself() {
    let s = store();
    import(
        &s,
        "pinned_questions",
        vec![pin("31", "default", "questions/a")],
    );
    let err = s
        .import_relation(
            SEED,
            "pinned_questions",
            vec![pin("32", "default", "questions/a")],
        )
        .unwrap_err();
    assert_eq!(err.code, crate::error::CONSTRAINT_VIOLATION);
    assert!(
        err.message.contains("pinned_questions_source_slug_key"),
        "{}",
        err.message
    );
    let mut nameless = pin("33", "default", "questions/c");
    nameless.remove("question");
    let err = s
        .import_relation(SEED, "pinned_questions", vec![nameless])
        .unwrap_err();
    assert!(err.message.contains("question"), "{}", err.message);
}

#[test]
fn evidence_keeps_its_ids_under_its_pin_and_raises_its_own_counter() {
    let s = store();
    import(
        &s,
        "pinned_questions",
        vec![pin("31", "default", "questions/a")],
    );
    let evidence = |id: &str, revision: &str| {
        row(&[
            ("id", id),
            ("question_id", "31"),
            ("answer_revision", revision),
            ("sentence_id", "s1"),
            ("kind", "fact"),
            ("source_id", "default"),
            ("item_id", "12"),
            ("content_hash", "abc"),
            ("created_at", "2026-03-02 00:00:00+00"),
        ])
    };
    let r = import(
        &s,
        "question_evidence",
        vec![evidence("41", "1"), evidence("42", "2")],
    );
    assert_eq!((r.imported, r.skipped), (2, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    let rows = crate::questions::evidence_of(&*s.read().unwrap(), 31).unwrap();
    assert_eq!(
        rows.iter()
            .map(|e| (e.id, e.answer_revision))
            .collect::<Vec<_>>(),
        [(41, 1), (42, 2)]
    );
    assert_eq!(
        (rows[0].item_id, rows[0].content_hash.as_deref()),
        (Some(12), Some("abc"))
    );
    assert_eq!(
        import(&s, "question_evidence", vec![evidence("41", "1")]).skipped,
        1
    );
    assert_eq!(counter(&s, crate::questions::NEXT_EVIDENCE_ID), 43);
    s.insert_question_evidence(&[crate::questions::EvidenceInsert {
        question_id: 31,
        answer_revision: 3,
        sentence_id: "s".into(),
        kind: "page".into(),
        source_id: "default".into(),
        page_id: None,
        page_slug: None,
        page_generation: None,
        page_revision: None,
        item_id: None,
        content_hash: None,
    }])
    .unwrap();
    assert_eq!(
        crate::questions::evidence_of(&*s.read().unwrap(), 31)
            .unwrap()
            .last()
            .unwrap()
            .id,
        43
    );
}
