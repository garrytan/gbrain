//! The page-write reads and the path attach (write_misc.rs).

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn source(store: &Store, id: &str, config: Value) {
    store
        .upsert_source(&SourceInput {
            id: id.into(),
            name: Some(id.into()),
            local_path: Some(format!("/brains/{id}")),
            config: config.as_object().cloned(),
            ..SourceInput::default()
        })
        .unwrap();
}

#[test]
fn source_state_reads_incarnation_archived_path_and_config() {
    let dir = TempDir::new("write-misc-source-state");
    let store = open(&dir);
    source(
        &store,
        "alpha",
        json!({ "mirror_read_only": true, "slug_root_mode": "strip" }),
    );
    store.set_source_archived("alpha", true).unwrap();
    let state = store.read_source_state("alpha").unwrap().unwrap();
    assert_eq!(state.incarnation.len(), 36);
    assert!(state.archived);
    assert_eq!(state.local_path.as_deref(), Some("/brains/alpha"));
    assert_eq!(
        Value::Object(state.config),
        json!({ "mirror_read_only": true, "slug_root_mode": "strip" })
    );
    let default = store.read_source_state("default").unwrap().unwrap();
    assert!(!default.archived);
    assert_eq!(default.local_path, None);
    assert!(store.read_source_state("nope").unwrap().is_none());
    assert!(store.read_source_state("bad\0id").unwrap().is_none());
}

#[test]
fn attach_source_path_sets_the_path_and_only_the_passed_fields() {
    let dir = TempDir::new("write-misc-attach-path");
    let store = open(&dir);
    store
        .upsert_source(&SourceInput {
            id: "work".into(),
            name: Some("work".into()),
            config: json!({ "kind": "notes", "federated": true })
                .as_object()
                .cloned(),
            ..SourceInput::default()
        })
        .unwrap();
    let before = store.read_source_state("work").unwrap().unwrap();
    assert!(
        store
            .attach_source_path("work", "/brains/work", None, None)
            .unwrap()
    );
    let kept = store.get_source("work").unwrap().unwrap();
    assert_eq!(kept.name.as_deref(), Some("work"));
    assert_eq!(kept.local_path.as_deref(), Some("/brains/work"));
    assert_eq!(
        Value::Object(kept.config),
        json!({ "kind": "notes", "federated": true })
    );
    assert!(
        store
            .attach_source_path("work", "/brains/work2", Some("Work notes"), Some(false))
            .unwrap()
    );
    let after = store.read_source_state("work").unwrap().unwrap();
    assert_eq!(after.incarnation, before.incarnation);
    assert_eq!(after.local_path.as_deref(), Some("/brains/work2"));
    assert_eq!(
        Value::Object(after.config),
        json!({ "kind": "notes", "federated": false })
    );
    assert_eq!(
        store.get_source("work").unwrap().unwrap().name.as_deref(),
        Some("Work notes")
    );
    assert!(
        !store
            .attach_source_path("nope", "/brains/nope", Some("x"), Some(true))
            .unwrap()
    );
    assert!(store.read_source_state("nope").unwrap().is_none());
}

fn put(store: &Store, source: &str, slug: &str, frontmatter: Value) {
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter}),
    )
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

fn naming(store: &Store, principal: &str, limit: u32) -> Vec<(String, String)> {
    naming_of(store, principal, limit, false)
}

fn naming_of(store: &Store, principal: &str, limit: u32, live_only: bool) -> Vec<(String, String)> {
    store
        .list_pages_naming_reader(principal, limit, live_only)
        .unwrap()
        .into_iter()
        .map(|r| (r.source_id, r.slug))
        .collect()
}

#[test]
fn pages_naming_reader_match_normalized_readers_exactly_in_every_source() {
    let dir = TempDir::new("write-misc-pages-naming");
    let store = open(&dir);
    source(&store, "other", json!({}));
    put(
        &store,
        "default",
        "notes/b",
        json!({"readable_by": ["alice-example", "group:team-a"]}),
    );
    put(
        &store,
        "default",
        "notes/a",
        json!({"readable_by": " Member:Alice-Example "}),
    );
    put(
        &store,
        "other",
        "notes/c",
        json!({"readable_by": ["member:alice-example"]}),
    );
    put(
        &store,
        "default",
        "notes/gone",
        json!({"readable_by": ["alice-example"]}),
    );
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    put(
        &store,
        "default",
        "notes/bob",
        json!({"readable_by": ["bob-example"]}),
    );
    put(
        &store,
        "default",
        "notes/bad",
        json!({"readable_by": ["alice-example", 7]}),
    );
    put(
        &store,
        "default",
        "notes/open",
        json!({"title": "alice-example"}),
    );
    let pair = |s: &str, p: &str| (s.to_string(), p.to_string());
    assert_eq!(
        naming(&store, "member:alice-example", 50),
        vec![
            pair("default", "notes/a"),
            pair("default", "notes/b"),
            pair("default", "notes/gone"),
            pair("other", "notes/c"),
        ]
    );
    assert_eq!(
        naming(&store, "member:alice-example", 2),
        vec![pair("default", "notes/a"), pair("default", "notes/b")]
    );
    assert_eq!(naming(&store, "member:alice-example", 0), vec![]);
    assert_eq!(
        naming_of(&store, "member:alice-example", 201, true),
        vec![
            pair("default", "notes/a"),
            pair("default", "notes/b"),
            pair("other", "notes/c"),
        ],
        "the live read leaves the soft-deleted page out"
    );
    assert_eq!(
        naming_of(&store, "member:alice-example", 1, true),
        vec![pair("default", "notes/a")]
    );
    assert_eq!(
        naming(&store, "group:team-a", 50),
        vec![pair("default", "notes/b")]
    );
    assert_eq!(naming(&store, "alice-example", 50), vec![]);
    assert_eq!(naming(&store, "member:Alice-Example", 50), vec![]);
    assert_eq!(naming(&store, "group:alice-example", 50), vec![]);
    assert_eq!(naming(&store, "member:carol-example", 50), vec![]);
}

#[test]
fn a_synopsis_frontmatter_override_is_a_live_default_page_naming_the_tier() {
    let dir = TempDir::new("write-misc-synopsis-override");
    let store = open(&dir);
    source(&store, "other", json!({}));
    assert!(!store.has_synopsis_frontmatter_override().unwrap());
    // Another tier, another key, a value that only contains the tier, and a source that does not trust its pages.
    put(
        &store,
        "default",
        "a",
        json!({ "contextual_retrieval": "off" }),
    );
    put(
        &store,
        "default",
        "b",
        json!({ "retrieval": "per_chunk_synopsis" }),
    );
    put(
        &store,
        "default",
        "c",
        json!({ "contextual_retrieval": ["per_chunk_synopsis"] }),
    );
    put(
        &store,
        "other",
        "d",
        json!({ "contextual_retrieval": "per_chunk_synopsis" }),
    );
    assert!(!store.has_synopsis_frontmatter_override().unwrap());
    put(
        &store,
        "default",
        "e",
        json!({ "contextual_retrieval": "per_chunk_synopsis" }),
    );
    assert!(store.has_synopsis_frontmatter_override().unwrap());
    // A deleted page and an archived source no longer count.
    store.soft_delete_page("e", Some("default")).unwrap();
    assert!(!store.has_synopsis_frontmatter_override().unwrap());
    store.restore_page("e", Some("default")).unwrap();
    assert!(store.has_synopsis_frontmatter_override().unwrap());
    store.set_source_archived("default", true).unwrap();
    assert!(!store.has_synopsis_frontmatter_override().unwrap());
}
