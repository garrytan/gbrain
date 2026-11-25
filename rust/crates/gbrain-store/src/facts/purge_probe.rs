//! The rows a purge verification's inventory probe searches in the stores the probe reads whole tables of
//! (`countPurgeProbe` on a `probed_reported` inventory table, src/core/deletion-inventory.ts). Each owning module
//! returns its rows as [`ProbeRow`]s: the row's `source_id` (when the table has one) and each probed column as the
//! text Postgres prints for `col::text`, or the raw bytes of a `bytea` column. `purge_plan.rs` matches the needles.

use crate::cli_reads::pg_text::jsonb_text;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use serde::de::DeserializeOwned;
use serde_json::Value;

/// One probed column of a row.
pub(crate) enum ProbeCell {
    /// SQL NULL: matches no needle.
    Null,
    /// The column as `col::text` prints it.
    Text(String),
    /// A `bytea` column: matched byte for byte.
    Bytes(Vec<u8>),
}

impl ProbeCell {
    pub(crate) fn text(text: &str) -> Self {
        ProbeCell::Text(text.to_string())
    }

    pub(crate) fn opt_text(text: Option<&str>) -> Self {
        text.map_or(ProbeCell::Null, ProbeCell::text)
    }

    /// A `jsonb` column: the text Postgres prints for it.
    pub(crate) fn jsonb(value: &Value) -> Self {
        ProbeCell::Text(jsonb_text(value))
    }

    pub(crate) fn opt_jsonb(value: Option<&Value>) -> Self {
        value.map_or(ProbeCell::Null, ProbeCell::jsonb)
    }

    /// A `jsonb` column the store keeps as JSON text: printed as Postgres prints the parsed value.
    pub(crate) fn opt_jsonb_text(text: Option<&str>) -> Self {
        match text {
            None => ProbeCell::Null,
            Some(t) => serde_json::from_str::<Value>(t)
                .map_or_else(|_| ProbeCell::text(t), |v| ProbeCell::jsonb(&v)),
        }
    }

    /// A `text[]` column: Postgres's array literal (`{a,"b c"}`).
    pub(crate) fn text_array(items: &[String]) -> Self {
        ProbeCell::Text(array_literal(items))
    }
}

/// One row a probe searches.
pub(crate) struct ProbeRow {
    /// The row's `source_id`; `None` when the table has no such column.
    pub source_id: Option<String>,
    pub cells: Vec<(&'static str, ProbeCell)>,
}

/// Every record stored under `prefix`, decoded.
pub(crate) fn json_rows<T: DeserializeOwned>(read: &dyn KvRead, prefix: &[u8]) -> Result<Vec<T>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, prefix, false, &mut |_, v| {
        match serde_json::from_slice::<T>(v) {
            Ok(row) => out.push(row),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// `array_out` of a `text[]`: an element is double-quoted when it is empty, is `NULL` in any case, or holds a
/// brace, comma, quote, backslash or white space; inside quotes a quote or backslash is backslash-escaped.
fn array_literal(items: &[String]) -> String {
    let mut out = String::from("{");
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let quote = item.is_empty()
            || item.eq_ignore_ascii_case("null")
            || item.chars().any(|c| {
                matches!(
                    c,
                    '{' | '}' | ',' | '"' | '\\' | ' ' | '\t' | '\n' | '\r' | '\x0b' | '\x0c'
                )
            });
        if !quote {
            out.push_str(item);
            continue;
        }
        out.push('"');
        for c in item.chars() {
            if c == '"' || c == '\\' {
                out.push('\\');
            }
            out.push(c);
        }
        out.push('"');
    }
    out.push('}');
    out
}

/// Standard base64 (padding optional), as the jobs store keeps attachment bytes; `None` when it is not base64.
pub(crate) fn decode_base64(text: &str) -> Option<Vec<u8>> {
    fn value(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some(u32::from(c - b'A')),
            b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let body = text.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in body {
        acc = (acc << 6) | value(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// The rows of an inventory table this store probes whole; `None` for a table it does not probe this way.
pub(crate) fn table_rows(
    read: &dyn KvRead,
    table: &str,
    source_id: &str,
) -> Result<Option<Vec<ProbeRow>>> {
    Ok(Some(match table {
        "calibration_profiles" => {
            crate::eval_capture::calibration_profiles::purge_probe_rows(read)?
        }
        "decision_receipts" => crate::eval_capture::decide_store::purge_probe_receipt_rows(read)?,
        "dream_verdicts" => crate::dream::purge_probe_rows(read)?,
        "eval_candidates" => crate::eval_capture::purge_probe_rows(read)?,
        "eval_contradictions_cache" => crate::contradictions::purge_probe_cache_rows(read)?,
        "eval_contradictions_runs" => crate::contradictions::purge_probe_run_rows(read)?,
        "fact_relink_attempts" => super::relink::purge_probe_rows(read, source_id)?,
        "ingest_log" => crate::stats::purge_probe_rows(read)?,
        "mcp_request_log" => crate::telemetry::purge_probe_rows(read)?,
        "minion_attachments" => crate::jobs::purge_probe_attachment_rows(read)?,
        "minion_inbox" => crate::jobs::purge_probe_inbox_rows(read)?,
        "minion_jobs" => crate::jobs::purge_probe_job_rows(read)?,
        "persistence_topology_changes" => crate::persistence::purge_probe_topology_rows(read)?,
        "subagent_messages" => crate::jobs::purge_probe_message_rows(read)?,
        "subagent_tool_executions" => crate::jobs::purge_probe_tool_rows(read)?,
        _ => return Ok(None),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn array_literal_quotes_as_postgres_prints() {
        let items = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(array_literal(&[]), "{}");
        assert_eq!(array_literal(&items(&["a", "b"])), "{a,b}");
        assert_eq!(
            array_literal(&items(&["b c", "", "NuLL", "say \"hi\"", r"a\b", "x,y"])),
            r#"{"b c","","NuLL","say \"hi\"","a\\b","x,y"}"#
        );
    }

    #[test]
    fn base64_decodes_with_and_without_padding() {
        assert_eq!(decode_base64("aGk=").unwrap(), b"hi");
        assert_eq!(decode_base64("aGk").unwrap(), b"hi");
        assert_eq!(decode_base64("c2F5cyBoaQ==").unwrap(), b"says hi");
        assert!(decode_base64("a*b").is_none());
    }
}
