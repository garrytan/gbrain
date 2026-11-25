//! The last family-tail reads (tail_reads) and `listEvalCandidateQueries` (eval_capture). Expected
//! rows follow the PGLite SQL in src/core/engine-sql/contradictions-cycle.ts and admin-reads.ts.
//! The cross-engine cases are test/engine-parity/family-tail-sites.test.ts.

mod common;

use common::TempDir;
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::eval_capture::EvalCandidateInput;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::sources::SourceInput;
use gbrain_store::tail_reads::{LiveChunksInput, LiveTakesInput};
use gbrain_store::takes::TakeInput;
use gbrain_store::{OpenOptions, Store, SystemEnv};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::sync::Arc;

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

struct Brain {
    _dir: TempDir,
    store: Store,
}

impl Brain {
    fn new(name: &str) -> Self {
        let dir = TempDir::new(name);
        let kv = Arc::new(RedbKv::open_path(&dir.path().join("records.redb")).unwrap());
        let store = Store::open_kv(kv, Arc::new(SystemEnv), OpenOptions::default()).unwrap();
        Brain { _dir: dir, store }
    }

    fn source(&self, id: &str) {
        let input: SourceInput = de(json!({"id": id, "name": id}));
        self.store.upsert_source(&input).unwrap();
    }

    fn page(&self, slug: &str, source: &str, frontmatter: Value) -> u64 {
        let input: PageInput = de(json!({
            "type": "note", "title": slug, "compiled_truth": format!("{slug} body"),
            "frontmatter": frontmatter,
        }));
        let options: PutPageOptions = de(json!({"sourceId": source, "index": false}));
        self.store.put_page(slug, &input, &options).unwrap()["id"]
            .as_u64()
            .unwrap()
    }

    fn seal(&self, slug: &str, source: &str, texts: &[&str]) {
        let inputs: Vec<ChunkInput> = texts
            .iter()
            .enumerate()
            .map(|(i, text)| {
                de(json!({"chunk_index": i, "chunk_text": text, "chunk_source": "compiled_truth"}))
            })
            .collect();
        let options = UpsertChunksOptions {
            source_id: Some(source.into()),
            seal: true,
            ..UpsertChunksOptions::default()
        };
        self.store.upsert_chunks(slug, &inputs, &options).unwrap();
    }

    fn chunks(&self, ids: Vec<i64>, scope: Value) -> Vec<Value> {
        let input: LiveChunksInput = de(json!({"ids": ids, "scope": scope}));
        self.store.list_live_chunks_by_ids(&input).unwrap()
    }

    fn takes(&self, ids: Vec<i64>, holders: Value) -> Vec<Value> {
        let input: LiveTakesInput = de(json!({"ids": ids, "scope": {}, "holders": holders}));
        self.store.list_live_takes_by_ids(&input).unwrap()
    }
}

fn texts(rows: &[Value]) -> Vec<&str> {
    rows.iter()
        .map(|r| r["chunk_text"].as_str().unwrap())
        .collect()
}

#[test]
fn live_chunks_keep_the_asked_ids_in_id_order_within_the_source_scope() {
    let b = Brain::new("tail-reads-chunks");
    b.source("other");
    b.page("notes/a", "default", json!({}));
    b.page("notes/b", "other", json!({}));
    b.seal("notes/a", "default", &["a0", "a1"]);
    b.seal("notes/b", "other", &["b0"]);
    let all = b.chunks((1..50).collect(), json!({}));
    assert_eq!(texts(&all), ["a0", "a1", "b0"]);
    let ids: Vec<i64> = all.iter().map(|r| r["id"].as_i64().unwrap()).collect();

    // Ids match once each, in id order, whatever order the caller asks in; an unknown id is dropped.
    let asked = vec![ids[2], ids[0], ids[0], 987_654, -1];
    assert_eq!(texts(&b.chunks(asked, json!({}))), ["a0", "b0"]);
    let other = b.chunks(ids.clone(), json!({"sourceId": "other"}));
    assert_eq!(other[0]["slug"], "notes/b");
    assert_eq!(other[0]["source_id"], "other");
    assert_eq!(other.len(), 1);
    assert!(b.chunks(vec![], json!({})).is_empty());
}

#[test]
fn a_bad_trust_floor_is_refused_even_with_no_ids() {
    let b = Brain::new("tail-reads-floor");
    let input: LiveChunksInput = de(json!({"ids": [], "scope": {"minTrust": "nonsense"}}));
    assert!(b.store.list_live_chunks_by_ids(&input).is_err());
}

#[test]
fn live_takes_keep_active_rows_and_an_empty_holder_list_admits_none() {
    let b = Brain::new("tail-reads-takes");
    let page = b.page("people/alice-example", "default", json!({}));
    let rows: Vec<TakeInput> = [(1, "world", true), (2, "garry", true), (3, "world", false)]
        .iter()
        .map(|(row, holder, active)| {
            de(json!({
                "page_id": page, "row_num": row, "claim": format!("claim {row}"), "kind": "take",
                "holder": holder, "weight": 0.5, "active": active,
            }))
        })
        .collect();
    b.store.add_takes_batch(&rows).unwrap();

    let all = b.takes((1..50).collect(), Value::Null);
    let claims: Vec<&str> = all.iter().map(|r| r["claim"].as_str().unwrap()).collect();
    assert_eq!(claims, ["claim 1", "claim 2"]);
    assert_eq!(all[0]["row_num"], 1);
    assert_eq!(all[0]["slug"], "people/alice-example");

    let world = b.takes((1..50).collect(), json!(["world"]));
    assert_eq!(world.len(), 1);
    assert_eq!(world[0]["holder"], "world");
    assert!(b.takes((1..50).collect(), json!([])).is_empty());
}

#[test]
fn version_history_reads_the_named_pages_with_their_frontmatter() {
    let b = Brain::new("tail-reads-versions");
    let one = b.page("notes/one", "default", json!({"tags": ["x"]})) as i64;
    let two = b.page("notes/two", "default", json!({})) as i64;
    let rows = b
        .store
        .read_pages_for_version_history(&[two, one, 987_654])
        .unwrap();
    let slugs: Vec<&str> = rows.iter().map(|r| r["slug"].as_str().unwrap()).collect();
    assert_eq!(slugs, ["notes/one", "notes/two"]);
    assert_eq!(rows[0]["source_id"], "default");
    assert!(rows[1]["frontmatter"].is_object());
    assert!(
        b.store
            .read_pages_for_version_history(&[])
            .unwrap()
            .is_empty()
    );
}

#[test]
fn eval_candidate_queries_are_the_newest_first_and_a_negative_limit_is_refused() {
    let b = Brain::new("tail-reads-eval");
    for q in ["first", "second", "third"] {
        let input: EvalCandidateInput = de(json!({
            "tool_name": "query", "query": q, "retrieved_slugs": [], "retrieved_chunk_ids": [],
            "source_ids": ["default"], "vector_enabled": true, "expansion_applied": false,
            "latency_ms": 1, "remote": false,
        }));
        b.store.log_eval_candidate(&input).unwrap();
    }
    assert_eq!(
        b.store.list_eval_candidate_queries(100).unwrap(),
        ["third", "second", "first"]
    );
    assert_eq!(
        b.store.list_eval_candidate_queries(2).unwrap(),
        ["third", "second"]
    );
    assert!(b.store.list_eval_candidate_queries(0).unwrap().is_empty());
    let err = b.store.list_eval_candidate_queries(-1).unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}
