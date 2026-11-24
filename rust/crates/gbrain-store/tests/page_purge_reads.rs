//! The reads and tombstone edits of a page purge the store serves (`facts/page_purge_reads.rs`, `facts/page_purges.rs`,
//! `facts/purge_ledger.rs`, `facts/take_purges.rs`): a page's claims, link streams, queued purges, stored body, versions,
//! cascade counts, mirrored claims and the page, fact and take tombstones.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::PagePurgeUpsert;
use gbrain_store::facts::purge_ledger::FactPurgeInsert;
use gbrain_store::facts::take_purges::TakePurgeInsert;
use gbrain_store::links::AddLinkOptions;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::persistence::WriteRequestInsert;
use gbrain_store::sources::SourceInput;
use gbrain_store::takes::TakeInput;
use serde_json::{Value, json};

const SLUG: &str = "notes/doomed";
const REQ: &str = "A0000000-0000-4000-8000-0000000000A1";
const REQ2: &str = "a0000000-0000-4000-8000-0000000000a2";
const TERMINAL: &str = "cli:extract-conversation-facts:terminal:v2";

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

fn put(store: &Store, slug: &str, body: &str, source_path: Option<&str>) -> u64 {
    let input: PageInput = args(
        json!({ "type": "note", "title": slug, "compiled_truth": body,
        "frontmatter": {}, "source_path": source_path }),
    );
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn fact(store: &Store, source: &str, text: &str, extra: Value) -> u64 {
    let mut input = json!({ "fact": text, "kind": "fact", "visibility": "world", "source": "fence",
        "entity_slug": null, "source_markdown_slug": null, "row_num": null });
    for (k, v) in extra.as_object().unwrap() {
        input[k] = v.clone();
    }
    store
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": [input], "sourceId": source }),
        ))
        .unwrap()["ids"][0]
        .as_u64()
        .unwrap()
}

fn filed(store: &Store, text: &str, row: i64, extra: Value) -> u64 {
    let mut over = json!({ "source_markdown_slug": SLUG, "row_num": row });
    for (k, v) in extra.as_object().unwrap() {
        over[k] = v.clone();
    }
    fact(store, "default", text, over)
}

