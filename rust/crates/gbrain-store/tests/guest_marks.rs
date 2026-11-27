//! The guest marks of guest notes (`guest_marks`), matched to the SQL statements in
//! `src/core/engine-sql/guest-notes.ts`.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::guest_marks::GuestMarkInsert;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::{Value, json};

fn put(store: &Store, slug: &str) -> u64 {
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "body"}))
            .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
    store
        .read_page_id_in_source(slug, "default")
        .unwrap()
        .unwrap()
}

fn mark(slug: &str, sender: &str) -> GuestMarkInsert {
    serde_json::from_value(json!({
        "sourceId": "default", "slug": slug, "audienceMember": "alice-example", "groupSlug": "team-a",
        "senderLabel": sender, "writerKind": "oauth_client", "writerId": "broker-a",
        "requestId": "00000000-0000-4000-8000-000000000001",
    }))
    .unwrap()
}

fn marks(store: &Store, ids: &[u64]) -> Vec<Value> {
    store.read_guest_marks(ids).unwrap()
}

#[test]
fn a_mark_is_written_once_per_page_and_reads_back_with_promoted_false() {
    let dir = TempDir::new("gm-write");
    let store = open(&dir);
    let a = put(&store, "notes/a");
    let b = put(&store, "notes/b");
    assert_eq!(
        store
            .insert_guest_mark(&mark("notes/a", "Agent One"))
            .unwrap(),
        1
    );
    // No page at the slug: no row, as the INSERT ... SELECT selects none.
    assert_eq!(
        store
            .insert_guest_mark(&mark("notes/none", "Agent One"))
            .unwrap(),
        0
    );
    // A second mark of one page is the primary key's error and changes nothing.
    let dup = store
        .insert_guest_mark(&mark("notes/a", "Agent Two"))
        .unwrap_err();
    assert_eq!(dup.code, CONSTRAINT_VIOLATION);
    assert!(dup.message.contains("guest_marks_pkey"), "{}", dup.message);
    let read = marks(&store, &[b, a, a, 999]);
    assert_eq!(read.len(), 1);
    let row = &read[0];
    assert_eq!(row["page_id"], json!(a));
    assert_eq!(row["sender_label"], json!("Agent One"));
    assert_eq!(row["group_slug"], json!("team-a"));
    assert_eq!(row["audience_member"], json!("alice-example"));
    assert_eq!(row["writer_kind"], json!("oauth_client"));
    assert_eq!(row["writer_id"], json!("broker-a"));
    assert_eq!(row["promoted"], json!(false));
    assert!(
        row["saved_at"].as_str().is_some_and(|t| t.ends_with('Z')),
        "{row}"
    );
    assert!(marks(&store, &[]).is_empty());
}

#[test]
fn a_soft_deleted_page_takes_a_mark_and_keeps_it_and_a_hard_delete_drops_it() {
    let dir = TempDir::new("gm-delete");
    let store = open(&dir);
    let soft = put(&store, "notes/soft");
    let hard = put(&store, "notes/hard");
    store
        .soft_delete_page("notes/soft", Some("default"))
        .unwrap();
    // The statement joins pages with no deleted_at filter.
    assert_eq!(
        store
            .insert_guest_mark(&mark("notes/soft", "Agent One"))
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .insert_guest_mark(&mark("notes/hard", "Agent One"))
            .unwrap(),
        1
    );
    store.delete_page("notes/hard", Some("default")).unwrap();
    let read = marks(&store, &[soft, hard]);
    assert_eq!(read.len(), 1);
    assert_eq!(read[0]["page_id"], json!(soft));
}

#[test]
fn text_with_a_nul_byte_is_refused() {
    let dir = TempDir::new("gm-nul");
    let store = open(&dir);
    put(&store, "notes/a");
    let err = store
        .insert_guest_mark(&mark("notes/a", "Agent\0One"))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    assert_eq!(
        store
            .insert_guest_mark(&mark("notes/a", "Agent One"))
            .unwrap(),
        1
    );
}
