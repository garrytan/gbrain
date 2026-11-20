//! `insertRetrievalEvents`, `readRetrievalEvent`, `applyRetrievalRatings` and `readFeedbackStatus`: the page filter of an
//! event, a rating that moves a weight once, the weights as `REAL`, and the status listing by byte of source and key.

mod memory_env;

use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::retrieval_feedback::{RatingBatchInput, RetrievalEventInput};
use gbrain_store::sources::SourceInput;
use memory_env::brain;
use serde_json::{Value, json};

fn put(b: &gbrain_store::Store, source: &str, slug: &str) {
    if source != "default" {
        let s: SourceInput =
            serde_json::from_value(json!({ "id": source, "name": source, "config": {} })).unwrap();
        b.upsert_source(&s).unwrap();
    }
    let input: PageInput = serde_json::from_value(
        json!({ "type": "note", "title": slug, "compiled_truth": format!("{slug} body") }),
    )
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({ "sourceId": source })).unwrap();
    b.put_page(slug, &input, &options).unwrap();
}

fn events(v: Value) -> Vec<RetrievalEventInput> {
    serde_json::from_value(v).unwrap()
}

fn batch(event: &str, rating: i32, targets: &[(&str, &str)]) -> RatingBatchInput {
    let targets: Vec<Value> = targets
        .iter()
        .map(|(s, k)| json!({ "kind": "page", "source_id": s, "key": k, "rating": rating, "content_hash": null }))
        .collect();
    serde_json::from_value(json!({
        "eventId": event, "clientId": "local", "signal": "explicit", "alpha": 0.6, "targets": targets,
    }))
    .unwrap()
}

