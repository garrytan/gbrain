//! The `code_traversal_cache` table: `getCodeTraversalCache`, `putCodeTraversalCache` and
//! `clearCodeTraversalCache`, matched to the SQL in `src/core/engine-sql/code-traversal-cache.ts`.

mod memory_env;

use gbrain_store::code_edges::{CacheClearInput, CacheKeyInput, CachePutInput};
use gbrain_store::env::SystemEnv;
use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::kv::{Kv, scan_prefix};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{OpenOptions, Store};
use memory_env::{Brain, brain};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::sync::Arc;

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

const EPOCH: &str = "1970-01-01T00:00:00.000Z";

fn key(symbol: &str, depth: i64, source: &str, generation: i64) -> CacheKeyInput {
    de(json!({
        "symbol_qualified": symbol, "depth": depth, "source_id": source, "cluster_generation": generation,
    }))
}

fn put(b: &Brain, symbol: &str, depth: i64, source: &str, generation: i64, response: Value) {
    b.put_code_traversal_cache(&de::<CachePutInput>(json!({
        "symbol_qualified": symbol, "depth": depth, "source_id": source, "cluster_generation": generation,
        "response_json": response, "max_chunk_updated_at": EPOCH, "xmin_max": 0,
    })))
    .unwrap();
}

fn get(b: &Brain, symbol: &str, depth: i64, source: &str, generation: i64) -> Option<Value> {
    b.get_code_traversal_cache(&key(symbol, depth, source, generation))
        .unwrap()
}

fn clear(b: &Brain, source: Option<&str>) -> u64 {
    b.clear_code_traversal_cache(&de::<CacheClearInput>(json!({"sourceId": source})))
        .unwrap()
}

#[test]
fn a_row_is_found_by_symbol_depth_source_and_generation_only() {
    let b = brain("tc-find");
    put(&b, "pkg.a", 1, "default", 0, json!({"edges": 1}));
    put(&b, "pkg.a", 2, "default", 0, json!({"edges": 2}));
    put(&b, "pkg.a", 1, "other", 0, json!({"edges": 3}));
    put(&b, "pkg.b", 1, "default", 7, json!({"edges": 4}));
    let response = |v: Option<Value>| v.map(|row| row["response_json"].clone());
    assert_eq!(
        response(get(&b, "pkg.a", 1, "default", 0)),
        Some(json!({"edges": 1}))
    );
    assert_eq!(
        response(get(&b, "pkg.a", 2, "default", 0)),
        Some(json!({"edges": 2}))
    );
    assert_eq!(
        response(get(&b, "pkg.a", 1, "other", 0)),
        Some(json!({"edges": 3}))
    );
    assert_eq!(
        response(get(&b, "pkg.b", 1, "default", 7)),
        Some(json!({"edges": 4}))
    );
    assert_eq!(get(&b, "pkg.a", 3, "default", 0), None);
    assert_eq!(get(&b, "pkg.a", 2, "other", 0), None);
    assert_eq!(get(&b, "pkg.c", 1, "default", 0), None);
    assert_eq!(get(&b, "PKG.A", 1, "default", 0), None);
    assert_eq!(get(&b, "pkg.b", 1, "default", 0), None);
    assert_eq!(get(&b, "pkg.b", 1, "default", 8), None);
    // Negative depths and a generation beyond int4 are keys like any other.
    put(&b, "pkg.n", -3, "default", 1 << 40, json!(null));
    assert_eq!(
        get(&b, "pkg.n", -3, "default", 1 << 40),
        Some(json!({
            "response_json": null,
            "computed_at": "2027-01-15T08:00:00.000000Z",
            "cluster_generation": 1u64 << 40,
        }))
    );
}

#[test]
fn a_put_on_the_key_replaces_the_row_and_restarts_computed_at() {
    let b = brain("tc-conflict");
    put(&b, "pkg.a", 1, "default", 0, json!({"edges": 1}));
    put(&b, "pkg.a", 1, "other", 0, json!({"edges": 9}));
    let first = get(&b, "pkg.a", 1, "default", 0).unwrap();
    assert_eq!(first["computed_at"], json!("2027-01-15T08:00:00.000000Z"));
    b.clock.advance(5_000_000);
    put(&b, "pkg.a", 1, "default", 5, json!({"edges": 2}));
    assert_eq!(get(&b, "pkg.a", 1, "default", 0), None);
    let second = get(&b, "pkg.a", 1, "default", 5).unwrap();
    assert_eq!(second["response_json"], json!({"edges": 2}));
    assert_eq!(second["cluster_generation"], json!(5));
    assert_eq!(second["computed_at"], json!("2027-01-15T08:00:05.000000Z"));
    // The other source's row is its own.
    assert_eq!(
        get(&b, "pkg.a", 1, "other", 0).unwrap()["response_json"],
        json!({"edges": 9})
    );
    // One row per key: clearing the source counts one.
    assert_eq!(clear(&b, Some("default")), 1);
}

