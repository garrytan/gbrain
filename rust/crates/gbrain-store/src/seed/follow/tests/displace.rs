//! Tests of the rows a follow call displaces to take a natural key: what the displacement takes
//! with it, and that it never removes a row newer than the call.

use super::*;
use crate::seed::FollowResult;

const ALICE: &str = "people/alice-example";
const MOVED: &str = "companies/acme-moved";

/// The sort key byte of page `id`: `linked_pages` sorts page 7 first and page 9 second.
fn sort_of(id: u8) -> u8 {
    match id {
        7 => 1,
        9 => 2,
        _ => 3,
    }
}

/// Page `id` at `slug` as one call's upsert.
fn put_page(s: &Store, generation: u64, id: u8, slug: &str) -> FollowResult {
    s.replace_relation_rows(
        SEED,
        "pages",
        generation,
        &[key(sort_of(id), &[("id", &id.to_string())])],
        &[page_row(&id.to_string(), slug)],
        &[digv(sort_of(id), 40 + id)],
    )
    .unwrap()
}

/// Page `id` at `slug` as an interval reconcile of its sort key alone.
fn put_page_interval(s: &Store, generation: u64, id: u8, slug: &str) -> FollowResult {
    s.replace_interval(
        SEED,
        "pages",
        generation,
        Some(&hex(&[sort_of(id)])),
        Some(&hex(&[sort_of(id) + 1])),
        &[page_row(&id.to_string(), slug)],
        &[digv(sort_of(id), 40 + id)],
    )
    .unwrap()
}

fn page_id(s: &Store, slug: &str) -> Option<u64> {
    read_page(s, slug).map(|p| p["page"]["id"].as_u64().unwrap())
}

fn tags_of(s: &Store, slug: &str) -> Vec<String> {
    s.get_tags(slug, &ReadScope::default()).unwrap()
}

#[test]
fn a_displaced_page_gets_its_tags_back_when_a_reconcile_restores_it() {
    let s = linked_pages();
    assert_eq!(tags_of(&s, ALICE), ["yc"]);
    let reference = digest_of(&s, "tags");
    // Page 9 takes page 7's slug: page 7 is displaced, and its tags with it.
    let r = put_page(&s, 1, 9, ALICE);
    assert_eq!((r.upserted, r.displaced), (1, 1));
    assert_eq!(entries(&s, "pages"), 1);
    // The tags entry went with the page, so a reconcile can see the tag is missing.
    assert_eq!(entries(&s, "tags"), 0);
    // A later call stores page 7 again, at a slug of its own: a new page, with no tags.
    let r = put_page(&s, 2, 7, "people/alice-moved");
    assert_eq!((r.upserted, r.displaced), (1, 0));
    assert!(tags_of(&s, "people/alice-moved").is_empty());
    // The reconcile of the tags restores them.
    let tag = row(&[("page_id", "7"), ("tag", "yc")]);
    let r = s
        .replace_interval(SEED, "tags", 3, None, None, &[tag], &[dig(1)])
        .unwrap();
    assert_eq!(r.upserted, 1);
    assert_eq!(tags_of(&s, "people/alice-moved"), ["yc"]);
    assert_eq!(digest_of(&s, "tags"), reference);
}

#[test]
fn displacing_a_page_leaves_the_entries_of_rows_that_stay() {
    let s = linked_pages();
    put_page(&s, 1, 9, ALICE);
    // Chunks and links of page 7 are rows of their own, and stay.
    assert_eq!(entries(&s, "content_chunks"), 2);
    assert_eq!(entries(&s, "links"), 1);
}

#[test]
fn an_older_call_does_not_displace_a_newer_row_and_leaves_the_old_version() {
    let s = linked_pages();
    // A newer call moved page 9 to a slug of its own.
    assert_eq!(put_page(&s, 9, 9, MOVED).upserted, 1);
    let before = snapshot(&s);
    // An older call moves page 7 onto that slug.
    let r = put_page(&s, 5, 7, MOVED);
    assert_eq!((r.upserted, r.displaced, r.skipped_older), (0, 0, 1));
    assert_eq!(page_id(&s, MOVED), Some(9));
    assert_eq!(page_id(&s, ALICE), Some(7));
    assert_eq!(tags_of(&s, ALICE), ["yc"]);
    assert_eq!(entries(&s, "pages"), 2);
    // Nothing changed: not the holder, not the old version, not their entries.
    assert_eq!(snapshot(&s), before);
}

#[test]
fn a_newer_call_displaces_an_older_row() {
    let s = linked_pages();
    assert_eq!(put_page(&s, 5, 9, MOVED).upserted, 1);
    let r = put_page(&s, 9, 7, MOVED);
    assert_eq!((r.upserted, r.displaced, r.skipped_older), (1, 1, 0));
    assert_eq!(page_id(&s, MOVED), Some(7));
    assert!(read_page(&s, ALICE).is_none());
    assert_eq!(entries(&s, "pages"), 1);
}

#[test]
fn an_older_interval_does_not_displace_a_row_a_newer_interval_stored() {
    let s = linked_pages();
    assert_eq!(put_page_interval(&s, 9, 9, MOVED).upserted, 1);
    let before = snapshot(&s);
    let r = put_page_interval(&s, 5, 7, MOVED);
    assert_eq!((r.upserted, r.displaced, r.skipped_older), (0, 0, 1));
    assert_eq!(page_id(&s, MOVED), Some(9));
    assert_eq!(page_id(&s, ALICE), Some(7));
    assert_eq!(snapshot(&s), before);
}

#[test]
fn a_newer_interval_displaces_a_row_an_older_interval_stored() {
    let s = linked_pages();
    assert_eq!(put_page_interval(&s, 5, 9, MOVED).upserted, 1);
    let r = put_page_interval(&s, 9, 7, MOVED);
    assert_eq!((r.upserted, r.displaced, r.skipped_older), (1, 1, 0));
    assert_eq!(page_id(&s, MOVED), Some(7));
    assert!(read_page(&s, ALICE).is_none());
}

#[test]
fn a_new_row_older_than_the_row_holding_its_key_is_skipped() {
    let s = linked_pages();
    assert_eq!(put_page(&s, 9, 9, MOVED).upserted, 1);
    // Page 11 has no entry yet: nothing of it is released, and it must not take the slug.
    let before = snapshot(&s);
    let r = put_page(&s, 5, 11, MOVED);
    assert_eq!((r.upserted, r.displaced, r.skipped_older), (0, 0, 1));
    assert_eq!(page_id(&s, MOVED), Some(9));
    assert_eq!(snapshot(&s), before);
}
