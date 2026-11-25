//! The admin operations' page read (`listVisiblePageSlugs`), matched to the PGLite engine.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn put(store: &Store, source: &str, slug: &str, frontmatter: Value) -> u64 {
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter}),
    )
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
    store.read_page_id_in_source(slug, source).unwrap().unwrap()
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
fn visible_slugs_keep_live_pages_in_scope_that_the_policy_admits() {
    let dir = TempDir::new("admin-visible-slugs");
    let store = seeded(&dir);
    put(&store, "default", "notes/open", json!({}));
    put(
        &store,
        "default",
        "notes/private",
        json!({"visibility": "private"}),
    );
    put(&store, "default", "notes/gone", json!({}));
    put(&store, "other", "notes/elsewhere", json!({}));
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    let slugs = strings(&[
        "notes/open",
        "notes/private",
        "notes/gone",
        "notes/elsewhere",
        "notes/open",
        "notes/never",
    ]);
    let policy = PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    };
    assert_eq!(
        store.list_visible_page_slugs(&slugs, None, None).unwrap(),
        strings(&["notes/elsewhere", "notes/open", "notes/private"])
    );
    assert_eq!(
        store
            .list_visible_page_slugs(&slugs, None, Some(&policy))
            .unwrap(),
        strings(&["notes/elsewhere", "notes/open"])
    );
    assert_eq!(
        store
            .list_visible_page_slugs(&slugs, Some(&strings(&["other"])), Some(&policy))
            .unwrap(),
        strings(&["notes/elsewhere"])
    );
    assert!(
        store
            .list_visible_page_slugs(&[], None, None)
            .unwrap()
            .is_empty()
    );
}
