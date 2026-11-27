//! The typed members `gbrain repair visibility` and the contextual-mode proof use on a Rust brain
//! (`facts/repair_applies.rs` readFactLiveVisibility / tightenFencedFactVisibility,
//! `persistence/projection_rebuild.rs` readChunkInputHashes / clearChunkEmbeddingsByIds /
//! writeChunkInputHashes): the PGLite semantics of each, on rows the typed writers make.

mod memory_env;

use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::repair_applies::DuplicateArgs;
use gbrain_store::pages::{PageInput, PutPageOptions};
use memory_env::{Brain, T0, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put(b: &Brain, slug: &str) -> i64 {
    let input: PageInput =
        args(json!({ "type": "note", "title": slug, "compiled_truth": format!("{slug} body") }));
    let options = PutPageOptions {
        index: Some(false),
        ..PutPageOptions::default()
    };
    b.put_page(slug, &input, &options).unwrap()["id"]
        .as_i64()
        .unwrap()
}

#[test]
fn a_fenced_world_fact_turns_private_only_at_its_row_and_reads_back_live() {
    let b = brain("repair-visibility-fenced");
    b.clock.set(T0);
    let row = |fact: &str, row_num: Value| {
        json!({ "fact": fact, "kind": "fact", "entity_slug": null, "visibility": "world", "source": "fence",
            "source_markdown_slug": "notes/diary", "row_num": row_num })
    };
    b.insert_facts(&args::<InsertFactsArgs>(json!({
        "rows": [row("at row one", json!(1)), row("at row two", json!(2)), row("unfenced", Value::Null)],
        "sourceId": "default",
    })))
    .unwrap();
    let ids: Vec<f64> = (1..=3).map(f64::from).collect();
    assert_eq!(
        b.read_fact_live_visibility(ids[0]).unwrap(),
        Some(json!({ "visibility": "world", "live": true }))
    );
    assert_eq!(b.read_fact_live_visibility(999.0).unwrap(), None);
    let tighten = |id: f64, row_num: f64, source: &str| {
        b.tighten_fenced_fact_visibility(
            &args::<DuplicateArgs>(json!({ "sourceId": source, "ids": [id] })),
            row_num,
        )
        .unwrap()
    };
    // Another row, another source and an unfenced fact change nothing.
    assert!(tighten(ids[0], 2.0, "default").is_empty());
    assert!(tighten(ids[0], 1.0, "other").is_empty());
    assert!(tighten(ids[2], 1.0, "default").is_empty());
    assert_eq!(tighten(ids[0], 1.0, "default"), vec![1]);
    assert_eq!(
        b.read_fact_live_visibility(ids[0]).unwrap(),
        Some(json!({ "visibility": "private", "live": true }))
    );
    // A second run finds the row private already.
    assert!(tighten(ids[0], 1.0, "default").is_empty());
}

#[test]
fn the_contextual_proof_reads_clears_and_stamps_the_named_chunks_of_one_page() {
    let b = brain("repair-visibility-chunks");
    b.clock.set(T0);
    let page = put(&b, "notes/a") as f64;
    let chunk = |i: i64, text: &str| -> ChunkInput {
        args(json!({ "chunk_index": i, "chunk_text": text, "chunk_source": "compiled_truth" }))
    };
    b.upsert_chunks(
        "notes/a",
        &[chunk(0, "alpha"), chunk(1, "beta")],
        &UpsertChunksOptions::default(),
    )
    .unwrap();
    let hashes = || {
        let mut rows = b.read_chunk_input_hashes(page).unwrap();
        rows.sort_by_key(|r| r["id"].as_u64());
        rows
    };
    let ids: Vec<f64> = hashes().iter().map(|r| r["id"].as_f64().unwrap()).collect();
    assert_eq!(ids.len(), 2);
    assert!(hashes().iter().all(|r| r["embedding_input_hash"].is_null()));
    b.write_chunk_input_hashes(page, &ids, &["h0".to_string(), "h1".to_string()])
        .unwrap();
    assert_eq!(
        hashes()
            .iter()
            .map(|r| r["embedding_input_hash"].clone())
            .collect::<Vec<_>>(),
        vec![json!("h0"), json!("h1")]
    );
    // Clearing the first chunk drops only its hash; the other keeps its own.
    b.clear_chunk_embeddings_by_ids(page, &ids[..1]).unwrap();
    assert_eq!(
        hashes()
            .iter()
            .map(|r| r["embedding_input_hash"].clone())
            .collect::<Vec<_>>(),
        vec![Value::Null, json!("h1")]
    );
    // Mismatched lists are refused; an unknown page reads nothing.
    assert!(
        b.write_chunk_input_hashes(page, &ids, &["h".to_string()])
            .is_err()
    );
    assert!(b.read_chunk_input_hashes(9999.0).unwrap().is_empty());
}
