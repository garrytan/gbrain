//! Vector search: `searchVector` and `searchTakesVector` through the public store API, matched to
//! the PGLite engine: what a brain without vectors answers, what every brain refuses, and a ranking
//! over vectors written by the chunk write. The filter, guard and cache cases live in the module's
//! unit tests (`src/vectors.rs`).

mod common;

use common::TempDir;
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::vectors::{TakesVectorOptions, VectorSearchOptions};
use gbrain_store::{OpenOptions, Store};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn open(dir: &TempDir) -> Store {
    Store::open_dir(dir.path(), OpenOptions::default()).unwrap()
}

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn refusal(store: &Store, query: &[f64], options: Value) -> (String, String) {
    let e = store
        .search_vector(query, &de::<VectorSearchOptions>(options))
        .unwrap_err();
    (e.code.to_string(), e.message)
}

fn invalid(message: &str) -> (String, String) {
    (INVALID_ARGUMENT.to_string(), message.to_string())
}

#[test]
fn a_brain_without_vectors_finds_nothing() {
    let dir = TempDir::new("vectors-empty");
    let store = open(&dir);
    let none = VectorSearchOptions::default();
    assert!(store.search_vector(&[0.5, 0.5], &none).unwrap().is_empty());
    assert!(
        store
            .search_takes_vector(&[0.5, 0.5], &TakesVectorOptions::default())
            .unwrap()
            .is_empty()
    );

    // A sealed page whose chunks carry no vector is not a candidate.
    let input: PageInput = de(json!({"type": "note", "title": "A", "compiled_truth": "body"}));
    store
        .put_page("a", &input, &PutPageOptions::default())
        .unwrap();
    let chunks = vec![ChunkInput {
        chunk_index: 0,
        chunk_text: "body".into(),
        ..ChunkInput::default()
    }];
    let seal: UpsertChunksOptions = de(json!({"seal": true}));
    store.upsert_chunks("a", &chunks, &seal).unwrap();
    assert!(store.search_vector(&[0.5, 0.5], &none).unwrap().is_empty());
    // With no stored vector there is no dimension to disagree with.
    assert!(
        store
            .search_vector(&[0.1; 8], &de(json!({"model": "any:model"})))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_query_pglite_cannot_parse_is_refused_on_any_brain() {
    let dir = TempDir::new("vectors-refusals");
    let store = open(&dir);
    assert_eq!(
        refusal(&store, &[], json!({})),
        invalid("vector must have at least 1 dimension")
    );
    assert_eq!(
        refusal(&store, &[1.0, f64::NAN], json!({})),
        invalid("NaN not allowed in vector")
    );
    assert_eq!(
        refusal(&store, &[f64::INFINITY], json!({})),
        invalid("infinite value not allowed in vector")
    );
    assert_eq!(
        refusal(&store, &[1.0], json!({"offset": 1.5})),
        invalid("invalid input syntax for type integer: \"101.5\"")
    );
    assert_eq!(
        refusal(&store, &[1.0], json!({"offset": -1})),
        invalid("OFFSET must not be negative")
    );
    let takes = store
        .search_takes_vector(&[], &TakesVectorOptions::default())
        .unwrap_err();
    assert_eq!(
        (takes.code.to_string(), takes.message),
        invalid("vector must have at least 1 dimension")
    );
}

#[test]
fn chunk_vectors_written_by_the_chunk_write_rank_by_cosine() {
    let dir = TempDir::new("vectors-rank");
    let store = open(&dir);
    store.set_config("embedding_dimensions", "3").unwrap();
    for (slug, vector) in [
        ("near", [1.0, 0.0, 0.0]),
        ("far", [-1.0, 0.0, 0.0]),
        ("mid", [1.0, 1.0, 0.0]),
    ] {
        let input: PageInput = de(json!({"type": "note", "title": slug, "compiled_truth": slug}));
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        let chunk: ChunkInput = de(json!({
            "chunk_index": 0, "chunk_text": slug, "embedding": vector, "model": "test:model",
        }));
        let seal: UpsertChunksOptions = de(json!({"seal": true}));
        store.upsert_chunks(slug, &[chunk], &seal).unwrap();
    }
    let rows = store
        .search_vector(&[1.0, 0.0, 0.0], &de(json!({"model": "test:model"})))
        .unwrap();
    let got: Vec<(String, f64)> = rows
        .iter()
        .map(|r| {
            (
                r["slug"].as_str().unwrap().to_string(),
                r["score"].as_f64().unwrap(),
            )
        })
        .collect();
    assert_eq!(got.len(), 3);
    assert_eq!(got[0], ("near".to_string(), 1.0));
    assert_eq!(got[1].0, "mid");
    assert!((got[1].1 - std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-6);
    assert_eq!(got[2], ("far".to_string(), -1.0));
    // Another model's vectors are not candidates.
    assert!(
        store
            .search_vector(&[1.0, 0.0, 0.0], &de(json!({"model": "other:model"})))
            .unwrap()
            .is_empty()
    );
}
