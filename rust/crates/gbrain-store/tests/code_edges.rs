//! Code edges: `addCodeEdges`, `deleteCodeEdgesForChunks`, `getCallersOf`, `getCalleesOf` and
//! `getEdgesByChunk`, matched to the PGLite engine.

mod common;

use common::TempDir;
use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::code_edges::{ChunkEdgesOptions, CodeEdgeInput, EdgeLookup};
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope};
use gbrain_store::sources::SourceInput;
use gbrain_store::{OpenOptions, Store};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

fn open(dir: &TempDir) -> Store {
    Store::open_dir(dir.path(), OpenOptions::default()).unwrap()
}

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// A code page in `source` with one sealed chunk per symbol; returns the chunk ids in order.
fn seed(store: &Store, source: &str, slug: &str, symbols: &[&str]) -> Vec<u64> {
    let input: PageInput = de(json!({"type": "code", "title": slug, "compiled_truth": "body"}));
    let opts: PutPageOptions = de(json!({"sourceId": source}));
    store.put_page(slug, &input, &opts).unwrap();
    let chunks: Vec<ChunkInput> = symbols
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let mut rest = Map::new();
            rest.insert("symbol_name".into(), json!(s));
            ChunkInput {
                chunk_index: i as u32,
                chunk_text: format!("fn {s}() {{}}"),
                rest,
                ..ChunkInput::default()
            }
        })
        .collect();
    store
        .upsert_chunks(
            slug,
            &chunks,
            &UpsertChunksOptions {
                source_id: Some(source.into()),
                seal: true,
                ..UpsertChunksOptions::default()
            },
        )
        .unwrap();
    let scope: ReadScope = de(json!({"sourceId": source}));
    store
        .get_chunks(slug, &scope)
        .unwrap()
        .iter()
        .map(|c| c["id"].as_u64().unwrap())
        .collect()
}

fn source(store: &Store, id: &str) {
    let input: SourceInput = de(json!({"id": id, "name": id}));
    store.upsert_source(&input).unwrap();
}

fn edge(from: u64, to: Option<u64>, from_symbol: &str, to_symbol: &str) -> CodeEdgeInput {
    de(json!({
        "from_chunk_id": from, "to_chunk_id": to, "from_symbol_qualified": from_symbol,
        "to_symbol_qualified": to_symbol, "edge_type": "calls", "edge_metadata": {},
        "source_id": "default",
    }))
}

fn lookup(name: &str, extra: Value) -> EdgeLookup {
    let mut v = json!({"name": name, "limit": 100});
    for (k, val) in extra.as_object().unwrap() {
        v[k] = val.clone();
    }
    de(v)
}

fn ids(rows: &[Value]) -> Vec<(bool, u64)> {
    rows.iter()
        .map(|r| (r["resolved"].as_bool().unwrap(), r["id"].as_u64().unwrap()))
        .collect()
}

fn by_chunk(store: &Store, chunk: u64, direction: &str) -> Vec<Value> {
    store
        .get_edges_by_chunk(&de::<ChunkEdgesOptions>(
            json!({"chunk_id": chunk, "direction": direction, "limit": 50}),
        ))
        .unwrap()
}

#[test]
fn add_splits_by_target_and_skips_repeats() {
    let dir = TempDir::new("code-edges-add");
    let store = open(&dir);
    let a = seed(&store, "default", "a", &["run"]);
    let b = seed(&store, "default", "b", &["helper"]);
    let batch = [
        edge(a[0], Some(b[0]), "a.run", "b.helper"),
        edge(a[0], None, "a.run", "ext.log"),
        edge(a[0], None, "a.run", "ext.log"),
    ];
    assert_eq!(store.add_code_edges(&batch).unwrap(), 2);
    assert_eq!(store.add_code_edges(&batch).unwrap(), 0);
    let out = by_chunk(&store, a[0], "out");
    assert_eq!(ids(&out), vec![(true, 1), (false, 1)]);
    assert_eq!(out[0]["to_chunk_id"], json!(b[0]));
    assert_eq!(out[1]["to_chunk_id"], Value::Null);
    assert_eq!(out[1]["source_id"], json!("default"));
    // `in` reads only the chunk table.
    assert_eq!(ids(&by_chunk(&store, b[0], "in")), vec![(true, 1)]);
    assert!(by_chunk(&store, a[0], "in").is_empty());
}

