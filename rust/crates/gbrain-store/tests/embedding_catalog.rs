//! Embedding catalog reads (`embedding_catalog.rs`): the vector column's width and model and
//! whether a store holds vectors, read from the per-vector records. An empty store answers as a
//! PGLite brain with no vector column; a configured width answers as the declared column.

mod memory_env;

use gbrain_store::Store;
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::embeddings::TakeEmbeddingInput;
use gbrain_store::facts::InsertFactArgs;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::takes::TakeInput;
use memory_env::brain;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn basis(dims: usize) -> Vec<f64> {
    (0..dims).map(|i| if i == 0 { 1.0 } else { 0.0 }).collect()
}

fn page(store: &Store, slug: &str) -> (u64, String) {
    let input: PageInput = de(json!({
        "type": "note", "title": slug, "compiled_truth": "body text", "frontmatter": {},
    }));
    let row = store
        .put_page(slug, &input, &de::<PutPageOptions>(json!({"index": false})))
        .unwrap();
    (
        row["id"].as_u64().unwrap(),
        row["knowledge_revision"].as_str().unwrap().to_string(),
    )
}

fn has(store: &Store, name: &str) -> bool {
    store.has_stored_vectors(name).unwrap()
}

#[test]
fn an_empty_store_has_no_vector_column_and_no_vectors() {
    let b = brain("catalog-empty");
    assert_eq!(
        b.read_chunk_vector_column("embedding").unwrap(),
        json!({ "exists": false, "dims": null })
    );
    assert_eq!(b.read_embedding_identity().unwrap(), Value::Null);
    for store in ["content_chunks", "facts", "query_cache", "takes"] {
        assert!(!has(&b, store), "{store}");
    }
    assert!(
        b.has_stored_vectors("pages")
            .unwrap_err()
            .to_string()
            .contains("'pages' is not an embedding store")
    );
}

#[test]
fn a_configured_width_reads_as_the_declared_column() {
    let b = brain("catalog-config");
    b.set_config("embedding_dimensions", "1024").unwrap();
    assert_eq!(
        b.read_chunk_vector_column("embedding").unwrap(),
        json!({ "exists": true, "dims": 1024 })
    );
    // Only `embedding` exists: the store keeps no other vector column.
    assert_eq!(
        b.read_chunk_vector_column("embedding_voyage").unwrap(),
        json!({ "exists": false, "dims": null })
    );
    assert_eq!(
        b.read_embedding_identity().unwrap(),
        json!({ "model": null, "dimensions": 1024 })
    );
    b.set_config("embedding_model", "  voyage:voyage-4 ")
        .unwrap();
    assert_eq!(
        b.read_embedding_identity().unwrap(),
        json!({ "model": "voyage:voyage-4", "dimensions": 1024 })
    );
    // A width that is not a positive integer is no width.
    b.set_config("embedding_dimensions", "0").unwrap();
    assert_eq!(b.read_embedding_identity().unwrap(), Value::Null);
}

#[test]
fn stored_vectors_give_the_width_and_model() {
    let b = brain("catalog-vectors");
    b.set_config("embedding_dimensions", "8").unwrap();
    b.set_config("embedding_model", "configured:model").unwrap();
    let (page_id, rev) = page(&b, "notes/a");
    b.upsert_chunks(
        "notes/a",
        &de::<Vec<ChunkInput>>(json!([
            {"chunk_index": 0, "chunk_text": "alpha", "model": "m1", "embedding": basis(8)},
        ])),
        &UpsertChunksOptions {
            expected_revision: Some(rev),
            seal: true,
            ..Default::default()
        },
    )
    .unwrap();
    // The vector's own model wins over the config: it is what the rows hold.
    assert_eq!(
        b.read_embedding_identity().unwrap(),
        json!({ "model": "m1", "dimensions": 8 })
    );
    // The width comes from the vector even when the config names another.
    b.set_config("embedding_dimensions", "16").unwrap();
    assert_eq!(
        b.read_chunk_vector_column("embedding").unwrap(),
        json!({ "exists": true, "dims": 8 })
    );
    b.set_config("embedding_dimensions", "8").unwrap();
    assert!(has(&b, "content_chunks"));
    assert!(!has(&b, "takes"));
    assert!(!has(&b, "facts"));

    let take: TakeInput = de(json!({
        "page_id": page_id, "row_num": 1, "claim": "a claim", "kind": "bet", "holder": "garry",
        "weight": 0.5, "active": true,
    }));
    b.add_takes_batch(&[take]).unwrap();
    assert!(!has(&b, "takes"));
    let take_id = b.list_stale_takes(&Default::default()).unwrap()[0]["take_id"]
        .as_u64()
        .unwrap();
    b.update_take_embeddings(&[TakeEmbeddingInput {
        take_id,
        embedding: basis(8),
        claim: "a claim".to_string(),
        model: "m1".to_string(),
    }])
    .unwrap();
    assert!(has(&b, "takes"));

    b.insert_fact(&de::<InsertFactArgs>(json!({
        "input": {
            "fact": "a fact", "source": "chat", "embedding": format!("[1{}]", ",0".repeat(7)),
            "embedding_model": "m1",
        },
        "sourceId": "default",
    })))
    .unwrap();
    assert!(has(&b, "facts"));
    assert!(!has(&b, "query_cache"));
}
