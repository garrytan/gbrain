//! `listExtractorFactsForClassification` (`facts/extractor_classify.rs`): the expired fenceless
//! conversation-extractor facts and the page, withdrawal, duplicate, fence and receipt evidence the
//! repair classifier reads. The receipt is a committed write request of the page that completed at
//! the instant the fact expired, so each fact here expires at its request's `completed_at`.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::extractor_classify::ExtractorClassificationQuery;
use gbrain_store::facts::{ExpireFactArgs, InsertFactsArgs};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::persistence::{ClaimStamp, WriteCompletion, WriteRequestInsert};
use serde_json::{Value, json};

const EXTRACTOR: &str = "cli:extract-conversation-facts";
const TOKEN: &str = "c0000000-0000-4000-8000-0000000000c1";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put(store: &Store, slug: &str) {
    let input: PageInput = args(json!({
        "type": "note", "title": slug, "compiled_truth": slug, "frontmatter": {},
    }));
    store
        .put_page(slug, &input, &args::<PutPageOptions>(json!({})))
        .unwrap();
}

/// One fenceless fact of `chats/…`; `extra` overrides the defaults. Returns its id.
fn fact(store: &Store, text: &str, extra: Value) -> u64 {
    let mut input = json!({
        "fact": text, "visibility": "private", "source": EXTRACTOR, "row_num": null,
        "source_markdown_slug": "chats/one", "valid_from": "2026-01-01T00:00:00.000Z",
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

fn expire(store: &Store, id: u64, at: Option<&str>) {
    assert!(
        store
            .expire_fact(&args::<ExpireFactArgs>(json!({ "id": id, "at": at })))
            .unwrap()
    );
}

/// Admits, claims and completes one write request of `slug` in `state`; returns its
/// `(request_id, completed_at)`.
fn request(store: &Store, request_id: &str, slug: &str, state: &str) -> (String, String) {
    let keys = vec!["brain".to_string()];
    store.lock_persistence_counters(&keys).unwrap();
    let incarnation = store.read_source_membership("default").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string();
    let insert: WriteRequestInsert = args(json!({
        "principalKind": "local_cli", "principalId": "parity-writer", "requestId": request_id,
        "operation": "put_page", "sourceId": "default", "sourceIncarnation": incarnation, "pageId": null,
        "slug": slug, "worktreeId": null, "topologyGeneration": null, "digest": "digest", "intent": {},
        "authority": {}, "intentBytes": 10, "terminalReservation": 4096, "targetKind": "page",
        "protocolVersion": 1, "admitterVersion": "v-test", "admitterHostId": null, "counterKeys": keys,
        "clientRequestId": null, "state": "queued", "deferredRefreshId": null,
    }));
    let row = store.insert_write_request(&insert).unwrap();
    let id = row["id"].as_str().unwrap().to_string();
    store
        .stamp_write_claim(&ClaimStamp {
            id: id.clone(),
            token: TOKEN.into(),
            lease_ms: 1000.0,
            phase_json: None,
        })
        .unwrap();
    let completion: WriteCompletion = args(json!({
        "id": id, "state": state, "outcome": {}, "errorCode": null, "errorMessage": null,
        "consumerVersion": format!("consumer-{request_id}"), "consumerHostId": null, "errorDetail": null,
        "resultBytes": 100, "counterKeys": ["brain"], "intentBytes": 10, "retainedBytes": 0,
        "terminalReservation": 4096,
    }));
    let done = store.complete_write_row(&completion).unwrap().unwrap();
    (
        done["request_id"].as_str().unwrap().to_string(),
        done["completed_at"].as_str().unwrap().to_string(),
    )
}

fn list(store: &Store, sources: &[&str], slug: Option<&str>) -> Vec<Value> {
    store
        .list_extractor_facts_for_classification(&args::<ExtractorClassificationQuery>(json!({
            "sourceIds": sources, "slug": slug,
        })))
        .unwrap()
}

#[test]
fn extractor_facts_carry_their_page_withdrawal_duplicate_fence_and_receipt_evidence() {
    let dir = TempDir::new("facts-extractor-classify");
    let store = open(&dir);
    put(&store, "chats/one");
    put(&store, "chats/two");

    // A committed request whose completion instant is the fact's expiry: its receipt.
    let (receipt, at) = request(
        &store,
        "a0000000-0000-4000-8000-0000000000a1",
        "chats/one",
        "committed",
    );
    let kept = fact(
        &store,
        "Ana keeps bees",
        json!({ "source": format!("{EXTRACTOR}:v1"), "entity_slug": "people/ana" }),
    );
    expire(&store, kept, Some(&at));
    // The same instant on a failed request is no receipt.
    let (_, failed_at) = request(
        &store,
        "a0000000-0000-4000-8000-0000000000a2",
        "chats/two",
        "failed",
    );
    let unreceipted = fact(
        &store,
        "Bo rides",
        json!({ "source_markdown_slug": "chats/two" }),
    );
    expire(&store, unreceipted, Some(&failed_at));

    // Withdrawn under `*`, with an active duplicate and a fence row on the page.
    let withdrawn = fact(&store, "Cy sings", json!({}));
    expire(&store, withdrawn, None);
    // The duplicate is saved before the withdrawal: a claim written after it is saved expired
    // (`gbrain_preserve_fact_withdrawal`), so it would no longer be an active duplicate.
    fact(&store, "  CY sings. ", json!({}));
    store
        .insert_fact_withdrawal("default", "private", "Cy sings", "*", None)
        .unwrap();
    fact(
        &store,
        "a fence row",
        json!({ "source": "fence:chats/one", "row_num": 1 }),
    );

    // Excluded: active, fenced, retired, slugless, another lane.
    fact(&store, "still active", json!({}));
    let fenced = fact(&store, "fenced", json!({ "row_num": 7 }));
    expire(&store, fenced, None);
    let retired = fact(
        &store,
        "retired",
        json!({ "context": "x retired: conversation-labels y" }),
    );
    expire(&store, retired, None);
    let slugless = fact(&store, "slugless", json!({ "source_markdown_slug": null }));
    expire(&store, slugless, None);
    let other = fact(&store, "other lane", json!({ "source": "mcp:put_page" }));
    expire(&store, other, None);

    let rows = list(&store, &["default"], None);
    let ids: Vec<u64> = rows.iter().map(|r| r["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, vec![kept, withdrawn, unreceipted]);

    let first = &rows[0];
    assert_eq!(first["receipt"], json!(receipt));
    assert_eq!(
        first["receipt_consumer"],
        json!("consumer-a0000000-0000-4000-8000-0000000000a1")
    );
    assert_eq!(first["expired_at"], json!(at));
    assert_eq!(first["page_deleted"], json!(false));
    assert!(first["page_id"].is_u64());
    assert_eq!(first["fence_history"], json!(true));
    assert_eq!(first["withdrawn"], json!(false));
    assert_eq!(first["superseded"], json!(false));
    assert_eq!(first["slug"], json!("chats/one"));

    let second = &rows[1];
    assert_eq!(second["withdrawn"], json!(true));
    assert_eq!(second["active_duplicate"], json!(true));
    assert_eq!(second["receipt"], Value::Null);
    assert_eq!(second["receipt_consumer"], Value::Null);

    let third = &rows[2];
    assert_eq!(third["receipt"], Value::Null);
    assert_eq!(third["fence_history"], json!(false));
    assert_eq!(third["active_duplicate"], json!(false));

    let by_slug = list(&store, &["default"], Some("chats/two"));
    assert_eq!(by_slug.len(), 1);
    assert_eq!(by_slug[0]["id"], json!(unreceipted));
    assert!(list(&store, &["default"], Some("chats/none")).is_empty());
    assert!(list(&store, &[], None).is_empty());
    assert!(list(&store, &["other"], None).is_empty());

    // A soft-deleted page still names its id; a missing page names none.
    store.soft_delete_page("chats/two", None).unwrap();
    let gone = list(&store, &["default"], Some("chats/two"));
    assert_eq!(gone[0]["page_deleted"], json!(true));
    let orphan = fact(
        &store,
        "orphan",
        json!({ "source_markdown_slug": "chats/none" }),
    );
    expire(&store, orphan, None);
    let none = list(&store, &["default"], Some("chats/none"));
    assert_eq!(none[0]["page_id"], Value::Null);
    assert_eq!(none[0]["page_deleted"], json!(false));
}
