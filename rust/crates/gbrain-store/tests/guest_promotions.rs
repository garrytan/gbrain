//! The owner's promotions of guest notes (`guest_promotions`) and the reads a remote delete and the guest stamp make,
//! matched to the SQL statements in `src/core/engine-sql/guest-notes.ts`.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::guest_marks::GuestMarkInsert;
use gbrain_store::guest_promotions::{GuestPromotionLink, GuestRefPagesQuery};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn put(store: &Store, source: &str, slug: &str) -> u64 {
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "body"}))
            .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
    store.read_page_id_in_source(slug, source).unwrap().unwrap()
}

fn link(page: u64, slug: &str, by: &str) -> GuestPromotionLink {
    serde_json::from_value(
        json!({"guestPageId": page, "targetSource": "default", "targetSlug": slug,
        "byKind": "cli", "byId": by, "requestId": null}),
    )
    .unwrap()
}

fn guests(dir: &TempDir) -> Store {
    let store = open(dir);
    store
        .upsert_source(&SourceInput {
            id: "guests".into(),
            ..Default::default()
        })
        .unwrap();
    store
}

#[test]
fn a_link_counts_as_kept_only_while_its_target_page_exists_and_a_relink_keeps_one_row() {
    let dir = TempDir::new("gp-link");
    let store = guests(&dir);
    let note = put(&store, "guests", "notes/a");
    assert!(
        !store
            .read_guest_promotion_kept(note, "default", "notes/a")
            .unwrap()
    );
    store
        .link_guest_promotion(&link(note, "notes/a", "one"))
        .unwrap();
    // No target page yet: the link exists but does not count.
    assert!(
        !store
            .read_guest_promotion_kept(note, "default", "notes/a")
            .unwrap()
    );
    put(&store, "default", "notes/a");
    assert!(
        store
            .read_guest_promotion_kept(note, "default", "notes/a")
            .unwrap()
    );
    store
        .link_guest_promotion(&link(note, "notes/a", "two"))
        .unwrap();
    let marks = store.read_guest_marks(&[note]).unwrap();
    assert!(marks.is_empty(), "no mark was written");
    // A guest page that does not exist is the foreign key's error.
    let err = store
        .link_guest_promotion(&link(999, "notes/a", "one"))
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    let err = store
        .link_guest_promotion(&link(note, "notes/\0a", "one"))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

#[test]
fn the_delete_check_reads_the_guest_record_the_promotion_and_the_writer() {
    let dir = TempDir::new("gp-delete");
    let store = guests(&dir);
    assert_eq!(
        store.read_guest_delete_check("guests", "notes/a").unwrap(),
        Value::Null
    );
    let note = put(&store, "guests", "notes/a");
    assert_eq!(
        store.read_guest_delete_check("guests", "notes/a").unwrap(),
        json!({"hidden": false, "guest": false, "kept": false, "writer": null})
    );
    store
        .upsert_guest_source("guests", &["w".into()], "external_untrusted")
        .unwrap();
    let mark: GuestMarkInsert = serde_json::from_value(json!({
        "sourceId": "guests", "slug": "notes/a", "audienceMember": "a", "groupSlug": "g", "senderLabel": "s",
        "writerKind": "oauth_client", "writerId": "broker-a", "requestId": "r"}))
    .unwrap();
    store.insert_guest_mark(&mark).unwrap();
    store
        .link_guest_promotion(&link(note, "notes/a", "one"))
        .unwrap();
    assert_eq!(
        store.read_guest_delete_check("guests", "notes/a").unwrap(),
        json!({"hidden": false, "guest": true, "kept": true, "writer": "oauth_client:broker-a"})
    );
    assert_eq!(
        store.read_guest_marks(&[note]).unwrap()[0]["promoted"],
        json!(true)
    );
}

#[test]
fn a_hard_delete_of_the_guest_page_drops_its_promotions_and_the_ref_read_finds_pages_by_id_and_key()
{
    let dir = TempDir::new("gp-cascade");
    let store = guests(&dir);
    let a = put(&store, "guests", "notes/a");
    let b = put(&store, "guests", "notes/b");
    put(&store, "default", "notes/a");
    store
        .link_guest_promotion(&link(a, "notes/a", "one"))
        .unwrap();
    store.soft_delete_page("notes/b", Some("guests")).unwrap();
    let query: GuestRefPagesQuery = serde_json::from_value(json!({
        "ids": [b, 4242], "keys": [{"source_id": "guests", "slug": "notes/a"}, {"source_id": "guests", "slug": "notes/b"}]}))
    .unwrap();
    let rows = store.read_guest_ref_pages(&query).unwrap();
    let ids: Vec<u64> = rows.iter().map(|r| r["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, vec![a, b]);
    assert_eq!(rows[0]["slug"], json!("notes/a"));
    assert_eq!(rows[0]["type"], json!("note"));
    store.delete_page("notes/a", Some("guests")).unwrap();
    assert!(
        !store
            .read_guest_promotion_kept(a, "default", "notes/a")
            .unwrap()
    );
}
