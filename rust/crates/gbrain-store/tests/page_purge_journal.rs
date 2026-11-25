//! The journal statements of a page purge's sweep and intent redaction the store serves
//! (`persistence/journal_redaction.rs`). The TypeScript parity cases (test/engine-parity/page-purge-journal.test.ts) compare
//! the same members with PGLite; these cover what a parity case cannot see: the request record and its keys after a
//! redaction, the bound a malformed argument is refused with, and the counter arithmetic at its edges.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::persistence::{
    ClaimStamp, RedactRequestArgs, SweepChunkArgs, WriteCompletion, WriteRequestInsert,
};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

const SLUG: &str = "notes/a";
const KEY: &str = "principal:local_cli:u";
const CLAIM: &str = "harbor ledger fact";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let store = open(&dir);
    let other: SourceInput = args(json!({ "id": "other", "name": "other", "config": {} }));
    store.upsert_source(&other).unwrap();
    (dir, store)
}

fn rid(n: u32) -> String {
    format!("a0000000-0000-4000-8000-{n:012}")
}

/// Admits a request (queued), then completes it as `committed` with `outcome` unless `pending`; returns its journal id.
fn admit(
    store: &Store,
    n: u32,
    source: &str,
    slug: &str,
    intent: Value,
    outcome: Option<Value>,
) -> String {
    let keys = vec!["brain".to_string(), KEY.to_string()];
    store.lock_persistence_counters(&keys).unwrap();
    let incarnation = store.read_source_membership(source).unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string();
    let insert: WriteRequestInsert = args(json!({
        "principalKind": "local_cli", "principalId": "u", "requestId": rid(n),
        "operation": "put_page", "sourceId": source, "sourceIncarnation": incarnation, "pageId": null,
        "slug": slug, "worktreeId": null, "topologyGeneration": null, "digest": "d", "intent": intent,
        "authority": {}, "intentBytes": 100, "terminalReservation": 4096, "targetKind": "page",
        "protocolVersion": 1, "admitterVersion": "v-test", "admitterHostId": null, "counterKeys": keys,
        "clientRequestId": null, "state": "queued", "deferredRefreshId": null,
    }));
    let id = store.insert_write_request(&insert).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    if let Some(outcome) = outcome {
        let stamp: ClaimStamp = args(json!({
            "id": id, "token": "c0000000-0000-4000-8000-0000000000c1", "leaseMs": 60000.0, "phaseJson": "{}",
        }));
        store.stamp_write_claim(&stamp).unwrap();
        let done: WriteCompletion = args(json!({
            "id": id, "state": "committed", "outcome": outcome, "consumerVersion": "v-test", "resultBytes": 1200,
            "counterKeys": keys, "intentBytes": 100, "retainedBytes": 1500, "terminalReservation": 4096,
        }));
        store.complete_write_row(&done).unwrap();
    }
    id
}

fn chunk(store: &Store, over: Value) -> Value {
    let mut base = json!({ "sourceId": "default", "needles": [CLAIM], "after": "0", "ceiling": null, "limit": 100, "ids": null, "exclude": null });
    for (k, v) in over.as_object().unwrap() {
        base[k] = v.clone();
    }
    let q: SweepChunkArgs = args(base);
    store.sweep_journal_chunk(&q).unwrap()
}

fn ids_of(chunk: &Value) -> Vec<String> {
    chunk["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect()
}

fn terminal(store: &Store, key: &str) -> i64 {
    let rows = store.read_counter_rows(&[key.to_string()]).unwrap();
    let raw = &rows[0]["terminal_bytes"];
    raw.as_i64()
        .or_else(|| raw.as_str().and_then(|s| s.parse().ok()))
        .unwrap()
}

#[test]
fn a_redacted_request_leaves_the_slug_list_but_stays_readable_with_its_receipt() {
    let (_dir, store) = brain("page-purge-journal-redact");
    let a = admit(
        &store,
        1,
        "default",
        SLUG,
        json!({ "content": CLAIM }),
        Some(json!({ "ok": CLAIM, "keep": "x" })),
    );
    let b = admit(
        &store,
        2,
        "default",
        SLUG,
        json!({ "content": "other" }),
        Some(json!({ "ok": true })),
    );
    let listed = store
        .list_requests_for_slugs("default", &[SLUG.to_string()], 10, "0")
        .unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 2);
    let redaction: RedactRequestArgs = args(json!({
        "id": a, "terminalReservation": 900, "outcome": "{\"keep\":\"x\"}", "errorDetail": null,
    }));
    store.redact_write_request_row(&redaction).unwrap();
    let row = store.read_write_request_by_id(&a).unwrap().unwrap();
    assert_eq!(row["intent"], Value::Null);
    assert_eq!(row["compacted"], json!(true));
    assert_eq!(row["outcome"], json!({ "keep": "x" }));
    assert_eq!(row["error_message"], Value::Null);
    assert_eq!(row["error_detail"], Value::Null);
    assert_eq!(
        row["terminal_reservation"].to_string().trim_matches('"'),
        "900"
    );
    let listed = store
        .list_requests_for_slugs("default", &[SLUG.to_string()], 10, "0")
        .unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], json!(b));
    // The compacted request no longer carries the claim; the other request is untouched.
    assert!(ids_of(&chunk(&store, json!({}))).is_empty());
    assert_eq!(
        store.read_write_request_by_id(&b).unwrap().unwrap()["intent"],
        json!({ "content": "other" })
    );
}

