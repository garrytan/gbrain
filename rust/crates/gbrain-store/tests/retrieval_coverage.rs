//! `countPendingProjectionPages` at its cap (link_queries::retrieval_coverage). Each count is
//! min(every match in scope, 1000), as src/core/engine-sql/retrieval-coverage.ts counts on PGLite
//! and Postgres, so the answer does not depend on the order pages were written in, and a walk past
//! its time limit gives no count.

mod memory_env;

use gbrain_store::link_queries::PendingCountInput;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::{Value, json};

fn de<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// An unsealed note: its text projection waits, so it counts as pending.
fn note(brain: &memory_env::Brain, slug: &str, title: &str) {
    let input: PageInput = de(json!({
        "type": "note", "title": title, "compiled_truth": format!("{title} body"),
    }));
    let options: PutPageOptions = de(json!({"sourceId": "default", "index": false}));
    brain.put_page(slug, &input, &options).unwrap();
}

fn widget_count(timeout_ms: Option<u64>) -> Value {
    json!({
        "scope": {},
        "relevance": {"all": false, "types": ["company"], "terms": ["widget"], "pageIds": [], "imageArm": false},
        "timeoutMs": timeout_ms,
    })
}

fn count(brain: &memory_env::Brain, input: Value) -> Value {
    let input: PendingCountInput = de(input);
    serde_json::to_value(brain.count_pending_projection_pages(&input).unwrap()).unwrap()
}

#[test]
fn a_capped_count_counts_every_match_in_scope() {
    let brain = memory_env::brain("coverage-capped");
    note(&brain, "zeta/widget-3", "Widget 3");
    note(&brain, "zeta/widget-4", "Widget 4");
    for i in 0..1000 {
        note(&brain, &format!("mid/other-{i:04}"), "Other");
    }
    for i in 0..3 {
        note(&brain, &format!("alpha/widget-{i}"), &format!("Widget {i}"));
    }
    let expected =
        json!({"total": 1000, "could_affect": 5, "capped": true, "could_affect_images": 0});
    assert_eq!(count(&brain, widget_count(Some(2000))), expected);
    assert_eq!(count(&brain, widget_count(None)), expected);
}

#[test]
fn more_matches_than_the_cap_stop_could_affect_at_the_cap() {
    let brain = memory_env::brain("coverage-many");
    for i in 0..1003 {
        note(
            &brain,
            &format!("notes/widget-{i:04}"),
            &format!("Widget {i}"),
        );
    }
    assert_eq!(
        count(&brain, widget_count(Some(2000))),
        json!({"total": 1000, "could_affect": 1000, "capped": true, "could_affect_images": 0})
    );
}

#[test]
fn a_walk_past_its_time_limit_gives_no_count() {
    let brain = memory_env::brain("coverage-timeout");
    note(&brain, "notes/widget-a", "Widget a");
    // The test clock stands still, so a limit of 0 has passed at the first page and any other never does.
    assert_eq!(count(&brain, widget_count(Some(0))), Value::Null);
    assert_eq!(
        count(&brain, widget_count(Some(1))),
        json!({"total": 1, "could_affect": 1, "capped": false, "could_affect_images": 0})
    );
}