#[test]
fn the_response_comes_back_in_the_key_order_jsonb_prints() {
    let b = brain("tc-jsonb");
    let response: Value = serde_json::from_str(
        r#"{"zeta":1,"b":[3,{"yy":1,"x":2}],"aaa":null,"é":1,"a":1.5,"":0,"Z":2}"#,
    )
    .unwrap();
    put(&b, "pkg.json", 1, "default", 0, response);
    let row = get(&b, "pkg.json", 1, "default", 0).unwrap();
    let keys = |v: &Value| -> Vec<String> { v.as_object().unwrap().keys().cloned().collect() };
    assert_eq!(
        keys(&row["response_json"]),
        ["", "Z", "a", "b", "é", "aaa", "zeta"]
    );
    assert_eq!(keys(&row["response_json"]["b"][1]), ["x", "yy"]);
}

#[test]
fn clear_removes_one_source_or_every_row_and_counts_them() {
    let b = brain("tc-clear");
    for (symbol, depth, source) in [
        ("s1", 1, "a"),
        ("s1", 2, "a"),
        ("s2", 1, "a"),
        ("s1", 1, "b"),
        ("s3", 1, "default"),
    ] {
        put(&b, symbol, depth, source, 0, json!({"s": symbol}));
    }
    assert_eq!(clear(&b, Some("a")), 3);
    assert_eq!(get(&b, "s1", 1, "a", 0), None);
    assert_eq!(get(&b, "s1", 2, "a", 0), None);
    assert_eq!(get(&b, "s2", 1, "a", 0), None);
    assert!(get(&b, "s1", 1, "b", 0).is_some());
    assert!(get(&b, "s3", 1, "default", 0).is_some());
    assert_eq!(clear(&b, Some("a")), 0);
    assert_eq!(clear(&b, Some("nowhere")), 0);
    // The unique key is free again after a clear, and the by-source index holds no ghost.
    put(&b, "s1", 1, "a", 0, json!({"again": true}));
    assert_eq!(clear(&b, Some("a")), 1);
    assert_eq!(clear(&b, None), 2);
    assert_eq!(get(&b, "s1", 1, "b", 0), None);
    assert_eq!(get(&b, "s3", 1, "default", 0), None);
    assert_eq!(clear(&b, None), 0);
}

#[test]
fn a_source_prefix_does_not_clear_a_longer_source() {
    let b = brain("tc-prefix");
    put(&b, "s", 1, "a", 0, json!(1));
    put(&b, "s", 1, "ab", 0, json!(2));
    put(&b, "s", 1, "a\u{1}", 0, json!(3));
    assert_eq!(clear(&b, Some("a")), 1);
    assert!(get(&b, "s", 1, "ab", 0).is_some());
    assert!(get(&b, "s", 1, "a\u{1}", 0).is_some());
}

#[test]
fn a_symbol_and_source_that_join_alike_stay_apart() {
    let b = brain("tc-join");
    put(&b, "a", 1, "b", 0, json!("ab"));
    put(&b, "a\u{1}", 1, "b", 0, json!("a1b"));
    put(&b, "a", 1, "b\u{1}", 0, json!("ab1"));
    assert_eq!(
        get(&b, "a", 1, "b", 0).unwrap()["response_json"],
        json!("ab")
    );
    assert_eq!(
        get(&b, "a\u{1}", 1, "b", 0).unwrap()["response_json"],
        json!("a1b")
    );
    assert_eq!(
        get(&b, "a", 1, "b\u{1}", 0).unwrap()["response_json"],
        json!("ab1")
    );
}

