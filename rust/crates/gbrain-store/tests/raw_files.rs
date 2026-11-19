//! Raw data and files: `putRawData`, `getRawData`, `upsertFile`, `getFile` and
//! `listFilesForPage`, matched to the PGLite engine.

mod common;

use common::TempDir;
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, PAGE_NOT_FOUND};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::raw_files::{FileSpec, RawDataScope};
use gbrain_store::sources::SourceInput;
use gbrain_store::{OpenOptions, Store};
use serde_json::{Value, json};

fn open(dir: &TempDir) -> Store {
    Store::open_dir(dir.path(), OpenOptions::default()).unwrap()
}

fn put(store: &Store, source: &str, slug: &str) -> u64 {
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "x"}))
            .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
    store.put_page(slug, &input, &opts).unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn add_source(store: &Store, id: &str) {
    let source: SourceInput = serde_json::from_value(json!({"id": id})).unwrap();
    store.upsert_source(&source).unwrap();
}

fn scope(v: Value) -> RawDataScope {
    serde_json::from_value(v).unwrap()
}

fn spec(v: Value) -> FileSpec {
    serde_json::from_value(v).unwrap()
}

fn data(rows: &[Value]) -> Vec<Value> {
    rows.iter().map(|r| r["data"].clone()).collect()
}

