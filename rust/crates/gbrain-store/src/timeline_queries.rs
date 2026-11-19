//! Timeline reads by date and event projections. Nothing is built yet: every member below still
//! refuses with `engine_capability_missing` in the TypeScript engine.
//!
//! Members: getTimelineForDate, getSince, getOnThisDay, getLastSeen, upsertEventProjection.
//!
//! Keys: every record of this family starts with `keys::TIMELINE_QUERIES` (`u`). The bytes after
//! the tag are this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.

use crate::Result;
use crate::kv::KvWrite;
use serde_json::Value;

/// `ON DELETE CASCADE` of `timeline_entries.event_page_id`: deletes every timeline entry, on any
/// page, whose `event_page_id` is the page being hard deleted. `pages::remove_page` calls it.
/// Empty until this family stores event projections.
pub(crate) fn remove_event_projections(_tx: &mut dyn KvWrite, _event_page_id: u64) -> Result<()> {
    Ok(())
}

/// The text form Postgres gives a `jsonb` value: `{"a": 1, "b": [1, 2]}`, object keys ordered
/// by length and then bytes, as jsonb stores them.
pub(crate) fn jsonb_text(value: &Value) -> String {
    let mut out = String::new();
    write_jsonb(value, &mut out);
    out
}

fn write_jsonb(value: &Value, out: &mut String) {
    match value {
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
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| (a.len(), a.as_bytes()).cmp(&(b.len(), b.as_bytes())));
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push_str(": ");
                write_jsonb(&map[key], out);
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// `->>`: a string's contents, any other value's jsonb text, and SQL NULL for JSON null.
pub(crate) fn jsonb_field_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(jsonb_text(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn jsonb_text_orders_keys_by_length_then_bytes() {
        let value = json!({"bb": 1, "a": [1, "x", null], "c": {"zz": true, "y": false}});
        assert_eq!(
            jsonb_text(&value),
            r#"{"a": [1, "x", null], "c": {"y": false, "zz": true}, "bb": 1}"#
        );
        assert_eq!(jsonb_field_text(&json!("plain")), Some("plain".into()));
        assert_eq!(jsonb_field_text(&json!(null)), None);
        assert_eq!(jsonb_field_text(&json!(2.5)), Some("2.5".into()));
    }
}
