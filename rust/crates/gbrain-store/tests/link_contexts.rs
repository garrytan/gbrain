//! `listLinkContexts`: the stored contexts of one link, as the edge-contradictions phase quotes
//! them. What the parity case (test/engine-parity/family-tail-sites.test.ts) cannot show: the
//! store's byte order when more than three contexts exist, and ids that name no page.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::links::AddLinkOptions;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::json;

fn put(store: &Store, slug: &str) -> f64 {
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "body"}))
            .unwrap();
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
    store
        .read_page_id_in_source(slug, "default")
        .unwrap()
        .unwrap() as f64
}

fn link(store: &Store, to: &str, link_type: &str, source: &str, context: &str) {
    let options: AddLinkOptions = serde_json::from_value(
        json!({"linkType": link_type, "linkSource": source, "context": context}),
    )
    .unwrap();
    store.add_link("n/a", to, &options).unwrap();
}

#[test]
fn three_distinct_non_empty_contexts_in_byte_order() {
    let dir = TempDir::new("link-contexts");
    let store = open(&dir);
    let a = put(&store, "n/a");
    let b = put(&store, "n/b");
    put(&store, "n/c");
    for (source, context) in [
        ("manual", "zeta"),
        ("markdown", "Beta"),
        ("frontmatter", "alpha"),
        ("mcp", "Beta"),
        ("cli", ""),
        ("api", "gamma"),
    ] {
        link(&store, "n/b", "works_at", source, context);
    }
    link(&store, "n/b", "invested_in", "manual", "other type");
    link(&store, "n/c", "works_at", "manual", "other page");
    assert_eq!(
        store.list_link_contexts(a, b, "works_at").unwrap(),
        vec!["Beta", "alpha", "gamma"]
    );
    assert_eq!(
        store.list_link_contexts(a, b, "invested_in").unwrap(),
        vec!["other type"]
    );
    assert!(
        store
            .list_link_contexts(b, a, "works_at")
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list_link_contexts(a + 0.5, b, "works_at")
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list_link_contexts(-1.0, b, "works_at")
            .unwrap()
            .is_empty()
    );
}