fn texts(rows: Vec<Value>, field: &str) -> Vec<String> {
    rows.iter()
        .map(|r| r[field].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_pages_facts_are_those_filed_on_it_and_those_extracted_from_it_by_id() {
    let (_dir, store) = brain("page-purge-facts");
    let a = filed(&store, "Filed one", 1, json!({}));
    let b = filed(
        &store,
        "EXTRACTION_COMPLETE",
        2,
        json!({ "source": TERMINAL }),
    );
    let c = fact(
        &store,
        "default",
        "Extracted fact",
        json!({ "source": "mcp:put_page", "context": "notes/doomed \u{2014} first paragraph" }),
    );
    // Not the page's: another page's, another context head, a non-extraction source, another source.
    filed(
        &store,
        "Elsewhere",
        3,
        json!({ "source_markdown_slug": "notes/keeper" }),
    );
    fact(
        &store,
        "default",
        "Other head",
        json!({ "source": "mcp:put_page", "context": "notes/doomed-two \u{2014} x" }),
    );
    fact(
        &store,
        "default",
        "Chat fact",
        json!({ "source": "chat", "context": "notes/doomed \u{2014} x" }),
    );
    fact(
        &store,
        "other",
        "Other source",
        json!({ "source": "mcp:put_page", "context": "notes/doomed \u{2014} x" }),
    );
    let rows = store.list_purge_claim_facts("default", SLUG).unwrap();
    let ids: Vec<u64> = rows.iter().map(|r| r["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, vec![a, b, c]);
    assert_eq!(rows[1]["source"], TERMINAL);
    assert!(
        store
            .list_purge_claim_facts("default", "notes/none")
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.list_purge_claim_facts("other", SLUG).unwrap().len(),
        1
    );
    // The segment claims and the mirrored claims leave the outcome marker out.
    assert_eq!(
        store.list_purge_segment_claims("default", SLUG, 0).unwrap(),
        vec!["Extracted fact".to_string(), "Filed one".to_string()]
    );
    let mirror = store.list_page_mirror_facts("default", SLUG).unwrap();
    assert_eq!(mirror.len(), 2);
    assert!(
        mirror
            .iter()
            .all(|m| m["visibility"] == "world" && m["subject"] == "*")
    );
    assert!(
        store
            .list_page_mirror_facts("default", "notes/none")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn the_page_purge_tombstones_each_claim_once_and_the_unpurge_removes_them_by_request() {
    let (_dir, store) = brain("page-purge-fact-tombstones");
    filed(&store, "Filed one", 1, json!({}));
    filed(&store, "filed  ONE.", 2, json!({}));
    filed(
        &store,
        "Private note",
        3,
        json!({ "visibility": "private", "entity_slug": "people/alice" }),
    );
    filed(
        &store,
        "EXTRACTION_COMPLETE",
        4,
        json!({ "source": TERMINAL }),
    );
    store
        .insert_page_fact_purges("default", SLUG, REQ, "owner:local")
        .unwrap();
    // A second purge of the same claims keeps the first tombstones.
    store
        .insert_page_fact_purges("default", SLUG, REQ2, "owner:other")
        .unwrap();
    assert!(
        store
            .is_fact_purged("default", "world", "Filed one", None)
            .unwrap()
    );
    assert!(
        store
            .is_fact_purged("default", "private", "Private note", Some("people/alice"))
            .unwrap()
    );
    assert!(
        !store
            .is_fact_purged("default", "world", "EXTRACTION_COMPLETE", None)
            .unwrap()
    );
    assert!(
        store
            .insert_page_fact_purges("default", SLUG, "nope", "x")
            .is_err()
    );
    // A page with no claims writes nothing, even into a source that does not exist.
    store
        .insert_page_fact_purges("missing", "notes/none", REQ, "x")
        .unwrap();
    assert_eq!(
        store
            .delete_fact_purges_by_requests("default", &[REQ2.to_string()])
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .delete_fact_purges_by_requests("other", &[REQ.to_string()])
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .delete_fact_purges_by_requests("default", &[REQ.to_lowercase()])
            .unwrap(),
        2
    );
    assert!(
        !store
            .is_fact_purged("default", "world", "Filed one", None)
            .unwrap()
    );
    assert!(
        store
            .delete_fact_purges_by_requests("default", &["nope".to_string()])
            .is_err()
    );
}

#[test]
fn a_pages_takes_are_read_by_id_and_hashed_once_per_claim() {
    let (_dir, store) = brain("page-purge-takes");
    let page = put(&store, SLUG, "body", None);
    let keeper = put(&store, "notes/keeper", "body", None);
    let take = |page_id: u64, row: u64, claim: &str| -> TakeInput {
        args(
            json!({ "page_id": page_id, "row_num": row, "claim": claim, "kind": "take",
            "holder": "people/alice", "weight": 0.5, "active": true }),
        )
    };
    store
        .add_takes_batch(&[
            take(page, 1, "The harbor reopens"),
            take(page, 2, "the harbor  REOPENS."),
            take(page, 3, "Another claim"),
            take(keeper, 1, "Keeper claim"),
        ])
        .unwrap();
    let rows = store.list_purge_claim_takes(page as i64).unwrap();
    assert_eq!(texts(rows, "claim")[2], "Another claim");
    assert_eq!(
        store.list_purge_claim_takes(keeper as i64).unwrap().len(),
        1
    );
    assert!(store.list_purge_claim_takes(9999).unwrap().is_empty());
    assert!(store.list_purge_claim_takes(-1).unwrap().is_empty());
    // Two claims that normalize alike share one fingerprint.
    assert_eq!(
        store
            .list_page_mirror_take_hashes(page as i64)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        store
            .list_purge_segment_claims("default", SLUG, page as i64)
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        store.count_page_cascade_rows(page as i64).unwrap()["takes"],
        3
    );
}

#[test]
fn the_link_streams_of_a_page_name_the_origin_page_when_a_link_has_one() {
    let (_dir, store) = brain("page-purge-link-streams");
    let doomed = put(&store, SLUG, "body", None);
    for slug in [
        "notes/keeper",
        "notes/third",
        "notes/unrelated",
        "notes/unrelated-two",
    ] {
        put(&store, slug, "body", None);
    }
    let link = |from: &str, to: &str, origin: Option<&str>| {
        let options: AddLinkOptions = args(json!({ "linkType": "mentions", "context": "c",
            "originSlug": origin, "originField": origin.map(|_| "related") }));
        store.add_link(from, to, &options).unwrap();
    };
    link(SLUG, "notes/keeper", None);
    link("notes/keeper", SLUG, None);
    link("notes/unrelated", SLUG, Some("notes/third"));
    link("notes/unrelated", "notes/unrelated-two", None);
    assert_eq!(
        store
            .list_page_link_streams("default", doomed as i64)
            .unwrap(),
        vec!["notes/doomed", "notes/keeper", "notes/third"]
    );
    assert!(
        store
            .list_page_link_streams("other", doomed as i64)
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list_page_link_streams("default", 9999)
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list_page_link_streams("default", -1)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn queued_page_purges_are_the_queued_purge_requests_after_a_sequence_with_their_page() {
    let (_dir, store) = brain("page-purge-queued");
    let page = put(&store, SLUG, "body", None);
    let keys = vec!["brain".to_string()];
    let admit = |request_id: &str, operation: &str, slug: &str, intent: Value, source: &str| {
        store.lock_persistence_counters(&keys).unwrap();
        let incarnation = store.read_source_membership(source).unwrap().unwrap()["incarnation"]
            .as_str()
            .unwrap()
            .to_string();
        let insert: WriteRequestInsert = args(json!({
            "principalKind": "local_cli", "principalId": "parity-writer", "requestId": request_id,
            "operation": operation, "sourceId": source, "sourceIncarnation": incarnation, "pageId": null,
            "slug": slug, "worktreeId": null, "topologyGeneration": null, "digest": "digest", "intent": intent,
            "authority": {}, "intentBytes": 10, "terminalReservation": 4096, "targetKind": "page",
            "protocolVersion": 1, "admitterVersion": "v-test", "admitterHostId": null, "counterKeys": keys,
            "clientRequestId": null, "state": "queued", "deferredRefreshId": null,
        }));
        let row = store.insert_write_request(&insert).unwrap();
        row["sequence"].as_str().map_or_else(
            || row["sequence"].as_u64().unwrap().to_string(),
            str::to_string,
        )
    };
    let first = admit(
        "b0000000-0000-4000-8000-0000000000b1",
        "delete_page",
        SLUG,
        json!({ "purge": true }),
        "default",
    );
    admit(
        "b0000000-0000-4000-8000-0000000000b2",
        "delete_page",
        "notes/no-page",
        json!({ "purge": true }),
        "default",
    );
    admit(
        "b0000000-0000-4000-8000-0000000000b3",
        "delete_page",
        SLUG,
        json!({ "purge": false }),
        "default",
    );
    admit(
        "b0000000-0000-4000-8000-0000000000b4",
        "put_page",
        SLUG,
        json!({ "purge": true }),
        "default",
    );
    admit(
        "b0000000-0000-4000-8000-0000000000b5",
        "delete_page",
        SLUG,
        json!({}),
        "default",
    );
    admit(
        "b0000000-0000-4000-8000-0000000000b6",
        "delete_page",
        SLUG,
        json!({ "purge": "true" }),
        "default",
    );
    admit(
        "b0000000-0000-4000-8000-0000000000b7",
        "delete_page",
        SLUG,
        json!({ "purge": true }),
        "other",
    );
    let all = store.list_queued_page_purges("default", "0", 32).unwrap();
    let slugs: Vec<(String, Option<u64>)> = all
        .iter()
        .map(|r| {
            (
                r["slug"].as_str().unwrap().to_string(),
                r["page_id"].as_u64(),
            )
        })
        .collect();
    assert_eq!(
        slugs,
        vec![
            (SLUG.to_string(), Some(page)),
            ("notes/no-page".to_string(), None),
            (SLUG.to_string(), Some(page)),
        ]
    );
    assert_eq!(
        store
            .list_queued_page_purges("default", &first, 32)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        store
            .list_queued_page_purges("default", "0", 1)
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .list_queued_page_purges("default", "0", 0)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .list_queued_page_purges("other", "0", 32)
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .list_queued_page_purges("nobody", "0", 32)
            .unwrap()
            .is_empty()
    );
    assert!(store.list_queued_page_purges("default", "x", 32).is_err());
}

#[test]
fn a_pages_stored_body_versions_and_cascade_counts() {
    let (_dir, store) = brain("page-purge-body");
    let page = put(&store, SLUG, "first draft", Some("notes/doomed.md"));
    store.create_version(SLUG, None).unwrap();
    put(&store, SLUG, "second draft", Some("notes/doomed-old.md"));
    store.create_version(SLUG, None).unwrap();
    put(&store, SLUG, "third draft", Some("notes/doomed.md"));
    let body = store.read_purge_page_body(page as i64).unwrap();
    assert!(body["content_hash"].as_str().is_some_and(|h| !h.is_empty()));
    assert_eq!(body["body_generation"], 0);
    assert!(store.read_purge_page_body(9999).unwrap().is_null());
    assert!(store.read_purge_page_body(-1).unwrap().is_null());
    let versions = store
        .list_page_version_bodies_for_purge(page as i64)
        .unwrap();
    assert_eq!(
        texts(versions.clone(), "compiled_truth"),
        vec!["second draft", "first draft"]
    );
    assert_eq!(versions[0]["body_storage"], "inline");
    assert!(versions[0]["body_generation"].is_null());
    assert_eq!(versions[0]["type"], "note");
    assert_eq!(
        store.list_page_version_source_paths(page as i64).unwrap(),
        vec!["notes/doomed-old.md", "notes/doomed.md"]
    );
    let counts = store.count_page_cascade_rows(page as i64).unwrap();
    assert_eq!(counts["versions"], 2);
    assert_eq!(counts["takes"], 0);
    assert!(counts["chunks"].as_u64().unwrap() >= 1);
    let none = store.count_page_cascade_rows(9999).unwrap();
    assert_eq!(
        none,
        json!({ "chunks": 0, "versions": 0, "takes": 0, "timeline": 0 })
    );
}

#[test]
fn page_tombstones_list_newest_first_and_the_delete_returns_the_request_of_each() {
    let (_dir, store) = brain("page-purge-tombstones");
    let upsert = |source: &str, hashes: &[&str], slug: &str, request: Option<&str>| {
        store
            .upsert_page_purges(&args::<PagePurgeUpsert>(json!({ "sourceId": source,
                "contentHashes": hashes, "slug": slug, "requestId": request })))
            .unwrap();
    };
    upsert("default", &["h1", "h2"], SLUG, Some(REQ));
    std::thread::sleep(std::time::Duration::from_millis(2));
    upsert("default", &["h3"], "notes/gone", Some(REQ2));
    std::thread::sleep(std::time::Duration::from_millis(2));
    upsert("other", &["h1"], SLUG, None);
    let fact: FactPurgeInsert = args(json!({ "sourceId": "default", "visibility": "world",
        "subject": "*", "factHash": "f1", "requestId": REQ, "actor": "x", "reason": null }));
    store.insert_fact_purge(&fact).unwrap();
    let take: TakePurgeInsert = args(json!({ "sourceId": "default", "subject": SLUG,
        "claimHash": "t1", "requestId": REQ }));
    store.insert_take_purge(&take).unwrap();
    let tombstones = store.list_page_purge_tombstones("default", 10).unwrap();
    assert_eq!(texts(tombstones, "content_hash"), vec!["h3", "h1", "h2"]);
    assert_eq!(
        store
            .list_page_purge_tombstones("default", 1)
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .list_page_purge_tombstones("default", 0)
            .unwrap()
            .is_empty()
    );
    assert!(store.list_page_purge_tombstones("default", -1).is_err());
    let all = store.list_page_purge_rows(None, 10).unwrap();
    assert_eq!(all.len(), 4);
    assert_eq!(all[0]["source_id"], "other");
    assert_eq!(all[1]["slug"], "notes/gone");
    assert!(all[0]["purged_at"].as_str().unwrap().ends_with('Z'));
    let one = store.list_page_purge_rows(Some("other"), 10).unwrap();
    assert_eq!(one.len(), 1);
    assert!(one[0]["request_id"].is_null());
    assert_eq!(one[0]["source_id"], "other");
    assert_eq!(store.list_page_purge_rows(None, 1).unwrap().len(), 1);
    assert!(
        store
            .list_page_purge_rows(Some("nobody"), 10)
            .unwrap()
            .is_empty()
    );
    // The delete returns each removed tombstone's request id and leaves the other slug and source alone.
    let cleared = store.delete_page_purge_tombstones("default", SLUG).unwrap();
    assert_eq!(
        cleared,
        vec![Some(REQ.to_lowercase()), Some(REQ.to_lowercase())]
    );
    assert!(
        store
            .delete_page_purge_tombstones("default", SLUG)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .count_page_purge_tombstones("default", "notes/gone")
            .unwrap(),
        1
    );
    assert_eq!(store.count_page_purge_tombstones("other", SLUG).unwrap(), 1);
    assert_eq!(
        store.delete_page_purge_tombstones("other", SLUG).unwrap(),
        vec![None]
    );
    // The fact and take tombstones of the cleared request go by request id.
    assert_eq!(
        store
            .delete_fact_purges_by_requests("default", &[REQ.to_string()])
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .delete_take_purges_by_requests("default", &[REQ.to_string()])
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .delete_take_purges_by_requests("default", &[REQ.to_string()])
            .unwrap(),
        0
    );
    assert!(
        store
            .delete_take_purges_by_requests("default", &["nope".to_string()])
            .is_err()
    );
}
