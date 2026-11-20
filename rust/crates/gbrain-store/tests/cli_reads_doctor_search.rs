//! The doctor search-and-knowledge reads (`cli_reads/doctor_search.rs`): the PGLite semantics of each.

use gbrain_store::env::uuid_from_bytes;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{Env, OpenOptions, Store};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);

struct Clock(AtomicU64);

impl Env for Clock {
    fn now_micros(&self) -> i64 {
        1_800_000_000_000_000
    }
    fn new_uuid(&self) -> String {
        let n = self.0.fetch_add(1, Ordering::SeqCst);
        let mut bytes = [0u8; 16];
        bytes[8..].copy_from_slice(&n.to_be_bytes());
        uuid_from_bytes(bytes)
    }
}

fn brain(name: &str) -> Store {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "doctor-search-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let kv = Arc::new(RedbKv::open_path(&dir.join("records.redb")).unwrap());
    Store::open_kv(
        kv,
        Arc::new(Clock(AtomicU64::new(1))),
        OpenOptions::default(),
    )
    .unwrap()
}

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// Writes a page from the fields of `input` (a JSON object merged over type, title and body) and returns its id.
fn put(s: &Store, slug: &str, input: Value) -> i64 {
    let mut base = json!({ "type": "note", "title": slug, "compiled_truth": "body" });
    for (k, v) in input.as_object().unwrap() {
        base[k] = v.clone();
    }
    let input: PageInput = args(base);
    s.put_page(slug, &input, &PutPageOptions::default())
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn orphaned_alias_counts_cover_both_tables_per_source_and_ignore_soft_deleted_targets() {
    let s = brain("orphans");
    assert!(s.list_orphaned_alias_counts().unwrap().is_empty());
    put(&s, "notes/a", json!({}));
    s.update_slug("notes/a", "notes/b", None).unwrap();
    // The redirect's canonical page is live: not an orphan.
    assert!(s.list_orphaned_alias_counts().unwrap().is_empty());
    s.delete_page("notes/b", None).unwrap();
    s.set_page_aliases(
        "people/ghost",
        "default",
        &strings(&["ghost one", "ghost two"]),
    )
    .unwrap();
    let rows = s.list_orphaned_alias_counts().unwrap();
    assert_eq!(
        rows,
        vec![json!({ "source_id": "default", "slug_redirects": 1, "page_aliases": 2 })]
    );
}

#[test]
fn soft_deleted_alias_counts_count_alias_rows_whose_page_is_soft_deleted() {
    let s = brain("soft");
    assert_eq!(
        s.read_soft_deleted_alias_counts().unwrap(),
        json!({ "slug_redirects": 0, "page_aliases": 0 })
    );
    put(&s, "notes/a", json!({}));
    put(&s, "people/jane", json!({}));
    s.update_slug("notes/a", "notes/b", None).unwrap();
    s.set_page_aliases("people/jane", "default", &strings(&["jane"]))
        .unwrap();
    s.soft_delete_page("notes/b", None).unwrap();
    s.soft_delete_page("people/jane", None).unwrap();
    assert_eq!(
        s.read_soft_deleted_alias_counts().unwrap(),
        json!({ "slug_redirects": 1, "page_aliases": 1 })
    );
}

#[test]
fn page_type_pairs_are_distinct_live_source_type_pairs_in_bytewise_order() {
    let s = brain("pairs");
    assert!(s.list_page_type_pairs().unwrap().is_empty());
    put(&s, "notes/a", json!({}));
    put(&s, "notes/b", json!({}));
    put(&s, "people/jane", json!({ "type": "person" }));
    put(&s, "people/gone", json!({ "type": "ghost" }));
    s.soft_delete_page("people/gone", None).unwrap();
    assert_eq!(
        s.list_page_type_pairs().unwrap(),
        vec![
            json!({ "source_id": "default", "type": "note" }),
            json!({ "source_id": "default", "type": "person" }),
        ]
    );
}
