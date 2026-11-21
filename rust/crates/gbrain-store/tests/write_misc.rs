//! The page-write reads and the path attach (write_misc.rs).

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
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
