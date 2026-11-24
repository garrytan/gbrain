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
use gbrain_store::vectors::TakesVectorOptions;
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

#[test]
fn take_vector_search_ranks_current_vectors_by_cosine_distance_and_refuses_a_bad_query() {
    let b = brain("emb-take-search");
    let (open, _) = page(&b, "notes/open", json!({}));
    let (held, _) = page(&b, "notes/held", json!({"quarantine": true}));
    let take = |page_id: u64, row: i64, claim: &str, holder: &str| -> TakeInput {
        de(json!({
            "page_id": page_id, "row_num": row, "claim": claim, "kind": "bet", "holder": holder,
            "weight": 0.5, "active": true,
        }))
    };
    b.add_takes_batch(&[
        take(open, 1, "near", "garry"),
        take(open, 2, "far", "alice"),
        take(open, 3, "reworded", "garry"),
        take(open, 4, "never embedded", "garry"),
        take(held, 1, "held", "garry"),
    ])
    .unwrap();
    let ids: std::collections::HashMap<String, u64> = b
        .list_stale_takes(&StaleTakeOptions::default())
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["claim"].as_str().unwrap().to_string(),
                r["take_id"].as_u64().unwrap(),
            )
        })
        .collect();
    let lean = |axis: usize, by: f64| {
        let mut v = basis(0, 1536);
        v[axis] = by;
        v
    };
    let rows: Vec<TakeEmbeddingInput> = [
        ("near", 0.1),
        ("far", 0.5),
        ("reworded", 0.01),
        ("held", 0.05),
    ]
    .iter()
    .enumerate()
    .map(|(i, (claim, by))| TakeEmbeddingInput {
        take_id: ids[*claim],
        embedding: lean(i + 1, *by),
        claim: claim.to_string(),
        model: "m1".to_string(),
    })
    .collect();
    assert_eq!(b.update_take_embeddings(&rows).unwrap(), 4);
    // A reworded claim leaves its vector stale, so it is not searched.
    b.add_takes_batch(&[take(open, 3, "reworded again", "garry")])
        .unwrap();
    let search = |embedding: &[f64], options: Value| -> Vec<Value> {
        b.search_takes_vector(embedding, &de::<TakesVectorOptions>(options))
            .unwrap()
    };
    let query: Vec<f64> = basis(0, 1536);
    let claims = |hits: &[Value]| -> Vec<String> {
        hits.iter()
            .map(|h| h["claim"].as_str().unwrap().to_string())
            .collect()
    };
    let all = search(&query, json!({}));
    assert_eq!(claims(&all), ["held", "near", "far"]);
    assert_eq!(all[1]["take_id"], json!(ids["near"]));
    assert_eq!(all[1]["page_slug"], json!("notes/open"));
    assert_eq!(all[1]["weight"], json!(0.5));
    // (1 - distance)::real of [1, .., 0.1 on axis 2] against axis 0: 1/sqrt(1.01) as f32.
    assert_eq!(all[1]["score"], json!(0.9950372));
    assert_eq!(claims(&search(&query, json!({ "limit": 1 }))), ["held"]);
    assert_eq!(
        claims(&search(&query, json!({ "allow_list": ["alice"] }))),
        ["far"]
    );
    assert_eq!(
        claims(&search(&query, json!({ "eligible_only": true }))),
        ["near", "far"]
    );
    let refused = |embedding: &[f64]| {
        b.search_takes_vector(embedding, &TakesVectorOptions::default())
            .unwrap_err()
            .to_string()
    };
    assert!(refused(&basis(0, 3)).contains("different vector dimensions 3 and 1536"));
    assert!(refused(&[1.0, f64::NAN]).contains("NaN not allowed in vector"));
    assert!(refused(&[]).contains("at least 1 dimension"));
    // No candidate take means no distance is computed, so another width finds nothing.
    assert!(search(&basis(0, 3), json!({ "allow_list": [] })).is_empty());
}

/// `cosinesByChunkIds`: ids of a page's chunks, in chunk index order.
fn chunk_ids(store: &Store, slug: &str) -> Vec<u64> {
    chunks_of(store, slug)
        .iter()
        .map(|r| r["id"].as_u64().unwrap())
        .collect()
}

