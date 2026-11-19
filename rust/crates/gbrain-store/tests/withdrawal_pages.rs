//! The page statements a fact withdrawal runs (`facts/withdrawal_pages.rs`): the segmented pages among the slugs,
//! and the invalidation of every other page (a new knowledge revision, no text projection revision, no embedding
//! signature), each slug once, never another source's page.

mod memory_env;

use gbrain_store::Store;
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::embeddings::{SignatureOptions, StaleChunkOptions};
use gbrain_store::page_body::SegmentedPageMeta;
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope};
use gbrain_store::sources::SourceInput;
use memory_env::brain;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(store: &Store, slug: &str, source: &str) -> (u64, String) {
    let input: PageInput = de(
        json!({ "type": "note", "title": slug, "compiled_truth": "body text", "frontmatter": {} }),
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

fn shell(store: &Store, slug: &str) -> u64 {
    store
        .create_segmented_page_shell(
            slug,
            &de::<SegmentedPageMeta>(json!({ "type": "note", "title": slug })),
            &de(json!({ "sourceId": "default" })),
        )
        .unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn basis() -> Vec<f64> {
    (0..1536).map(|i| if i == 0 { 1.0 } else { 0.0 }).collect()
}

fn slugs(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn revision(store: &Store, slug: &str, source: &str) -> String {
    let scope = ReadScope {
        source_id: Some(source.to_string()),
        include_deleted: true,
        ..ReadScope::default()
    };
    let snap = store.read_page_snapshot(slug, &scope).unwrap().unwrap();
    snap["page"]["knowledge_revision"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn only_segmented_pages_of_the_source_are_listed() {
    let b = brain("wp-list");
    page(&b, "notes/inline", "default");
    let seg = shell(&b, "notes/seg");
    let got = b
        .list_segmented_pages(
            "default",
            &slugs(&["notes/seg", "notes/inline", "notes/seg", "notes/none"]),
        )
        .unwrap();
    assert_eq!(got, vec![json!({ "id": seg, "slug": "notes/seg" })]);
    assert!(
        b.list_segmented_pages("other", &slugs(&["notes/seg"]))
            .unwrap()
            .is_empty()
    );
    assert!(
        b.list_segmented_pages("default\0", &slugs(&["notes/seg"]))
            .is_err()
    );
}

#[test]
fn invalidation_renews_each_inline_page_once_and_clears_its_signature() {
    let b = brain("wp-invalidate");
    b.upsert_source(&de::<SourceInput>(
        json!({ "id": "other", "name": "other", "config": {} }),
    ))
    .unwrap();
    let (id, before) = page(&b, "notes/a", "default");
    let (_, other_before) = page(&b, "notes/a", "other");
    shell(&b, "notes/seg");
    let seg_before = revision(&b, "notes/seg", "default");
    b.upsert_chunks(
        "notes/a",
        &de::<Vec<ChunkInput>>(json!([{ "chunk_index": 0, "chunk_text": "one", "model": "openai:m1", "embedding": basis() }])),
        &UpsertChunksOptions { expected_revision: Some(before.clone()), seal: true, ..Default::default() },
    )
    .unwrap();
    b.set_page_embedding_signature(
        "notes/a",
        &de::<SignatureOptions>(json!({ "signature": "openai:m1:1536" })),
    )
    .unwrap();
    let stale = |b: &Store| {
        b.count_stale_chunks(&de::<StaleChunkOptions>(
            json!({ "signature": "openai:m2:1536", "sourceId": "default" }),
        ))
        .unwrap()
    };
    let signed = stale(&b);

    let got = b
        .invalidate_withdrawn_pages(
            "default",
            &slugs(&["notes/a", "notes/seg", "notes/a", "notes/none"]),
        )
        .unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["id"], json!(id));
    assert_eq!(got[0]["slug"], json!("notes/a"));
    let after = revision(&b, "notes/a", "default");
    assert_ne!(after, before);
    assert_eq!(got[0]["knowledge_revision"], json!(after));
    // The segmented page and the other source's page keep their revisions.
    assert_eq!(revision(&b, "notes/seg", "default"), seg_before);
    assert_eq!(revision(&b, "notes/a", "other"), other_before);
    // Signed at another model, the page's vector counted as stale; with no signature it no longer does.
    assert_eq!(signed, 1);
    assert_eq!(stale(&b), 0);
}
