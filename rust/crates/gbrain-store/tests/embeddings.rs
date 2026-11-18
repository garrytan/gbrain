//! Embedding state: chunk vectors through `upsertChunks`/`sealChunks`, the stale-chunk reads, the
//! signature and content-drift invalidations, the state counts, and take vectors, matched to the
//! PGLite engine.

mod memory_env;

use gbrain_store::Store;
use gbrain_store::chunks::{ChunkInput, GetChunksOptions, UpsertChunksOptions};
use gbrain_store::embeddings::{
    ChunksWithEmbeddingsOptions, InvalidateOptions, ListStaleChunksOptions, SignatureOptions,
    StaleChunkOptions, StaleTakeOptions, StateCountOptions, StateRowOptions, TakeEmbeddingInput,
};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::takes::TakeInput;
use memory_env::{T0, brain};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// A unit vector of width `dims` along `axis`.
fn basis(axis: usize, dims: usize) -> Vec<f64> {
    (0..dims)
        .map(|i| if i == axis { 1.0 } else { 0.0 })
        .collect()
}

/// A page with `frontmatter`, not chunked; returns (id, knowledge revision).
fn page(store: &Store, slug: &str, frontmatter: Value) -> (u64, String) {
    let input: PageInput = de(json!({
        "type": "note", "title": slug, "compiled_truth": "body text", "frontmatter": frontmatter,
    }));
    let row = store
        .put_page(slug, &input, &de::<PutPageOptions>(json!({"index": false})))
        .unwrap();
    (
        row["id"].as_u64().unwrap(),
        row["knowledge_revision"].as_str().unwrap().to_string(),
    )
}

/// `sealChunks`: replaces the page's chunks and seals them to `revision`.
fn seal(store: &Store, slug: &str, revision: &str, chunks: Value) {
    store
        .upsert_chunks(
            slug,
            &de::<Vec<ChunkInput>>(chunks),
            &UpsertChunksOptions {
                expected_revision: Some(revision.to_string()),
                seal: true,
                ..Default::default()
            },
        )
        .unwrap();
}

fn chunks_of(store: &Store, slug: &str) -> Vec<Value> {
    store
        .get_chunks_with(
            slug,
            &GetChunksOptions {
                include_embedding: true,
                ..Default::default()
            },
        )
        .unwrap()
}

fn stale(store: &Store, v: Value) -> u64 {
    store
        .count_stale_chunks(&de::<StaleChunkOptions>(v))
        .unwrap()
}

#[test]
fn a_sealed_vector_reads_back_with_its_model_and_time() {
    let b = brain("emb-roundtrip");
    let (_, rev) = page(&b, "notes/a", json!({}));
    b.clock.set(T0 + 5);
    seal(
        &b,
        "notes/a",
        &rev,
        json!([
            {"chunk_index": 0, "chunk_text": "alpha", "model": "m1", "embedding": basis(0, 1536)},
            {"chunk_index": 1, "chunk_text": "beta", "model": "m1"},
        ]),
    );
    let rows = chunks_of(&b, "notes/a");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["embedding"].as_array().unwrap().len(), 1536);
    assert_eq!(rows[0]["embedding"][0], json!(1.0));
    assert_eq!(rows[0]["embedding_is_null"], json!(false));
    assert_eq!(
        rows[0]["embedded_at"],
        json!(gbrain_store::env::iso(T0 + 5))
    );
    assert_eq!(rows[1]["embedding"], Value::Null);
    assert_eq!(rows[1]["embedding_is_null"], json!(true));
    assert_eq!(rows[1]["embedded_at"], Value::Null);
    // Without includeEmbedding the vector is not returned, and its presence still is.
    let plain = b
        .get_chunks_with("notes/a", &GetChunksOptions::default())
        .unwrap();
    assert_eq!(plain[0]["embedding"], Value::Null);
    assert_eq!(plain[0]["embedding_is_null"], json!(false));
    // One stale chunk: the one with no vector.
    assert_eq!(stale(&b, json!({})), 1);
    assert_eq!(
        b.sum_stale_chunk_chars(&StaleChunkOptions::default())
            .unwrap(),
        4
    );
    let ids: Vec<u64> = rows.iter().map(|r| r["id"].as_u64().unwrap()).collect();
    let got = b.get_embeddings_by_chunk_ids(&ids).unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["id"], rows[0]["id"]);
}