/// The `(id, cosine)` rows of one `cosinesByChunkIds` read.
fn cosines(store: &Store, ids: &[u64], query: &[f64]) -> Vec<(u64, f64)> {
    store
        .cosines_by_chunk_ids(ids, query)
        .unwrap()
        .iter()
        .map(|r| (r["id"].as_u64().unwrap(), r["cosine"].as_f64().unwrap()))
        .collect()
}

#[test]
fn cosines_are_the_text_space_cosine_of_the_served_chunks_with_a_vector() {
    let b = brain("emb-cosines");
    let (_, rev) = page(&b, "notes/a", json!({}));
    let diagonal: Vec<f64> = (0..1536).map(|i| if i < 2 { 1.0 } else { 0.0 }).collect();
    let opposite: Vec<f64> = basis(0, 1536).iter().map(|x| -x).collect();
    seal(
        &b,
        "notes/a",
        &rev,
        json!([
            {"chunk_index": 0, "chunk_text": "same axis", "model": "m1", "embedding": basis(0, 1536)},
            {"chunk_index": 1, "chunk_text": "other axis", "model": "m1", "embedding": basis(1, 1536)},
            {"chunk_index": 2, "chunk_text": "diagonal", "model": "m1", "embedding": diagonal},
            {"chunk_index": 3, "chunk_text": "opposite", "model": "m1", "embedding": opposite},
            {"chunk_index": 4, "chunk_text": "no vector", "model": "m1"},
        ]),
    );
    // A page whose text projection is not sealed serves no chunk.
    let (_, rev_unsealed) = page(&b, "notes/unsealed", json!({}));
    b.upsert_chunks(
        "notes/unsealed",
        &de::<Vec<ChunkInput>>(json!([
            {"chunk_index": 0, "chunk_text": "pending", "model": "m1", "embedding": basis(0, 1536)},
        ])),
        &UpsertChunksOptions {
            expected_revision: Some(rev_unsealed),
            ..Default::default()
        },
    )
    .unwrap();
    let ids = chunk_ids(&b, "notes/a");
    assert_eq!(ids.len(), 5);
    let mut asked = ids.clone();
    asked.push(u64::MAX - 1);
    asked.extend(chunk_ids(&b, "notes/unsealed"));
    let got = cosines(&b, &asked, &basis(0, 1536));
    // Rows come back for the four vectors only, in page then chunk order; the id that is no chunk and
    // the unsealed page's chunk have none.
    assert_eq!(
        got.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
        ids[..4].to_vec()
    );
    let values: Vec<f64> = got.iter().map(|(_, c)| *c).collect();
    assert_eq!(values[0], 1.0);
    assert_eq!(values[1], 0.0);
    assert!((values[2] - std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-7);
    assert_eq!(values[3], -1.0);
    // A longer query of the same direction scores the same, within rounding.
    let scaled: Vec<f64> = basis(0, 1536).iter().map(|x| x * 3.0).collect();
    let rescaled = cosines(&b, &ids, &scaled);
    assert_eq!(
        rescaled.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
        ids[..4].to_vec()
    );
    for ((_, a), (_, c)) in rescaled.iter().zip(&got) {
        assert!((a - c).abs() < 1e-12);
    }
    // Another width and a zero query score 0 for every served chunk.
    for query in [vec![1.0, 2.0, 3.0], vec![0.0; 1536]] {
        let zeros = cosines(&b, &ids, &query);
        assert_eq!(zeros.len(), 4);
        assert!(zeros.iter().all(|(_, c)| *c == 0.0));
    }
    // Nothing asked, nothing read.
    assert!(cosines(&b, &[], &basis(0, 1536)).is_empty());
}

#[test]
fn cosines_refuse_a_query_pgvector_cannot_parse_before_reading_any_row() {
    let b = brain("emb-cosines-bad");
    for (query, message) in [
        (vec![], "vector must have at least 1 dimension"),
        (vec![f64::NAN], "NaN not allowed in vector"),
        (vec![f64::INFINITY], "infinite value not allowed in vector"),
    ] {
        let err = b.cosines_by_chunk_ids(&[1], &query).unwrap_err();
        assert_eq!(err.message, message);
    }
}

#[test]
fn require_safe_chunks_reads_a_page_chunked_below_the_safe_fence_as_no_chunks() {
    let b = brain("emb-safe-fence");
    let (_, rev) = page(&b, "notes/a", json!({}));
    seal(
        &b,
        "notes/a",
        &rev,
        json!([{"chunk_index": 0, "chunk_text": "alpha", "model": "m1", "embedding": basis(0, 1536)}]),
    );
    let safe = |b: &Store| {
        b.get_chunks_with(
            "notes/a",
            &GetChunksOptions {
                include_embedding: true,
                require_safe_chunks: true,
                ..Default::default()
            },
        )
        .unwrap()
        .len()
    };
    assert_eq!(safe(&b), 1);
    b.set_chunker_version("notes/a", "3", None).unwrap();
    assert_eq!(safe(&b), 0);
    // Without the option the short page still reads its chunks.
    assert_eq!(chunks_of(&b, "notes/a").len(), 1);
}

#[test]
fn provenance_is_complete_only_when_every_visible_chunk_holds_a_current_vector() {
    let b = brain("emb-provenance");
    let (_, rev) = page(&b, "notes/a", json!({}));
    let provenance = |slug: &str, source: &str, model: &str, dims: Option<u32>| {
        b.read_page_provenance_complete(slug, source, model, dims)
            .unwrap()
    };
    // No chunk yet: not complete. A missing page and a missing source are not complete either.
    assert!(!provenance("notes/a", "default", "openai:m1", Some(1536)));
    seal(
        &b,
        "notes/a",
        &rev,
        json!([
            {"chunk_index": 0, "chunk_text": "one", "model": "openai:m1", "embedding": basis(0, 1536)},
            {"chunk_index": 1, "chunk_text": "two", "model": "m1", "embedding": basis(1, 1536)},
        ]),
    );
    // The label may be the target's bare tail; the width must be the target's.
    assert!(provenance("notes/a", "default", "openai:m1", Some(1536)));
    assert!(!provenance("notes/a", "default", "openai:m1", Some(768)));
    assert!(!provenance("notes/a", "default", "openai:m1", None));
    assert!(!provenance("notes/a", "default", "openai:m2", Some(1536)));
    assert!(!provenance("notes/a", "nowhere", "openai:m1", Some(1536)));
    assert!(!provenance(
        "notes/none",
        "default",
        "openai:m1",
        Some(1536)
    ));
    // One chunk without a vector, and one unsealed projection, each make it incomplete.
    seal(
        &b,
        "notes/a",
        &rev,
        json!([
            {"chunk_index": 0, "chunk_text": "one", "model": "openai:m1", "embedding": basis(0, 1536)},
            {"chunk_index": 1, "chunk_text": "two", "model": "openai:m1"},
        ]),
    );
    assert!(!provenance("notes/a", "default", "openai:m1", Some(1536)));
    let sealed_without = json!([{"chunk_index": 0, "chunk_text": "one", "model": "openai:m1", "embedding": basis(0, 1536)}]);
    seal(&b, "notes/a", &rev, sealed_without);
    assert!(provenance("notes/a", "default", "openai:m1", Some(1536)));
    // A page write moves the knowledge revision, so the projection is unsealed until it is sealed again.
    page(&b, "notes/a", json!({"edited": true}));
    assert!(!provenance("notes/a", "default", "openai:m1", Some(1536)));
}

#[test]
fn vectorless_chunk_indexes_name_the_live_rows_with_no_vector() {
    let b = brain("emb-vectorless");
    let (id, rev) = page(&b, "notes/a", json!({}));
    assert!(
        b.list_vectorless_chunk_indexes(id as i64)
            .unwrap()
            .is_empty()
    );
    seal(
        &b,
        "notes/a",
        &rev,
        json!([
            {"chunk_index": 0, "chunk_text": "zero", "model": "m1"},
            {"chunk_index": 1, "chunk_text": "one", "model": "m1", "embedding": basis(1, 1536)},
            {"chunk_index": 2, "chunk_text": "two", "model": "m1"},
        ]),
    );
    assert_eq!(
        b.list_vectorless_chunk_indexes(id as i64).unwrap(),
        vec![0, 2]
    );
    // An id that names no page, or no id at all, answers none.
    assert!(b.list_vectorless_chunk_indexes(9_999).unwrap().is_empty());
    assert!(b.list_vectorless_chunk_indexes(0).unwrap().is_empty());
    assert!(b.list_vectorless_chunk_indexes(-3).unwrap().is_empty());
}
