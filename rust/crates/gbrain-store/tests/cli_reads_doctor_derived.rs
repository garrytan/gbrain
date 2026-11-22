//! The doctor-derived reads (`cli_reads/doctor_derived.rs`): the PGLite semantics of each.

use gbrain_store::env::uuid_from_bytes;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::raw_files::FileSpec;
use gbrain_store::redb_kv::RedbKv;
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
        "doctor-derived-{name}-{}-{}",
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

fn put(s: &Store, slug: &str, extra: Value) -> i64 {
    let mut input =
        json!({ "type": "note", "title": slug, "compiled_truth": format!("{slug} body") });
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let input: PageInput = args(input);
    // `index: false`: an indexed write seals the page at the safe fence version.
    let options = PutPageOptions {
        index: Some(false),
        ..PutPageOptions::default()
    };
    s.put_page(slug, &input, &options).unwrap()["id"]
        .as_i64()
        .unwrap()
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn safe_index_pending_counts_live_pages_below_the_fence() {
    let (s, _) = brain("safe-index");
    assert_eq!(
        s.count_safe_index_pending(None).unwrap(),
        json!({ "rebuildable": 0, "kept": 0 })
    );
    put(&s, "notes/old-a", json!({ "chunker_version": 1 }));
    put(&s, "notes/old-b", json!({ "chunker_version": 3 }));
    put(&s, "notes/new", json!({ "chunker_version": 4 }));
    put(&s, "notes/gone", json!({ "chunker_version": 1 }));
    // A code page with neither a `file` frontmatter key nor a source path is kept, not rebuilt.
    put(
        &s,
        "code/orphan",
        json!({ "page_kind": "code", "type": "code", "chunker_version": 1 }),
    );
    s.soft_delete_page("notes/gone", None).unwrap();
    let want = json!({ "rebuildable": 3, "kept": 1 });
    assert_eq!(s.count_safe_index_pending(None).unwrap(), want);
    assert_eq!(
        s.count_safe_index_pending(Some(&strings(&["default"])))
            .unwrap(),
        want
    );
    assert_eq!(
        s.count_safe_index_pending(Some(&strings(&["nowhere"])))
            .unwrap(),
        json!({ "rebuildable": 0, "kept": 0 })
    );
}

#[test]
fn pages_by_type_and_owner_split_live_pages_by_writer() {
    let (s, _) = brain("type-owner");
    assert!(s.count_pages_by_type_and_owner(None).unwrap().is_empty());
    put(&s, "notes/a", json!({}));
    put(&s, "notes/b", json!({}));
    put(&s, "notes/gone", json!({}));
    put(
        &s,
        "extracts/r1",
        json!({ "type": "extract_receipt", "frontmatter": { "dream_generated": "true" } }),
    );
    put(&s, "extracts/r2", json!({ "type": "extract_receipt" }));
    s.soft_delete_page("notes/gone", None).unwrap();
    let rows = s.count_pages_by_type_and_owner(None).unwrap();
    assert_eq!(
        rows,
        vec![
            json!({ "src": "default", "type": "extract_receipt", "own": null, "n": "1" }),
            json!({ "src": "default", "type": "extract_receipt", "own": true, "n": "1" }),
            json!({ "src": "default", "type": "note", "own": false, "n": "2" }),
        ]
    );
    assert_eq!(
        s.count_pages_by_type_and_owner(Some(&strings(&["default"])))
            .unwrap(),
        rows
    );
    assert!(
        s.count_pages_by_type_and_owner(Some(&strings(&["nowhere"])))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn image_asset_files_list_image_rows_in_file_order() {
    let (s, _) = brain("images");
    assert!(s.list_image_asset_files().unwrap().is_empty());
    let id = put(
        &s,
        "notes/photo",
        json!({ "source_path": "notes/photo.md" }),
    );
    for (name, mime) in [
        ("a.png", "image/png"),
        ("b.txt", "text/plain"),
        ("c.jpg", "image/jpeg"),
    ] {
        let file: FileSpec = args(json!({
            "page_slug": "notes/photo", "page_id": id, "filename": name, "storage_path": format!("assets/{name}"),
            "content_hash": name, "mime_type": mime, "metadata": "{\"alt\":\"x\"}",
        }));
        s.upsert_file(&file).unwrap();
    }
    let rows = s.list_image_asset_files().unwrap();
    let paths: Vec<&str> = rows
        .iter()
        .map(|r| r["storage_path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["assets/a.png", "assets/c.jpg"]);
    assert_eq!(rows[0]["page_source_path"], "notes/photo.md");
    assert_eq!(rows[0]["metadata"], json!({ "alt": "x" }));
    assert!(rows[0]["source_local_path"].is_null());
}

#[test]
fn restorable_atom_retirements_group_per_source() {
    let (s, _) = brain("retirements");
    let sources = strings(&["default"]);
    assert!(
        s.list_restorable_atom_retirements(&sources)
            .unwrap()
            .is_empty()
    );
    put(&s, "notes/origin", json!({}));
    let retired = json!({ "retired_by": "managed-reextract", "source_slug": "notes/origin", "source_hash": "h1", "retired_at": "2026-01-01T00:00:00.000Z" });
    let mut pending = retired.clone();
    pending["source_hash"] = json!("pending:h1");
    pending["retired_at"] = json!("2026-02-01T00:00:00.000Z");
    let mut lost = retired.clone();
    lost["source_slug"] = json!("notes/missing");
    for (slug, fm) in [
        ("atoms/a1", retired),
        ("atoms/a2", pending),
        ("atoms/a3", lost),
    ] {
        put(&s, slug, json!({ "type": "atom", "frontmatter": fm }));
        s.soft_delete_page(slug, None).unwrap();
    }
    let rows = s.list_restorable_atom_retirements(&sources).unwrap();
    assert_eq!(
        rows,
        vec![json!({
            "source_id": "default", "count": 2, "origins": 1,
            "oldest": "2026-01-01T00:00:00.000Z", "newest": "2026-02-01T00:00:00.000Z",
            // The Clock env sits at 1_800_000_000 s (2027-01-15T08:00:00Z); the hold runs 30 days from the delete.
            "hold_until": "2027-02-14T08:00:00Z",
        })]
    );
    assert!(
        s.list_restorable_atom_retirements(&strings(&["nowhere"]))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn timeline_history_batch_pages_inline_pages_with_own_rows() {
    let (s, _) = brain("timeline-batch");
    let sources = strings(&["default"]);
    assert!(
        s.list_timeline_history_batch(&sources, 0)
            .unwrap()
            .is_empty()
    );
    let t1 = put(
        &s,
        "notes/t1",
        json!({ "timeline": "- **2026-01-02** | met" }),
    );
    put(&s, "notes/t2", json!({}));
    put(&s, "notes/none", json!({}));
    for (slug, day) in [("notes/t1", "2026-01-02"), ("notes/t2", "2026-02-03")] {
        let entry: TimelineInput = args(json!({ "date": day, "summary": "met" }));
        s.add_timeline_entry(slug, &entry, &AddTimelineOptions::default())
            .unwrap();
    }
    let first = s.list_timeline_history_batch(&sources, 0).unwrap();
    let slugs: Vec<&str> = first.iter().map(|r| r["slug"].as_str().unwrap()).collect();
    assert_eq!(slugs, ["notes/t1", "notes/t2"]);
    assert_eq!(first[0]["timeline"], "- **2026-01-02** | met");
    assert_eq!(
        s.list_timeline_history_batch(&sources, t1).unwrap().len(),
        1
    );
    assert!(
        s.list_timeline_history_batch(&strings(&["nowhere"]), 0)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn atom_fence_candidates_and_compiled_truths() {
    let (s, _) = brain("atom-fence");
    let atoms = |atom_id: Option<i64>, after: i64| -> Vec<Value> {
        let q: gbrain_store::repair_fence_scans::AtomFenceQuery = serde_json::from_value(json!({
            "atom_id": atom_id, "after_id": after, "limit": 10,
        }))
        .unwrap();
        let rows = s
            .list_atom_fence_candidates(&strings(&["default"]), &q)
            .unwrap();
        serde_json::to_value(rows)
            .unwrap()
            .as_array()
            .unwrap()
            .clone()
    };
    assert!(atoms(None, 0).is_empty());
    let fenced = put(
        &s,
        "notes/origin",
        json!({ "compiled_truth": "before\n<!-- gbrain:facts:begin -->\nx" }),
    );
    let plain = put(&s, "notes/origin-plain", json!({}));
    let one = put(
        &s,
        "atoms/one",
        json!({ "type": "atom", "compiled_truth": "claim one",
        "frontmatter": { "visibility": "world", "source_slug": "notes/origin", "source_quote": "q" } }),
    );
    put(
        &s,
        "atoms/two",
        json!({ "type": "atom", "frontmatter": { "visibility": "world", "source_slug": "notes/origin-plain" } }),
    );
    put(
        &s,
        "atoms/three",
        json!({ "type": "atom", "frontmatter": { "visibility": "private", "source_slug": "notes/origin" } }),
    );
    let rows = atoms(None, 0);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], one);
    assert_eq!(rows[0]["origin_id"], fenced);
    assert_eq!(rows[0]["text"], "atoms/one\nclaim one\nq");
    assert_eq!(rows[0]["origin_unread"], false);
    assert_eq!(atoms(Some(one), 0).len(), 1);
    assert!(atoms(None, one).is_empty());
    let truths = s.read_page_compiled_truths(&[plain, fenced, 9999]).unwrap();
    assert_eq!(
        truths,
        vec![
            json!({ "id": fenced, "body": "before\n<!-- gbrain:facts:begin -->\nx" }),
            json!({ "id": plain, "body": "notes/origin-plain body" }),
        ]
    );
}
