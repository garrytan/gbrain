//! `readLinkContextMatches` and `readLinkContextOriginPages`: the link rows and origin page bodies
//! the world-only link context check (`worldLinkContexts`) reads.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::link_queries::LinkContextAsk;
use gbrain_store::links::AddLinkOptions;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::{Value, json};

fn put(store: &Store, slug: &str, body: &str) -> u64 {
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": slug, "compiled_truth": body, "timeline": "t"}),
    )
    .unwrap();
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn link(store: &Store, from: &str, to: &str, link_type: &str, context: &str, extra: Value) {
    let mut options = json!({"linkType": link_type, "context": context});
    options
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let options: AddLinkOptions = serde_json::from_value(options).unwrap();
    store.add_link(from, to, &options).unwrap();
}

fn ask(i: i64, from: &str, to: &str, link_type: &str, context: &str) -> LinkContextAsk {
    serde_json::from_value(json!({
        "i": i, "fromSourceId": "default", "fromSlug": from, "toSourceId": "default",
        "toSlug": to, "linkType": link_type, "context": context,
    }))
    .unwrap()
}

#[test]
fn matches_follow_the_edge_the_text_and_the_live_origin() {
    let dir = TempDir::new("link-context-matches");
    let store = open(&dir);
    let a = put(&store, "a/one", "alpha body");
    put(&store, "a/two", "beta body");
    let o = put(&store, "a/origin", "origin body");
    link(
        &store,
        "a/one",
        "a/two",
        "cites",
        "the whole context",
        json!({}),
    );
    link(
        &store,
        "a/one",
        "a/two",
        "mentions",
        "other text",
        json!({"linkSource": "manual", "originSlug": "a/origin"}),
    );

    let rows = store
        .read_link_context_matches(&[
            ask(0, "a/one", "a/two", "cites", "the whole context"),
            ask(1, "a/one", "a/two", "cites", "the who\u{2026}"),
            ask(2, "a/one", "a/two", "cites", "the wrong\u{2026}"),
            ask(3, "a/one", "a/two", "mentions", "other text"),
            ask(4, "a/one", "a/missing", "cites", "the whole context"),
        ])
        .unwrap();
    let got: Vec<(i64, Value, Value)> = rows
        .iter()
        .map(|r| {
            (
                r["i"].as_i64().unwrap(),
                r["context"].clone(),
                r["page_id"].clone(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            (0, json!("the whole context"), json!(a)),
            (1, json!("the whole context"), json!(a)),
            (3, json!("other text"), json!(o)),
        ]
    );
    assert_eq!(rows[2]["link_source"], json!("manual"));

    // A deleted origin page leaves the match with a null page id.
    store.soft_delete_page("a/origin", None).unwrap();
    let rows = store
        .read_link_context_matches(&[ask(3, "a/one", "a/two", "mentions", "other text")])
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["page_id"], Value::Null);
}

#[test]
fn origin_pages_are_read_by_id_deleted_or_not() {
    let dir = TempDir::new("link-context-origins");
    let store = open(&dir);
    let b = put(&store, "b/two", "second body");
    let a = put(&store, "b/one", "first body");
    store.soft_delete_page("b/two", None).unwrap();
    let rows = store
        .read_link_context_origin_pages(&[a, b, a, 999_999])
        .unwrap();
    let ids: Vec<u64> = rows.iter().map(|r| r["id"].as_u64().unwrap()).collect();
    let mut want = vec![a, b];
    want.sort();
    assert_eq!(ids, want);
    let first = rows.iter().find(|r| r["id"] == json!(a)).unwrap();
    assert_eq!(first["slug"], json!("b/one"));
    assert_eq!(first["source_id"], json!("default"));
    assert_eq!(first["compiled_truth"], json!("first body"));
    assert_eq!(first["timeline"], json!("t"));
}
