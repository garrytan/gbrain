//! Postgres text semantics the CLI reads reproduce: `lower()`, the jsonb `->>` and `->` operators,
//! `timestamptz::text`, `btrim`, the `[[:space:]]` class and the case-insensitive match rules of
//! `~*` and `ILIKE`, as PGLite (PostgreSQL 18.6, libc provider, ctype `C.UTF-8`, TimeZone UTC)
//! evaluates them (rust/docs/store/cli-reads-ops.md, "Text semantics").

use super::pg_case::CASE_MAP;
use crate::env::iso;
use serde_json::{Map, Value};

fn case_entry(c: char) -> Option<(char, char)> {
    let cp = c as u32;
    let i = CASE_MAP.binary_search_by_key(&cp, |e| e.0).ok()?;
    let (_, lower, upper) = CASE_MAP[i];
    Some((char::from_u32(lower)?, char::from_u32(upper)?))
}

/// `lower(chr(c))`: one character, from PGLite's table.
pub(crate) fn lower_char(c: char) -> char {
    case_entry(c).map_or(c, |e| e.0)
}

/// `upper(chr(c))`: one character, from PGLite's table.
#[cfg(test)]
pub(crate) fn upper_char(c: char) -> char {
    case_entry(c).map_or(c, |e| e.1)
}

/// `lower(text)`: every character mapped on its own (the libc provider has no multi-character mappings).
pub(crate) fn pg_lower(text: &str) -> String {
    text.chars().map(lower_char).collect()
}

/// `btrim(text)`: strips the space character (U+0020) only, never other whitespace.
pub(crate) fn btrim(text: &str) -> &str {
    text.trim_matches(' ')
}

/// The `[[:space:]]` class: 9-13, 32, 133, 8192-8198, 8200-8202, 8232, 8233, 8287 and 12288.
/// Unlike JavaScript's `\s` it holds U+0085 and not U+00A0, U+1680, U+2007, U+202F or U+FEFF.
pub(crate) fn is_pg_space(c: char) -> bool {
    matches!(
        c as u32,
        9..=13 | 32 | 133 | 8192..=8198 | 8200..=8202 | 8232 | 8233 | 8287 | 12288
    )
}

/// Does text character `t` match pattern character `p`? Case-sensitive: equality. Case-insensitive
/// (`~*`): `t` is `lower(p)` or `upper(p)`. The text is not folded, and a title-case pattern
/// character (U+01C5, U+01C8, U+01CB, U+01F2) does not match itself.
pub(crate) fn regex_char_matches(p: char, t: char, case_sensitive: bool) -> bool {
    if case_sensitive {
        return p == t;
    }
    match case_entry(p) {
        Some((lower, upper)) => t == lower || t == upper,
        None => t == p,
    }
}

/// `text LIKE '%' || needle || '%'` (`ILIKE` when not case sensitive: both sides lowered per character).
pub(crate) fn like_contains(text: &str, needle: &str, case_sensitive: bool) -> bool {
    if case_sensitive {
        text.contains(needle)
    } else {
        pg_lower(text).contains(&pg_lower(needle))
    }
}

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
            for (i, (key, item)) in crate::jsonb::sorted_entries(map).into_iter().enumerate() {
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

/// A JSON value as jsonb stores it: object keys in jsonb order, at every depth
/// ([`crate::jsonb::ordered`]).
pub(crate) fn jsonb_value(value: &Value) -> Value {
    crate::jsonb::ordered(value)
}

/// `frontmatter ->> key`: the string itself, the jsonb text of any other value, `None` for a
/// missing key or JSON null.
pub(crate) fn fm_text(frontmatter: &Map<String, Value>, key: &str) -> Option<String> {
    match frontmatter.get(key)? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(jsonb_text(other)),
    }
}

/// `frontmatter -> key`: the value in jsonb form, JSON null for a missing key.
pub(crate) fn fm_value(frontmatter: &Map<String, Value>, key: &str) -> Value {
    frontmatter
        .get(key)
        .map_or(Value::Null, |v| crate::jsonb::order(v.clone()))
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
    fn lower_and_upper_follow_the_pglite_table() {
        assert_eq!(pg_lower("ÀÉÎ ABC ΣΑ İ"), "àéî abc σα i");
        // Rust's own tables differ: U+1E9E upper of ß, Ⓐ has no lower in PGLite.
        assert_eq!(upper_char('ß'), '\u{1E9E}');
        assert_eq!(lower_char('\u{24B6}'), '\u{24B6}');
        assert_eq!(upper_char('\u{1F80}'), '\u{1F88}');
        assert_eq!(lower_char('\u{212A}'), 'k');
    }

    #[test]
    fn case_insensitive_regex_does_not_fold_the_text() {
        assert!(!regex_char_matches('k', '\u{212A}', false));
        assert!(regex_char_matches('\u{212A}', 'k', false));
        assert!(!regex_char_matches('i', 'İ', false));
        assert!(regex_char_matches('İ', 'i', false));
        assert!(!regex_char_matches('\u{1C5}', '\u{1C5}', false));
        assert!(regex_char_matches('\u{1C5}', '\u{1C6}', false));
        assert!(regex_char_matches('\u{1C5}', '\u{1C4}', false));
        assert!(!regex_char_matches('s', 'ſ', false));
        assert!(regex_char_matches('a', 'A', false));
        assert!(!regex_char_matches('a', 'A', true));
    }

    #[test]
    fn ilike_lowers_both_sides() {
        assert!(like_contains("the \u{212A}ey", "key", false));
        assert!(!like_contains("the \u{212A}ey", "key", true));
        assert!(like_contains("a 50%_off", "50%_", true));
    }

    #[test]
    fn space_class_and_btrim() {
        assert!(is_pg_space('\u{85}'));
        assert!(!is_pg_space('\u{A0}'));
        assert!(!is_pg_space('\u{FEFF}'));
        assert_eq!(btrim("\t a \n"), "\t a \n");
        assert_eq!(btrim("  a b  "), "a b");
    }

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
        let fm = json!({"s": "plain", "n": null, "k": 5})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(fm_text(&fm, "s").as_deref(), Some("plain"));
        assert_eq!(fm_text(&fm, "n"), None);
        assert_eq!(fm_text(&fm, "k").as_deref(), Some("5"));
        assert_eq!(fm_text(&fm, "missing"), None);
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
