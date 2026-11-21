//! A page purge receipt's store probes (`facts/purge_store_probe.rs`): the rows, requests and effects that still name a
//! purged page, counted at most `rows + 1`, and the effect probe's item list.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::purge_store_probe::StoreProbeArgs;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::persistence::WriteRequestInsert;
use gbrain_store::sources::SourceInput;
use gbrain_store::takes::TakeInput;
use serde_json::{Value, json};

const SLUG: &str = "notes/doomed";

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

fn put(store: &Store, slug: &str) -> u64 {
    let input: PageInput = args(
        json!({ "type": "note", "title": slug, "compiled_truth": "body",
        "frontmatter": {}, "source_path": null }),
    );
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn count(store: &Store, probe: Value, rows: i64) -> i64 {
    let q: StoreProbeArgs = args(json!({ "probe": probe, "rows": rows }));
    store.count_purge_store_probe(&q).unwrap()
}

fn slug_key(store: &Store, kind: &str, source: &str, slug: &str) -> i64 {
    count(
        store,
        json!({ "kind": "slug_key", "store": kind, "sourceId": source, "slug": slug }),
        10,
    )
}

#[test]
fn a_page_and_the_facts_filed_on_it_are_counted_in_their_own_source_only() {
    let (_dir, store) = brain("purge-store-probe-slug");
    put(&store, SLUG);
    let fact: InsertFactsArgs = args(json!({ "sourceId": "default", "rows": [{
        "fact": "claim", "kind": "fact", "visibility": "world", "source": "fence", "entity_slug": null,
        "source_markdown_slug": SLUG, "row_num": 1 }] }));
    store.insert_facts(&fact).unwrap();
    assert_eq!(slug_key(&store, "pages", "default", SLUG), 1);
    assert_eq!(slug_key(&store, "pages", "other", SLUG), 0);
    assert_eq!(slug_key(&store, "pages", "default", "notes/nobody"), 0);
    assert_eq!(slug_key(&store, "facts", "default", SLUG), 1);
    assert_eq!(slug_key(&store, "facts", "other", SLUG), 0);
    for empty in [
        "take_proposals",
        "open_loops",
        "page_aliases",
        "slug_aliases",
        "eval_candidates.retrieved_slugs",
        "files",
        "write_gate_holds",
    ] {
        assert_eq!(slug_key(&store, empty, "default", SLUG), 0, "{empty}");
    }
}

#[test]
fn a_page_leaves_its_chunks_versions_takes_and_timeline_to_count_by_id() {
    let (_dir, store) = brain("purge-store-probe-rows");
    let page = put(&store, SLUG);
    let take: TakeInput = args(
        json!({ "page_id": page, "row_num": 1, "claim": "c", "kind": "take",
        "holder": "people/alice", "weight": 0.5, "active": true }),
    );
    store.add_takes_batch(&[take]).unwrap();
    let rows = |kind: &str, id: i64| {
        count(
            &store,
            json!({ "kind": "page_rows", "store": kind, "pageId": id }),
            10,
        )
    };
    assert_eq!(rows("takes", page as i64), 1);
    assert_eq!(rows("timeline_entries", page as i64), 0);
    assert_eq!(rows("takes", 9999), 0);
    assert_eq!(rows("takes", -1), 0);
}

#[test]
fn a_count_stops_at_one_past_the_bound() {
    let (_dir, store) = brain("purge-store-probe-bound");
    put(&store, SLUG);
    let probe =
        json!({ "kind": "slug_key", "store": "pages", "sourceId": "default", "slug": SLUG });
    assert_eq!(count(&store, probe.clone(), 0), 1);
    let q: StoreProbeArgs = args(json!({ "probe": probe.clone() }));
    assert!(
        store
            .count_purge_store_probe(&q)
            .unwrap_err()
            .to_string()
            .contains("rows is required")
    );
    let q: StoreProbeArgs = args(json!({ "probe": probe, "rows": -1 }));
    assert!(store.count_purge_store_probe(&q).is_err());
}

#[test]
fn a_request_still_naming_the_page_counts_and_the_purge_itself_does_not() {
    let (_dir, store) = brain("purge-store-probe-requests");
    put(&store, SLUG);
    let keys = vec!["brain".to_string()];
    let admit = |request_id: &str, intent: Value| {
        store.lock_persistence_counters(&keys).unwrap();
        let incarnation = store.read_source_membership("default").unwrap().unwrap()["incarnation"]
            .as_str()
            .unwrap()
            .to_string();
        let insert: WriteRequestInsert = args(json!({
            "principalKind": "local_cli", "principalId": "writer", "requestId": request_id,
            "operation": "put_page", "sourceId": "default", "sourceIncarnation": incarnation, "pageId": null,
            "slug": "notes/other", "worktreeId": null, "topologyGeneration": null, "digest": "digest",
            "intent": intent, "authority": {}, "intentBytes": 10, "terminalReservation": 4096,
            "targetKind": "page", "protocolVersion": 1, "admitterVersion": "v-test", "admitterHostId": null,
            "counterKeys": keys, "clientRequestId": null, "state": "queued", "deferredRefreshId": null,
        }));
        store.insert_write_request(&insert).unwrap();
    };
    let own = "b0000000-0000-4000-8000-0000000000b1";
    admit(own, json!({ "text": "mentions Notes/Doomed here" }));
    let probe = |request_id: &str, needle: &str| {
        count(
            &store,
            json!({ "kind": "page_requests", "sourceId": "default", "slug": SLUG, "requestId": request_id,
                "needles": [needle], "reasons": [] }),
            10,
        )
    };
    let other = "b0000000-0000-4000-8000-0000000000b2";
    assert_eq!(probe(other, "notes/doomed"), 1);
    assert_eq!(probe(other, "notes/absent"), 0);
    assert_eq!(probe(own, "notes/doomed"), 0);
}

#[test]
fn the_stores_the_store_does_not_keep_and_the_fact_purge_probes_refuse() {
    let (_dir, store) = brain("purge-store-probe-refusals");
    let refused = |probe: Value| {
        let q: StoreProbeArgs = args(json!({ "probe": probe, "rows": 1 }));
        store.count_purge_store_probe(&q).unwrap_err().to_string()
    };
    assert!(
        refused(json!({ "kind": "slug_key", "store": "core_edit_notices", "sourceId": "default", "slug": SLUG }))
            .contains("not kept")
    );
    assert!(
        refused(json!({ "kind": "page_rows", "store": "page_aliases", "pageId": 1 }))
            .contains("not kept")
    );
    assert!(
        serde_json::from_value::<StoreProbeArgs>(
            json!({ "probe": { "kind": "fingerprint", "store": "facts" } })
        )
        .is_err()
    );
    let q: StoreProbeArgs = args(json!({ "probe": { "kind": "slug_key", "store": "pages",
        "sourceId": "default", "slug": SLUG } }));
    assert!(
        store
            .list_purge_store_probe_items(&q)
            .unwrap_err()
            .to_string()
            .contains("only an effect probe")
    );
    let nul = args::<StoreProbeArgs>(json!({ "probe": { "kind": "slug_key", "store": "pages",
        "sourceId": "default", "slug": "a\u{0}b" }, "rows": 1 }));
    assert!(store.count_purge_store_probe(&nul).is_err());
}

#[test]
fn an_effect_probe_of_a_store_with_no_effects_lists_nothing() {
    let (_dir, store) = brain("purge-store-probe-effects");
    let q: StoreProbeArgs = args(
        json!({ "probe": { "kind": "effect_payload", "sourceId": "default",
        "forms": ["notes/doomed"], "page": { "slug": SLUG, "reasonForms": ["purge"] } }, "rows": 5 }),
    );
    assert_eq!(store.count_purge_store_probe(&q).unwrap(), 0);
    assert_eq!(store.list_purge_store_probe_items(&q).unwrap(), json!([]));
}
