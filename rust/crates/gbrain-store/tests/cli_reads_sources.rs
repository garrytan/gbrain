//! Source-resolution reads: the rows `listLocalPathSources`, `listSourceRoutingRows` and
//! `countDefaultSourceSplit` answer, matched to the PGLite engine.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::cli_reads::sources::DefaultSourceSplit;
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

fn page(store: &Store, source_id: &str, slug: &str) {
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "body"}))
            .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({"sourceId": source_id})).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

fn split(d: u64, n: u64, s: u64) -> DefaultSourceSplit {
    DefaultSourceSplit {
        default_pages: d,
        non_default_pages: n,
        non_default_sources: s,
    }
}

#[test]
fn an_empty_brain_has_no_local_paths_one_routing_row_and_no_pages() {
    let dir = TempDir::new("cli-src-empty");
    let store = open(&dir);
    assert!(store.list_local_path_sources().unwrap().is_empty());
    let rows = store.list_source_routing_rows().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "default");
    assert_eq!(rows[0].local_path, None);
    assert!(!rows[0].archived);
    assert_eq!(
        serde_json::to_value(&rows[0].config).unwrap(),
        json!({"federated": true})
    );
    assert!(!rows[0].default_has_pages);
    assert_eq!(store.count_default_source_split().unwrap(), split(0, 0, 0));
}

#[test]
fn local_path_sources_keep_archived_rows_and_skip_sources_without_a_path() {
    let dir = TempDir::new("cli-src-paths");
    let store = open(&dir);
    source(&store, "beta", Some("/w/beta"), json!({}));
    source(&store, "alpha", Some("/w/alpha"), json!({}));
    source(&store, "nopath", None, json!({}));
    assert!(store.set_source_archived("beta", true).unwrap());
    let rows = serde_json::to_value(store.list_local_path_sources().unwrap()).unwrap();
    assert_eq!(
        rows,
        json!([
            {"id": "alpha", "local_path": "/w/alpha", "archived": false},
            {"id": "beta", "local_path": "/w/beta", "archived": true},
        ])
    );
}

#[test]
fn routing_rows_carry_config_archived_and_whether_default_has_a_live_page() {
    let dir = TempDir::new("cli-src-routing");
    let store = open(&dir);
    source(
        &store,
        "wiki",
        Some("/w/wiki"),
        json!({"role": "storage_manifest"}),
    );
    source(&store, "old", None, json!({}));
    assert!(store.set_source_archived("old", true).unwrap());
    page(&store, "wiki", "notes/a");
    let rows = serde_json::to_value(store.list_source_routing_rows().unwrap()).unwrap();
    assert_eq!(
        rows,
        json!([
            {"id": "default", "local_path": null, "archived": false, "config": {"federated": true}, "default_has_pages": false},
            {"id": "old", "local_path": null, "archived": true, "config": {}, "default_has_pages": false},
            {"id": "wiki", "local_path": "/w/wiki", "archived": false, "config": {"role": "storage_manifest"}, "default_has_pages": false},
        ])
    );
    page(&store, "default", "notes/d");
    assert!(
        store
            .list_source_routing_rows()
            .unwrap()
            .iter()
            .all(|r| r.default_has_pages)
    );
    // A soft-deleted page is not live.
    store.soft_delete_page("notes/d", Some("default")).unwrap();
    assert!(
        store
            .list_source_routing_rows()
            .unwrap()
            .iter()
            .all(|r| !r.default_has_pages)
    );
}

#[test]
fn the_default_split_counts_live_pages_and_distinct_other_sources() {
    let dir = TempDir::new("cli-src-split");
    let store = open(&dir);
    source(&store, "a", None, json!({}));
    source(&store, "b", None, json!({}));
    page(&store, "default", "d1");
    page(&store, "default", "d2");
    page(&store, "a", "x");
    page(&store, "a", "y");
    page(&store, "b", "z");
    assert_eq!(store.count_default_source_split().unwrap(), split(2, 3, 2));
    store.soft_delete_page("z", Some("b")).unwrap();
    store.soft_delete_page("d2", Some("default")).unwrap();
    assert_eq!(store.count_default_source_split().unwrap(), split(1, 2, 1));
    assert_eq!(
        serde_json::to_value(store.count_default_source_split().unwrap()).unwrap(),
        json!({"defaultPages": 1, "nonDefaultPages": 2, "nonDefaultSources": 1})
    );
}

#[test]
fn source_page_counts_keep_to_one_source_and_count_soft_deleted_pages_only_when_asked() {
    let dir = TempDir::new("cli-src-count");
    let store = open(&dir);
    source(&store, "a", None, json!({}));
    source(&store, "ab", None, json!({}));
    page(&store, "a", "x");
    page(&store, "a", "y");
    page(&store, "ab", "z");
    page(&store, "default", "d");
    store.soft_delete_page("y", Some("a")).unwrap();
    assert_eq!(store.count_source_pages("a", false).unwrap(), 1);
    assert_eq!(store.count_source_pages("a", true).unwrap(), 2);
    assert_eq!(store.count_source_pages("ab", false).unwrap(), 1);
    assert_eq!(store.count_source_pages("default", true).unwrap(), 1);
    assert_eq!(store.count_source_pages("missing", true).unwrap(), 0);
}

#[test]
fn insert_source_creates_a_source_and_refuses_a_taken_id_or_name() {
    let dir = TempDir::new("cli-src-insert");
    let store = open(&dir);
    let config = json!({"federated": false, "kind": "url"});
    let row = store
        .insert_source("wiki", "Wiki", Some("/w/wiki"), config.as_object().unwrap())
        .unwrap();
    assert_eq!(row.id, "wiki");
    let got = store.get_source_by_id("wiki").unwrap().unwrap();
    assert_eq!(got.name.as_deref(), Some("Wiki"));
    assert_eq!(got.local_path.as_deref(), Some("/w/wiki"));
    assert_eq!(serde_json::to_value(&got.config).unwrap(), config);
    let empty = serde_json::Map::new();
    let taken_id = store
        .insert_source("wiki", "Other", None, &empty)
        .unwrap_err();
    assert_eq!(taken_id.code, "constraint_violation");
    let taken_name = store
        .insert_source("notes", "Wiki", None, &empty)
        .unwrap_err();
    assert_eq!(taken_name.code, "constraint_violation");
    assert!(store.get_source_by_id("notes").unwrap().is_none());
    let bad = store
        .insert_source("Bad Id", "Bad", None, &empty)
        .unwrap_err();
    assert_eq!(bad.code, "invalid_argument");
    // The first insert is untouched by the refused ones.
    let again = store.get_source_by_id("wiki").unwrap().unwrap();
    assert_eq!(again.name.as_deref(), Some("Wiki"));
}
