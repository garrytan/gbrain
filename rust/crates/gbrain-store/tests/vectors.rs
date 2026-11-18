//! Vector search: `searchVector` and `searchTakesVector` through the public store API, matched to
//! the PGLite engine. Vectors are written by the chunk and take families (not public yet), so these
//! cases cover what a brain without vectors answers and what every brain refuses. The ranking,
//! filter and cache cases live in the module's unit tests (`src/vectors.rs`).

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
