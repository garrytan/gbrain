//! Postgres text forms the persistence receipts size and print: the jsonb text of a value and
//! `timestamptz::text` with TimeZone UTC, as PGLite (PostgreSQL 18.6) evaluates them. The CLI
//! reads' other text semantics (`lower()`, `btrim`, `ILIKE`) arrive with those reads.

use crate::env::iso;
use serde_json::{Map, Value};

/// jsonb's text form: keys ordered by (length, bytes), `", "` and `": "` separators, numbers in
/// plain decimal notation, strings escaped as JSON.
pub(crate) fn jsonb_text(value: &Value) -> String {
    let mut out = String::new();
    write_jsonb(value, &mut out);
    out
}

fn write_jsonb(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number_text(n)),
        Value::String(s) => out.push_str(&Value::String(s.clone()).to_string()),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write_jsonb(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (key, item)) in jsonb_key_order(map).into_iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push_str(": ");
                write_jsonb(item, out);
            }
            out.push('}');
        }
    }
}

fn number_text(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    // Shortest round-trip digits in plain notation, as numeric prints the JSON number text.
    let f = n.as_f64().unwrap_or(0.0);
    if f == 0.0 {
        "0".to_string()
    } else {
        format!("{f}")
    }
}

fn jsonb_key_order(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut entries: Vec<(&String, &Value)> = map.iter().collect();
    entries.sort_by(|a, b| {
        a.0.len()
            .cmp(&b.0.len())
            .then_with(|| a.0.as_bytes().cmp(b.0.as_bytes()))
    });
    entries
}

/// `timestamptz::text` with TimeZone UTC: `2026-11-18 02:37:05.215+00`, trailing fraction zeros
/// dropped and no fraction when it is zero.
pub(crate) fn timestamptz_text(micros: i64) -> String {
    let iso = iso(micros);
    let (date_time, frac) = iso
        .trim_end_matches('Z')
        .split_once('.')
        .unwrap_or((&iso, ""));
    let frac = frac.trim_end_matches('0');
    let date_time = date_time.replacen('T', " ", 1);
    if frac.is_empty() {
        format!("{date_time}+00")
    } else {
        format!("{date_time}.{frac}+00")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn jsonb_text_matches_postgres_output() {
        assert_eq!(jsonb_text(&json!(true)), "true");
        assert_eq!(
            jsonb_text(&json!({"x": [1, 2], "ab": "c"})),
            r#"{"x": [1, 2], "ab": "c"}"#
        );
        assert_eq!(
            jsonb_text(&json!({"bb": 1, "a": 2, "ab": 3})),
            r#"{"a": 2, "ab": 3, "bb": 1}"#
        );
        assert_eq!(jsonb_text(&json!(1e21)), "1000000000000000000000");
        assert_eq!(jsonb_text(&json!(1.5e-7)), "0.00000015");
        assert_eq!(jsonb_text(&json!(["a\nb", "é"])), "[\"a\\nb\", \"é\"]");
    }

    #[test]
    fn timestamptz_text_trims_the_fraction() {
        assert_eq!(
            timestamptz_text(1_795_000_000_215_000),
            "2026-11-18 11:06:40.215+00"
        );
        assert_eq!(
            timestamptz_text(1_795_000_000_000_000),
            "2026-11-18 11:06:40+00"
        );
        assert_eq!(
            timestamptz_text(1_795_000_000_000_001),
            "2026-11-18 11:06:40.000001+00"
        );
    }
}
