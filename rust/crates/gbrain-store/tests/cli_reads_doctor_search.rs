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

fn slugs(rows: &[Value], key: &str) -> Vec<String> {
    rows.iter()
        .map(|r| r[key].as_str().unwrap().to_owned())
        .collect()
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

/// A raw `content` of `n` characters with an H2 heading.
fn raw_content(n: usize) -> String {
    format!("intro\n## Heading\n{}", "x".repeat(n))
}

fn put_raw(s: &Store, slug: &str, content: &str) {
    s.put_raw_data(
        slug,
        Some("import"),
        Some(&json!({ "content": content }).to_string()),
        None,
    )
    .unwrap();
}

#[test]
fn truncated_bodies_need_long_raw_content_with_a_heading_and_a_body_under_thirty_percent() {
    let s = brain("truncated");
    assert!(s.list_truncated_markdown_bodies().unwrap().is_empty());
    put(&s, "notes/short-body", json!({ "compiled_truth": "tiny" }));
    put_raw(&s, "notes/short-body", &raw_content(2000));
    // A body at 30% or more of the raw text is complete enough.
    put(
        &s,
        "notes/full-body",
        json!({ "compiled_truth": "y".repeat(800) }),
    );
    put_raw(&s, "notes/full-body", &raw_content(2000));
    // No heading, raw text of 1000 characters or fewer, and a one-hash line never qualify.
    put(&s, "notes/no-heading", json!({ "compiled_truth": "tiny" }));
    put_raw(&s, "notes/no-heading", &"z".repeat(3000));
    put(&s, "notes/small-raw", json!({ "compiled_truth": "tiny" }));
    put_raw(&s, "notes/small-raw", &format!("## H\n{}", "x".repeat(990)));
    put(&s, "notes/one-hash", json!({ "compiled_truth": "tiny" }));
    put_raw(&s, "notes/one-hash", &format!("# H\n{}", "x".repeat(2000)));
    put(
        &s,
        "notes/hash-no-space",
        json!({ "compiled_truth": "tiny" }),
    );
    put_raw(
        &s,
        "notes/hash-no-space",
        &format!("##H\n{}", "x".repeat(2000)),
    );
    // A heading on the first line counts; a soft-deleted page is still listed (the SQL has no filter).
    put(&s, "notes/first-line", json!({ "compiled_truth": "tiny" }));
    put_raw(
        &s,
        "notes/first-line",
        &format!("### H\n{}", "x".repeat(2000)),
    );
    put(&s, "notes/gone", json!({ "compiled_truth": "tiny" }));
    put_raw(&s, "notes/gone", &raw_content(2000));
    s.soft_delete_page("notes/gone", None).unwrap();
    let rows = s.list_truncated_markdown_bodies().unwrap();
    assert_eq!(
        slugs(&rows, "slug"),
        ["notes/short-body", "notes/first-line", "notes/gone"]
    );
    assert_eq!(rows[0]["body_len"], 4);
    assert_eq!(rows[0]["raw_len"], raw_content(2000).chars().count());
}

#[test]
fn segmented_markdown_bodies_count_only_segmented_pages() {
    let s = brain("segmented-md");
    assert_eq!(s.count_segmented_markdown_bodies().unwrap(), 0);
    put(&s, "notes/inline", json!({}));
    put_raw(&s, "notes/inline", &raw_content(2000));
    assert_eq!(s.count_segmented_markdown_bodies().unwrap(), 0);
}

#[test]
fn recent_bodies_are_the_newest_live_pages_in_scope_and_none_are_segmented_inline() {
    let s = brain("recent");
    assert!(s.list_recent_page_bodies(None).unwrap().is_empty());
    put(
        &s,
        "notes/a",
        json!({ "compiled_truth": "first", "timeline": "t1" }),
    );
    put(&s, "notes/b", json!({ "compiled_truth": "second" }));
    put(&s, "notes/gone", json!({ "compiled_truth": "gone" }));
    s.soft_delete_page("notes/gone", None).unwrap();
    let rows = s.list_recent_page_bodies(None).unwrap();
    assert_eq!(
        rows,
        vec![
            json!({ "compiled_truth": "second", "timeline": "" }),
            json!({ "compiled_truth": "first", "timeline": "t1" }),
        ]
    );
    assert!(
        s.list_recent_page_bodies(Some(vec!["other".into()]))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        s.list_recent_page_bodies(Some(vec!["default".into()]))
            .unwrap()
            .len(),
        2
    );
    assert_eq!(s.count_segmented_recent_pages(None).unwrap(), 0);
}

#[test]
fn hidden_by_prefix_counts_served_chunked_pages_under_the_pattern() {
    let s = brain("hidden");
    assert_eq!(
        s.count_pages_hidden_by_prefix("test/%".into(), None)
            .unwrap(),
        0
    );
    for slug in ["test/a", "test/b", "test/gone", "notes/x", "test_under/a"] {
        put(&s, slug, json!({}));
    }
    // A page with no text has no chunk.
    put(&s, "test/unchunked", json!({ "compiled_truth": "" }));
    put(
        &s,
        "test/quarantined",
        json!({ "frontmatter": { "quarantine": {} } }),
    );
    put(
        &s,
        "test/pinned",
        json!({ "frontmatter": { "pinned_question": true } }),
    );
    s.soft_delete_page("test/gone", None).unwrap();
    let count = |pattern: &str, sources: Option<Vec<String>>| {
        s.count_pages_hidden_by_prefix(pattern.into(), sources)
            .unwrap()
    };
    assert_eq!(count("test/%", None), 2);
    // `_` is a wildcard unless escaped, so the escaped pattern matches only the literal underscore.
    assert_eq!(count("test_%", None), 3);
    assert_eq!(count("test\\_%", None), 1);
    assert_eq!(count("test/%", Some(vec!["default".into()])), 2);
    assert_eq!(count("test/%", Some(vec!["other".into()])), 0);
    s.set_source_archived("default", true).unwrap();
    assert_eq!(count("test/%", None), 0);
}

#[test]
fn git_image_hold_counts_read_the_summary_checkpoint_of_each_current_incarnation() {
    use gbrain_store::cli_reads::doctor_checkpoints::LastKnownWrite;
    let s = brain("image-holds");
    let ids = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();
    // No checkpoint, and no source ids: nothing is listed.
    assert_eq!(
        s.list_git_image_hold_counts(ids(&["default"])).unwrap(),
        Vec::<Value>::new()
    );
    assert_eq!(
        s.list_git_image_hold_counts(vec![]).unwrap(),
        Vec::<Value>::new()
    );
    for id in ["other", "quiet"] {
        s.upsert_source(&args(json!({ "id": id, "name": id })))
            .unwrap();
    }
    let fingerprint = |id: &str| {
        format!(
            "{id}:{}",
            s.get_source_by_id(id).unwrap().unwrap().incarnation
        )
    };
    let write = |entry: String, value: Value| {
        s.write_doctor_last_known(&args::<LastKnownWrite>(
            json!({ "op": "sync-hold-summary", "rows": [{ "entry": entry, "value": value }] }),
        ))
        .unwrap();
    };
    write(fingerprint("default"), json!({ "count": 3, "images": 2 }));
    write(fingerprint("other"), json!({ "count": 1, "images": "4" }));
    write(fingerprint("quiet"), json!({ "count": 1, "images": 0 }));
    // A summary of a past incarnation of the source does not count.
    write(
        "default:00000000-0000-0000-0000-00000000dead".into(),
        json!({ "images": 9 }),
    );
    let rows = s
        .list_git_image_hold_counts(ids(&["default", "other", "quiet", "absent"]))
        .unwrap();
    assert_eq!(
        rows,
        vec![
            json!({ "source_id": "default", "images": 2 }),
            json!({ "source_id": "other", "images": 4 }),
        ]
    );
    assert_eq!(
        s.list_git_image_hold_counts(ids(&["other"])).unwrap(),
        vec![json!({ "source_id": "other", "images": 4 })]
    );
}