#[test]
fn a_failed_batch_writes_nothing() {
    let dir = TempDir::new("code-edges-fk");
    let store = open(&dir);
    let a = seed(&store, "default", "a", &["run"]);
    let err = store
        .add_code_edges(&[
            edge(a[0], None, "a.run", "ext.ok"),
            edge(a[0], Some(9999), "a.run", "ghost"),
        ])
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    assert!(err.message.contains("code_edges_chunk_to_chunk_id_fkey"));
    assert!(by_chunk(&store, a[0], "both").is_empty());

    let mut missing = edge(a[0], None, "a.run", "x");
    missing.edge_type = None;
    let err = store.add_code_edges(&[missing]).unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    assert!(err.message.contains("\"edge_type\""));

    let mut gone = edge(a[0], None, "a.run", "x");
    gone.source_id = Some("nowhere".into());
    let err = store.add_code_edges(&[gone]).unwrap_err();
    assert!(err.message.contains("code_edges_symbol_source_id_fkey"));

    let err = store
        .add_code_edges(&[de(json!({
            "from_chunk_id": 1.5, "to_chunk_id": null, "from_symbol_qualified": "a",
            "to_symbol_qualified": "b", "edge_type": "calls", "edge_metadata": {},
        }))])
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

#[test]
fn callers_and_callees_read_live_rows_in_scope() {
    let dir = TempDir::new("code-edges-reads");
    let store = open(&dir);
    source(&store, "other");
    let a = seed(&store, "default", "a", &["run"]);
    let b = seed(&store, "default", "b", &["helper"]);
    let c = seed(&store, "other", "c", &["helper"]);
    let mut stamped = edge(c[0], None, "c.helper", "b.helper");
    stamped.source_id = Some("other".into());
    stamped.edge_metadata = json!({"resolved_chunk_id": b[0]});
    store
        .add_code_edges(&[edge(a[0], Some(b[0]), "a.run", "b.helper"), stamped])
        .unwrap();

    let all = store
        .get_callers_of(&lookup("b.helper", json!({})))
        .unwrap();
    assert_eq!(ids(&all), vec![(true, 1), (false, 1)]);
    let scoped = store
        .get_callers_of(&lookup("b.helper", json!({"source_id": "other"})))
        .unwrap();
    assert_eq!(ids(&scoped), vec![(false, 1)]);
    let by_id = store
        .get_callers_of(&lookup("ignored", json!({"chunk_id": b[0]})))
        .unwrap();
    assert_eq!(ids(&by_id), vec![(true, 1), (false, 1)]);
    let limited = store
        .get_callers_of(&lookup("b.helper", json!({"limit": 1})))
        .unwrap();
    assert_eq!(ids(&limited), vec![(true, 1)]);

    let callees = store.get_callees_of(&lookup("a.run", json!({}))).unwrap();
    assert_eq!(ids(&callees), vec![(true, 1)]);
    // The bare fallback re-keys on the chunks named `run`.
    assert!(
        store
            .get_callees_of(&lookup("run", json!({})))
            .unwrap()
            .is_empty()
    );
    let bare = store
        .get_callees_of(&lookup("run", json!({"bare_fallback": true})))
        .unwrap();
    assert_eq!(ids(&bare), vec![(true, 1)]);

    // A soft-deleted endpoint hides the row from the live reads, not from getEdgesByChunk.
    store.soft_delete_page("b", Some("default")).unwrap();
    assert!(
        store
            .get_callers_of(&lookup("b.helper", json!({"source_id": "default"})))
            .unwrap()
            .is_empty()
    );
    assert_eq!(by_chunk(&store, b[0], "in").len(), 1);
}

#[test]
fn bad_input_is_refused_as_postgres_refuses_it() {
    let dir = TempDir::new("code-edges-refuse");
    let store = open(&dir);
    let a = seed(&store, "default", "a", &["run"]);
    let mut bad = edge(a[0], None, "a.run", "x");
    bad.edge_metadata = json!({"resolved_chunk_id": "nope"});
    store.add_code_edges(&[bad]).unwrap();
    let err = store
        .get_callers_of(&lookup("", json!({"chunk_id": a[0]})))
        .unwrap_err();
    assert_eq!(
        err.message,
        "invalid input syntax for type integer: \"nope\""
    );
    // By name, the bad stamp is never cast.
    assert_eq!(
        store.get_callers_of(&lookup("x", json!({}))).unwrap().len(),
        1
    );
    let err = store
        .get_callers_of(&lookup("x", json!({"limit": -1})))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

#[test]
fn deleting_chunks_drops_their_edges_both_ways() {
    let dir = TempDir::new("code-edges-delete");
    let store = open(&dir);
    let a = seed(&store, "default", "a", &["run"]);
    let b = seed(&store, "default", "b", &["helper"]);
    store
        .add_code_edges(&[
            edge(a[0], Some(b[0]), "a.run", "b.helper"),
            edge(b[0], None, "b.helper", "ext"),
            edge(a[0], None, "a.run", "ext"),
        ])
        .unwrap();
    store.delete_code_edges_for_chunks(&[]).unwrap();
    store
        .delete_code_edges_for_chunks(&[Value::Null, json!(b[0])])
        .unwrap();
    assert_eq!(ids(&by_chunk(&store, a[0], "both")), vec![(false, 2)]);
    assert!(by_chunk(&store, b[0], "both").is_empty());
    // Sealing the page with no chunks drops the edges of the chunks it removed.
    assert!(seed(&store, "default", "a", &[]).is_empty());
    assert!(by_chunk(&store, a[0], "both").is_empty());
}
