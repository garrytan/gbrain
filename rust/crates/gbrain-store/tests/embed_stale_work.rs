//! The embed --stale reads and writes (`embeddings::stale_work`, rust/docs/store/embed-stale-work.md), matched to the
//! SQL in `src/core/engine-sql/embed-stale-work.ts`.

mod memory_env;

use gbrain_store::Store;
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::embeddings::SignatureOptions;
use gbrain_store::embeddings::stale_work::{
    ArchivedWorkOptions, DriftWindow, PendingScope, SignatureDriftOptions,
};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use memory_env::brain;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn basis(axis: usize) -> Vec<f64> {
    (0..1536)
        .map(|i| if i == axis { 1.0 } else { 0.0 })
        .collect()
}

fn source(store: &Store, id: &str) {
    store
        .upsert_source(&SourceInput {
            id: id.into(),
            name: Some(id.into()),
            ..SourceInput::default()
        })
        .unwrap();
}

/// A page in `source`; returns (id, knowledge revision).
fn page(store: &Store, source: &str, slug: &str, frontmatter: Value) -> (u64, String) {
    let input: PageInput = de(
        json!({ "type": "note", "title": slug, "compiled_truth": "body text", "frontmatter": frontmatter }),
    );
    let row = store
        .put_page(
            slug,
            &input,
            &de::<PutPageOptions>(json!({ "index": false, "sourceId": source })),
        )
        .unwrap();
    (
        row["id"].as_u64().unwrap(),
        row["knowledge_revision"].as_str().unwrap().to_string(),
    )
}

/// Seals one chunk of the page, with a vector when `embedded`.
fn seal(store: &Store, source: &str, slug: &str, revision: &str, embedded: bool) {
    let chunk = if embedded {
        json!({ "chunk_index": 0, "chunk_text": "body text", "model": "openai:m", "embedding": basis(0) })
    } else {
        json!({ "chunk_index": 0, "chunk_text": "body text", "model": "openai:m" })
    };
    store
        .upsert_chunks(
            slug,
            &de::<Vec<ChunkInput>>(json!([chunk])),
            &UpsertChunksOptions {
                expected_revision: Some(revision.to_string()),
                seal: true,
                source_id: Some(source.to_string()),
                ..Default::default()
            },
        )
        .unwrap();
}

fn archived(store: &Store, v: Value) -> u64 {
    store
        .count_archived_embedding_work(&de::<ArchivedWorkOptions>(v))
        .unwrap()
}

fn drift(store: &Store, v: Value) -> bool {
    store
        .has_embedding_signature_drift(&de::<SignatureDriftOptions>(v))
        .unwrap()
}

#[test]
fn archived_work_counts_live_pages_of_archived_sources_with_work() {
    let b = brain("esw-archived");
    source(&b, "old");
    let (_, rev) = page(&b, "old", "a/stale", json!({}));
    seal(&b, "old", "a/stale", &rev, false);
    let (_, rev) = page(&b, "old", "a/embedded", json!({}));
    seal(&b, "old", "a/embedded", &rev, true);
    page(&b, "old", "a/chunkless", json!({}));
    page(
        &b,
        "old",
        "a/quarantined",
        json!({ "quarantine": { "reason": "t" } }),
    );
    let (_, rev) = page(
        &b,
        "old",
        "a/skip",
        json!({ "embed_skip": { "reason": "t" } }),
    );
    seal(&b, "old", "a/skip", &rev, false);
    let (_, rev) = page(&b, "default", "a/active", json!({}));
    seal(&b, "default", "a/active", &rev, false);
    assert!(b.set_source_archived("old", true).unwrap());
    let base = json!({ "sourceId": null, "signature": null, "includeNullSignature": false, "includeUnsealed": false, "column": "embedding" });
    assert_eq!(
        archived(&b, base.clone()),
        2,
        "the stale page and the chunkless one"
    );
    let mut null_column = base.clone();
    null_column["column"] = Value::Null;
    assert_eq!(
        archived(&b, null_column),
        3,
        "a null column reads every chunk as missing its vector"
    );
    let mut unsealed = base.clone();
    unsealed["includeUnsealed"] = json!(true);
    assert_eq!(
        archived(&b, unsealed),
        3,
        "the unsealed quarantined page counts too"
    );
    let mut signed = base.clone();
    signed["signature"] = json!("openai:m:1536");
    signed["includeNullSignature"] = json!(true);
    assert_eq!(
        archived(&b, signed),
        3,
        "the embedded page has no signature"
    );
    let mut wrong = base;
    wrong["column"] = json!("embedding_image");
    assert!(
        b.count_archived_embedding_work(&de::<ArchivedWorkOptions>(wrong))
            .is_err()
    );
}

