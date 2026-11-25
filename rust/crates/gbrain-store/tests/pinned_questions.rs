//! `insertPinnedQuestion`, `readPinnedQuestion` and `listPinnedQuestions`: an idempotent pin and a listing by byte of source id.

mod memory_env;

use gbrain_store::jobs::{PinFilter, PinInsert};
use memory_env::brain;
use serde_json::{Value, json};

fn pin(source: &str, slug: &str, state: &str) -> PinInsert {
    serde_json::from_value(json!({
        "sourceId": source, "slug": slug, "question": format!("q {slug}?"), "scopeSlugPrefix": null,
        "scopeEntity": null, "state": state, "inactiveReason": null, "publishMode": "publish", "createdBy": "test",
    }))
    .unwrap()
}

fn sources(listed: &Value) -> Vec<&str> {
    listed
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["source_id"].as_str().unwrap())
        .collect()
}

#[test]
fn a_pin_is_added_once_and_read_back_with_the_table_defaults() {
    let b = brain("pinned-questions-insert");
    let row = b
        .insert_pinned_question(&pin("default", "pin", "active"))
        .unwrap()
        .unwrap();
    assert_eq!(row["id"], 1);
    assert_eq!(row["origin"], "pin");
    assert_eq!(row["revision"], 1);
    assert_eq!(row["answer_revision"], 0);
    assert_eq!(row["refresh_attempts"], 0);
    assert_eq!(row["spend_usd"], 0.0);
    assert_eq!(row["answer"], Value::Null);
    assert!(row["created_at"].is_string());
    // The second insert of the same (source_id, slug) does nothing and returns no row.
    assert!(
        b.insert_pinned_question(&pin("default", "pin", "inactive"))
            .unwrap()
            .is_none()
    );
    assert_eq!(b.read_pinned_question("default", "pin").unwrap(), Some(row));
    assert_eq!(b.read_pinned_question("default", "other").unwrap(), None);
    let next = b
        .insert_pinned_question(&pin("default", "second", "active"))
        .unwrap()
        .unwrap();
    assert_eq!(next["id"], 2);
}

#[test]
fn a_pin_without_a_required_column_is_refused() {
    let b = brain("pinned-questions-null");
    let mut row = pin("default", "pin", "active");
    row.question = None;
    let err = b.insert_pinned_question(&row).unwrap_err();
    assert!(err.message.contains("\"question\""), "{}", err.message);
}

#[test]
fn pins_list_by_byte_of_source_id_and_filter_by_source_and_state() {
    let b = brain("pinned-questions-list");
    // en_US puts `ab` before `a-z`; bytes put `a-z` (0x2D) first, `a/z` (0x2F) next, then `ab`.
    for (source, state) in [
        ("ab", "active"),
        ("a0", "active"),
        ("a-z", "inactive"),
        ("a/z", "archived"),
    ] {
        b.insert_pinned_question(&pin(source, "pin", state))
            .unwrap()
            .unwrap();
    }
    b.insert_pinned_question(&pin("ab", "later", "active"))
        .unwrap()
        .unwrap();
    let all = b.list_pinned_questions(&PinFilter::default()).unwrap();
    // The archived pin is left out unless asked for; a tie on the source breaks by creation time, then id.
    assert_eq!(sources(&all), ["a-z", "a0", "ab", "ab"]);
    assert_eq!(all[2]["slug"], "pin");
    assert_eq!(all[3]["slug"], "later");
    let with_archived = b
        .list_pinned_questions(&PinFilter {
            include_archived: true,
            ..PinFilter::default()
        })
        .unwrap();
    assert_eq!(sources(&with_archived), ["a-z", "a/z", "a0", "ab", "ab"]);
    let states = b
        .list_pinned_questions(&PinFilter {
            states: Some(vec!["archived".to_string()]),
            ..PinFilter::default()
        })
        .unwrap();
    assert_eq!(sources(&states), ["a/z"]);
    let by_source = b
        .list_pinned_questions(&PinFilter {
            source_ids: Some(vec!["ab".to_string(), "a-z".to_string()]),
            ..PinFilter::default()
        })
        .unwrap();
    assert_eq!(sources(&by_source), ["a-z", "ab", "ab"]);
}
