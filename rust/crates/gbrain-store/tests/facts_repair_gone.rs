//! The two group D repair reads the store serves (`facts/repair_gone.rs`): the expired extractor-fact classifier and
//! the purged-page fact count.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::repair_gone::{ExtractorArgs, PurgedArgs};
use gbrain_store::facts::{ExpireFactArgs, InsertFactsArgs};
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU32, Ordering};

const EXTRACTOR: &str = "cli:extract-conversation-facts";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn row_num() -> u32 {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

fn put(store: &Store, slug: &str) {
    let input: PageInput =
        serde_json::from_value(json!({ "type": "note", "title": slug, "compiled_truth": slug }))
            .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({ "sourceId": "default" })).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

fn fact(store: &Store, text: &str, extra: Value) -> u64 {
    let mut input = json!({
        "fact": text, "visibility": "private", "source": EXTRACTOR, "valid_from": "2026-01-01T00:00:00.000Z",
    });
    for (k, v) in extra.as_object().unwrap() {
        input[k] = v.clone();
    }
    store
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": [input], "sourceId": "default" }),
        ))
        .unwrap()["ids"][0]
        .as_u64()
        .unwrap()
}

fn expire(store: &Store, id: u64) {
    store
        .expire_fact(&args::<ExpireFactArgs>(json!({ "id": id })))
        .unwrap();
}

fn classify(store: &Store, slug: Option<&str>) -> Vec<Value> {
    let a: ExtractorArgs = args(json!({ "sourceIds": ["default"], "slug": slug }));
    store.list_extractor_facts_for_classification(&a).unwrap()
}

fn purged(store: &Store, limit: u64) -> Vec<bool> {
    let a: PurgedArgs = args(json!({ "sourceIds": ["default"], "limit": limit }));
    store.count_purged_page_facts(&a).unwrap()
}

#[test]
fn expired_extractor_facts_come_with_their_page_duplicate_and_fence_evidence() {
    let dir = TempDir::new("gone-extractor");
    let store = open(&dir);
    put(&store, "chats/one");
    let kept = fact(
        &store,
        "kept",
        json!({ "source": format!("{EXTRACTOR}:v1"), "source_markdown_slug": "chats/one" }),
    );
    let twin = fact(
        &store,
        "twin",
        json!({ "source_markdown_slug": "chats/one" }),
    );
    fact(
        &store,
        "twin",
        json!({ "source_markdown_slug": "chats/one" }),
    );
    let retired = fact(
        &store,
        "retired",
        json!({ "source_markdown_slug": "chats/one", "context": "retired: conversation-labels" }),
    );
    let fenced = fact(
        &store,
        "fenced",
        json!({ "source_markdown_slug": "chats/one", "source": "mcp:put_page", "row_num": row_num() }),
    );
    let loose = fact(
        &store,
        "loose",
        json!({ "source_markdown_slug": "chats/gone" }),
    );
    for id in [kept, twin, retired, fenced, loose] {
        expire(&store, id);
    }
    let rows = classify(&store, None);
    // `fenced` is not an extractor fact and `retired` is excluded by its context; by (slug, id).
    let got: Vec<(u64, &str)> = rows
        .iter()
        .map(|r| (r["id"].as_u64().unwrap(), r["slug"].as_str().unwrap()))
        .collect();
    assert_eq!(
        got,
        vec![
            (loose, "chats/gone"),
            (kept, "chats/one"),
            (twin, "chats/one")
        ]
    );
    assert_eq!(rows[0]["page_id"], Value::Null);
    assert_eq!(rows[0]["page_deleted"], json!(false));
    assert_eq!(rows[0]["fence_history"], json!(false));
    assert_eq!(rows[1]["page_deleted"], json!(false));
    assert!(rows[1]["page_id"].is_u64());
    assert_eq!(rows[1]["fence_history"], json!(true));
    assert_eq!(rows[1]["active_duplicate"], json!(false));
    assert_eq!(rows[2]["active_duplicate"], json!(true));
    assert_eq!(rows[2]["withdrawn"], json!(false));
    assert_eq!(rows[2]["superseded"], json!(false));
    assert_eq!(rows[2]["receipt"], Value::Null);
    assert_eq!(rows[2]["receipt_consumer"], Value::Null);
    assert!(rows[2]["expired_at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(rows[2]["fingerprint"].as_str().unwrap().len(), 64);
    let one: Vec<u64> = classify(&store, Some("chats/one"))
        .iter()
        .map(|r| r["id"].as_u64().unwrap())
        .collect();
    assert_eq!(one, vec![kept, twin]);
    assert!(classify(&store, Some("chats/none")).is_empty());
}

#[test]
fn a_soft_deleted_page_still_holds_its_slug_and_only_active_facts_of_a_gone_page_are_counted() {
    let dir = TempDir::new("gone-purged");
    let store = open(&dir);
    put(&store, "notes/open");
    put(&store, "notes/soft");
    store.soft_delete_page("notes/soft", None).unwrap();
    let at = |text: &str, context: &str| {
        fact(
            &store,
            text,
            json!({ "source": "mcp:put_page", "context": context }),
        )
    };
    at("open page", "notes/open");
    at("soft deleted page", "notes/soft \u{2014} a note");
    at("no slash", "gone");
    at("whitespace", "gone/a page");
    let counted = at("gone page", "gone/page \u{2014} a note");
    at("another", "gone/other");
    fact(
        &store,
        "other source",
        json!({ "source": "mcp:other", "context": "gone/page" }),
    );
    fact(
        &store,
        "on a page",
        json!({ "source": "mcp:put_page", "context": "gone/page", "source_markdown_slug": "gone/page" }),
    );
    at("withdrawn", "gone/withdrawn");
    assert!(
        store
            .insert_fact_withdrawal("default", "private", "withdrawn", "*", None)
            .unwrap()
    );
    let expired = at("expired", "gone/expired");
    expire(&store, expired);
    assert_eq!(purged(&store, 10), vec![false, false]);
    assert_eq!(purged(&store, 1), vec![false]);
    assert!(purged(&store, 0).is_empty());
    let _ = counted;
}
