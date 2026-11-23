//! jsonb key order. Postgres keeps a jsonb object's keys shorter first, then by bytes, at every
//! depth (the last of duplicate keys wins, which a parsed `Map` already did), and every read gives
//! them in that order. The store keeps JSON as written, so each stored record field that holds a
//! jsonb column decodes through one of the `de_*` helpers here, and a Rust brain answers with the
//! bytes Postgres would: CLI and MCP JSON stay byte-exact.
//!
//! Answers built from a record still in memory (a write's answer, before any re-read) order the
//! jsonb fields they emit with `order` / `order_map`.
//!
//! A take's `write_origin` is ordered by `RowTrust` (trust/row_trust.rs) when it is read.

use std::cmp::Ordering;

use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

/// jsonb's key comparison: shorter keys first, then by bytes.
pub(crate) fn key_cmp(a: &str, b: &str) -> Ordering {
    a.len()
        .cmp(&b.len())
        .then_with(|| a.as_bytes().cmp(b.as_bytes()))
}

/// The object's entries in jsonb key order, borrowed.
pub(crate) fn sorted_entries(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut entries: Vec<(&String, &Value)> = map.iter().collect();
    entries.sort_by(|a, b| key_cmp(a.0, b.0));
    entries
}

/// The object with its keys in jsonb order, at every depth.
pub(crate) fn order_map(map: Map<String, Value>) -> Map<String, Value> {
    let mut entries: Vec<(String, Value)> = map.into_iter().collect();
    entries.sort_by(|a, b| key_cmp(&a.0, &b.0));
    entries.into_iter().map(|(k, v)| (k, order(v))).collect()
}

/// The value with every object's keys in jsonb order, at every depth.
pub(crate) fn order(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(order_map(map)),
        Value::Array(items) => Value::Array(items.into_iter().map(order).collect()),
        other => other,
    }
}

/// A copy of the value with every object's keys in jsonb order, at every depth.
pub(crate) fn ordered(value: &Value) -> Value {
    order(value.clone())
}

/// `deserialize_with` for a `Value` jsonb field.
pub(crate) fn de_value<'de, D: Deserializer<'de>>(d: D) -> Result<Value, D::Error> {
    Value::deserialize(d).map(order)
}

/// `deserialize_with` for an `Option<Value>` jsonb field (pair it with `#[serde(default)]`).
pub(crate) fn de_opt_value<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Option::<Value>::deserialize(d).map(|v| v.map(order))
}

/// `deserialize_with` for a `Map` jsonb field (an object column such as `frontmatter`).
pub(crate) fn de_map<'de, D: Deserializer<'de>>(d: D) -> Result<Map<String, Value>, D::Error> {
    Map::<String, Value>::deserialize(d).map(order_map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn orders_keys_by_length_then_bytes_at_every_depth() {
        let value = order(json!({"bb": 1, "a": {"zz": 1, "b": 2}, "ab": [{"cc": 1, "c": 2}]}));
        assert_eq!(
            serde_json::to_string(&value).unwrap(),
            r#"{"a":{"b":2,"zz":1},"ab":[{"c":2,"cc":1}],"bb":1}"#
        );
    }

    #[test]
    fn compares_bytes_not_chars_for_equal_lengths() {
        // "Z" (0x5A) sorts before "a" (0x61); "é" is two bytes, so it is longer than "z".
        let value = order(json!({"é": 1, "a": 2, "Z": 3, "z": 4}));
        assert_eq!(
            serde_json::to_string(&value).unwrap(),
            r#"{"Z":3,"a":2,"z":4,"é":1}"#
        );
    }

    #[derive(Deserialize)]
    struct Row {
        #[serde(deserialize_with = "de_value")]
        v: Value,
        #[serde(default, deserialize_with = "de_opt_value")]
        o: Option<Value>,
        #[serde(default, deserialize_with = "de_opt_value")]
        missing: Option<Value>,
        #[serde(deserialize_with = "de_map")]
        m: Map<String, Value>,
    }

    #[test]
    fn decode_helpers_order_each_field() {
        let row: Row = serde_json::from_str(
            r#"{"v":{"zz":1,"a":{"y":1,"x":2}},"o":{"mm":1,"b":2},"m":{"zz":1,"a":2}}"#,
        )
        .unwrap();
        assert_eq!(row.v.to_string(), r#"{"a":{"x":2,"y":1},"zz":1}"#);
        assert_eq!(row.o.unwrap().to_string(), r#"{"b":2,"mm":1}"#);
        assert!(row.missing.is_none());
        assert_eq!(serde_json::to_string(&row.m).unwrap(), r#"{"a":2,"zz":1}"#);
    }

    #[test]
    fn a_null_option_decodes_as_none() {
        let row: Row = serde_json::from_str(r#"{"v":null,"o":null,"m":{}}"#).unwrap();
        assert_eq!(row.v, Value::Null);
        assert!(row.o.is_none());
    }

    #[test]
    fn a_page_reads_and_answers_its_frontmatter_in_jsonb_order() {
        use crate::pages::{PageInput, PutPageOptions, ReadScope};
        let store = crate::test_support::store();
        let input: PageInput = serde_json::from_str(
            r#"{"type":"note","title":"t","compiled_truth":"x","frontmatter":{"zz":1,"a":2,"mm":3,"b":{"y":1,"x":2}}}"#,
        )
        .unwrap();
        let want = r#"{"a":2,"b":{"x":2,"y":1},"mm":3,"zz":1}"#;
        let put = store
            .put_page("notes/a", &input, &PutPageOptions::default())
            .unwrap();
        assert_eq!(put["frontmatter"].to_string(), want);
        let read = store
            .read_page_snapshot("notes/a", &ReadScope::default())
            .unwrap()
            .unwrap();
        assert_eq!(read["page"]["frontmatter"].to_string(), want);
    }
}
