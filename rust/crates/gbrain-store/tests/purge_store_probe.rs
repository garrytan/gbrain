//! A page purge receipt's store probes (`facts/purge_store_probe.rs`): the rows, requests and effects that still name a
//! purged page, counted at most `rows + 1`, and the effect probe's item list.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::purge::PurgeTargetArgs;
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
fn the_stores_the_store_does_not_keep_refuse_and_a_probe_missing_its_fields_does_not_parse() {
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
        refused(
            json!({ "kind": "claim_text", "store": "core_edit_notices", "sourceId": "default",
            "claim": "x", "json": "x", "reason": "x", "reasonJson": "x" })
        )
        .contains("not kept")
    );
    assert!(
        refused(
            json!({ "kind": "fingerprint", "store": "page_aliases", "sourceId": "default",
            "factHash": "h", "visibility": "world", "subject": "*" })
        )
        .contains("not kept")
    );
    assert!(
        serde_json::from_value::<StoreProbeArgs>(
            json!({ "probe": { "kind": "fingerprint", "store": "facts" } })
        )
        .is_err()
    );
    let nul_claim = args::<StoreProbeArgs>(
        json!({ "probe": { "kind": "claim_text", "store": "pages",
        "sourceId": "default", "claim": "a\u{0}b", "json": "x", "reason": "x", "reasonJson": "x" }, "rows": 1 }),
    );
    assert!(store.count_purge_store_probe(&nul_claim).is_err());
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

const CLAIM: &str = r#"Acme "raised" a Seed \ round"#;

