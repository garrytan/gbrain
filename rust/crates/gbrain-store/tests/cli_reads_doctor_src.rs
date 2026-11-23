//! The `sources` doctor reads (`cli_reads/doctor_sources.rs`): the PGLite semantics of each.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::json;

fn source(store: &Store, id: &str, local_path: Option<&str>, config: serde_json::Value) {
    let input: SourceInput = serde_json::from_value(json!({
        "id": id, "name": id, "local_path": local_path, "config": config,
    }))
    .unwrap();
    store.upsert_source(&input).unwrap();
}

fn page(store: &Store, source_id: &str, slug: &str, source_path: Option<&str>) {
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": slug, "compiled_truth": "body", "source_path": source_path}),
    )
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({"sourceId": source_id})).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

#[test]
fn doctor_sources_list_every_source_by_id_with_the_columns_the_statements_read() {
    let dir = TempDir::new("doctor-src-list");
    let store = open(&dir);
    source(&store, "beta", Some("/w/beta"), json!({"kind": "google"}));
    source(&store, "alpha", None, json!({"canonical": "git"}));
    store.set_source_archived("beta", true).unwrap();
    let rows = store.list_doctor_sources().unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        ["alpha", "beta", "default"],
        "byte order of the id, default not first"
    );
    let beta = &rows[1];
    assert_eq!(beta.local_path.as_deref(), Some("/w/beta"));
    assert!(beta.archived);
    assert_eq!(
        serde_json::to_value(&beta.config).unwrap(),
        json!({"kind": "google"})
    );
    assert!(!beta.incarnation.is_empty());
    assert_eq!(beta.last_sync_at, None);
    assert!(!rows[0].archived);
    assert_eq!(rows[0].local_path, None);
}

#[test]
fn source_ids_with_live_pages_skip_empty_sources_and_soft_deleted_pages() {
    let dir = TempDir::new("doctor-src-live");
    let store = open(&dir);
    source(&store, "alpha", None, json!({}));
    source(&store, "beta", None, json!({}));
    source(&store, "alphabet", None, json!({}));
    assert!(store.list_source_ids_with_live_pages().unwrap().is_empty());
    page(&store, "alphabet", "notes/a", None);
    page(&store, "beta", "notes/b", None);
    store.soft_delete_page("notes/b", Some("beta")).unwrap();
    assert_eq!(
        store.list_source_ids_with_live_pages().unwrap(),
        ["alphabet"]
    );
    page(&store, "default", "notes/d", None);
    assert_eq!(
        store.list_source_ids_with_live_pages().unwrap(),
        ["alphabet", "default"]
    );
}

#[test]
fn default_source_files_count_live_pages_and_those_with_a_source_path() {
    let dir = TempDir::new("doctor-src-files");
    let store = open(&dir);
    let none = store.count_default_source_files().unwrap();
    assert_eq!((none.live, none.file_backed), (0, 0));
    page(&store, "default", "notes/a", Some("notes/a.md"));
    page(&store, "default", "notes/b", None);
    page(&store, "default", "notes/c", Some("notes/c.md"));
    source(&store, "other", None, json!({}));
    page(&store, "other", "notes/o", Some("notes/o.md"));
    store.soft_delete_page("notes/c", Some("default")).unwrap();
    let counts = store.count_default_source_files().unwrap();
    assert_eq!((counts.live, counts.file_backed), (2, 1));
}
