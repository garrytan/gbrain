//! The doctor access reads (access_doctor.rs): the pages no enabled member reads remotely, and the owner-only guard.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::access_doctor::PagesReadByNobodySpec;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

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

fn read(store: &Store, spec: Value) -> Vec<(String, String, Option<Vec<String>>)> {
    let spec: PagesReadByNobodySpec = serde_json::from_value(spec).unwrap();
    store
        .list_pages_read_by_nobody(&spec)
        .unwrap()
        .into_iter()
        .map(|r| (r.source_id, r.slug, r.readers))
        .collect()
}

fn strs(xs: &[&str]) -> Option<Vec<String>> {
    Some(xs.iter().map(|x| (*x).to_owned()).collect())
}

#[test]
fn labelled_pages_naming_no_live_identity_are_read_by_nobody() {
    let dir = TempDir::new("access-doctor-labelled");
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
        read(
            &store,
            json!({ "by": "labelled", "live": ["member:alice", "group:team"] })
        ),
        vec![(
            "default".into(),
            "notes/leaver".into(),
            strs(&["member:bob"])
        )]
    );
    // With no live identity, every labelled page that is not closed on purpose counts.
    assert_eq!(
        read(&store, json!({ "by": "labelled", "live": [] }))
            .into_iter()
            .map(|r| r.1)
            .collect::<Vec<_>>(),
        vec!["notes/alice", "notes/leaver", "notes/team"]
    );
}

#[test]
fn a_folder_rule_with_no_admitted_identity_covers_every_page_it_holds() {
    let dir = TempDir::new("access-doctor-rule");
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
    let rule = |admitted: Value| json!({ "by": "rule", "sourceId": "work", "prefix": "deals/", "admitted": admitted });
    assert_eq!(
        read(&store, rule(json!([])))
            .into_iter()
            .map(|r| r.1)
            .collect::<Vec<_>>(),
        vec!["deals/a", "deals/b", "deals/c"]
    );
    // Admitted identities exist: only labelled pages naming none of them count; an unlabelled page is readable.
    assert_eq!(
        read(&store, rule(json!(["member:alice"]))),
        vec![("work".into(), "deals/b".into(), strs(&["member:carol"]))]
    );
    // A page rule covers its own slug only.
    assert_eq!(
        read(
            &store,
            json!({ "by": "rule", "sourceId": "work", "prefix": "deals/a", "admitted": [] })
        )
        .into_iter()
        .map(|r| r.1)
        .collect::<Vec<_>>(),
        vec!["deals/a"]
    );
}

#[test]
fn the_owner_only_guard_follows_owner_only_sources_and_marks() {
    let dir = TempDir::new("access-doctor-guard");
    let store = open(&dir);
    assert!(!store.owner_only_guarded().unwrap());
    source(&store, "dms", json!({ "owner_only": true }));
    assert!(store.owner_only_guarded().unwrap());
    put(&store, "dms", "notes/secret", json!({}));
    store.delete_page("notes/secret", Some("dms")).unwrap();
    // The hard delete marked the page, so the guard stays on after the source stops being owner-only.
    source(&store, "dms", json!({}));
    assert!(store.owner_only_guarded().unwrap());
}
