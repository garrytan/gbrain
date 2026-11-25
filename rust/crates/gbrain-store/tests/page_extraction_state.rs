//! The extraction watermark and the partial-input receipt (`page_extraction_state`), matched to the
//! PGLite statements in `src/core/engine-sql/page-extraction-state.ts`, and the two doctor reads
//! that list its receipts.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::page_extraction_state::CommitInput;
use gbrain_store::page_ops::PurgeOptions;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn put(store: &Store, source: &str, slug: &str) -> u64 {
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "body"}))
            .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
    store.read_page_id_in_source(slug, source).unwrap().unwrap()
}

fn seeded(dir: &TempDir) -> Store {
    let store = open(dir);
    store
        .upsert_source(&SourceInput {
            id: "other".into(),
            ..Default::default()
        })
        .unwrap();
    store
}

fn commit(
    page_id: u64,
    pipeline: &str,
    bytes: i64,
    receipt: Option<Value>,
    keep: bool,
) -> CommitInput {
    serde_json::from_value(json!({
        "pageId": page_id, "pipeline": pipeline, "pipelineVersion": 1, "watermarkBytes": bytes,
        "watermarkSha256": format!("sha-{bytes}"), "receipt": receipt, "keepReceipt": keep,
    }))
    .unwrap()
}

#[test]
fn a_page_with_no_row_reads_as_no_watermark_and_a_missing_page_reads_null() {
    let dir = TempDir::new("pes-read");
    let store = seeded(&dir);
    let id = put(&store, "default", "notes/a");
    let read = store
        .read_page_extraction_watermark("default", "notes/a", "facts_backstop")
        .unwrap();
    assert_eq!(
        read,
        json!({"page_id": id, "pipeline_version": null, "watermark_bytes": null, "watermark_sha256": null})
    );
    // The slug exists in another source only.
    assert_eq!(
        store
            .read_page_extraction_watermark("other", "notes/a", "facts_backstop")
            .unwrap(),
        Value::Null
    );
    assert_eq!(
        store
            .read_page_extraction_receipt(id, "facts_backstop")
            .unwrap(),
        Value::Null
    );
}

#[test]
fn a_commit_stores_the_watermark_and_a_full_read_clears_the_receipt() {
    let dir = TempDir::new("pes-commit");
    let store = seeded(&dir);
    let id = put(&store, "default", "notes/a");
    let head = json!({"kind": "head", "pipeline": "facts_backstop", "processed_chars": 8000, "total_chars": 9000});
    store
        .commit_page_extraction(&commit(
            id,
            "facts_backstop",
            100,
            Some(head.clone()),
            false,
        ))
        .unwrap();
    assert_eq!(
        store
            .read_page_extraction_watermark("default", "notes/a", "facts_backstop")
            .unwrap(),
        json!({"page_id": id, "pipeline_version": 1, "watermark_bytes": 100, "watermark_sha256": "sha-100"})
    );
    // The receipt keeps jsonb key order: shorter keys first, then bytes.
    assert_eq!(
        store
            .read_page_extraction_receipt(id, "facts_backstop")
            .unwrap()
            .to_string(),
        r#"{"kind":"head","pipeline":"facts_backstop","total_chars":9000,"processed_chars":8000}"#
    );
    // Another pipeline of the page has its own row.
    assert_eq!(
        store
            .read_page_extraction_watermark("default", "notes/a", "extract_atoms")
            .unwrap()["watermark_bytes"],
        Value::Null
    );
    // A complete tail read keeps the gap an earlier read left.
    store
        .commit_page_extraction(&commit(id, "facts_backstop", 200, None, true))
        .unwrap();
    assert_eq!(
        store
            .read_page_extraction_receipt(id, "facts_backstop")
            .unwrap()["kind"],
        "head"
    );
    assert_eq!(
        store
            .read_page_extraction_watermark("default", "notes/a", "facts_backstop")
            .unwrap()["watermark_bytes"],
        200
    );
    // A full read replaces it with none.
    store
        .commit_page_extraction(&commit(id, "facts_backstop", 300, None, false))
        .unwrap();
    assert_eq!(
        store
            .read_page_extraction_receipt(id, "facts_backstop")
            .unwrap(),
        Value::Null
    );
}

