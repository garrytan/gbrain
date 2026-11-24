//! The page-store reads and writes of `gbrain repair secret-spans` (`repair_secret_spans.rs`): the page and its stores as one
//! redaction input, the rewrites each family's own helper makes (so the indexes follow), and the refusals. The PGLite and
//! Postgres parity cases are in test/engine-parity/repair-secret-spans.test.ts; these cover what they cannot show: the dedup
//! key a rewritten timeline row moves, the embedding a rewritten fact loses, the claim revision a rewritten take counts, the
//! chunk postings a delete removes, and a raw data row named by its position.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::error::*;
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope};
use gbrain_store::repair_secret_spans::RedactedPageFields;
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput, TimelineOptions};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let store = open(&dir);
    (dir, store)
}

fn put(store: &Store, slug: &str, body: &str, frontmatter: Value) -> u64 {
    let input: PageInput = args(
        json!({ "type": "note", "title": slug, "compiled_truth": body, "timeline": "", "frontmatter": frontmatter }),
    );
    let options: PutPageOptions = args(json!({ "sourceId": "default" }));
    store.put_page(slug, &input, &options).unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn snapshot(store: &Store, slug: &str) -> Value {
    let scope = ReadScope {
        source_id: Some("default".into()),
        include_deleted: true,
        ..ReadScope::default()
    };
    store.read_page_snapshot(slug, &scope).unwrap().unwrap()
}

fn entry(store: &Store, slug: &str, date: &str, summary: &str, source: &str) {
    let input: TimelineInput =
        args(json!({ "date": date, "source": source, "summary": summary, "detail": "" }));
    assert!(
        store
            .add_timeline_entry(slug, &input, &AddTimelineOptions::default())
            .unwrap()
    );
}

fn timeline(store: &Store, slug: &str) -> Vec<(u64, String, String)> {
    let options = TimelineOptions {
        limit: Some(100),
        source_id: Some("default".into()),
        ..TimelineOptions::default()
    };
    let mut rows: Vec<_> = store
        .get_timeline(slug, &options)
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["id"].as_u64().unwrap(),
                e["summary"].as_str().unwrap().to_owned(),
                e["source"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    rows.sort();
    rows
}

fn fields(title: &str, body: &str, frontmatter: Value) -> RedactedPageFields {
    args(
        json!({ "title": title, "frontmatter": frontmatter, "compiledTruth": body, "timeline": "", "contentHash": "h" }),
    )
}

fn literal() -> String {
    let mut v = vec!["0".to_string(); 1536];
    v[0] = "0.5".into();
    format!("[{}]", v.join(","))
}

#[test]
fn the_page_row_reads_as_postgres_reads_it_and_a_tombstone_reads_as_none() {
    let (_dir, store) = brain("redaction-row");
    let id = put(&store, "notes/a", "body", json!({ "owner": "alice" }));
    store.add_tag("notes/a", "zeta", None).unwrap();
    store.add_tag("notes/a", "alpha", None).unwrap();
    let row = store
        .read_page_redaction_row("default", "notes/a")
        .unwrap()
        .unwrap();
    assert_eq!(row["id"], json!(id));
    assert_eq!(row["frontmatter"], json!({ "owner": "alice" }));
    assert_eq!(
        (
            row["body_storage"].as_str(),
            row["generation"].as_str(),
            row["page_kind"].as_str()
        ),
        (Some("inline"), Some("0"), Some("markdown"))
    );
    assert_eq!(
        (
            row["body_bytes"].clone(),
            row["body_flags"].clone(),
            row["contextual_retrieval_mode"].clone(),
            row["corpus_generation"].clone()
        ),
        (Value::Null, Value::Null, Value::Null, Value::Null)
    );
    assert_eq!(row["tags"], json!(["alpha", "zeta"]), "sorted");
    assert_eq!(row["revision"], snapshot(&store, "notes/a")["revision"]);
    assert_eq!(row["compiled_truth"], json!("body"));
    assert_eq!(
        store
            .read_page_redaction_row("default", "notes/missing")
            .unwrap(),
        None
    );
    assert_eq!(
        store.read_page_redaction_row("other", "notes/a").unwrap(),
        None
    );
    store
        .soft_delete_pages(
            &["notes/a".to_owned()],
            &args(json!({ "sourceId": "default" })),
        )
        .unwrap();
    assert_eq!(
        store.read_page_redaction_row("default", "notes/a").unwrap(),
        None,
        "a tombstone is not live"
    );
}

#[test]
fn the_stores_of_a_page_read_in_id_order_with_the_facts_it_holds_or_is_named_by() {
    let (_dir, store) = brain("redaction-rows");
    let a = put(&store, "notes/a", "x", json!({}));
    let b = put(&store, "notes/b", "y", json!({}));
    entry(&store, "notes/a", "2024-01-02", "first", "import");
    entry(&store, "notes/a", "2024-03-04", "second", "import");
    entry(&store, "notes/b", "2024-01-02", "not ours", "import");
    let fact = |text: &str, extra: Value| {
        let mut input = json!({ "fact": text, "source": "s", "context": format!("ctx {text}") });
        for (k, v) in extra.as_object().unwrap() {
            input[k] = v.clone();
        }
        store
            .insert_fact(&args(json!({ "input": input, "sourceId": "default" })))
            .unwrap();
    };
    // The fence columns are written by the batch insert only.
    store.insert_facts(&args(json!({ "rows": [
        { "fact": "held", "source": "s", "context": "ctx held", "source_markdown_slug": "notes/a", "entity_slug": "notes/b", "row_num": 1 },
        { "fact": "held elsewhere", "source": "s", "context": "ctx elsewhere", "source_markdown_slug": "notes/b", "entity_slug": "notes/a", "row_num": 1 }], "sourceId": "default" }))).unwrap();
    fact("named", json!({ "entity_slug": "notes/a" }));
    fact("other page", json!({ "entity_slug": "notes/b" }));
    store.add_takes_batch(&[args(json!({ "page_id": a, "row_num": 2, "claim": "two", "kind": "bet", "holder": "h", "weight": 0.5, "active": true, "source": "src" })),
        args(json!({ "page_id": a, "row_num": 1, "claim": "one", "kind": "bet", "holder": "h", "weight": 0.5, "active": true }))]).unwrap();
    store
        .add_link(
            "notes/a",
            "notes/b",
            &args(json!({ "context": "from a", "linkType": "mentions" })),
        )
        .unwrap();
    store
        .add_link(
            "notes/b",
            "notes/a",
            &args(json!({ "context": "from b", "linkType": "mentions" })),
        )
        .unwrap();
    store
        .put_raw_data("notes/a", Some("zeta"), Some(r#"{"z":1}"#), None)
        .unwrap();
    store
        .put_raw_data("notes/a", Some("alpha"), Some(r#"{"a":1}"#), None)
        .unwrap();
    let rows = store
        .read_page_redaction_rows(a as i64, "default", "notes/a")
        .unwrap();
    let col = |store: &str, column: &str| -> Vec<Value> {
        rows[store]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r[column].clone())
            .collect()
    };
    assert_eq!(
        col("timeline", "summary"),
        [json!("first"), json!("second")]
    );
    assert_eq!(
        col("facts", "context"),
        [json!("ctx held"), json!("ctx named")],
        "held by the page, or naming it with no holder, in id order"
    );
    let ids = col("facts", "id");
    assert!(ids[0].as_u64() < ids[1].as_u64());
    assert_eq!(
        col("takes", "claim"),
        [json!("two"), json!("one")],
        "in id order"
    );
    assert_eq!(col("takes", "source"), [json!("src"), Value::Null]);
    assert_eq!(col("links", "context"), [json!("from a")]);
    assert_eq!(col("rawData", "id"), [json!(1), json!(2)]);
    assert_eq!(
        col("rawData", "data"),
        [json!({ "a": 1 }), json!({ "z": 1 })],
        "numbered from 1 in source order"
    );
    assert_eq!(
        store.read_raw_data_value(a as i64, 2).unwrap(),
        Some(json!({ "z": 1 }))
    );
    assert_eq!(store.read_raw_data_value(a as i64, 3).unwrap(), None);
    assert_eq!(store.read_raw_data_value(a as i64, 0).unwrap(), None);
    assert_eq!(
        store
            .read_page_redaction_rows(-1, "default", "notes/a")
            .unwrap()["timeline"],
        json!([])
    );
    let _ = b;
}

#[test]
fn a_raw_data_row_is_replaced_by_its_position_and_keeps_its_source() {
    let (_dir, store) = brain("redaction-raw");
    let a = put(&store, "notes/a", "x", json!({}));
    store
        .put_raw_data("notes/a", Some("alpha"), Some(r#"{"a":1}"#), None)
        .unwrap();
    store
        .put_raw_data("notes/a", Some("beta"), Some(r#"{"b":1}"#), None)
        .unwrap();
    store
        .set_raw_data_value(a as i64, 2, json!({ "b": "[redacted]" }))
        .unwrap();
    store
        .set_raw_data_value(a as i64, 9, json!({ "none": true }))
        .unwrap();
    let rows = store
        .get_raw_data("notes/a", None, &args(json!({})))
        .unwrap();
    let by_source: Vec<(String, Value)> = rows
        .iter()
        .map(|r| (r["source"].as_str().unwrap().to_owned(), r["data"].clone()))
        .collect();
    assert_eq!(
        by_source,
        [
            ("alpha".to_owned(), json!({ "a": 1 })),
            ("beta".to_owned(), json!({ "b": "[redacted]" }))
        ]
    );
}

#[test]
fn the_page_rewrite_takes_a_new_revision_only_when_a_field_changed_and_stamps_the_hash() {
    let (_dir, store) = brain("redaction-page");
    let id = put(&store, "notes/a", "old body", json!({ "k": "v" }));
    let before = snapshot(&store, "notes/a");
    // Nothing changed: the revision stays (the hash and updated_at still move).
    store
        .set_redacted_page_fields(
            id as i64,
            &fields("notes/a", "old body", json!({ "k": "v" })),
        )
        .unwrap();
    let same = snapshot(&store, "notes/a");
    assert_eq!(same["revision"], before["revision"]);
    assert_eq!(same["page"]["content_hash"], json!("h"));
    store
        .set_redacted_page_fields(
            id as i64,
            &fields("new title", "new body", json!({ "k": "w" })),
        )
        .unwrap();
    let after = snapshot(&store, "notes/a");
    assert_ne!(after["revision"], before["revision"]);
    assert_eq!(
        (
            after["page"]["title"].as_str(),
            after["page"]["compiled_truth"].as_str(),
            after["page"]["frontmatter"].clone()
        ),
        (Some("new title"), Some("new body"), json!({ "k": "w" }))
    );
    assert_eq!(
        after["page"]["text_projection_revision"],
        Value::Null,
        "the seal goes with the revision"
    );
    store
        .set_redacted_page_fields(9999, &fields("x", "y", json!({})))
        .unwrap();
    assert_eq!(
        store
            .set_redacted_page_fields(id as i64, &fields("a\0b", "y", json!({})))
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        snapshot(&store, "notes/a")["page"]["title"],
        json!("new title")
    );
}

#[test]
fn retained_versions_list_in_id_order_count_and_take_a_new_body() {
    let (_dir, store) = brain("redaction-versions");
    let id = put(&store, "notes/a", "first body", json!({ "k": "first" }));
    store.create_version("notes/a", Some("default")).unwrap();
    put(&store, "notes/a", "second body", json!({ "k": "second" }));
    store.create_version("notes/a", Some("default")).unwrap();
    assert_eq!(store.count_page_version_rows(id as i64).unwrap(), 2);
    assert_eq!(store.count_page_version_rows(9999).unwrap(), 0);
    let versions = store.list_version_bodies_for_redaction(id as i64).unwrap();
    assert_eq!(
        versions
            .iter()
            .map(|v| v["compiled_truth"].clone())
            .collect::<Vec<_>>(),
        [json!("first body"), json!("second body")]
    );
    assert_eq!(versions[0]["frontmatter"], json!({ "k": "first" }));
    assert_eq!(versions[0]["body_storage"], json!("inline"));
    let first = versions[0]["id"].as_i64().unwrap();
    store
        .set_retained_version_body(
            id as i64,
            first,
            Some("[redacted] body".into()),
            args(json!({ "k": "[redacted]" })),
        )
        .unwrap();
    store
        .set_retained_version_body(id as i64, 9999, Some("x".into()), args(json!({})))
        .unwrap();
    let after = store.list_version_bodies_for_redaction(id as i64).unwrap();
    assert_eq!(
        (
            after[0]["compiled_truth"].clone(),
            after[0]["frontmatter"].clone()
        ),
        (json!("[redacted] body"), json!({ "k": "[redacted]" }))
    );
    assert_eq!(after[1]["compiled_truth"], json!("second body"));
    store
        .set_retained_version_body(id as i64, first, None, args(json!({})))
        .unwrap();
    assert_eq!(
        store.list_version_bodies_for_redaction(id as i64).unwrap()[0]["compiled_truth"],
        Value::Null
    );
}

#[test]
fn chunk_rows_list_with_their_doc_comments_and_a_delete_removes_only_the_named_chunks_of_the_page()
{
    let (_dir, store) = brain("redaction-chunks");
    let a = put(&store, "notes/a", "x", json!({}));
    let b = put(&store, "notes/b", "y", json!({}));
    let chunk = |i: u32, text: &str, doc: Option<&str>| -> ChunkInput {
        args(
            json!({ "chunk_index": i, "chunk_text": text, "chunk_source": "compiled_truth", "doc_comment": doc }),
        )
    };
    store
        .upsert_chunks(
            "notes/a",
            &[
                chunk(0, "keep me", None),
                chunk(1, "secret one", Some("a comment")),
                chunk(2, "secret two", None),
            ],
            &UpsertChunksOptions::default(),
        )
        .unwrap();
    store
        .upsert_chunks(
            "notes/b",
            &[chunk(0, "secret one", None)],
            &UpsertChunksOptions::default(),
        )
        .unwrap();
    let rows = store.list_chunk_texts_for_redaction(a as i64).unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r["chunk_text"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["keep me", "secret one", "secret two"]
    );
    assert_eq!(
        rows.iter()
            .map(|r| r["doc_comment"].clone())
            .collect::<Vec<_>>(),
        [Value::Null, json!("a comment"), Value::Null]
    );
    let ids: Vec<i64> = rows.iter().map(|r| r["id"].as_i64().unwrap()).collect();
    let other = store.list_chunk_texts_for_redaction(b as i64).unwrap()[0]["id"]
        .as_i64()
        .unwrap();
    // The other page's id in the list is not deleted, and an unknown id is ignored.
    store
        .delete_chunks_by_ids(a as i64, &[ids[1], ids[2], other, 9999])
        .unwrap();
    let left = store.list_chunk_texts_for_redaction(a as i64).unwrap();
    assert_eq!(
        left.iter()
            .map(|r| r["chunk_text"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["keep me"]
    );
    assert_eq!(
        store
            .list_chunk_texts_for_redaction(b as i64)
            .unwrap()
            .len(),
        1
    );
    store.delete_chunks_by_ids(a as i64, &[]).unwrap();
    store.delete_chunks_by_ids(-1, &[ids[0]]).unwrap();
    assert_eq!(
        store
            .list_chunk_texts_for_redaction(a as i64)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn a_rewritten_timeline_row_moves_its_dedup_key_and_a_new_key_another_row_holds_is_refused() {
    let (_dir, store) = brain("redaction-timeline");
    let a = put(&store, "notes/a", "x", json!({}));
    entry(&store, "notes/a", "2024-01-02", "token abc", "import");
    entry(
        &store,
        "notes/a",
        "2024-01-02",
        "token [redacted]",
        "import",
    );
    let dedup = store.list_timeline_dedup_rows(a as i64).unwrap();
    assert_eq!(
        dedup
            .iter()
            .map(|r| r["summary"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["token abc", "token [redacted]"]
    );
    assert_eq!(dedup[0]["date"], json!("2024-01-02"));
    let first = timeline(&store, "notes/a")[0].0 as i64;
    // The second row already holds the key the first would take: refused, nothing written.
    let refused = store
        .set_redacted_row_text(
            a as i64,
            "timeline_entries",
            first,
            "summary",
            "token [redacted]",
        )
        .unwrap_err();
    assert_eq!(refused.code, CONSTRAINT_VIOLATION);
    assert_eq!(
        timeline(&store, "notes/a")
            .iter()
            .map(|r| r.1.as_str())
            .collect::<Vec<_>>(),
        ["token abc", "token [redacted]"]
    );
    store
        .set_redacted_row_text(
            a as i64,
            "timeline_entries",
            first,
            "summary",
            "token [removed]",
        )
        .unwrap();
    store
        .set_redacted_row_text(a as i64, "timeline_entries", first, "source", "import-2")
        .unwrap();
    assert_eq!(
        timeline(&store, "notes/a")[0],
        (
            first as u64,
            "token [removed]".to_owned(),
            "import-2".to_owned()
        )
    );
    // The old key is free again, and the new one is taken.
    let input: TimelineInput = args(
        json!({ "date": "2024-01-02", "source": "import", "summary": "token abc", "detail": "" }),
    );
    assert!(
        store
            .add_timeline_entry("notes/a", &input, &AddTimelineOptions::default())
            .unwrap()
    );
    let again: TimelineInput = args(
        json!({ "date": "2024-01-02", "source": "import-2", "summary": "token [removed]", "detail": "" }),
    );
    assert!(
        !store
            .add_timeline_entry("notes/a", &again, &AddTimelineOptions::default())
            .unwrap()
    );
    store
        .set_redacted_row_text(a as i64, "timeline_entries", 9999, "summary", "x")
        .unwrap();
}

#[test]
fn a_rewritten_fact_or_take_loses_its_embedding_and_a_link_keeps_its_keys() {
    let (_dir, store) = brain("redaction-rows-write");
    let a = put(&store, "notes/a", "x", json!({}));
    put(&store, "notes/b", "y", json!({}));
    let fact_id = store.insert_fact(&args(json!({ "input": { "fact": "token abc", "context": "ctx abc", "entity_slug": "notes/a", "source": "s",
        "embedding": literal(), "embedding_model": "m1" }, "sourceId": "default" }))).unwrap()["id"].as_u64().unwrap() as i64;
    store.add_takes_batch(&[args(json!({ "page_id": a, "row_num": 1, "claim": "claim abc", "kind": "bet", "holder": "h", "weight": 0.5, "active": true }))]).unwrap();
    store
        .add_link(
            "notes/a",
            "notes/b",
            &args(json!({ "context": "link abc", "linkType": "mentions" })),
        )
        .unwrap();
    let query = args(
        json!({ "sourceId": "default", "entitySlug": "notes/a", "activeOnly": false, "limit": 10 }),
    );
    let before = store.list_facts_by_entity(&query).unwrap();
    assert!(before[0]["embedding"].is_array() && before[0]["embedding_model"] == json!("m1"));
    store
        .set_redacted_row_text(a as i64, "facts", fact_id, "fact", "token [redacted]")
        .unwrap();
    store
        .set_redacted_row_text(a as i64, "facts", fact_id, "context", "ctx [redacted]")
        .unwrap();
    let after = store.list_facts_by_entity(&query).unwrap();
    assert_eq!(
        (after[0]["fact"].as_str(), after[0]["context"].as_str()),
        (Some("token [redacted]"), Some("ctx [redacted]"))
    );
    assert_eq!(
        (
            after[0]["embedding"].clone(),
            after[0]["embedding_model"].clone(),
            after[0]["embedded_at"].clone()
        ),
        (Value::Null, Value::Null, Value::Null)
    );
    assert_eq!(after[0]["id"], before[0]["id"]);

    let take = store.list_takes(&args(json!({ "page_id": a }))).unwrap();
    let take_id = take[0]["id"].as_i64().unwrap();
    store
        .set_redacted_row_text(a as i64, "takes", take_id, "claim", "claim [redacted]")
        .unwrap();
    store
        .set_redacted_row_text(a as i64, "takes", take_id, "source", "src [redacted]")
        .unwrap();
    let take = store.list_takes(&args(json!({ "page_id": a }))).unwrap();
    assert_eq!(
        (take[0]["claim"].as_str(), take[0]["source"].as_str()),
        (Some("claim [redacted]"), Some("src [redacted]"))
    );

    let link_id = store
        .read_page_redaction_rows(a as i64, "default", "notes/a")
        .unwrap()["links"][0]["id"]
        .as_i64()
        .unwrap();
    store
        .set_redacted_row_text(a as i64, "links", link_id, "context", "link [redacted]")
        .unwrap();
    let link = store
        .get_links("notes/a", &args(json!({ "sourceId": "default" })))
        .unwrap();
    assert_eq!(
        (link.len(), link[0]["context"].as_str()),
        (1, Some("link [redacted]"))
    );
    let again = store
        .read_page_redaction_rows(a as i64, "default", "notes/a")
        .unwrap()["links"][0]["id"]
        .as_i64()
        .unwrap();
    assert_eq!(again, link_id, "the link keeps its id");
    let backlinks = store
        .get_backlinks("notes/b", &args(json!({ "sourceId": "default" })))
        .unwrap();
    assert_eq!(
        backlinks.len(),
        1,
        "the backlink index still names the link"
    );

    for (store_name, column) in [
        ("pages", "title"),
        ("facts", "embedding"),
        ("takes", "weight"),
        ("links", "link_type"),
        ("timeline_entries", "date"),
    ] {
        assert_eq!(
            store
                .set_redacted_row_text(a as i64, store_name, 1, column, "x")
                .unwrap_err()
                .code,
            INVALID_ARGUMENT,
            "{store_name}.{column}"
        );
    }
    assert_eq!(
        store
            .set_redacted_row_text(a as i64, "facts", 1, "fact", "a\0b")
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    for store_name in ["facts", "takes", "links"] {
        store
            .set_redacted_row_text(
                a as i64,
                store_name,
                9999,
                if store_name == "facts" {
                    "fact"
                } else if store_name == "takes" {
                    "claim"
                } else {
                    "context"
                },
                "x",
            )
            .unwrap();
    }
}