fn put_in(store: &Store, slug: &str, source: &str, extra: Value) -> u64 {
    let mut body =
        json!({ "type": "note", "title": slug, "compiled_truth": "body", "frontmatter": {} });
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let input: PageInput = args(body);
    let options: PutPageOptions = args(json!({ "sourceId": source, "index": false }));
    store.put_page(slug, &input, &options).unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn fingerprint(store: &Store, kind: &str, hash: &str, over: Value, rows: i64) -> i64 {
    let mut probe = json!({ "kind": "fingerprint", "store": kind, "sourceId": "default",
        "factHash": hash, "visibility": "world", "subject": "*" });
    probe
        .as_object_mut()
        .unwrap()
        .extend(over.as_object().unwrap().clone());
    count(store, probe, rows)
}

fn claim_text(store: &Store, kind: &str, over: Value) -> i64 {
    let (claim, json) = (
        CLAIM.to_lowercase(),
        "acme \\\"raised\\\" a seed \\\\ round",
    );
    let mut probe = json!({ "kind": "claim_text", "store": kind, "sourceId": "default",
        "claim": claim, "json": json, "reason": "tidy the ledger", "reasonJson": "tidy the ledger" });
    probe
        .as_object_mut()
        .unwrap()
        .extend(over.as_object().unwrap().clone());
    count(store, probe, 10)
}

#[test]
fn the_fingerprint_probe_counts_facts_takes_and_proposals_of_the_source_by_claim_hash() {
    let (_dir, store) = brain("purge-store-probe-fingerprint");
    let hasher: SourceInput = args(json!({ "id": "hasher", "name": "hasher", "config": {} }));
    store.upsert_source(&hasher).unwrap();
    // The fingerprint of a claim as the purge target carries it (a fact of that text in a source no probe reads).
    let hash_of = |text: &str| -> String {
        let hashing: InsertFactsArgs = args(json!({ "sourceId": "hasher", "rows": [{
            "fact": text, "kind": "fact", "visibility": "world", "source": "chat", "entity_slug": null }] }));
        let id = store.insert_facts(&hashing).unwrap()["ids"][0]
            .as_f64()
            .unwrap();
        let target: PurgeTargetArgs = args(json!({ "id": id, "sourceId": "hasher" }));
        store.load_purge_target(&target).unwrap()["fact_hash"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let hash = hash_of("The harbor will reopen");
    let row = |fact: &str, over: Value| {
        let mut r = json!({ "fact": fact, "kind": "fact", "visibility": "world", "source": "chat", "entity_slug": null });
        r.as_object_mut()
            .unwrap()
            .extend(over.as_object().unwrap().clone());
        r
    };
    let facts: InsertFactsArgs = args(json!({ "sourceId": "default", "rows": [
        row("The harbor will reopen", json!({})),
        row("the  Harbor will reopen ", json!({ "entity_slug": "notes/keeper" })),
        row("The harbor will reopen", json!({ "visibility": "private" })),
        row("Something else", json!({})),
        row("EXTRACTION_COMPLETE", json!({ "source": "cli:extract-conversation-facts:terminal" })),
    ] }));
    store.insert_facts(&facts).unwrap();
    let elsewhere: InsertFactsArgs =
        args(json!({ "sourceId": "other", "rows": [row("The harbor will reopen", json!({}))] }));
    store.insert_facts(&elsewhere).unwrap();
    let probe = |kind: &str, over: Value| fingerprint(&store, kind, &hash, over, 10);
    assert_eq!(probe("facts", json!({})), 2);
    assert_eq!(probe("facts", json!({ "subject": "notes/keeper" })), 1);
    assert_eq!(probe("facts", json!({ "subject": "notes/nobody" })), 0);
    assert_eq!(probe("facts", json!({ "visibility": "private" })), 1);
    assert_eq!(probe("facts", json!({ "sourceId": "other" })), 1);
    assert_eq!(probe("facts", json!({ "sourceId": "nobody" })), 0);
    let marker = hash_of("EXTRACTION_COMPLETE");
    assert_eq!(fingerprint(&store, "facts", &marker, json!({}), 10), 0);
    assert_eq!(fingerprint(&store, "facts", "nothing", json!({}), 10), 0);
    // The bound: a count stops one row past it.
    assert_eq!(fingerprint(&store, "facts", &hash, json!({}), 1), 2);
    assert_eq!(fingerprint(&store, "facts", &hash, json!({}), 0), 1);

    let doomed = put_in(&store, "notes/doomed", "default", json!({}));
    let keeper = put_in(&store, "notes/keeper", "default", json!({}));
    let away = put_in(&store, "notes/doomed", "other", json!({}));
    let take = |page: u64, row: i32, claim: &str| -> TakeInput {
        args(
            json!({ "page_id": page, "row_num": row, "claim": claim, "kind": "take",
            "holder": "people/alice", "weight": 0.5, "active": true }),
        )
    };
    store
        .add_takes_batch(&[
            take(doomed, 1, "The harbor will reopen"),
            take(keeper, 1, "The harbor will reopen"),
            take(keeper, 2, "Another take"),
            take(away, 1, "The harbor will reopen"),
        ])
        .unwrap();
    assert_eq!(probe("takes", json!({})), 2);
    assert_eq!(probe("takes", json!({ "subject": "notes/keeper" })), 1);
    assert_eq!(probe("takes", json!({ "subject": "notes/nobody" })), 0);
    assert_eq!(probe("takes", json!({ "sourceId": "other" })), 1);
    // A take has no visibility: the probe's visibility never narrows it.
    assert_eq!(probe("takes", json!({ "visibility": "private" })), 2);
    assert_eq!(fingerprint(&store, "takes", &hash, json!({}), 1), 2);

    let proposal = |source: &str, claim: &str| -> gbrain_store::takes::TakeProposalInput {
        args(
            json!({ "sourceId": source, "pageSlug": "notes/doomed", "contentHash": "h",
            "promptVersion": "v", "proposalRunId": "r", "claimText": claim, "kind": "bet",
            "holder": "brain", "weight": 0.5, "modelId": "m" }),
        )
    };
    store
        .insert_take_proposal(&proposal("default", "The harbor will reopen"))
        .unwrap();
    store
        .insert_take_proposal(&proposal("other", "The harbor will reopen"))
        .unwrap();
    store
        .insert_take_proposal(&proposal("default", "Else"))
        .unwrap();
    assert_eq!(probe("take_proposals", json!({})), 1);
    assert_eq!(probe("take_proposals", json!({ "sourceId": "other" })), 1);
    assert_eq!(probe("take_proposals", json!({ "sourceId": "nobody" })), 0);
}

#[test]
fn the_claim_text_probe_counts_pages_chunks_versions_and_requests_that_state_the_claim() {
    let (_dir, store) = brain("purge-store-probe-claim-text");
    assert_eq!(claim_text(&store, "pages", json!({})), 0);
    put_in(
        &store,
        "notes/body",
        "default",
        json!({ "compiled_truth": format!("Notes: {}", CLAIM.to_uppercase()) }),
    );
    put_in(
        &store,
        "notes/timeline",
        "default",
        json!({ "timeline": format!("- {CLAIM}") }),
    );
    put_in(&store, "notes/title", "default", json!({ "title": CLAIM }));
    put_in(
        &store,
        "notes/frontmatter",
        "default",
        json!({ "frontmatter": { "note": CLAIM } }),
    );
    put_in(&store, "notes/clean", "default", json!({}));
    put_in(
        &store,
        "notes/away",
        "other",
        json!({ "compiled_truth": CLAIM }),
    );
    assert_eq!(claim_text(&store, "pages", json!({})), 4);
    assert_eq!(
        claim_text(&store, "pages", json!({ "sourceId": "other" })),
        1
    );
    assert_eq!(
        claim_text(
            &store,
            "pages",
            json!({ "claim": "never stated", "json": "never stated" })
        ),
        0
    );
    let gone = put_in(
        &store,
        "notes/gone",
        "default",
        json!({ "compiled_truth": CLAIM }),
    );
    assert_eq!(claim_text(&store, "pages", json!({})), 5);
    let chunk = |text: &str| -> Vec<ChunkInput> {
        vec![args(
            json!({ "chunk_index": 0, "chunk_text": text, "chunk_source": "compiled_truth" }),
        )]
    };
    let own = |source: &str| UpsertChunksOptions {
        source_id: Some(source.into()),
        ..UpsertChunksOptions::default()
    };
    store
        .upsert_chunks(
            "notes/gone",
            &chunk(&format!("says {CLAIM}")),
            &own("default"),
        )
        .unwrap();
    store
        .upsert_chunks("notes/clean", &chunk("says nothing"), &own("default"))
        .unwrap();
    store
        .upsert_chunks("notes/away", &chunk(CLAIM), &own("other"))
        .unwrap();
    assert_eq!(claim_text(&store, "content_chunks", json!({})), 1);
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    // A soft-deleted page is no page here, and its chunks still count.
    assert_eq!(claim_text(&store, "pages", json!({})), 4);
    assert_eq!(claim_text(&store, "content_chunks", json!({})), 1);
    assert!(gone > 0);

    store.create_version("notes/body", Some("default")).unwrap();
    store
        .create_version_with(
            "notes/clean",
            Some("default"),
            Some(&format!("quoted {CLAIM}")),
        )
        .unwrap();
    store
        .create_version_with("notes/title", Some("default"), Some("TIDY THE LEDGER now"))
        .unwrap();
    assert_eq!(claim_text(&store, "page_versions", json!({})), 3);
    assert_eq!(
        claim_text(&store, "page_versions", json!({ "sourceId": "other" })),
        0
    );

    let keys = vec!["brain".to_string()];
    let admit = |request_id: &str, source: &str, intent: Value| {
        store.lock_persistence_counters(&keys).unwrap();
        let incarnation = store.read_source_membership(source).unwrap().unwrap()["incarnation"]
            .as_str()
            .unwrap()
            .to_string();
        let insert: WriteRequestInsert = args(json!({
            "principalKind": "local_cli", "principalId": "writer", "requestId": request_id,
            "operation": "put_page", "sourceId": source, "sourceIncarnation": incarnation, "pageId": null,
            "slug": "notes/other", "worktreeId": null, "topologyGeneration": null, "digest": "digest",
            "intent": intent, "authority": {}, "intentBytes": 10, "terminalReservation": 4096,
            "targetKind": "page", "protocolVersion": 1, "admitterVersion": "v-test", "admitterHostId": null,
            "counterKeys": keys, "clientRequestId": null, "state": "queued", "deferredRefreshId": null,
        }));
        store.insert_write_request(&insert).unwrap();
    };
    assert_eq!(claim_text(&store, "persistence_requests", json!({})), 0);
    admit(
        "b0000000-0000-4000-8000-0000000000b1",
        "default",
        json!({ "content": CLAIM }),
    );
    admit(
        "b0000000-0000-4000-8000-0000000000b2",
        "other",
        json!({ "content": CLAIM }),
    );
    admit(
        "b0000000-0000-4000-8000-0000000000b3",
        "default",
        json!({ "content": "nothing" }),
    );
    assert_eq!(claim_text(&store, "persistence_requests", json!({})), 1);
    assert_eq!(
        claim_text(
            &store,
            "persistence_requests",
            json!({ "sourceId": "other" })
        ),
        1
    );
    // The reason's JSON form is matched as given.
    assert_eq!(
        claim_text(
            &store,
            "persistence_requests",
            json!({ "claim": "x1", "json": "x2", "reasonJson": "nothing" })
        ),
        1
    );
}