#[test]
fn an_event_keeps_the_pages_and_links_whose_pages_exist() {
    let b = brain("retrieval-feedback-event");
    put(&b, "default", "a");
    put(&b, "default", "b");
    b.insert_retrieval_events(&events(json!([{
        "id": "e1", "client_id": "c", "op": "query",
        "pages": [
            { "source_id": "default", "slug": "b", "content_hash": "h", "rank": 2, "cited": true },
            { "source_id": "default", "slug": "a", "content_hash": null, "rank": 1, "cited": false },
            { "source_id": "default", "slug": "gone", "content_hash": null, "rank": 3, "cited": false },
        ],
        "links": [
            { "source_id": "default", "edge_key": "a|links|b", "to_slug": "b" },
            { "source_id": "default", "edge_key": "a|links|gone", "to_slug": "b" },
            { "source_id": "default", "edge_key": "a|links|b", "to_slug": "gone" },
        ],
    }])))
    .unwrap();
    let event = b.read_retrieval_event("e1").unwrap().unwrap();
    let slugs: Vec<&str> = event["pages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["slug"].as_str().unwrap())
        .collect();
    assert_eq!(slugs, ["a", "b"]);
    assert_eq!(
        event["links"],
        json!([{ "source_id": "default", "edge_key": "a|links|b", "to_slug": "b" }])
    );
    assert_eq!(event["op"], "query");
    assert!(b.read_retrieval_event("none").unwrap().is_none());
    // A repeated id keeps the first row.
    b.insert_retrieval_events(&events(
        json!([{ "id": "e1", "client_id": "other", "op": "think" }]),
    ))
    .unwrap();
    assert_eq!(
        b.read_retrieval_event("e1").unwrap().unwrap()["client_id"],
        "c"
    );
}

#[test]
fn an_event_with_an_unknown_op_is_refused() {
    let b = brain("retrieval-feedback-op");
    let err = b
        .insert_retrieval_events(&events(
            json!([{ "id": "e1", "client_id": "c", "op": "other" }]),
        ))
        .unwrap_err();
    assert_eq!(err.code, "constraint_violation");
}

#[test]
fn a_rating_moves_a_weight_once_and_reads_back_as_real() {
    let b = brain("retrieval-feedback-rating");
    put(&b, "default", "a");
    b.insert_retrieval_events(&events(
        json!([{ "id": "e1", "client_id": "c", "op": "query" }]),
    ))
    .unwrap();
    let first = b
        .apply_retrieval_ratings(&batch("e1", 1, &[("default", "a"), ("default", "gone")]))
        .unwrap();
    assert_eq!(first.as_array().unwrap().len(), 1);
    assert_eq!(first[0]["weight_before"], 0.5);
    // REAL arithmetic: 0.5 + 0.6 * (0 - 0.5) is 0.19999999 in Postgres too.
    assert_eq!(first[0]["weight_after"], 0.19999999);
    assert_eq!(first[0]["newly_applied"], true);
    let again = b
        .apply_retrieval_ratings(&batch("e1", 5, &[("default", "a")]))
        .unwrap();
    assert_eq!(again[0]["rating"], 1);
    assert_eq!(again[0]["weight_after"], 0.19999999);
    assert_eq!(again[0]["newly_applied"], false);
    b.insert_retrieval_events(&events(
        json!([{ "id": "e2", "client_id": "c", "op": "query" }]),
    ))
    .unwrap();
    let second = b
        .apply_retrieval_ratings(&batch("e2", 5, &[("default", "a")]))
        .unwrap();
    assert_eq!(second[0]["weight_before"], 0.19999999);
    assert_eq!(second[0]["newly_applied"], true);
    let weight = second[0]["weight_after"].as_f64().unwrap();
    assert!((weight - 0.68).abs() < 1e-6, "{weight}");
}

#[test]
fn a_rating_of_a_missing_event_or_out_of_range_is_refused() {
    let b = brain("retrieval-feedback-refused");
    put(&b, "default", "a");
    let err = b
        .apply_retrieval_ratings(&batch("none", 3, &[("default", "a")]))
        .unwrap_err();
    assert_eq!(err.code, "constraint_violation");
    b.insert_retrieval_events(&events(
        json!([{ "id": "e1", "client_id": "c", "op": "query" }]),
    ))
    .unwrap();
    let err = b
        .apply_retrieval_ratings(&batch("e1", 6, &[("default", "a")]))
        .unwrap_err();
    assert_eq!(err.code, "constraint_violation");
}

#[test]
fn the_status_lists_the_weights_by_byte_of_source_and_key() {
    let b = brain("retrieval-feedback-status");
    for source in ["ab", "a0", "a-z"] {
        for key in ["k1", "k-1"] {
            put(&b, source, key);
        }
    }
    b.insert_retrieval_events(&events(
        json!([{ "id": "e1", "client_id": "c", "op": "query" }]),
    ))
    .unwrap();
    let all: Vec<(&str, &str)> = ["ab", "a0", "a-z"]
        .iter()
        .flat_map(|s| ["k1", "k-1"].map(|k| (*s, k)))
        .collect();
    b.apply_retrieval_ratings(&batch("e1", 1, &all)).unwrap();
    let status = b.read_feedback_status().unwrap();
    let listed: Vec<(&str, &str)> = status["lowest"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["source_id"].as_str().unwrap(),
                r["slug"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        listed,
        [
            ("a-z", "k-1"),
            ("a-z", "k1"),
            ("a0", "k-1"),
            ("a0", "k1"),
            ("ab", "k-1"),
            ("ab", "k1")
        ]
    );
    assert_eq!(status["lowest"][0]["low_ratings"], 1);
    assert_eq!(status["highest"], json!([]));
    assert_eq!(status["counts"]["events"], 1);
    assert_eq!(status["counts"]["ratings_explicit"], 6);
    assert_eq!(status["counts"]["weights_total"], 6);
    assert_eq!(status["counts"]["weights_off_neutral"], 6);
    assert_eq!(status["counts"]["top_client_share_7d"], 1.0);
    assert!(status["counts"]["last_rating_at"].is_string());
}
