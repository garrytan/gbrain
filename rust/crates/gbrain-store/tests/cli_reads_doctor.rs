//! The doctor reads (`cli_reads/doctor.rs`): the PGLite semantics of each.

use gbrain_store::env::uuid_from_bytes;
use gbrain_store::keys;
use gbrain_store::kv::Kv;
use gbrain_store::links::AddLinkOptions;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::raw_files::FileSpec;
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::takes::TakeInput;
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput};
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

/// A store and its record file, so a case can remove a page's id key as a torn write would.
fn brain(name: &str) -> (Store, Arc<RedbKv>) {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "doctor-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let kv = Arc::new(RedbKv::open_path(&dir.join("records.redb")).unwrap());
    let store = Store::open_kv(
        kv.clone(),
        Arc::new(Clock(AtomicU64::new(1))),
        OpenOptions::default(),
    )
    .unwrap();
    (store, kv)
}

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(s: &Store, slug: &str) -> i64 {
    let input: PageInput = args(json!({ "type": "note", "title": slug, "compiled_truth": "body" }));
    s.put_page(slug, &input, &PutPageOptions::default())
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

const TARGETS: [&str; 9] = [
    "page_versions.page_id",
    "tags.page_id",
    "takes.page_id",
    "raw_data.page_id",
    "timeline_entries.page_id",
    "links.from_page_id",
    "links.to_page_id",
    "links.origin_page_id",
    "files.page_id",
];

fn counts(s: &Store) -> Vec<(&'static str, u64)> {
    TARGETS
        .iter()
        .map(|t| (*t, s.count_page_child_orphans(t).unwrap()))
        .collect()
}

/// Writes one row of every page-child relation that names `slug` (and links from, to and with
/// origin `slug`).
fn children(s: &Store, slug: &str, id: i64, other: &str) {
    s.create_version(slug, None).unwrap();
    s.put_raw_data(slug, Some("crm"), Some(r#"{"id":1}"#), None)
        .unwrap();
    let entry: TimelineInput = args(json!({ "date": "2026-04-03", "summary": "met" }));
    s.add_timeline_entry(slug, &entry, &AddTimelineOptions::default())
        .unwrap();
    let take: TakeInput = args(
        json!({ "page_id": id, "row_num": 1, "claim": "ships", "kind": "bet", "holder": "self", "weight": 0.5, "active": true }),
    );
    s.add_takes_batch(&[take]).unwrap();
    let origin: AddLinkOptions =
        args(json!({ "linkType": "works_at", "originSlug": slug, "originField": "company" }));
    s.add_link(slug, other, &origin).unwrap();
    s.add_link(other, slug, &AddLinkOptions::default()).unwrap();
    let file: FileSpec = args(
        json!({ "page_slug": slug, "page_id": id, "filename": "a.png", "storage_path": format!("assets/{slug}.png"), "content_hash": "h", "metadata": "{}" }),
    );
    s.upsert_file(&file).unwrap();
}

#[test]
fn page_child_orphans_count_rows_whose_page_is_gone() {
    let (s, kv) = brain("orphans");
    let zero: Vec<(&str, u64)> = TARGETS.iter().map(|t| (*t, 0)).collect();
    assert_eq!(counts(&s), zero);
    let alice = page(&s, "people/alice-example");
    page(&s, "companies/acme-example");
    children(&s, "people/alice-example", alice, "companies/acme-example");
    assert_eq!(counts(&s), zero, "every child row has its page");

    // A delete cascades, as the FK does on Postgres.
    let bob = page(&s, "people/bob-example");
    children(&s, "people/bob-example", bob, "companies/acme-example");
    s.delete_page("people/bob-example", None).unwrap();
    assert_eq!(counts(&s), zero, "a deleted page leaves no child rows");

    // A page record gone without its cascade (a torn write): each relation that names it counts.
    let mut tx = kv.begin_write().unwrap();
    tx.delete(&keys::page_id(alice as u64)).unwrap();
    tx.commit().unwrap();
    let torn = counts(&s);
    let expected: Vec<(&str, u64)> = vec![
        ("page_versions.page_id", 1),
        ("tags.page_id", 0),
        ("takes.page_id", 1),
        ("raw_data.page_id", 1),
        ("timeline_entries.page_id", 1),
        ("links.from_page_id", 1),
        ("links.to_page_id", 1),
        ("links.origin_page_id", 1),
        ("files.page_id", 1),
    ];
    assert_eq!(torn, expected);
}

#[test]
fn page_child_orphans_refuse_an_unknown_target() {
    let (s, _kv) = brain("unknown");
    let err = s
        .count_page_child_orphans("content_chunks.page_id")
        .unwrap_err();
    assert!(err.to_string().contains("not a page child target"), "{err}");
}