#[test]
fn a_redaction_of_an_unknown_request_changes_nothing_and_a_bad_id_is_refused() {
    let (_dir, store) = brain("page-purge-journal-unknown");
    let a = admit(
        &store,
        1,
        "default",
        SLUG,
        json!({ "content": CLAIM }),
        Some(json!({ "ok": true })),
    );
    let missing: RedactRequestArgs = args(json!({
        "id": "f0000000-0000-4000-8000-0000000000ff", "terminalReservation": 1, "outcome": null, "errorDetail": null,
    }));
    store.redact_write_request_row(&missing).unwrap();
    assert_eq!(
        store.read_write_request_by_id(&a).unwrap().unwrap()["intent"],
        json!({ "content": CLAIM })
    );
    let bad: RedactRequestArgs = args(
        json!({ "id": "not-a-uuid", "terminalReservation": 1, "outcome": null, "errorDetail": null }),
    );
    assert!(store.redact_write_request_row(&bad).is_err());
    assert!(store.read_effect_bytes("not-a-uuid").is_err());
}

#[test]
fn a_chunk_is_bounded_by_its_cursor_ceiling_ids_and_exclusion_and_reports_where_it_stopped() {
    let (_dir, store) = brain("page-purge-journal-chunk");
    let a = admit(
        &store,
        1,
        "default",
        SLUG,
        json!({ "content": CLAIM }),
        Some(json!({ "ok": true })),
    );
    let b = admit(
        &store,
        2,
        "default",
        SLUG,
        json!({ "content": "plain" }),
        Some(json!({ "ok": true })),
    );
    let c = admit(
        &store,
        3,
        "default",
        SLUG,
        json!({ "content": "queued" }),
        None,
    );
    let d = admit(
        &store,
        4,
        "other",
        SLUG,
        json!({ "content": CLAIM }),
        Some(json!({ "ok": true })),
    );
    let all = chunk(&store, json!({}));
    // a matches; b matches nothing and is not pending; c is queued (pending); d is another source.
    assert_eq!(ids_of(&all), vec![a.clone(), c.clone()]);
    assert_eq!(all["scanned"], json!(3));
    assert_eq!(all["rows"][0]["hits"], json!([0]));
    assert_eq!(all["rows"][1]["pending"], json!(true));
    let seq = |id: &str| {
        store.read_write_request_by_id(id).unwrap().unwrap()["sequence"]
            .to_string()
            .trim_matches('"')
            .to_string()
    };
    assert_eq!(all["last"], json!(seq(&c)));
    let past = chunk(&store, json!({ "after": seq(&a), "ceiling": seq(&b) }));
    assert_eq!(past["scanned"], json!(1));
    assert_eq!(past["last"], json!(seq(&b)));
    assert!(past["rows"].as_array().unwrap().is_empty());
    assert_eq!(
        ids_of(&chunk(&store, json!({ "ids": [] }))),
        Vec::<String>::new()
    );
    assert_eq!(
        ids_of(&chunk(&store, json!({ "ids": [c.clone(), d.clone()] }))),
        vec![c.clone()]
    );
    assert_eq!(
        ids_of(&chunk(&store, json!({ "exclude": a.clone() }))),
        vec![c.clone()]
    );
    assert_eq!(chunk(&store, json!({ "limit": 1 }))["scanned"], json!(1));
    let none = chunk(&store, json!({ "sourceId": "nobody" }));
    assert_eq!(
        (none["scanned"].clone(), none["last"].clone()),
        (json!(0), Value::Null)
    );
    assert_eq!(store.read_journal_ceiling("nobody").unwrap(), Value::Null);
    assert_eq!(
        store.read_journal_ceiling("default").unwrap(),
        json!(seq(&c))
    );
    // An empty needle matches every request of the chunk.
    assert_eq!(
        ids_of(&chunk(&store, json!({ "needles": [""] }))),
        vec![a, b, c]
    );
}

#[test]
fn the_lock_answers_each_request_once_by_id_and_the_release_never_goes_below_zero() {
    let (_dir, store) = brain("page-purge-journal-lock");
    let a = admit(
        &store,
        1,
        "default",
        SLUG,
        json!({ "content": CLAIM }),
        Some(json!({ "ok": true })),
    );
    assert_eq!(store.read_effect_bytes(&a).unwrap(), 0);
    let before = terminal(&store, KEY);
    assert!(before > 0);
    store.release_terminal_bytes(KEY, 0).unwrap();
    store
        .release_terminal_bytes("principal:nobody:nothing", 500)
        .unwrap();
    assert_eq!(terminal(&store, KEY), before);
    store.release_terminal_bytes(KEY, 7).unwrap();
    assert_eq!(terminal(&store, KEY), before - 7);
    store
        .release_terminal_bytes(KEY, 1_000_000_000_000)
        .unwrap();
    assert_eq!(terminal(&store, KEY), 0);
}
