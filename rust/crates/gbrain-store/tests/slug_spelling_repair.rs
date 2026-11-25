//! The page scan of the `legacy_slug_spellings` doctor check (`listSlugSpellingCandidates`). Expected rows follow the
//! SQL in src/core/engine-sql/slug-spelling-repair.ts.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
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

#[test]
fn the_candidates_are_the_pages_with_a_capital_or_a_non_ascii_character() {
    let dir = TempDir::new("spelling-candidates");
    let store = open(&dir);
    store
        .upsert_source(&SourceInput {
            id: "other".into(),
            ..Default::default()
        })
        .unwrap();
    for slug in [
        "notes/plain",
        "notes/caf\u{e9}",
        "people/\u{65e5}\u{672c}",
        "notes/ok-1",
    ] {
        put(&store, "default", slug);
    }
    put(&store, "other", "notes/na\u{ef}ve");
    // A deleted page is still a candidate: the SQL has no live filter.
    store
        .soft_delete_page("people/\u{65e5}\u{672c}", Some("default"))
        .unwrap();

    let all = store.list_slug_spelling_candidates(0, 5000).unwrap();
    let rows: Vec<(&str, &str)> = all
        .iter()
        .map(|r| (r.source_id.as_str(), r.slug.as_str()))
        .collect();
    assert_eq!(
        rows,
        vec![
            ("default", "notes/caf\u{e9}"),
            ("default", "people/\u{65e5}\u{672c}"),
            ("other", "notes/na\u{ef}ve"),
        ]
    );
    let rest = store.list_slug_spelling_candidates(all[0].id, 1).unwrap();
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0].slug, "people/\u{65e5}\u{672c}");
    assert!(
        store
            .list_slug_spelling_candidates(all[2].id, 5000)
            .unwrap()
            .is_empty()
    );
}
