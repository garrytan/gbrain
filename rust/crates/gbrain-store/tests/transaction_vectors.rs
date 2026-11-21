//! Vector reads inside an explicit transaction (`transactions.rs`): a read that scans stored vectors
//! and reads each take's row returns instead of waiting on itself.

mod common;

use std::sync::mpsc;
use std::time::Duration;

use common::TempDir;
use gbrain_store::embeddings::TakeEmbeddingInput;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::takes::TakeInput;
use gbrain_store::{OpenOptions, Store};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

const DIMS: usize = 8;

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// The unit vector along axis `axis`.
fn axis(axis: usize) -> Vec<f64> {
    (0..DIMS)
        .map(|i| if i == axis { 1.0 } else { 0.0 })
        .collect()
}

/// A brain with one page and one active take on it; returns the take id.
fn brain_with_take(dir: &TempDir) -> (Store, u64) {
    let store = Store::open_dir(dir.path(), OpenOptions::default()).unwrap();
    store
        .set_config("embedding_dimensions", &DIMS.to_string())
        .unwrap();
    let input: PageInput = de(json!({
        "type": "note", "title": "t", "compiled_truth": "body text", "frontmatter": {},
    }));
    let row = store
        .put_page(
            "notes/t",
            &input,
            &de::<PutPageOptions>(json!({"index": false})),
        )
        .unwrap();
    let page_id = row["id"].as_u64().unwrap();
    let take: TakeInput = de(json!({
        "page_id": page_id, "row_num": 1, "claim": "a claim", "kind": "bet", "holder": "garry",
        "weight": 0.5, "active": true,
    }));
    store.add_takes_batch(&[take]).unwrap();
    let take_id = store.list_stale_takes(&Default::default()).unwrap()[0]["take_id"]
        .as_u64()
        .unwrap();
    (store, take_id)
}

fn embed(store: &Store, take_id: u64, vector: Vec<f64>) {
    store
        .update_take_embeddings(&[TakeEmbeddingInput {
            take_id,
            embedding: vector,
            claim: "a claim".to_string(),
            model: "m1".to_string(),
        }])
        .unwrap();
}

/// With one take vector stored, `hasStoredVectors('takes')` inside a transaction scans the vectors
/// and reads the take of each one. It answers, and the transaction still commits.
#[test]
fn a_take_vector_read_inside_a_transaction_answers_instead_of_waiting_on_itself() {
    let dir = TempDir::new("tx-take-vector-read");
    let (store, take_id) = brain_with_take(&dir);
    embed(&store, take_id, axis(0));
    let tx = store.begin_transaction(false).unwrap();
    let (sent, received) = mpsc::channel();
    std::thread::spawn(move || {
        let answer = tx.has_stored_vectors("takes");
        let committed = tx.commit_transaction().is_ok();
        let _ = sent.send((answer.map_err(|e| e.code.to_string()), committed));
    });
    let (answer, committed) = received
        .recv_timeout(Duration::from_secs(20))
        .expect("the read inside the transaction never returned: it waits on its own lock");
    assert_eq!(answer, Ok(true));
    assert!(committed);
    // The writer is free again.
    assert!(store.has_stored_vectors("takes").unwrap());
}
