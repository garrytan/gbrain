//! The doctor brain reads (`cli_reads/doctor_brain.rs`): the PGLite semantics of each.

use gbrain_store::cli_reads::doctor_brain::InterimQuery;
use gbrain_store::env::uuid_from_bytes;
use gbrain_store::facts::{ExpireFactArgs, InsertFactArgs};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::sources::SourceInput;
use gbrain_store::{Env, OpenOptions, Store};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);
const START: i64 = 1_800_000_000_000_000;
const DAY: i64 = 86_400_000_000;

struct Clock {
    now: AtomicI64,
    ids: AtomicU64,
}

impl Env for Clock {
    fn now_micros(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        let n = self.ids.fetch_add(1, Ordering::SeqCst);
        let mut bytes = [0u8; 16];
        bytes[8..].copy_from_slice(&n.to_be_bytes());
        uuid_from_bytes(bytes)
    }
}

fn brain(name: &str) -> (Store, Arc<Clock>) {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "doctor-brain-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let kv = Arc::new(RedbKv::open_path(&dir.join("records.redb")).unwrap());
    let clock = Arc::new(Clock {
        now: AtomicI64::new(START),
        ids: AtomicU64::new(1),
    });
    let store = Store::open_kv(kv, clock.clone(), OpenOptions::default()).unwrap();
    (store, clock)
}

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn source(s: &Store, id: &str) {
    let input: SourceInput = args(json!({ "id": id }));
    s.upsert_source(&input).unwrap();
}

fn put(s: &Store, source_id: &str, slug: &str, page_type: &str, frontmatter: Value) {
    let input: PageInput = args(
        json!({ "type": page_type, "title": slug, "compiled_truth": "body", "frontmatter": frontmatter }),
    );
    let options: PutPageOptions = args(json!({ "sourceId": source_id }));
    s.put_page(slug, &input, &options).unwrap();
}

fn query(shelf: &str) -> InterimQuery {
    args(
        json!({ "type": "stored-object", "shelfSourceId": shelf, "prefix": "storage-manifest/", "adoptedTag": "adopted" }),
    )
}