#[test]
fn a_receipt_write_keeps_the_watermark_and_a_clear_deletes_the_row() {
    let dir = TempDir::new("pes-receipt");
    let store = seeded(&dir);
    let id = put(&store, "default", "notes/a");
    // A new row holds the receipt and no watermark.
    store
        .write_page_extraction_receipt(
            id,
            "conversation_facts",
            1,
            &json!({"kind": "skipped_too_large"}),
        )
        .unwrap();
    assert_eq!(
        store
            .read_page_extraction_watermark("default", "notes/a", "conversation_facts")
            .unwrap(),
        json!({"page_id": id, "pipeline_version": 1, "watermark_bytes": null, "watermark_sha256": null})
    );
    // A row that exists keeps its watermark and version.
    store
        .commit_page_extraction(&commit(id, "conversation_facts", 50, None, false))
        .unwrap();
    store
        .write_page_extraction_receipt(id, "conversation_facts", 7, &json!({"kind": "no_messages"}))
        .unwrap();
    let read = store
        .read_page_extraction_watermark("default", "notes/a", "conversation_facts")
        .unwrap();
    assert_eq!(read["pipeline_version"], 1);
    assert_eq!(read["watermark_bytes"], 50);
    assert_eq!(
        store
            .read_page_extraction_receipt(id, "conversation_facts")
            .unwrap(),
        json!({"kind": "no_messages"})
    );
    // The clear deletes the watermark with the receipt.
    store
        .clear_page_extraction_state(id, "conversation_facts")
        .unwrap();
    assert_eq!(
        store
            .read_page_extraction_watermark("default", "notes/a", "conversation_facts")
            .unwrap()["watermark_bytes"],
        Value::Null
    );
    store
        .clear_page_extraction_state(id, "conversation_facts")
        .unwrap();
}

#[test]
fn a_write_the_table_constraints_refuse_changes_nothing() {
    let dir = TempDir::new("pes-constraints");
    let store = seeded(&dir);
    let id = put(&store, "default", "notes/a");
    let refused = |e: gbrain_store::StoreError| assert_eq!(e.code, CONSTRAINT_VIOLATION, "{e}");
    refused(
        store
            .commit_page_extraction(&commit(id + 99, "facts_backstop", 1, None, false))
            .unwrap_err(),
    );
    refused(
        store
            .commit_page_extraction(&commit(id, "other_pipeline", 1, None, false))
            .unwrap_err(),
    );
    refused(
        store
            .commit_page_extraction(&commit(id, "facts_backstop", -1, None, false))
            .unwrap_err(),
    );
    refused(
        store
            .write_page_extraction_receipt(id + 99, "facts_backstop", 1, &json!({"kind": "head"}))
            .unwrap_err(),
    );
    refused(
        store
            .write_page_extraction_receipt(id, "nope", 1, &json!({"kind": "head"}))
            .unwrap_err(),
    );
    let e = store
        .write_page_extraction_receipt(id, "facts_backstop", 1, &json!("head"))
        .unwrap_err();
    assert_eq!(e.code, INVALID_ARGUMENT);
    assert_eq!(
        store
            .read_page_extraction_watermark("default", "notes/a", "facts_backstop")
            .unwrap()["pipeline_version"],
        Value::Null
    );
}

