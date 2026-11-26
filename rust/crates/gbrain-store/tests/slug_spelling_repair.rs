//! The reads of `gbrain repair slug-spelling` and its doctor check. Expected rows follow the SQL in
//! src/core/engine-sql/slug-spelling-repair.ts; the keys are what PGLite computes for
//! `SPELLING_KEY_SQL` and `SCAN_KEY_SQL` over the same text.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::slug_spelling_repair::{spelling_index_key, spelling_scan_key};
use gbrain_store::sources::SourceInput;
use serde_json::json;

fn put(store: &Store, source: &str, slug: &str) {
    let input: PageInput =
        serde_json::from_value(json!({ "type": "note", "title": slug, "compiled_truth": "body" }))
            .unwrap();
    let options: PutPageOptions =
        serde_json::from_value(json!({ "sourceId": source, "index": false })).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

fn seeded(dir: &TempDir) -> Store {
    let store = open(dir);
    store
        .upsert_source(&SourceInput {
            id: "other".into(),
            ..Default::default()
        })
        .unwrap();
    store
}

#[test]
fn the_keys_match_the_sql_keys() {
    // (slug, SPELLING_KEY_SQL, SCAN_KEY_SQL) as PGLite computes them.
    let cases = [
        ("Notes/Caf\u{e9}", "notes/caf\u{e9}", "notescaf"),
        ("notes/cafe\u{301}", "notes/caf\u{e9}", "notescaf"),
        (
            "People/\u{130}stanbul",
            "people/i\u{307}stanbul",
            "peopleistanbul",
        ),
        ("K\u{212A}elvin", "kkelvin", "kkelvin"),
        ("\u{c5}NGSTR\u{d6}M", "\u{c5}ngstr\u{d6}m", "ngstrm"),
        ("\u{65e5}\u{672c}/x1", "\u{65e5}\u{672c}/x1", "x1"),
        ("", "", ""),
    ];
    for (slug, index, scan) in cases {
        assert_eq!(
            (spelling_index_key(slug), spelling_scan_key(slug)),
            (index.to_string(), scan.to_string()),
            "{slug:?}"
        );
    }
}

#[test]
fn the_candidates_are_the_pages_with_a_capital_or_a_non_ascii_character() {
    let dir = TempDir::new("spelling-candidates");
    let store = seeded(&dir);
    for slug in [
        "notes/plain",
        "notes/caf\u{e9}",
        "people/\u{65e5}\u{672c}",
        "notes/ok-1",
    ] {
        put(&store, "default", slug);
    }
    put(&store, "other", "notes/na\u{ef}ve");
    store
        .soft_delete_page("people/\u{65e5}\u{672c}", Some("default"))
        .unwrap();

    let all = store.list_slug_spelling_candidates(0, 5000).unwrap();
    let slugs: Vec<(&str, &str)> = all
        .iter()
        .map(|r| (r.source_id.as_str(), r.slug.as_str()))
        .collect();
    assert_eq!(
        slugs,
        vec![
            ("default", "notes/caf\u{e9}"),
            ("default", "people/\u{65e5}\u{672c}"),
            ("other", "notes/na\u{ef}ve"),
        ]
    );
    // After the first id, and capped.
    let rest = store.list_slug_spelling_candidates(all[0].id, 1).unwrap();
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0].slug, "people/\u{65e5}\u{672c}");

    let source = store
        .list_source_slug_spelling_candidates("default", 0, 5000)
        .unwrap();
    assert_eq!(source.len(), 2);
    assert_eq!(
        (source[1].slug.as_str(), source[1].deleted),
        ("people/\u{65e5}\u{672c}", true)
    );
    assert!(!source[0].deleted && !source[0].revision.is_empty());
    assert!(
        store
            .list_source_slug_spelling_candidates("ghost", 0, 5000)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn the_key_pages_match_by_index_key_or_by_scan_key_and_leave_out_the_page_asked_about() {
    let dir = TempDir::new("spelling-key-pages");
    let store = seeded(&dir);
    put(&store, "default", "notes/caf\u{e9}");
    put(&store, "default", "notes/cafe");
    put(&store, "other", "notes/caf\u{e9}");
    let page = store
        .list_source_slug_spelling_candidates("default", 0, 10)
        .unwrap()[0]
        .id;

    let keys = vec!["notes/caf\u{e9}".to_string()];
    assert!(
        store
            .read_spelling_key_pages("default", Some(&keys), "", page)
            .unwrap()
            .is_empty()
    );
    let with_it = store
        .read_spelling_key_pages("default", Some(&keys), "", 0)
        .unwrap();
    assert_eq!(with_it.len(), 1);
    assert_eq!(with_it[0].slug, "notes/caf\u{e9}");
    // The scan key drops the accent, so `notes/cafe` shares it.
    let scanned = store
        .read_spelling_key_pages("default", None, "notescaf", 0)
        .unwrap();
    assert_eq!(
        scanned.iter().map(|p| p.slug.as_str()).collect::<Vec<_>>(),
        vec!["notes/caf\u{e9}"]
    );
    let scanned_e = store
        .read_spelling_key_pages("default", None, "notescafe", 0)
        .unwrap();
    assert_eq!(scanned_e.len(), 1);
}

#[test]
fn the_source_row_and_the_page_slug_reads() {
    let dir = TempDir::new("spelling-source");
    let store = seeded(&dir);
    put(&store, "default", "notes/a");
    let source = store.read_slug_repair_source("default").unwrap().unwrap();
    assert!(!source.incarnation.is_empty());
    assert_eq!(source.slug_root_mode, None);
    assert!(store.read_slug_repair_source("ghost").unwrap().is_none());
    // `notes/a` is normal ASCII, so it is no candidate; its id comes from the scan-key read.
    assert!(
        store
            .list_slug_spelling_candidates(0, 10)
            .unwrap()
            .is_empty()
    );
    let id = store
        .read_spelling_key_pages("default", None, "notesa", 0)
        .unwrap()[0]
        .id;
    assert_eq!(
        store.read_page_slug_in_source(id, "default").unwrap(),
        Some("notes/a".to_string())
    );
    assert_eq!(store.read_page_slug_in_source(id, "other").unwrap(), None);
    assert_eq!(
        store.read_page_slug_in_source(987_654, "default").unwrap(),
        None
    );
    let page = store.read_slug_repair_page(id, "default").unwrap().unwrap();
    assert_eq!((page.slug.as_str(), page.deleted), ("notes/a", false));
    assert!(!page.revision.is_empty());
    assert!(store.read_slug_repair_page(id, "other").unwrap().is_none());
}
