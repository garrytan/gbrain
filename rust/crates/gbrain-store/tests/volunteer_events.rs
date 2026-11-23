//! Context-volunteer events (volunteer_events.rs): the insert's page guard, the listings, and the scrubs of every hard
//! delete: `deletePages`, `purgeDeletedPages` and a source delete remove the rows that name the page or source, a soft
//! delete keeps them, and the purge probe finds a row that still carries a purged claim.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::purge_plan::{ProbeNeedle, PurgeProbeArgs};
use gbrain_store::page_ops::{PurgeOptions, SourceOption};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::volunteer_events::VolunteerEventInput;
use serde_json::{Map, json};

fn put(store: &Store, source: &str, slug: &str) {
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": slug, "compiled_truth": format!("{slug} body"), "frontmatter": {}}),
    )
    .unwrap();
    let options = PutPageOptions {
        source_id: Some(source.to_owned()),
        ..Default::default()
    };
    store.put_page(slug, &input, &options).unwrap();
}

fn event(source: &str, slug: &str, channel: &str, rationale: &str) -> VolunteerEventInput {
    VolunteerEventInput {
        source_id: source.into(),
        slug: slug.into(),
        confidence: 0.9,
        match_arm: "exact".into(),
        rationale: rationale.into(),
        channel: channel.into(),
        session_id: None,
        turn: None,
    }
}

fn count(store: &Store, source: &str, slug: &str) -> u64 {
    store.count_volunteer_events_for_slug(source, slug).unwrap()
}

/// Two sources with pages `notes/a` and `notes/b`, one event each.
fn seed(store: &Store) {
    for source in ["alpha", "beta"] {
        store
            .insert_source(source, source, None, &Map::new())
            .unwrap();
        put(store, source, "notes/a");
        put(store, source, "notes/b");
        store
            .insert_volunteer_event_rows(&[
                event(source, "notes/a", "op", "matched Secret Name"),
                event(source, "notes/b", "hook", "matched other"),
            ])
            .unwrap();
    }
}

fn probe(store: &Store, source: &str, needle: &str) -> i64 {
    let args = PurgeProbeArgs {
        table: "context_volunteer_events".into(),
        source_id: source.into(),
        columns: vec!["rationale".into()],
        needles: vec![ProbeNeedle {
            text: needle.into(),
            lower: needle.to_lowercase(),
            escaped: needle.to_lowercase(),
        }],
        scoped: true,
        binary: false,
        rows: Some(100),
    };
    store.count_purge_probe(&args).unwrap()
}

#[test]
fn delete_pages_scrubs_the_rows_of_the_deleted_page_only() {
    let dir = TempDir::new("volunteer-delete-pages");
    let store = open(&dir);
    seed(&store);
    let options = SourceOption {
        source_id: Some("alpha".into()),
    };
    let gone = store
        .delete_pages(&["notes/a".to_owned()], &options)
        .unwrap();
    assert_eq!(gone, vec!["notes/a".to_owned()]);
    assert_eq!(count(&store, "alpha", "notes/a"), 0);
    assert_eq!(count(&store, "alpha", "notes/b"), 1);
    assert_eq!(count(&store, "beta", "notes/a"), 1);
    // A write that lands after the purge finds no page and writes nothing.
    let wrote = store
        .insert_volunteer_event_rows(&[event("alpha", "notes/a", "late", "again")])
        .unwrap();
    assert_eq!(wrote, 0);
    assert_eq!(count(&store, "alpha", "notes/a"), 0);
}

#[test]
fn a_soft_delete_keeps_the_rows_and_a_purge_removes_them() {
    let dir = TempDir::new("volunteer-purge-deleted");
    let store = open(&dir);
    seed(&store);
    store.soft_delete_page("notes/a", Some("alpha")).unwrap();
    assert_eq!(count(&store, "alpha", "notes/a"), 1);
    // A soft-deleted page still exists, so a write for it is kept.
    assert_eq!(
        store
            .insert_volunteer_event_rows(&[event("alpha", "notes/a", "op", "again")])
            .unwrap(),
        1
    );
    std::thread::sleep(std::time::Duration::from_millis(5));
    let purged = store
        .purge_deleted_pages(0.0, &PurgeOptions::default())
        .unwrap();
    assert_eq!(purged["count"], 1);
    assert_eq!(count(&store, "alpha", "notes/a"), 0);
    assert_eq!(count(&store, "alpha", "notes/b"), 1);
    assert_eq!(count(&store, "beta", "notes/a"), 1);
}

#[test]
fn a_source_delete_removes_the_rows_of_the_source_only() {
    let dir = TempDir::new("volunteer-source-delete");
    let store = open(&dir);
    seed(&store);
    assert!(store.delete_source_record("alpha", false).unwrap());
    assert_eq!(count(&store, "alpha", "notes/a"), 0);
    assert_eq!(count(&store, "alpha", "notes/b"), 0);
    assert_eq!(count(&store, "beta", "notes/a"), 1);
    assert!(
        store
            .list_volunteer_channels(Some(&["alpha".to_owned()]))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .list_volunteer_channels(Some(&["beta".to_owned()]))
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn the_purge_probe_finds_a_rationale_that_still_carries_the_claim() {
    let dir = TempDir::new("volunteer-probe");
    let store = open(&dir);
    seed(&store);
    assert_eq!(probe(&store, "alpha", "secret name"), 1);
    assert_eq!(probe(&store, "alpha", "no such text"), 0);
    // The probe is scoped to the source it names.
    store
        .delete_volunteer_events_for_slugs("alpha", &["notes/a".to_owned()])
        .unwrap();
    assert_eq!(probe(&store, "alpha", "secret name"), 0);
    assert_eq!(probe(&store, "beta", "secret name"), 1);
}

#[test]
fn rows_survive_a_reopen() {
    let dir = TempDir::new("volunteer-reopen");
    {
        let store = open(&dir);
        seed(&store);
    }
    let store = open(&dir);
    assert_eq!(count(&store, "alpha", "notes/a"), 1);
    store
        .insert_volunteer_event_rows(&[event("alpha", "notes/a", "op", "more")])
        .unwrap();
    assert_eq!(count(&store, "alpha", "notes/a"), 2);
}