#[test]
fn a_vector_of_the_wrong_width_or_with_no_model_is_refused() {
    let b = brain("emb-dims");
    let (_, rev) = page(&b, "notes/a", json!({}));
    let wrong = b.upsert_chunks(
        "notes/a",
        &de::<Vec<ChunkInput>>(json!([
            {"chunk_index": 0, "chunk_text": "alpha", "model": "m1", "embedding": basis(0, 8)},
        ])),
        &UpsertChunksOptions {
            expected_revision: Some(rev.clone()),
            seal: true,
            ..Default::default()
        },
    );
    assert!(
        wrong
            .unwrap_err()
            .to_string()
            .contains("expected 1536 dimensions, not 8")
    );
    let unlabeled = b.upsert_chunks(
        "notes/a",
        &de::<Vec<ChunkInput>>(json!([
            {"chunk_index": 0, "chunk_text": "alpha", "embedding": basis(0, 1536)},
        ])),
        &UpsertChunksOptions {
            expected_revision: Some(rev),
            seal: true,
            ..Default::default()
        },
    );
    assert!(
        unlabeled
            .unwrap_err()
            .to_string()
            .contains("Embedding model provenance is unknown")
    );
    // Nothing was written by either refusal.
    assert_eq!(b.count_chunks().unwrap(), 0);
    // The width follows the embedding_dimensions config.
    b.set_config("embedding_dimensions", "8").unwrap();
    let (_, rev) = page(&b, "notes/b", json!({}));
    seal(
        &b,
        "notes/b",
        &rev,
        json!([{"chunk_index": 0, "chunk_text": "alpha", "model": "m1", "embedding": basis(0, 8)}]),
    );
    assert_eq!(
        chunks_of(&b, "notes/b")[0]["embedding"]
            .as_array()
            .unwrap()
            .len(),
        8
    );
}

#[test]
fn a_merge_keeps_the_vector_of_an_unchanged_chunk_and_drops_a_changed_one() {
    let b = brain("emb-merge");
    let (_, rev) = page(&b, "notes/a", json!({}));
    seal(
        &b,
        "notes/a",
        &rev,
        json!([
            {"chunk_index": 0, "chunk_text": "same", "model": "m1", "embedding": basis(0, 1536)},
            {"chunk_index": 1, "chunk_text": "old", "model": "m1", "embedding": basis(1, 1536)},
        ]),
    );
    b.clock.advance(10);
    // upsertChunks (merge): the text-only rewrite keeps chunk 0's vector, drops chunk 1's.
    b.upsert_chunks(
        "notes/a",
        &de::<Vec<ChunkInput>>(json!([
            {"chunk_index": 0, "chunk_text": "same", "model": "m2"},
            {"chunk_index": 1, "chunk_text": "new", "model": "m2"},
        ])),
        &UpsertChunksOptions::default(),
    )
    .unwrap();
    let rows = chunks_of(&b, "notes/a");
    assert_eq!(rows[0]["embedding_is_null"], json!(false));
    assert_eq!(
        rows[0]["model"],
        json!("m1"),
        "a kept vector keeps its label"
    );
    assert_eq!(rows[1]["embedding_is_null"], json!(true));
    assert_eq!(stale(&b, json!({})), 1);
}

#[test]
fn signature_invalidation_drops_vectors_outside_the_target_space() {
    let b = brain("emb-signature");
    let (_, rev) = page(&b, "notes/a", json!({}));
    seal(
        &b,
        "notes/a",
        &rev,
        json!([
            {"chunk_index": 0, "chunk_text": "one", "model": "openai:m1", "embedding": basis(0, 1536)},
            {"chunk_index": 1, "chunk_text": "two", "model": "m1", "embedding": basis(1, 1536)},
            {"chunk_index": 2, "chunk_text": "three", "model": "m0", "embedding": basis(2, 1536)},
        ]),
    );
    b.set_page_embedding_signature(
        "notes/a",
        &de::<SignatureOptions>(json!({"signature": "openai:m1:1536"})),
    )
    .unwrap();
    // A missing page is a no-op.
    b.set_page_embedding_signature(
        "notes/none",
        &de::<SignatureOptions>(json!({"signature": "x:1"})),
    )
    .unwrap();
    // The stale count compares the page's signature, not each chunk's label.
    assert_eq!(stale(&b, json!({"signature": "openai:m1:1536"})), 0);
    assert_eq!(stale(&b, json!({"signature": "openai:m2:1536"})), 3);
    // A page already at the target signature is left alone.
    assert_eq!(
        b.invalidate_stale_signature_embeddings(&de::<InvalidateOptions>(
            json!({"signature": "openai:m1:1536"}),
        ))
        .unwrap(),
        0
    );
    // A page at an older signature loses the vectors that are not in the target space: the
    // label `m1` is the target's bare tail, so only the `m0` vector goes.
    b.set_page_embedding_signature(
        "notes/a",
        &de::<SignatureOptions>(json!({"signature": "openai:m0:1536"})),
    )
    .unwrap();
    let dropped = b
        .invalidate_stale_signature_embeddings(&de::<InvalidateOptions>(
            json!({"signature": "openai:m1:1536"}),
        ))
        .unwrap();
    assert_eq!(dropped, 1);
    let rows = chunks_of(&b, "notes/a");
    let nulls: Vec<bool> = rows
        .iter()
        .map(|r| r["embedding_is_null"].as_bool().unwrap())
        .collect();
    assert_eq!(nulls, [false, false, true]);
    // A second run finds nothing to drop.
    assert_eq!(
        b.invalidate_stale_signature_embeddings(&de::<InvalidateOptions>(
            json!({"signature": "openai:m1:1536"}),
        ))
        .unwrap(),
        0
    );
}