#[test]
fn pending_projections_read_unsealed_pages_of_the_scope() {
    let b = brain("esw-pending");
    source(&b, "old");
    let (_, rev) = page(&b, "default", "a/sealed", json!({}));
    seal(&b, "default", "a/sealed", &rev, false);
    let (unsealed, _) = page(&b, "default", "a/unsealed", json!({}));
    page(
        &b,
        "default",
        "a/skip",
        json!({ "embed_skip": { "reason": "t" } }),
    );
    page(&b, "old", "b/archived", json!({}));
    assert!(b.set_source_archived("old", true).unwrap());
    let scope = |v: Value| de::<PendingScope>(v);
    let all = json!({ "sourceId": null, "existingChunksOnly": false, "activeSourcesOnly": false, "stale": null });
    assert_eq!(
        b.count_embed_pending_projections(&scope(all.clone()))
            .unwrap(),
        2
    );
    let mut active = all.clone();
    active["activeSourcesOnly"] = json!(true);
    assert_eq!(
        b.count_embed_pending_projections(&scope(active)).unwrap(),
        1
    );
    let mut chunks = all.clone();
    chunks["existingChunksOnly"] = json!(true);
    assert_eq!(
        b.count_embed_pending_projections(&scope(chunks)).unwrap(),
        0
    );
    assert_eq!(
        b.list_embed_pending_projections(&scope(all.clone()), 10)
            .unwrap(),
        vec![json!({ "source_id": "default", "slug": "a/unsealed", "page_kind": "markdown" })]
    );
    assert_eq!(
        b.list_embed_projection_repair_pages(&scope(all.clone()), 0, 10)
            .unwrap(),
        vec![json!({ "slug": "a/unsealed", "source_id": "default", "id": unsealed })]
    );
    assert!(
        b.list_embed_projection_repair_pages(&scope(all), unsealed, 10)
            .unwrap()
            .is_empty()
    );
    assert!(!b.read_page_is_segmented(unsealed).unwrap());
    assert!(!b.read_page_is_segmented(987_654_321).unwrap());
}

#[test]
fn signature_drift_reads_embedded_live_body_chunks_and_skips_held_pages() {
    let b = brain("esw-drift");
    let (id, rev) = page(&b, "default", "a/one", json!({}));
    seal(&b, "default", "a/one", &rev, true);
    let base = json!({ "column": "embedding", "signature": "openai:m:1536", "sourceId": null, "includeNullSignature": false, "nullSignatureOnly": false });
    assert!(
        !drift(&b, base.clone()),
        "an unsigned page drifts only with includeNullSignature"
    );
    let mut with_null = base.clone();
    with_null["includeNullSignature"] = json!(true);
    assert!(drift(&b, with_null));
    let mut null_only = base.clone();
    null_only["nullSignatureOnly"] = json!(true);
    assert!(drift(&b, null_only.clone()));
    b.set_page_embedding_signature(
        "a/one",
        &de::<SignatureOptions>(json!({ "signature": "openai:other:1536" })),
    )
    .unwrap();
    assert!(drift(&b, base.clone()));
    assert!(!drift(&b, null_only));
    // A conversation-archive hold applies at any size, so the held page leaves the queue.
    b.hold_page_embedding(id, "archive_backfill").unwrap();
    assert!(!drift(&b, base));
}

#[test]
fn ensure_config_creates_the_row_once() {
    let b = brain("esw-config");
    assert_eq!(
        b.ensure_config("embed.content_drift_sweep.t", "{\"cursor\":0}")
            .unwrap(),
        "{\"cursor\":0}"
    );
    b.set_config("embed.content_drift_sweep.t", "{\"cursor\":7}")
        .unwrap();
    assert_eq!(
        b.ensure_config("embed.content_drift_sweep.t", "{\"cursor\":0}")
            .unwrap(),
        "{\"cursor\":7}"
    );
}

#[test]
fn a_content_drift_batch_walks_chunk_ids_and_keeps_current_vectors() {
    let b = brain("esw-content-drift");
    let (_, rev) = page(&b, "default", "a/one", json!({}));
    seal(&b, "default", "a/one", &rev, true);
    let (_, rev) = page(&b, "default", "a/two", json!({}));
    seal(&b, "default", "a/two", &rev, true);
    let window = |after: u64, limit: u64| {
        de::<DriftWindow>(
            json!({ "column": "embedding", "afterChunkId": after, "limit": limit, "sourceId": null }),
        )
    };
    let first = b.invalidate_content_drift_chunks(&window(0, 1)).unwrap();
    assert_eq!(
        (first["checked"].clone(), first["drifted"].clone()),
        (json!(1), json!(0))
    );
    let last = first["last_id"].as_u64().unwrap();
    let rest = b
        .invalidate_content_drift_chunks(&window(last, 10))
        .unwrap();
    assert_eq!(
        (rest["checked"].clone(), rest["drifted"].clone()),
        (json!(1), json!(0))
    );
    let done = b
        .invalidate_content_drift_chunks(&window(rest["last_id"].as_u64().unwrap(), 10))
        .unwrap();
    assert_eq!(done, json!({ "last_id": null, "checked": 0, "drifted": 0 }));
    assert!(b.invalidate_content_drift_chunks(&window(0, 0)).is_err());
}