#[test]
fn a_row_survives_a_reopen() {
    let dir = std::env::temp_dir().join(format!("tc-reopen-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    {
        let store = Store::open_dir(&dir, OpenOptions::default()).unwrap();
        store
            .put_code_traversal_cache(&de::<CachePutInput>(json!({
                "symbol_qualified": "s", "depth": 2, "source_id": "default", "cluster_generation": 3,
                "response_json": {"kept": true}, "max_chunk_updated_at": EPOCH, "xmin_max": 4,
            })))
            .unwrap();
    }
    let store = Store::open_dir(&dir, OpenOptions::default()).unwrap();
    let row = store
        .get_code_traversal_cache(&key("s", 2, "default", 3))
        .unwrap()
        .unwrap();
    assert_eq!(row["response_json"], json!({"kept": true}));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn what_postgres_rejects_is_refused_and_stores_nothing() {
    let b = brain("tc-refuse");
    let refused = |input: Value| {
        let e = b
            .put_code_traversal_cache(&de::<CachePutInput>(input))
            .unwrap_err();
        assert_eq!(e.code, INVALID_ARGUMENT, "{e}");
    };
    let base = json!({
        "symbol_qualified": "s", "depth": 1, "source_id": "default", "cluster_generation": 0,
        "response_json": {}, "max_chunk_updated_at": EPOCH, "xmin_max": 0,
    });
    let with = |field: &str, value: Value| {
        let mut v = base.clone();
        v[field] = value;
        v
    };
    refused(with("depth", json!(1i64 << 31)));
    refused(with("depth", json!(-(1i64 << 31) - 1)));
    refused(with("symbol_qualified", json!("a\u{0}b")));
    refused(with("source_id", json!("a\u{0}b")));
    refused(with("response_json", json!({"k": "a\u{0}b"})));
    refused(with("response_json", json!({"a\u{0}b": 1})));
    refused(with("max_chunk_updated_at", json!("not a date")));
    refused(with("max_chunk_updated_at", json!("2026-01-02")));
    assert_eq!(clear(&b, None), 0);
    // The edge of int4 is a valid depth.
    put(&b, "edge", i32::MAX as i64, "default", 0, json!(1));
    put(&b, "edge", i32::MIN as i64, "default", 0, json!(2));
    assert!(get(&b, "edge", i32::MAX as i64, "default", 0).is_some());
    assert!(get(&b, "edge", i32::MIN as i64, "default", 0).is_some());
    assert!(
        b.get_code_traversal_cache(&key("s", 1 << 31, "default", 0))
            .is_err()
    );
    assert!(
        b.clear_code_traversal_cache(&de::<CacheClearInput>(json!({"sourceId": "a\u{0}"})))
            .is_err()
    );
}

#[test]
fn a_clear_leaves_no_record_of_the_rows_it_removed() {
    let dir = std::env::temp_dir().join(format!("tc-leak-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let kv = Arc::new(RedbKv::open_path(&dir.join("records.redb")).unwrap());
    let store = Store::open_kv(kv.clone(), Arc::new(SystemEnv), OpenOptions::default()).unwrap();
    let records = |tag: u8| {
        let mut n = 0;
        scan_prefix(
            &*kv.snapshot().unwrap(),
            &[b'g', tag],
            false,
            &mut |_, _| {
                n += 1;
                true
            },
        )
        .unwrap();
        n
    };
    let put = |symbol: &str, source: &str| {
        store
            .put_code_traversal_cache(&de::<CachePutInput>(json!({
                "symbol_qualified": symbol, "depth": 1, "source_id": source, "cluster_generation": 0,
                "response_json": {}, "max_chunk_updated_at": EPOCH, "xmin_max": 0,
            })))
            .unwrap();
    };
    put("a", "one");
    put("b", "one");
    put("c", "two");
    // The row, the unique key and the by-source key: three of each kind per row.
    assert_eq!((records(0x01), records(0x02), records(0x03)), (3, 3, 3));
    let clear = |source: Option<&str>| {
        store
            .clear_code_traversal_cache(&de::<CacheClearInput>(json!({"sourceId": source})))
            .unwrap()
    };
    assert_eq!(clear(Some("one")), 2);
    assert_eq!((records(0x01), records(0x02), records(0x03)), (1, 1, 1));
    assert_eq!(clear(None), 1);
    assert_eq!((records(0x01), records(0x02), records(0x03)), (0, 0, 0));
    drop(store);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_whole_float_generation_beyond_2_pow_53_is_the_exact_int8_and_a_fraction_is_a_bind_error() {
    let b = brain("traversal-cache-whole-float");
    // napi hands a JavaScript number above 2^32 over as a float; 2^60 is exact as a double.
    let generation = 2f64.powi(60);
    b.put_code_traversal_cache(&de::<CachePutInput>(json!({
        "symbol_qualified": "pkg.big", "depth": 1, "source_id": "default", "cluster_generation": generation,
        "response_json": {"ok": 1}, "max_chunk_updated_at": EPOCH, "xmin_max": generation,
    })))
    .unwrap();
    let row =
        get(&b, "pkg.big", 1, "default", 1i64 << 60).expect("stored under the exact generation");
    assert_eq!(row["cluster_generation"], json!(1i64 << 60));
    let float_key: CacheKeyInput = de(json!({
        "symbol_qualified": "pkg.big", "depth": 1, "source_id": "default", "cluster_generation": generation,
    }));
    assert!(b.get_code_traversal_cache(&float_key).unwrap().is_some());

    for (bad, message) in [
        (json!(1.5), "invalid input syntax for type bigint: \"1.5\""),
        (json!(1e19), "out of range for type bigint"),
    ] {
        let err = serde_json::from_value::<CacheKeyInput>(json!({
            "symbol_qualified": "pkg.big", "depth": 1, "source_id": "default", "cluster_generation": bad,
        }))
        .unwrap_err();
        assert!(err.to_string().contains(message), "{err}");
    }
}
