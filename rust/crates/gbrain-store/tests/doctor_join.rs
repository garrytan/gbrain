//! The doctor-join store reads (cli_reads/doctor_join.rs): the pages no enabled member reads remotely, and the
//! owner-only mark state (owner_only_marks.rs). The cases are the store cases of rust-engine/doctor-row35-lane14
//! f2456a309e (tests/access_doctor.rs), adapted to these members.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

type Row = (String, String, Option<Vec<String>>);

fn source(store: &Store, id: &str, config: Value) {
    store
        .upsert_source(&SourceInput {
            id: id.into(),
            name: Some(id.into()),
            config: config.as_object().cloned(),
            ..SourceInput::default()
        })
        .unwrap();
}

fn put(store: &Store, source: &str, slug: &str, frontmatter: Value) {
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter}),
    )
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

fn owned(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|x| (*x).to_owned()).collect()
}

fn labelled(store: &Store, live: &[&str]) -> Vec<Row> {
    store
        .list_pages_read_by_nobody(&owned(live))
        .unwrap()
        .into_iter()
        .map(|r| (r.source_id, r.slug, r.readers))
        .collect()
}

fn rule(store: &Store, source_id: &str, prefix: &str, admitted: &[&str]) -> Vec<Row> {
    store
        .list_rule_pages_read_by_nobody(source_id, prefix, admitted.len() as i64, &owned(admitted))
        .unwrap()
        .into_iter()
        .map(|r| (r.source_id, r.slug, r.readers))
        .collect()
}

fn slugs(rows: Vec<Row>) -> Vec<String> {
    rows.into_iter().map(|r| r.1).collect()
}

#[test]
fn labelled_pages_naming_no_live_identity_are_read_by_nobody() {
    let dir = TempDir::new("doctor-join-labelled");
    let store = open(&dir);
    put(
        &store,
        "default",
        "notes/leaver",
        json!({ "readable_by": ["member:bob"] }),
    );
    put(
        &store,
        "default",
        "notes/alice",
        json!({ "readable_by": ["member:alice"] }),
    );
    put(
        &store,
        "default",
        "notes/team",
        json!({ "readable_by": "group:team" }),
    );
    put(
        &store,
        "default",
        "notes/closed",
        json!({ "readable_by": "!nobody" }),
    );
    put(&store, "default", "notes/open", json!({}));
    put(
        &store,
        "default",
        "memory/members/bob",
        json!({ "readable_by": ["member:bob"] }),
    );
    put(
        &store,
        "default",
        "notes/gone",
        json!({ "readable_by": ["member:bob"] }),
    );
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    assert_eq!(
        labelled(&store, &["member:alice", "group:team"]),
        vec![(
            "default".into(),
            "notes/leaver".into(),
            Some(owned(&["member:bob"]))
        )]
    );
    // With no live identity, every labelled page that is not closed on purpose counts.
    assert_eq!(
        slugs(labelled(&store, &[])),
        owned(&["notes/alice", "notes/leaver", "notes/team"])
    );
}

#[test]
fn a_folder_rule_with_no_admitted_identity_covers_every_page_it_holds() {
    let dir = TempDir::new("doctor-join-rule");
    let store = open(&dir);
    source(&store, "work", json!({}));
    put(&store, "work", "deals/a", json!({}));
    put(
        &store,
        "work",
        "deals/b",
        json!({ "readable_by": ["member:carol"] }),
    );
    put(
        &store,
        "work",
        "deals/c",
        json!({ "readable_by": ["member:alice"] }),
    );
    put(
        &store,
        "work",
        "deals/closed",
        json!({ "readable_by": "!nobody" }),
    );
    put(&store, "work", "dealsx/a", json!({}));
    put(&store, "default", "deals/a", json!({}));
    assert_eq!(
        slugs(rule(&store, "work", "deals/", &[])),
        owned(&["deals/a", "deals/b", "deals/c"])
    );
    // Admitted identities exist: only labelled pages naming none of them count; an unlabelled page is readable.
    assert_eq!(
        rule(&store, "work", "deals/", &["member:alice"]),
        vec![(
            "work".into(),
            "deals/b".into(),
            Some(owned(&["member:carol"]))
        )]
    );
    // A page rule covers its own slug only.
    assert_eq!(
        slugs(rule(&store, "work", "deals/a", &[])),
        owned(&["deals/a"])
    );
}

#[test]
fn the_owner_only_mark_state_is_held_by_owner_only_sources_and_marks() {
    let dir = TempDir::new("doctor-join-held");
    let store = open(&dir);
    let state = store.owner_only_mark_state().unwrap();
    assert!(!state.held && !state.closed && !state.row_security && state.closed_logins.is_empty());
    source(&store, "dms", json!({ "owner_only": true }));
    assert!(store.owner_only_mark_state().unwrap().held);
    put(&store, "dms", "notes/secret", json!({}));
    store.delete_page("notes/secret", Some("dms")).unwrap();
    // The hard delete marked the page, so the state stays held after the source stops being owner-only.
    source(&store, "dms", json!({}));
    let state = store.owner_only_mark_state().unwrap();
    assert!(state.held && !state.closed && state.closed_logins.is_empty());
}
