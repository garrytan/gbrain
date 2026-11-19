//! The search-ranking page reads (cli_reads/search_reads_pages.rs): what each answers from the
//! store's page records.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::cli_reads::search_reads_pages::LivePageRef;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn source(store: &Store, id: &str) {
    store
        .upsert_source(&SourceInput {
            id: id.into(),
            name: Some(id.into()),
            ..SourceInput::default()
        })
        .unwrap();
}

fn page(store: &Store, source_id: &str, slug: &str, page_type: &str, frontmatter: Value) -> u64 {
    let input = PageInput {
        page_type: page_type.into(),
        title: slug.into(),
        compiled_truth: format!("body of {slug}"),
        frontmatter: frontmatter.as_object().cloned(),
        ..PageInput::default()
    };
    let options = PutPageOptions {
        source_id: Some(source_id.into()),
        ..PutPageOptions::default()
    };
    store.put_page(slug, &input, &options).unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn live_ref(source_id: &str, slug: &str) -> LivePageRef {
    LivePageRef {
        source_id: source_id.into(),
        slug: slug.into(),
    }
}

#[test]
fn slugs_ending_in_match_the_whole_slug_or_a_literal_suffix_after_a_slash() {
    let dir = TempDir::new("search-pages-slugs");
    let store = open(&dir);
    source(&store, "other");
    for slug in [
        "people/widget",
        "companies/widget",
        "notes/widget",
        "widget",
        "notes/a-b",
        "notes/gone",
        "notes/xwidget",
    ] {
        page(&store, "default", slug, "note", json!({}));
    }
    page(&store, "other", "notes/solo", "note", json!({}));
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();

    // Four match; the two oldest come back.
    assert_eq!(
        store.slugs_ending_in("default", "widget").unwrap(),
        ["people/widget", "companies/widget"]
    );
    assert!(store.slugs_ending_in("default", "a%b").unwrap().is_empty());
    assert!(store.slugs_ending_in("default", "a_b").unwrap().is_empty());
    assert!(
        store
            .slugs_ending_in("default", "WIDGET")
            .unwrap()
            .is_empty()
    );
    assert!(store.slugs_ending_in("default", "gone").unwrap().is_empty());
    assert!(store.slugs_ending_in("default", "solo").unwrap().is_empty());
    assert!(store.slugs_ending_in("oth", "solo").unwrap().is_empty());
    assert_eq!(
        store.slugs_ending_in("other", "solo").unwrap(),
        ["notes/solo"]
    );
}

#[test]
fn generated_pages_in_reads_deleted_and_other_source_pages_by_id() {
    let dir = TempDir::new("search-pages-generated");
    let store = open(&dir);
    source(&store, "other");
    let dream = page(
        &store,
        "default",
        "notes/dream",
        "note",
        json!({ "dream_generated": true }),
    );
    let text = page(
        &store,
        "default",
        "notes/text",
        "note",
        json!({ "dream_generated": "true" }),
    );
    let nested = page(
        &store,
        "default",
        "notes/nested",
        "note",
        json!({ "meta": { "dream_generated": true } }),
    );
    let receipt = page(
        &store,
        "default",
        "notes/receipt",
        "extract_receipt",
        json!({}),
    );
    let other = page(
        &store,
        "other",
        "notes/dream",
        "note",
        json!({ "dream_generated": true }),
    );
    let human = page(&store, "default", "notes/human", "note", json!({}));
    store
        .soft_delete_page("notes/receipt", Some("default"))
        .unwrap();

    let ids = [human, other, receipt, nested, text, dream, dream];
    let ids: Vec<i64> = ids.iter().map(|&id| id as i64).collect();
    let rows = store.generated_pages_in(&ids).unwrap();
    let found: Vec<u64> = rows.iter().map(|r| r.id).collect();
    assert_eq!(found, [dream, text, receipt, other]);
    assert_eq!(
        rows[0].compiled_truth.as_deref(),
        Some("body of notes/dream")
    );
    assert_eq!(
        Value::Object(rows[1].frontmatter.clone()),
        json!({ "dream_generated": "true" })
    );
    assert!(store.generated_pages_in(&[]).unwrap().is_empty());
    assert!(
        store
            .generated_pages_in(&[0, -1, i64::from(i32::MAX)])
            .unwrap()
            .is_empty()
    );
    let err = store
        .generated_pages_in(&[dream as i64, i64::from(i32::MAX) + 1])
        .unwrap_err();
    assert_eq!(err.code, "invalid_argument");
}

#[test]
fn live_page_ids_at_give_each_live_page_once_matching_source_and_slug() {
    let dir = TempDir::new("search-pages-live");
    let store = open(&dir);
    source(&store, "other");
    let a = page(&store, "default", "notes/a", "note", json!({}));
    let other_a = page(&store, "other", "notes/a", "note", json!({}));
    page(&store, "default", "notes/gone", "note", json!({}));
    page(&store, "other", "notes/only-other", "note", json!({}));
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();

    let refs = [
        live_ref("other", "notes/a"),
        live_ref("default", "notes/a"),
        live_ref("default", "notes/a"),
        live_ref("default", "notes/gone"),
        live_ref("default", "notes/only-other"),
        live_ref("missing", "notes/a"),
    ];
    assert_eq!(store.live_page_ids_at(&refs).unwrap(), [a, other_a]);
    assert!(store.live_page_ids_at(&[]).unwrap().is_empty());
}