#[test]
fn interim_stored_objects_count_live_untagged_pages_outside_the_shelf_per_source() {
    let (s, _) = brain("interim");
    assert!(
        s.list_interim_stored_object_counts(&query("storage"))
            .unwrap()
            .is_empty()
    );
    source(&s, "zeta");
    source(&s, "alpha");
    source(&s, "storage");
    for (src, slug) in [
        ("zeta", "storage-manifest/a"),
        ("zeta", "storage-manifest/b"),
        ("alpha", "storage-manifest/c"),
        ("storage", "storage-manifest/shelf"),
    ] {
        put(&s, src, slug, "stored-object", json!({}));
    }
    put(
        &s,
        "alpha",
        "storage-manifest/index",
        "stored-object",
        json!({}),
    );
    put(&s, "alpha", "elsewhere/d", "stored-object", json!({}));
    put(&s, "alpha", "storage-manifest/note", "note", json!({}));
    put(
        &s,
        "alpha",
        "storage-manifest/gone",
        "stored-object",
        json!({}),
    );
    s.soft_delete_page("storage-manifest/gone", Some("alpha"))
        .unwrap();
    put(
        &s,
        "alpha",
        "storage-manifest/adopted",
        "stored-object",
        json!({}),
    );
    s.add_tag("storage-manifest/adopted", "adopted", Some("alpha"))
        .unwrap();
    let got: Vec<(String, i64)> = s
        .list_interim_stored_object_counts(&query("storage"))
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["source_id"].as_str().unwrap().to_owned(),
                r["n"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(got, vec![("alpha".to_owned(), 1), ("zeta".to_owned(), 2)]);
}

#[test]
fn the_oldest_source_and_the_maturity_row_follow_the_first_timestamp() {
    let (s, clock) = brain("maturity");
    // A fresh brain holds the default source, created when the store opened.
    let first = s.read_oldest_source_created_at().unwrap().unwrap();
    assert!(first.starts_with("2027-01-15T"), "{first}");
    clock.now.store(START + DAY, Ordering::SeqCst);
    source(&s, "later");
    assert_eq!(s.read_oldest_source_created_at().unwrap().unwrap(), first);
    let empty = s.read_brain_maturity().unwrap();
    assert_eq!(
        (empty["pages"].as_i64(), empty["facts"].as_i64()),
        (Some(0), Some(0))
    );
    assert_eq!(empty["since"].as_str().unwrap(), first);

    put(&s, "default", "notes/a", "note", json!({}));
    put(&s, "default", "notes/b", "note", json!({}));
    s.soft_delete_page("notes/b", None).unwrap();
    let kept: i64 = s
        .insert_fact(&args::<InsertFactArgs>(
            json!({ "input": { "fact": "kept", "source": "chat" }, "sourceId": "default" }),
        ))
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    let gone: i64 = s
        .insert_fact(&args::<InsertFactArgs>(
            json!({ "input": { "fact": "gone", "source": "chat" }, "sourceId": "default" }),
        ))
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    assert!(
        s.expire_fact(&args::<ExpireFactArgs>(json!({ "id": gone })))
            .unwrap()
    );
    assert_ne!(kept, gone);
    let row = s.read_brain_maturity().unwrap();
    assert_eq!(
        (row["pages"].as_i64(), row["facts"].as_i64()),
        (Some(1), Some(1))
    );
    assert_eq!(row["since"].as_str().unwrap(), first);
}

fn slugs(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .map(|r| {
            format!(
                "{}/{}",
                r["source_id"].as_str().unwrap(),
                r["slug"].as_str().unwrap()
            )
        })
        .collect()
}

#[test]
fn visibility_candidates_are_live_pages_of_live_sources_with_a_non_private_visibility_key() {
    let (s, _) = brain("visibility");
    assert!(s.list_visibility_candidate_pages(None).unwrap().is_empty());
    source(&s, "other");
    source(&s, "old");
    put(
        &s,
        "default",
        "b/public",
        "note",
        json!({ "visibility": "public" }),
    );
    put(
        &s,
        "default",
        "a/shouty",
        "note",
        json!({ "Visibility": "world" }),
    );
    put(
        &s,
        "default",
        "c/private",
        "note",
        json!({ "visibility": "private" }),
    );
    put(&s, "default", "d/none", "note", json!({ "other": 1 }));
    put(
        &s,
        "default",
        "e/null",
        "note",
        json!({ "visibility": null }),
    );
    put(
        &s,
        "default",
        "f/number",
        "note",
        json!({ "visibility": 3 }),
    );
    put(
        &s,
        "default",
        "g/gone",
        "note",
        json!({ "visibility": "public" }),
    );
    s.soft_delete_page("g/gone", None).unwrap();
    put(
        &s,
        "other",
        "a/other",
        "note",
        json!({ "visibility": "team" }),
    );
    put(
        &s,
        "old",
        "a/archived",
        "note",
        json!({ "visibility": "team" }),
    );
    assert!(s.set_source_archived("old", true).unwrap());
    let all = s.list_visibility_candidate_pages(None).unwrap();
    assert_eq!(
        slugs(&all),
        [
            "default/a/shouty",
            "default/b/public",
            "default/e/null",
            "default/f/number",
            "other/a/other"
        ]
    );
    // The exact-case key reads as text: the upper-case key has no `visibility` value, so it is not private.
    assert_eq!(all[0]["frontmatter"], json!({ "Visibility": "world" }));
    let narrowed = s
        .list_visibility_candidate_pages(Some(&["other".to_owned()]))
        .unwrap();
    assert_eq!(slugs(&narrowed), ["other/a/other"]);
}
