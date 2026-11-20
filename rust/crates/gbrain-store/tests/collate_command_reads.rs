//! The command page reads (collate_command_reads.rs): live pages naming a reader, the who-can-read
//! page rows and a source's markdown slugs, each in byte order.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn source(store: &Store, id: &str) {
    store
        .upsert_source(&SourceInput {
            id: id.into(),
            name: Some(id.into()),
            local_path: Some(format!("/brains/{id}")),
            ..SourceInput::default()
        })
        .unwrap();
}

fn put(store: &Store, source: &str, slug: &str, frontmatter: Value) {
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter}),
    )
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

#[test]
fn live_pages_naming_reader_are_listed_by_byte_source_and_slug_and_skip_deleted_ones() {
    let dir = TempDir::new("collate-reads-naming");
    let store = open(&dir);
    for id in ["ab", "a-z"] {
        source(&store, id);
    }
    let readers = json!({"readable_by": ["member:gone-example"]});
    for s in ["ab", "a-z"] {
        for slug in ["ab", "a-z"] {
            put(&store, s, slug, readers.clone());
        }
    }
    put(
        &store,
        "ab",
        "other",
        json!({"readable_by": ["member:someone-else"]}),
    );
    put(&store, "ab", "open", json!({}));
    let rows = store
        .list_live_pages_naming_reader("member:gone-example", 201)
        .unwrap();
    let got: Vec<(String, String)> = rows.into_iter().map(|r| (r.source_id, r.slug)).collect();
    let pair = |s: &str, l: &str| (s.to_string(), l.to_string());
    assert_eq!(
        got,
        vec![
            pair("a-z", "a-z"),
            pair("a-z", "ab"),
            pair("ab", "a-z"),
            pair("ab", "ab")
        ]
    );
    let cut = store
        .list_live_pages_naming_reader("member:gone-example", 3)
        .unwrap();
    assert_eq!(cut.len(), 3);
}

#[test]
fn page_access_rows_read_one_source_or_every_source_by_byte_source_id() {
    let dir = TempDir::new("collate-reads-access");
    let store = open(&dir);
    for id in ["ab", "a-z"] {
        source(&store, id);
        put(
            &store,
            id,
            "notes/a",
            json!({"readable_by": ["member:alice-example"]}),
        );
    }
    let every = store.read_page_access_rows("notes/a", None).unwrap();
    let ids: Vec<&str> = every.iter().map(|r| r.source_id.as_str()).collect();
    assert_eq!(ids, vec!["a-z", "ab"]);
    assert_eq!(every[0].page_type, "note");
    assert_eq!(
        Value::Object(every[0].frontmatter.clone()),
        json!({"readable_by": ["member:alice-example"]})
    );
    assert_eq!(every[0].folder_rule_ids, None);
    let one = store.read_page_access_rows("notes/a", Some("ab")).unwrap();
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].source_id, "ab");
    assert!(
        store
            .read_page_access_rows("none", None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn markdown_page_slugs_are_listed_by_byte_for_one_source() {
    let dir = TempDir::new("collate-reads-slugs");
    let store = open(&dir);
    for id in ["work", "other"] {
        source(&store, id);
    }
    for slug in ["ab", "a0", "a-z"] {
        put(&store, "work", slug, json!({}));
    }
    put(&store, "other", "elsewhere", json!({}));
    assert_eq!(
        store.list_markdown_page_slugs("work").unwrap(),
        vec!["a-z", "a0", "ab"]
    );
    assert!(store.list_markdown_page_slugs("none").unwrap().is_empty());
}
