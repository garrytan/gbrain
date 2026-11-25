//! The pinned-question reads that carry or compare `pages.generation` (`question_reads.rs`), against the store's
//! counter: the clock, the new-pages watermark, the page row, the candidate pages and the rows a publication rereads.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::{Value, json};

fn put(store: &Store, slug: &str, kind: &str, extra: Value) -> u64 {
    let mut input =
        json!({"type": kind, "title": slug, "compiled_truth": format!("body of {slug}")});
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let input: PageInput = serde_json::from_value(input).unwrap();
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap()["id"]
        .as_u64()
        .unwrap()
}

#[test]
fn the_clock_is_the_highest_generation_and_the_highest_fact_id() {
    let dir = TempDir::new("qr-clock");
    let store = open(&dir);
    assert_eq!(
        store.read_question_evidence_clock("default").unwrap(),
        json!({"generation": 0, "fact_id": 0})
    );
    put(&store, "notes/a", "note", json!({}));
    put(&store, "notes/b", "note", json!({}));
    put(
        &store,
        "notes/a",
        "note",
        json!({"compiled_truth": "edited"}),
    );
    // The edit moves a from 1 to 2; b holds 2 too.
    assert_eq!(
        store.read_question_evidence_clock("default").unwrap()["generation"],
        json!(2)
    );
    store.soft_delete_page("notes/b", None).unwrap();
    assert_eq!(
        store.read_question_evidence_clock("default").unwrap()["generation"],
        json!(3)
    );
    store.delete_page("notes/b", None).unwrap();
    assert_eq!(
        store.read_question_evidence_clock("default").unwrap()["generation"],
        json!(2)
    );
}

#[test]
fn new_pages_are_live_non_question_pages_above_the_watermark_under_the_prefix() {
    let dir = TempDir::new("qr-new-pages");
    let store = open(&dir);
    put(&store, "projects/a", "note", json!({}));
    put(&store, "projects/q", "question", json!({}));
    put(
        &store,
        "projects/pin",
        "note",
        json!({"frontmatter": {"pinned_question": true}}),
    );
    put(&store, "other/x", "note", json!({}));
    let seen = |generation: i64, prefix: Option<&str>| {
        store
            .has_new_question_pages("default", generation, prefix.map(String::from))
            .unwrap()
    };
    // a=1, q=2, pin=3, x=4.
    assert!(seen(0, None));
    assert!(seen(0, Some("projects/")));
    assert!(!seen(4, None));
    // Only the question and the pinned page sit above 1 under projects/.
    assert!(!seen(1, Some("projects/")));
    assert!(seen(1, Some("other/")));
    assert!(!seen(0, Some("nowhere/")));
    assert!(!store.has_new_question_pages("elsewhere", 0, None).unwrap());
    store.soft_delete_page("other/x", None).unwrap();
    assert!(!seen(3, None), "a soft-deleted page is not new");
}

#[test]
fn the_page_row_and_the_locked_rows_carry_the_generation() {
    let dir = TempDir::new("qr-rows");
    let store = open(&dir);
    let a = put(
        &store,
        "notes/a",
        "note",
        json!({"frontmatter": {"status": "archived"}}),
    );
    let row = store.read_question_page_row("default", "notes/a").unwrap();
    assert_eq!(row["generation"], json!(1));
    assert_eq!(row["archived"], json!(true));
    assert_eq!(row["body_storage"], json!("inline"));
    store.soft_delete_page("notes/a", None).unwrap();
    assert_eq!(
        store.read_question_page_row("default", "notes/a").unwrap(),
        Value::Null
    );
    let locked = store
        .lock_question_evidence_rows("page", &[a as i64, 999])
        .unwrap();
    let locked = locked.as_array().unwrap();
    assert_eq!(locked.len(), 1);
    assert_eq!(locked[0]["generation"], json!(2));
    assert_eq!(locked[0]["deleted"], json!(true));
    assert_eq!(locked[0]["body"].as_str().unwrap().len(), 32);
    assert!(store.lock_question_evidence_rows("nope", &[1]).is_err());
}