#[test]
fn a_soft_deleted_page_reads_null_but_a_hard_delete_a_purge_and_a_source_delete_drop_its_rows() {
    let dir = TempDir::new("pes-cascade");
    let store = seeded(&dir);
    let receipt = json!({"kind": "head"});
    let seed = |slug: &str, source: &str| {
        let id = put(&store, source, slug);
        for pipeline in ["facts_backstop", "extract_atoms"] {
            store
                .commit_page_extraction(&commit(id, pipeline, 10, Some(receipt.clone()), false))
                .unwrap();
        }
        id
    };
    let rows = |id: u64| {
        ["facts_backstop", "extract_atoms"]
            .iter()
            .filter(|p| store.read_page_extraction_receipt(id, p).unwrap() != Value::Null)
            .count()
    };
    let soft = seed("notes/soft", "default");
    let hard = seed("notes/hard", "default");
    let purged = seed("notes/purged", "default");
    let in_source = seed("notes/in-source", "other");

    // A soft delete keeps the rows (the page row stays); the watermark read sees no live page.
    store
        .soft_delete_page("notes/soft", Some("default"))
        .unwrap();
    assert_eq!(rows(soft), 2);
    assert_eq!(
        store
            .read_page_extraction_watermark("default", "notes/soft", "facts_backstop")
            .unwrap(),
        Value::Null
    );
    // A restore brings the page back with its rows.
    assert!(store.restore_page("notes/soft", Some("default")).unwrap());
    assert_eq!(
        store
            .read_page_extraction_watermark("default", "notes/soft", "facts_backstop")
            .unwrap()["watermark_bytes"],
        10
    );

    store.delete_page("notes/hard", Some("default")).unwrap();
    assert_eq!(rows(hard), 0);
    assert_eq!(rows(soft), 2);

    store
        .soft_delete_page("notes/purged", Some("default"))
        .unwrap();
    assert_eq!(rows(purged), 2);
    let out = store
        .purge_deleted_pages(0.0, &PurgeOptions::default())
        .unwrap();
    assert_eq!(out["count"], 1);
    assert_eq!(rows(purged), 0);
    assert_eq!(rows(soft), 2);

    assert_eq!(rows(in_source), 2);
    assert!(store.delete_source_record("other", false).unwrap());
    assert_eq!(rows(in_source), 0);
    assert_eq!(rows(soft), 2);
}

#[test]
fn the_doctor_lists_group_receipts_by_pipeline_and_kind_and_hold_back_ambiguous_pages() {
    let dir = TempDir::new("pes-doctor");
    let store = seeded(&dir);
    let a = put(&store, "default", "notes/a");
    let b = put(&store, "default", "notes/b");
    let c = put(&store, "other", "notes/c");
    let gone = put(&store, "default", "notes/gone");
    let write = |id: u64, pipeline: &str, receipt: Value| {
        store
            .write_page_extraction_receipt(id, pipeline, 1, &receipt)
            .unwrap();
    };
    write(a, "extract_atoms", json!({"kind": "head"}));
    write(b, "extract_atoms", json!({"kind": "head"}));
    write(c, "facts_backstop", json!({"kind": "tail_window"}));
    write(gone, "extract_atoms", json!({"kind": "head"}));
    // A receipt without a kind reads `unknown`; a chosen grammar and a held page are not truncations.
    write(a, "conversation_facts", json!({"other": 1}));
    write(b, "conversation_facts", json!({"kind": "grammar_chosen"}));
    write(
        c,
        "conversation_facts",
        json!({"kind": "detection_ambiguous", "grammars": {"slack": 2}}),
    );
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();

    let groups: Vec<(String, String, u64)> = store
        .list_extraction_input_receipts()
        .unwrap()
        .iter()
        .map(|g| {
            (
                g["pipeline"].as_str().unwrap().to_string(),
                g["kind"].as_str().unwrap().to_string(),
                g["pages"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        groups,
        vec![
            ("conversation_facts".to_string(), "unknown".to_string(), 1),
            ("extract_atoms".to_string(), "head".to_string(), 2),
            ("facts_backstop".to_string(), "tail_window".to_string(), 1),
        ]
    );
    let samples = store.list_extraction_input_receipts().unwrap()[1]["samples"].clone();
    assert_eq!(samples.as_array().unwrap().len(), 2);

    assert_eq!(
        store.list_ambiguous_extraction_inputs().unwrap(),
        vec![json!({"page": "other:notes/c", "grammars": {"slack": 2}, "total": 1})]
    );
}
