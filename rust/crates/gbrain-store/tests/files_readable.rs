//! `listReadableFileRows` and `listFilesByStoragePath` (`raw_files/ops.rs`): the files `file_list` shows, by byte order with an id
//! tie-break, cut at 100, and hidden when the caller's page policy hides the page they name.

mod common;

use common::TempDir;
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::raw_files::FileSpec;
use gbrain_store::{OpenOptions, Store};
use serde_json::{Value, json};

fn open(dir: &TempDir) -> Store {
    Store::open_dir(dir.path(), OpenOptions::default()).unwrap()
}

fn file(store: &Store, slug: Option<&str>, filename: &str, path: &str, page_id: Option<u64>) {
    let spec: FileSpec = serde_json::from_value(json!({
        "page_slug": slug, "page_id": page_id, "filename": filename,
        "storage_path": path, "content_hash": "h", "metadata": "{}",
    }))
    .unwrap();
    store.upsert_file(&spec).unwrap();
}

fn paths(rows: &[Value]) -> Vec<&str> {
    rows.iter()
        .map(|r| r["storage_path"].as_str().unwrap())
        .collect()
}

#[test]
fn lists_by_slug_then_filename_bytes_with_a_null_slug_last() {
    let dir = TempDir::new("files-readable-order");
    let s = open(&dir);
    file(&s, Some("b"), "one", "p/b", None);
    file(&s, Some("B"), "one", "p/B-upper", None);
    file(&s, Some("a_b"), "one", "p/a_b", None);
    file(&s, Some("a-b"), "one", "p/a-b", None);
    file(&s, None, "one", "p/none", None);
    let all = s.list_readable_files(None, None).unwrap();
    assert_eq!(
        paths(&all),
        ["p/B-upper", "p/a-b", "p/a_b", "p/b", "p/none"]
    );
    file(&s, Some("shared"), "b", "shared/b", None);
    file(&s, Some("shared"), "B", "shared/B", None);
    file(&s, Some("shared"), "a-b", "shared/a-b", None);
    let one = s.list_readable_files(Some("shared"), None).unwrap();
    assert_eq!(paths(&one), ["shared/B", "shared/a-b", "shared/b"]);
    assert_eq!(one[0]["size_bytes"], Value::Null);
    assert!(one[0]["created_at"].is_string());
}

#[test]
fn ties_go_by_file_id_and_the_list_stops_at_100() {
    let dir = TempDir::new("files-readable-limit");
    let s = open(&dir);
    for g in 1..=120 {
        file(
            &s,
            Some("tie/page"),
            "same.txt",
            &format!("tie/{:03}", 121 - g),
            None,
        );
    }
    let first100: Vec<String> = (0..100).map(|i| format!("tie/{:03}", 120 - i)).collect();
    for rows in [
        s.list_readable_files(None, None).unwrap(),
        s.list_readable_files(Some("tie/page"), None).unwrap(),
    ] {
        assert_eq!(paths(&rows), first100.iter().collect::<Vec<_>>());
    }
}

#[test]
fn a_policy_hides_the_files_of_a_private_page_by_id_or_by_slug() {
    let dir = TempDir::new("files-readable-policy");
    let s = open(&dir);
    let put = |slug: &str, frontmatter: Value| -> u64 {
        let input: PageInput = serde_json::from_value(json!({
            "type": "note", "title": slug, "compiled_truth": "x", "frontmatter": frontmatter,
        }))
        .unwrap();
        s.put_page(slug, &input, &PutPageOptions::default())
            .unwrap()["id"]
            .as_u64()
            .unwrap()
    };
    let open_id = put("notes/open", json!({}));
    let secret_id = put("notes/secret", json!({ "visibility": "private" }));
    file(&s, Some("notes/open"), "a", "f/open", Some(open_id));
    file(&s, Some("notes/secret"), "a", "f/by-slug", None);
    file(&s, None, "a", "f/by-id", Some(secret_id));
    file(&s, Some("notes/gone"), "a", "f/no-page", None);
    let policy = PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    };
    let rows = s.list_readable_files(None, Some(&policy)).unwrap();
    assert_eq!(paths(&rows), ["f/no-page", "f/open"]);
    let unrestricted = s.list_readable_files(None, None).unwrap();
    assert_eq!(unrestricted.len(), 4);
}

#[test]
fn the_verify_walk_lists_every_column_by_storage_path_bytes_and_stops_at_the_limit() {
    let dir = TempDir::new("files-by-path");
    let s = open(&dir);
    for path in ["files/b", "files/B", "files/a_b", "files/a-b", "files/é"] {
        file(&s, Some("any"), path, path, None);
    }
    let all = s.list_files_by_storage_path(&json!(1000)).unwrap();
    assert_eq!(
        paths(&all),
        ["files/B", "files/a-b", "files/a_b", "files/b", "files/é"]
    );
    for column in [
        "id",
        "source_id",
        "page_slug",
        "page_id",
        "filename",
        "storage_path",
        "mime_type",
        "size_bytes",
        "content_hash",
        "metadata",
        "created_at",
    ] {
        assert!(all[0].get(column).is_some(), "{column}");
    }
    assert_eq!(all[0]["metadata"], json!({}));
    let two = s.list_files_by_storage_path(&json!(2)).unwrap();
    assert_eq!(paths(&two), ["files/B", "files/a-b"]);
    assert!(s.list_files_by_storage_path(&json!(0)).unwrap().is_empty());
    for bad in [json!(-1), json!(1.5), json!("1")] {
        assert_eq!(
            s.list_files_by_storage_path(&bad).unwrap_err().code,
            "invalid_argument"
        );
    }
}
