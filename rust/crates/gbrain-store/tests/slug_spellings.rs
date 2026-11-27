//! The stored-spelling scan (`readStoredSlugSpellings`). Expected keys and rows follow `SPELLING_KEY_SQL` and the
//! statement in src/core/engine-sql/slug-spellings.ts; the keys below are what PGLite computes for the same text.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::slug_spellings::{STORED_SPELLINGS_PAGE, spelling_key};
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

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}

#[test]
fn the_key_matches_the_sql_key() {
    // Each pair is PGLite's answer to SPELLING_KEY_SQL for the same slug text.
    let cases = [
        ("notes/cafe", "notescafe"),
        ("Notes/Caf\u{e9}", "notescaf"),
        ("notes/cafe\u{301}", "notescaf"),
        ("People/\u{130}stanbul", "peopleistanbul"),
        ("K\u{212A}elvin", "kkelvin"),
        ("a-b_c.d/E9", "abcde9"),
        ("\u{65e5}\u{672c}/x1", "x1"),
        ("\u{c5}NGSTR\u{d6}M", "ngstrm"),
        ("stra\u{df}e", "strae"),
        ("\u{fb01}le", "le"),
        ("", ""),
    ];
    for (slug, key) in cases {
        assert_eq!(spelling_key(slug), key, "{slug:?}");
    }
}

#[test]
fn the_scan_lists_every_slug_with_the_key_in_byte_order_after_a_slug() {
    let dir = TempDir::new("spellings-scan");
    let store = seeded(&dir);
    for slug in [
        "notes/a-b",
        "notes/ab",
        "notes/a.b",
        "notes/abc",
        "people/ab",
    ] {
        put(&store, "default", slug);
    }
    put(&store, "other", "notes/a_b");
    // A deleted page still holds its spelling: the SQL has no live filter.
    store.soft_delete_page("notes/a.b", None).unwrap();

    let all = store
        .read_stored_slug_spellings("notesab", Some("default"), None, "")
        .unwrap();
    assert_eq!(all, strings(&["notes/a-b", "notes/a.b", "notes/ab"]));
    let after = store
        .read_stored_slug_spellings("notesab", Some("default"), None, "notes/a.b")
        .unwrap();
    assert_eq!(after, strings(&["notes/ab"]));

    // Every source, a source list, and an empty source list (which matches nothing).
    assert_eq!(
        store
            .read_stored_slug_spellings("notesab", None, None, "")
            .unwrap(),
        strings(&["notes/a-b", "notes/a.b", "notes/a_b", "notes/ab"])
    );
    let ids = strings(&["other", "other"]);
    assert_eq!(
        store
            .read_stored_slug_spellings("notesab", Some("default"), Some(&ids), "")
            .unwrap(),
        strings(&["notes/a_b"])
    );
    assert_eq!(
        store
            .read_stored_slug_spellings("notesab", Some("default"), Some(&[]), "")
            .unwrap(),
        Vec::<String>::new()
    );
    assert_eq!(
        store
            .read_stored_slug_spellings("nosuchkey", None, None, "")
            .unwrap(),
        Vec::<String>::new()
    );
}

#[test]
fn one_call_answers_at_most_one_page() {
    let dir = TempDir::new("spellings-page");
    let store = seeded(&dir);
    for i in 0..(STORED_SPELLINGS_PAGE + 3) {
        // Every slug keys to "xy": the key drops the slash and the dashes.
        put(&store, "default", &format!("x/{}y", "-".repeat(i + 1)));
    }
    let first = store
        .read_stored_slug_spellings("xy", Some("default"), None, "")
        .unwrap();
    assert_eq!(first.len(), STORED_SPELLINGS_PAGE);
    let rest = store
        .read_stored_slug_spellings("xy", Some("default"), None, first.last().unwrap())
        .unwrap();
    assert_eq!(rest.len(), 3);
    assert!(first.last().unwrap().as_str() < rest[0].as_str());
}