#[test]
fn raw_data_upserts_per_page_and_source() {
    let dir = TempDir::new("raw-upsert");
    let store = open(&dir);
    put(&store, "default", "people/alice");
    store
        .put_raw_data(
            "people/alice",
            Some("crust"),
            Some(r#"{"headline":"CEO"}"#),
            None,
        )
        .unwrap();
    store
        .put_raw_data("people/alice", Some("linkedin"), Some(r#"{"t":1}"#), None)
        .unwrap();
    store
        .put_raw_data(
            "people/alice",
            Some("crust"),
            Some(r#"{"headline":"CTO"}"#),
            None,
        )
        .unwrap();
    let all = store
        .get_raw_data("people/alice", None, &RawDataScope::default())
        .unwrap();
    assert_eq!(all.len(), 2);
    let one = store
        .get_raw_data("people/alice", Some("crust"), &RawDataScope::default())
        .unwrap();
    assert_eq!(data(&one), vec![json!({"headline": "CTO"})]);
    assert!(one[0]["fetched_at"].is_string());
    // An empty source filter is no filter, as PGLite's `if (source)`.
    assert_eq!(
        store
            .get_raw_data("people/alice", Some(""), &RawDataScope::default())
            .unwrap()
            .len(),
        2
    );
    assert!(
        store
            .get_raw_data("people/nobody", None, &RawDataScope::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn raw_data_keys_come_back_in_jsonb_order() {
    let dir = TempDir::new("raw-order");
    let store = open(&dir);
    put(&store, "default", "notes/a");
    store
        .put_raw_data(
            "notes/a",
            Some("s"),
            Some(r#"{"zz":1,"b":{"yy":1,"a":2},"aa":null}"#),
            None,
        )
        .unwrap();
    let rows = store
        .get_raw_data("notes/a", None, &RawDataScope::default())
        .unwrap();
    assert_eq!(
        serde_json::to_string(&rows[0]["data"]).unwrap(),
        r#"{"b":{"a":2,"yy":1},"aa":null,"zz":1}"#
    );
    // JSON null is a jsonb value, not SQL NULL.
    store
        .put_raw_data("notes/a", Some("n"), Some("null"), None)
        .unwrap();
    let rows = store
        .get_raw_data("notes/a", Some("n"), &RawDataScope::default())
        .unwrap();
    assert_eq!(rows[0]["data"], Value::Null);
}

#[test]
fn raw_data_scopes_by_source_and_follows_soft_delete() {
    let dir = TempDir::new("raw-scope");
    let store = open(&dir);
    add_source(&store, "other");
    put(&store, "default", "notes/shared");
    put(&store, "other", "notes/shared");
    store
        .put_raw_data(
            "notes/shared",
            Some("feed"),
            Some(r#"{"who":"d"}"#),
            Some("default"),
        )
        .unwrap();
    store
        .put_raw_data(
            "notes/shared",
            Some("feed"),
            Some(r#"{"who":"o"}"#),
            Some("other"),
        )
        .unwrap();
    let d = scope(json!({"sourceId": "default"}));
    assert_eq!(
        data(
            &store
                .get_raw_data("notes/shared", Some("feed"), &d)
                .unwrap()
        ),
        vec![json!({"who": "d"})]
    );
    let both = store
        .get_raw_data(
            "notes/shared",
            None,
            &scope(json!({"sourceIds": ["default", "other"]})),
        )
        .unwrap();
    assert_eq!(both.len(), 2);
    store
        .soft_delete_page("notes/shared", Some("default"))
        .unwrap();
    assert!(
        store
            .get_raw_data("notes/shared", None, &d)
            .unwrap()
            .is_empty()
    );
    let shown = scope(json!({"sourceId": "default", "includeDeleted": true}));
    assert_eq!(
        store
            .get_raw_data("notes/shared", None, &shown)
            .unwrap()
            .len(),
        1
    );
    // Unscoped writes reach every page by that slug, soft-deleted ones included.
    store
        .put_raw_data("notes/shared", Some("all"), Some("1"), None)
        .unwrap();
    assert_eq!(
        store
            .get_raw_data(
                "notes/shared",
                Some("all"),
                &scope(json!({"includeDeleted": true}))
            )
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn raw_data_refusals_match_pglite() {
    let dir = TempDir::new("raw-refuse");
    let store = open(&dir);
    let missing = store
        .put_raw_data("notes/none", Some("s"), Some("{}"), None)
        .unwrap_err();
    assert_eq!(missing.code, PAGE_NOT_FOUND);
    assert_eq!(
        missing.message,
        r#"putRawData failed: page "notes/none" not found"#
    );
    let scoped = store
        .put_raw_data("notes/none", Some("s"), Some("{}"), Some("default"))
        .unwrap_err();
    assert_eq!(
        scoped.message,
        r#"putRawData failed: page "notes/none" (source=default) not found"#
    );
    put(&store, "default", "notes/a");
    let no_data = store
        .put_raw_data("notes/a", Some("s"), None, None)
        .unwrap_err();
    assert_eq!(no_data.code, CONSTRAINT_VIOLATION);
    let nul = store
        .put_raw_data("notes/a", Some("s"), Some(r#"{"a":"\u0000"}"#), None)
        .unwrap_err();
    assert_eq!(nul.code, INVALID_ARGUMENT);
}

#[test]
fn a_file_is_created_then_updated_in_place() {
    let dir = TempDir::new("file-upsert");
    let store = open(&dir);
    let base = json!({
        "filename": "photo.png", "storage_path": "assets/photo.png", "mime_type": "image/png",
        "size_bytes": 1234, "content_hash": "h1", "metadata": r#"{"width":10,"height":20}"#,
    });
    let created = store.upsert_file(&spec(base.clone())).unwrap();
    assert!(created.created);
    let same = store.upsert_file(&spec(base.clone())).unwrap();
    assert!(!same.created);
    assert_eq!(same.id, created.id);
    let mut next = base.clone();
    next["content_hash"] = json!("h2");
    next["size_bytes"] = json!(5_000_000_000_f64);
    let replaced = store.upsert_file(&spec(next)).unwrap();
    assert_eq!(replaced.id, created.id);
    let row = store
        .get_file("default", "assets/photo.png")
        .unwrap()
        .unwrap();
    assert_eq!(row["content_hash"], "h2");
    assert_eq!(row["size_bytes"], json!(5_000_000_000_i64));
    assert_eq!(row["source_id"], "default");
    assert_eq!(row["page_id"], Value::Null);
    assert_eq!(
        serde_json::to_string(&row["metadata"]).unwrap(),
        r#"{"width":10,"height":20}"#
    );
    assert!(row["created_at"].is_string());
    assert!(
        store
            .get_file("other", "assets/photo.png")
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .get_file("default", "assets/none.png")
            .unwrap()
            .is_none()
    );
}

#[test]
fn storage_path_is_unique_across_sources() {
    let dir = TempDir::new("file-unique");
    let store = open(&dir);
    add_source(&store, "other");
    store
        .upsert_file(&spec(json!({
            "filename": "a", "storage_path": "p/a", "content_hash": "h", "metadata": "{}",
        })))
        .unwrap();
    // The conflict update keeps the first row's source.
    let again = store
        .upsert_file(&spec(json!({
            "source_id": "other", "filename": "b", "storage_path": "p/a", "content_hash": "h2", "metadata": "{}",
        })))
        .unwrap();
    assert!(!again.created);
    let row = store.get_file("default", "p/a").unwrap().unwrap();
    assert_eq!(row["filename"], "b");
    assert!(store.get_file("other", "p/a").unwrap().is_none());
}

#[test]
fn files_list_by_page_oldest_first_and_move_with_page_id() {
    let dir = TempDir::new("file-list");
    let store = open(&dir);
    let alice = put(&store, "default", "people/alice");
    let bob = put(&store, "default", "people/bob");
    for path in ["a/b.png", "a/a.png"] {
        store
            .upsert_file(&spec(json!({
                "page_slug": "people/alice", "page_id": alice, "filename": path,
                "storage_path": path, "content_hash": "h", "metadata": "{}",
            })))
            .unwrap();
    }
    let paths = |id: u64| -> Vec<String> {
        store
            .list_files_for_page(&json!(id))
            .unwrap()
            .iter()
            .map(|f| f["storage_path"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(paths(alice), vec!["a/b.png", "a/a.png"]);
    store
        .upsert_file(&spec(json!({
            "page_id": bob, "filename": "x", "storage_path": "a/a.png", "content_hash": "h", "metadata": "{}",
        })))
        .unwrap();
    assert_eq!(paths(alice), vec!["a/b.png"]);
    assert_eq!(paths(bob), vec!["a/a.png"]);
    assert!(store.list_files_for_page(&json!(-1)).unwrap().is_empty());
    assert_eq!(
        store.list_files_for_page(&json!(1.5)).unwrap_err().code,
        INVALID_ARGUMENT
    );
    // A hard page delete keeps the file and clears its page.
    store.delete_page("people/bob", None).unwrap();
    let row = store.get_file("default", "a/a.png").unwrap().unwrap();
    assert_eq!(row["page_id"], Value::Null);
    assert!(store.list_files_for_page(&json!(bob)).unwrap().is_empty());
}

#[test]
fn file_refusals_match_pglite() {
    let dir = TempDir::new("file-refuse");
    let store = open(&dir);
    let no_source = store
        .upsert_file(&spec(json!({
            "source_id": "nope", "filename": "a", "storage_path": "p/a", "content_hash": "h", "metadata": "{}",
        })))
        .unwrap_err();
    assert_eq!(no_source.code, CONSTRAINT_VIOLATION);
    assert!(no_source.message.contains("files_source_id_fkey"));
    let no_page = store
        .upsert_file(&spec(json!({
            "page_id": 999, "filename": "a", "storage_path": "p/a", "content_hash": "h", "metadata": "{}",
        })))
        .unwrap_err();
    assert!(no_page.message.contains("files_page_id_fkey"));
    let no_hash = store
        .upsert_file(&spec(
            json!({ "filename": "a", "storage_path": "p/a", "metadata": "{}" }),
        ))
        .unwrap_err();
    assert_eq!(no_hash.code, CONSTRAINT_VIOLATION);
    let half = store
        .upsert_file(&spec(json!({
            "filename": "a", "storage_path": "p/a", "content_hash": "h", "size_bytes": 1.5, "metadata": "{}",
        })))
        .unwrap_err();
    assert_eq!(half.code, INVALID_ARGUMENT);
    // Nothing was written, and no id was taken.
    assert!(store.get_file("default", "p/a").unwrap().is_none());
    let first = store
        .upsert_file(&spec(json!({
            "filename": "a", "storage_path": "p/a", "content_hash": "h", "metadata": "{}",
        })))
        .unwrap();
    assert_eq!(first.id, 1);
}