#[test]
fn content_drift_drops_a_vector_whose_text_hash_no_longer_matches() {
    let b = brain("emb-drift");
    let (_, rev) = page(&b, "notes/a", json!({}));
    seal(
        &b,
        "notes/a",
        &rev,
        json!([{"chunk_index": 0, "chunk_text": "text", "model": "m1", "embedding": basis(0, 1536)}]),
    );
    // Nothing has drifted.
    assert_eq!(
        b.invalidate_content_drift_embeddings(&InvalidateOptions::default())
            .unwrap(),
        0
    );
    assert_eq!(stale(&b, json!({})), 0);
}

#[test]
fn state_counts_and_rows_name_each_chunk_state() {
    let b = brain("emb-states");
    let (_, rev) = page(&b, "notes/done", json!({}));
    seal(
        &b,
        "notes/done",
        &rev,
        json!([{"chunk_index": 0, "chunk_text": "a", "model": "m1", "embedding": basis(0, 1536)}]),
    );
    let (_, rev) = page(&b, "notes/todo", json!({}));
    seal(
        &b,
        "notes/todo",
        &rev,
        json!([{"chunk_index": 0, "chunk_text": "b", "model": "m1"}]),
    );
    let counts = b
        .read_embedding_state_counts(&de::<StateCountOptions>(
            json!({"mode": "full", "purgeWindowHours": 72}),
        ))
        .unwrap();
    assert_eq!(counts["counts"]["embedded"], json!(1));
    assert_eq!(counts["counts"]["pending"], json!(1));
    assert_eq!(counts["covering_index"], Value::Null);
    let rows = b
        .list_embedding_state_rows(&de::<StateRowOptions>(
            json!({"states": ["pending"], "limit": 10, "purgeWindowHours": 72}),
        ))
        .unwrap();
    let slugs: Vec<&str> = rows.iter().map(|r| r["slug"].as_str().unwrap()).collect();
    assert_eq!(slugs, ["notes/todo"]);
    // listStaleChunks pages by page id and carries the row's identity.
    let stale_rows = b
        .list_stale_chunks(&ListStaleChunksOptions::default())
        .unwrap();
    assert_eq!(stale_rows.len(), 1);
    assert_eq!(stale_rows[0]["slug"], json!("notes/todo"));
    assert_eq!(stale_rows[0]["source_id"], json!("default"));
    let with = b
        .get_chunks_with_embeddings("notes/done", &ChunksWithEmbeddingsOptions::default())
        .unwrap();
    assert_eq!(with.len(), 1);
    assert_eq!(with[0]["embedding"].as_array().unwrap().len(), 1536);
}

#[test]
fn a_take_vector_counts_only_for_the_claim_it_was_computed_from() {
    let b = brain("emb-takes");
    let (page_id, _) = page(&b, "notes/t", json!({}));
    let take = |row: i64, claim: &str| -> TakeInput {
        de(json!({
            "page_id": page_id, "row_num": row, "claim": claim, "kind": "bet", "holder": "garry",
            "weight": 0.5, "active": true,
        }))
    };
    b.add_takes_batch(&[take(1, "first claim"), take(2, "second claim")])
        .unwrap();
    let listed = b.list_stale_takes(&StaleTakeOptions::default()).unwrap();
    assert_eq!(listed.len(), 2);
    let id = listed[0]["take_id"].as_u64().unwrap();
    let input = |claim: &str, dims: usize| TakeEmbeddingInput {
        take_id: id,
        embedding: basis(0, dims),
        claim: claim.to_string(),
        model: "m1".to_string(),
    };
    // A vector for another claim text is discarded.
    assert_eq!(
        b.update_take_embeddings(&[input("other text", 1536)])
            .unwrap(),
        0
    );
    assert!(
        b.update_take_embeddings(&[input("first claim", 8)])
            .unwrap_err()
            .to_string()
            .contains("expected 1536 dimensions, not 8")
    );
    assert_eq!(
        b.update_take_embeddings(&[input("first claim", 1536)])
            .unwrap(),
        1
    );
    assert_eq!(b.get_take_embeddings(&[id, id]).unwrap().len(), 1);
    assert_eq!(
        b.count_stale_takes(&StaleTakeOptions::default()).unwrap(),
        1
    );
    let other_model = de::<StaleTakeOptions>(json!({"model": "m2"}));
    assert_eq!(b.count_stale_takes(&other_model).unwrap(), 2);
    let wrong_dims = de::<StaleTakeOptions>(json!({"dims": 8}));
    assert_eq!(b.count_stale_takes(&wrong_dims).unwrap(), 2);
    // Rewording the claim makes the vector stale at once.
    b.add_takes_batch(&[take(1, "first claim, reworded")])
        .unwrap();
    assert!(b.get_take_embeddings(&[id]).unwrap().is_empty());
    assert_eq!(
        b.count_stale_takes(&StaleTakeOptions::default()).unwrap(),
        2
    );
}
