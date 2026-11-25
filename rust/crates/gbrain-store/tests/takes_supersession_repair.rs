//! The take supersession repair's reads and write: `listTakePointers`, `listTakeSupersedeReceipts`
//! and `setTakeSupersededBy` (`takes/reads.rs`), matched to the SQL in
//! `src/core/engine-sql/takes-reads.ts`.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::persistence::{ClaimStamp, WriteCompletion, WriteRequestInsert};
use gbrain_store::takes::TakeInput;
use serde_json::{Value, json};

const TOKEN: &str = "c0000000-0000-4000-8000-0000000000c2";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put(store: &Store, slug: &str) -> u64 {
    let input: PageInput = args(json!({
        "type": "note", "title": slug, "compiled_truth": slug, "frontmatter": {},
    }));
    store
        .put_page(slug, &input, &args::<PutPageOptions>(json!({})))
        .unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn takes(store: &Store, page_id: u64, rows: &[(i64, bool, Option<i64>)]) {
    let rows: Vec<TakeInput> = rows
        .iter()
        .map(|(row, active, by)| {
            args(json!({
                "page_id": page_id, "row_num": row, "claim": format!("claim {row}"), "kind": "bet",
                "holder": "world", "weight": 0.5, "active": active, "superseded_by": by,
            }))
        })
        .collect();
    store.add_takes_batch(&rows).unwrap();
}

/// Admits, claims and completes one request of `operation` on `slug` (page `page_id`, or none)
/// in `state`, with `outcome`.
fn request(
    store: &Store,
    request_id: &str,
    operation: &str,
    page_id: Option<u64>,
    slug: &str,
    state: &str,
    outcome: Value,
) {
    let keys = vec!["brain".to_string()];
    store.lock_persistence_counters(&keys).unwrap();
    let incarnation = store.read_source_membership("default").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string();
    let insert: WriteRequestInsert = args(json!({
        "principalKind": "local_cli", "principalId": "parity-writer", "requestId": request_id,
        "operation": operation, "sourceId": "default", "sourceIncarnation": incarnation, "pageId": page_id,
        "slug": slug, "worktreeId": null, "topologyGeneration": null, "digest": "digest", "intent": {},
        "authority": {}, "intentBytes": 10, "terminalReservation": 4096, "targetKind": "page",
        "protocolVersion": 1, "admitterVersion": "v-test", "admitterHostId": null, "counterKeys": keys,
        "clientRequestId": null, "state": "queued", "deferredRefreshId": null,
    }));
    let row = store.insert_write_request(&insert).unwrap();
    let id = row["id"].as_str().unwrap().to_string();
    store
        .stamp_write_claim(&ClaimStamp {
            fence: None,
            id: id.clone(),
            token: TOKEN.into(),
            lease_ms: 1000.0,
            phase_json: None,
        })
        .unwrap();
    let completion: WriteCompletion = args(json!({
        "id": id, "state": state, "outcome": outcome, "errorCode": null, "errorMessage": null,
        "consumerVersion": format!("consumer-{request_id}"), "consumerHostId": null, "errorDetail": null,
        "resultBytes": 100, "counterKeys": ["brain"], "intentBytes": 10, "retainedBytes": 0,
        "terminalReservation": 4096,
    }));
    store.complete_write_row(&completion).unwrap().unwrap();
}

fn pointers(store: &Store, page_id: u64) -> Vec<Value> {
    let mut rows = store.list_take_pointers(page_id).unwrap();
    rows.sort_by_key(|r| r["row_num"].as_i64());
    rows
}

#[test]
fn pointers_are_every_take_of_the_page_and_the_setter_moves_only_superseded_by() {
    let dir = TempDir::new("takes-supersession-pointers");
    let store = open(&dir);
    let page = put(&store, "notes/chain");
    let other = put(&store, "notes/other");
    takes(
        &store,
        page,
        &[(1, false, None), (2, false, Some(3)), (3, true, None)],
    );
    takes(&store, other, &[(1, true, None)]);
    assert_eq!(
        pointers(&store, page),
        vec![
            json!({"row_num": 1, "superseded_by": null}),
            json!({"row_num": 2, "superseded_by": 3}),
            json!({"row_num": 3, "superseded_by": null}),
        ]
    );
    assert!(store.list_take_pointers(999).unwrap().is_empty());

    let before = store
        .list_takes(&args(
            json!({"page_id": page, "active": null, "limit": 100}),
        ))
        .unwrap();
    store.set_take_superseded_by(page, 1, Some(2)).unwrap();
    store.set_take_superseded_by(page, 2, None).unwrap();
    // No take at the row: nothing is written.
    store.set_take_superseded_by(page, 9, Some(2)).unwrap();
    assert_eq!(
        pointers(&store, page),
        vec![
            json!({"row_num": 1, "superseded_by": 2}),
            json!({"row_num": 2, "superseded_by": null}),
            json!({"row_num": 3, "superseded_by": null}),
        ]
    );
    let after = store
        .list_takes(&args(
            json!({"page_id": page, "active": null, "limit": 100}),
        ))
        .unwrap();
    let strip = |rows: &[Value]| {
        rows.iter()
            .map(|r| {
                let mut r = r.clone();
                r.as_object_mut().unwrap().remove("superseded_by");
                r
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(strip(&after), strip(&before));
    assert_eq!(
        pointers(&store, other),
        vec![json!({"row_num": 1, "superseded_by": null})]
    );
}

#[test]
fn receipts_are_the_committed_takes_supersede_requests_of_the_page_or_its_pageless_slug() {
    let dir = TempDir::new("takes-supersession-receipts");
    let store = open(&dir);
    let page = put(&store, "notes/chain");
    let other = put(&store, "notes/other");
    assert!(
        store
            .list_take_supersede_receipts("default", page, "notes/chain")
            .unwrap()
            .is_empty()
    );

    let ok = json!({"old_row": 2, "new_row": 3});
    request(
        &store,
        "a0000000-0000-4000-8000-0000000000b1",
        "takes_supersede",
        Some(page),
        "notes/chain",
        "committed",
        ok.clone(),
    );
    // No page recorded: matched by slug.
    request(
        &store,
        "a0000000-0000-4000-8000-0000000000b2",
        "takes_supersede",
        None,
        "notes/chain",
        "committed",
        json!({"old_row": "4", "new_row": null}),
    );
    // Not committed, another operation, another page: not receipts.
    request(
        &store,
        "a0000000-0000-4000-8000-0000000000b3",
        "takes_supersede",
        Some(page),
        "notes/chain",
        "failed",
        ok.clone(),
    );
    request(
        &store,
        "a0000000-0000-4000-8000-0000000000b4",
        "put_page",
        Some(page),
        "notes/chain",
        "committed",
        ok.clone(),
    );
    request(
        &store,
        "a0000000-0000-4000-8000-0000000000b5",
        "takes_supersede",
        Some(other),
        "notes/chain",
        "committed",
        ok.clone(),
    );
    // An outcome without the keys reads null.
    request(
        &store,
        "a0000000-0000-4000-8000-0000000000b6",
        "takes_supersede",
        Some(page),
        "notes/chain",
        "committed",
        json!({}),
    );

    let mut rows = store
        .list_take_supersede_receipts("default", page, "notes/chain")
        .unwrap();
    rows.sort_by_key(|r| r.to_string());
    let mut want = vec![
        json!({"old_row": "2", "new_row": "3"}),
        json!({"old_row": "4", "new_row": null}),
        json!({"old_row": null, "new_row": null}),
    ];
    want.sort_by_key(|r| r.to_string());
    assert_eq!(rows, want);
    assert!(
        store
            .list_take_supersede_receipts("elsewhere", page, "notes/chain")
            .unwrap()
            .is_empty()
    );
}
