//! The page-write reads (write_misc.rs): a source's state.

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
