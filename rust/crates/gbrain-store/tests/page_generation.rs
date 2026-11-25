//! The page generation counter and its index (`M page_generation/<generation BE8><page id BE8>`, empty value; see
//! the `pages.rs` module header): one row per page, live or soft-deleted, written with the page change, rewritten
//! when the generation changes and removed when the page is purged; the whole-`P` scans read page records only.
//!
//! The key layout is the contract these tests read, through the public store and the raw record file.

mod common;

use common::TempDir;
use gbrain_store::cli_reads::sources::DefaultSourceSplit;
use gbrain_store::field_usage::FieldUsageQuery;
use gbrain_store::kv::{Kv, scan_prefix};
use gbrain_store::pages::{PageFilters, PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{OpenOptions, Store, SystemEnv, keys};
use serde_json::{Value, json};
use std::sync::Arc;

const INDEX: &[u8] = b"Mpage_generation/";

fn input(title: &str, body: &str) -> PageInput {
    serde_json::from_value(json!({"type": "note", "title": title, "compiled_truth": body})).unwrap()
}

fn put(store: &Store, slug: &str, body: &str) -> u64 {
    store
        .put_page(slug, &input(slug, body), &PutPageOptions::default())
        .unwrap()["id"]
        .as_u64()
        .unwrap()
}

/// A brain on a record file of its own, and a second handle on the same records to read keys.
fn brain(dir: &TempDir) -> (Store, Arc<dyn Kv>) {
    let kv: Arc<dyn Kv> = Arc::new(RedbKv::open_path(&dir.path().join("records.redb")).unwrap());
    let store = Store::open_kv(kv.clone(), Arc::new(SystemEnv), OpenOptions::default()).unwrap();
    (store, kv)
}

fn scan(kv: &Arc<dyn Kv>, prefix: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
    let snapshot = kv.snapshot().unwrap();
    let mut out = Vec::new();
    scan_prefix(&*snapshot, prefix, false, &mut |k, v| {
        out.push((k.to_vec(), v.to_vec()));
        true
    })
    .unwrap();
    out
}

/// The index rows as (generation, page id), in key order.
fn index_rows(kv: &Arc<dyn Kv>) -> Vec<(u64, u64)> {
    scan(kv, INDEX)
        .into_iter()
        .map(|(k, v)| {
            assert!(v.is_empty(), "an index row holds no value");
            assert_eq!(k.len(), INDEX.len() + 16);
            let tail = &k[INDEX.len()..];
            (
                keys::be8(&tail[..8]).unwrap(),
                keys::be8(&tail[8..]).unwrap(),
            )
        })
        .collect()
}

/// The generation field of the page record at `slug`.
fn generation(kv: &Arc<dyn Kv>, slug: &str) -> Option<u64> {
    let bytes = kv
        .snapshot()
        .unwrap()
        .get(&keys::page("default", slug))
        .unwrap()?;
    serde_json::from_slice::<Value>(&bytes).unwrap()["generation"].as_u64()
}

#[test]
fn each_new_page_takes_the_highest_generation_plus_one_and_gets_an_index_row() {
    let dir = TempDir::new("pagegen-insert");
    let (store, kv) = brain(&dir);
    let ids: Vec<u64> = ["notes/a", "notes/b", "notes/c"]
        .iter()
        .map(|slug| put(&store, slug, "body"))
        .collect();
    assert_eq!(generation(&kv, "notes/a"), Some(1));
    assert_eq!(generation(&kv, "notes/b"), Some(2));
    assert_eq!(generation(&kv, "notes/c"), Some(3));
    assert_eq!(index_rows(&kv), vec![(1, ids[0]), (2, ids[1]), (3, ids[2])]);
}

#[test]
fn a_generation_change_rewrites_the_index_row_and_a_purge_removes_it() {
    let dir = TempDir::new("pagegen-rewrite");
    let (store, kv) = brain(&dir);
    let a = put(&store, "notes/a", "one");
    let b = put(&store, "notes/b", "two");
    let c = put(&store, "notes/c", "three");
    // An edit moves a's row from generation 1 to 2: the old key is gone.
    put(&store, "notes/a", "one, edited");
    assert_eq!(index_rows(&kv), vec![(2, a), (2, b), (3, c)]);
    assert_eq!(generation(&kv, "notes/a"), Some(2));
    // A write that changes no watched column leaves the row where it is.
    store.add_tag("notes/a", "tag", None).unwrap();
    store.soft_delete_page("notes/b", None).unwrap();
    assert_eq!(index_rows(&kv), vec![(2, a), (3, b), (3, c)]);
    // A purge removes the page's row, a soft-deleted page's too.
    store.delete_page("notes/c", None).unwrap();
    assert_eq!(index_rows(&kv), vec![(2, a), (3, b)]);
    store.delete_page("notes/b", None).unwrap();
    assert_eq!(index_rows(&kv), vec![(2, a)]);
    // The number the purges freed is taken again.
    let d = put(&store, "notes/d", "four");
    assert_eq!(index_rows(&kv), vec![(2, a), (3, d)]);
    assert_eq!(generation(&kv, "notes/d"), Some(3));
}

#[test]
fn a_scan_of_the_index_range_returns_only_index_rows() {
    let dir = TempDir::new("pagegen-range");
    let (store, kv) = brain(&dir);
    for slug in ["notes/a", "notes/b"] {
        put(&store, slug, "body");
    }
    store.soft_delete_page("notes/a", None).unwrap();
    let rows = scan(&kv, INDEX);
    assert_eq!(rows.len(), 2);
    for (key, value) in rows {
        assert!(key.starts_with(INDEX) && key.len() == INDEX.len() + 16 && value.is_empty());
    }
    // The other metadata keys (id counters, the format record) are not in the range.
    assert!(!scan(&kv, b"Mnext_").is_empty());
    assert!(
        scan(&kv, b"Mnext_")
            .iter()
            .all(|(k, _)| !k.starts_with(INDEX))
    );
}

/// What the four scans that read every `P` key return: the access-flag scan (it runs when the brain opens), the
/// default-source split, the field usage samples and the page list (`all_pages`).
fn whole_p_scans(dir: &TempDir, kv: &Arc<dyn Kv>) -> Value {
    let store = Store::open_kv(kv.clone(), Arc::new(SystemEnv), OpenOptions::default()).unwrap();
    let split: DefaultSourceSplit = store.count_default_source_split().unwrap();
    let usage = store
        .read_field_usage_samples(&FieldUsageQuery::default())
        .unwrap();
    let listed = store.list_pages(&PageFilters::default()).unwrap();
    let _ = dir;
    json!({
        "split": [split.default_pages, split.non_default_pages, split.non_default_sources],
        "usage": usage,
        "slugs": listed.iter().map(|p| p["slug"].clone()).collect::<Vec<_>>(),
        "count": store.count_pages(None).unwrap(),
    })
}

#[test]
fn the_whole_page_scans_return_the_same_results_with_index_rows_present() {
    let dir = TempDir::new("pagegen-scans");
    let (store, kv) = brain(&dir);
    for slug in ["notes/a", "notes/b", "notes/c"] {
        put(&store, slug, "body");
    }
    store.soft_delete_page("notes/c", None).unwrap();
    drop(store);
    let rows = index_rows(&kv);
    assert_eq!(rows.len(), 3, "the pages have index rows");
    let with = whole_p_scans(&dir, &kv);
    // The same brain with its index rows taken out: the four scans read page records only, so nothing changes.
    let mut tx = kv.begin_write().unwrap();
    for (key, _) in scan(&kv, INDEX) {
        tx.delete(&key).unwrap();
    }
    tx.commit().unwrap();
    assert!(index_rows(&kv).is_empty());
    let without = whole_p_scans(&dir, &kv);
    assert_eq!(with, without);
    assert_eq!(with["count"], json!(2));
    let mut slugs = with["slugs"].as_array().unwrap().clone();
    slugs.sort_by_key(|s| s.as_str().unwrap().to_string());
    assert_eq!(slugs, vec![json!("notes/a"), json!("notes/b")]);
}
