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
    // The image columns are fixed `vector(1024)` on Postgres and PGLite: present with no text width.
    for column in ["embedding_image", "embedding_multimodal"] {
        assert_eq!(
            b.read_chunk_vector_column(column).unwrap(),
            json!({ "exists": true, "dims": 1024 }),
            "{column}"
        );
    }
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
    // A registry column does not exist: the store keeps no other text vector column.
    assert_eq!(
        b.read_chunk_vector_column("embedding_voyage").unwrap(),
        json!({ "exists": false, "dims": null })
    );
    // The image columns keep their own width whatever the text width is.
    for column in ["embedding_image", "embedding_multimodal"] {
        assert_eq!(
            b.read_chunk_vector_column(column).unwrap(),
            json!({ "exists": true, "dims": 1024 }),
            "{column}"
        );
    }
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

/// A take vector is current only at the take's `claim_rev`. Postgres's `addTakesBatch` sets
/// `takes.embedding` to NULL when it changes a claim (`engine-sql/takes.ts`, the
/// `ON CONFLICT ... CASE WHEN takes.claim IS DISTINCT FROM EXCLUDED.claim` arm) and keeps it when
/// the claim is the same. The store keeps the old vector record, so the rule is what hides it.
#[test]
fn a_take_vector_is_current_only_at_the_claim_revision() {
    let b = brain("catalog-take-rev");
    b.set_config("embedding_dimensions", "8").unwrap();
    let (page_id, _) = page(&b, "notes/t");
    let take = |claim: &str| -> TakeInput {
        de(json!({
            "page_id": page_id, "row_num": 1, "claim": claim, "kind": "bet", "holder": "garry",
            "weight": 0.5, "active": true,
        }))
    };
    let embed = |take_id: u64, claim: &str| {
        b.update_take_embeddings(&[TakeEmbeddingInput {
            take_id,
            embedding: basis(8),
            claim: claim.to_string(),
            model: "m1".to_string(),
        }])
        .unwrap();
    };
    let stale = || -> Vec<u64> {
        b.list_stale_takes(&Default::default())
            .unwrap()
            .iter()
            .map(|t| t["take_id"].as_u64().unwrap())
            .collect()
    };

    b.add_takes_batch(&[take("a claim")]).unwrap();
    let take_id = stale()[0];
    embed(take_id, "a claim");
    assert!(has(&b, "takes"));
    assert!(stale().is_empty());

    // The same claim again: Postgres keeps the vector, so it stays current.
    b.add_takes_batch(&[take("a claim")]).unwrap();
    assert!(has(&b, "takes"), "an unchanged claim keeps its vector");
    assert!(stale().is_empty());

    // A changed claim: Postgres nulls the vector; the store's old record no longer counts.
    b.add_takes_batch(&[take("a reworded claim")]).unwrap();
    assert!(!has(&b, "takes"), "a claim edit takes the vector away");
    assert_eq!(stale(), vec![take_id]);

    // A vector for the new claim is current again.
    embed(take_id, "a reworded claim");
    assert!(has(&b, "takes"));
    assert!(stale().is_empty());
}

#[test]
fn the_status_reads_answer_widths_census_and_unembedded_counts_as_postgres_does() {
    let b = brain("catalog-status");
    // No width yet: every embedding table reads as absent, any other table too.
    assert!(b.read_embedding_column_typmod("facts").unwrap().is_empty());
    b.set_config("embedding_dimensions", "8").unwrap();
    for table in ["content_chunks", "facts", "query_cache", "takes"] {
        assert_eq!(
            b.read_embedding_column_typmod(table).unwrap(),
            vec![json!({ "dim": 8 })],
            "{table}"
        );
    }
    assert!(b.read_embedding_column_typmod("pages").unwrap().is_empty());
    page(&b, "notes/a");
    page(&b, "notes/b");
    assert_eq!(
        b.read_embedding_signature_census().unwrap(),
        vec![json!({ "signature": null, "pages": 2 })]
    );
    assert_eq!(b.count_synopsis_tier_pages().unwrap(), 0);
    assert_eq!(b.count_embed_skip_null_chunks().unwrap(), 0);
    assert_eq!(
        b.count_unembedded_live_facts(&["audit:terminal".to_string()])
            .unwrap(),
        0
    );
    let fact = |source: &str| -> InsertFactArgs {
        de(
            json!({ "input": { "fact": format!("from {source}"), "source": source }, "sourceId": "default" }),
        )
    };
    b.insert_fact(&fact("chat")).unwrap();
    b.insert_fact(&fact("audit:terminal")).unwrap();
    assert_eq!(
        b.count_unembedded_live_facts(&["audit:terminal".to_string()])
            .unwrap(),
        1
    );
    // A false stamp needs a vector of another model under the target signature; with none, nothing counts.
    assert_eq!(
        b.read_false_stamped_chunk_counts(
            "openai:text-embedding-3-large:8",
            "openai:text-embedding-3-large"
        )
        .unwrap(),
        json!({ "pages": 0, "chunks": 0, "chars": 0 })
    );
}
