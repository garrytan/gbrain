//! The rows a purge verification's inventory probe searches in the stores the probe reads whole tables of
//! (`countPurgeProbe` on an inventory table, src/core/deletion-inventory.ts). Each owning module
//! returns its rows as [`ProbeRow`]s: the row's `source_id` (when the table has one) and each probed column as the
//! text Postgres prints for `col::text`, or the raw bytes of a `bytea` column. `purge_plan.rs` matches the needles.
//!
//! Two ways to read them. [`table_rows`] returns every row of a table at once (the probed-and-reported stores). The swept
//! stores a fact purge's receipt probes (the ledger, files, loops, aliases, holds, proposals and the segmented-body stores)
//! go through [`for_each_table_row`], which hands each row to the probe as the scan reaches it, so a count that has reached its
//! bound leaves the later entries unread. A column the store does not keep reads as NULL, which matches no needle.

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

    /// A `bytea` column printed as text: `\x` and the lowercase hex of its bytes.
    pub(crate) fn bytea_hex(hex: &str) -> Self {
        ProbeCell::Text(format!("\\x{}", hex.to_ascii_lowercase()))
    }

    pub(crate) fn opt_bytea_hex(hex: Option<&str>) -> Self {
        hex.map_or(ProbeCell::Null, ProbeCell::bytea_hex)
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

/// Calls `f` with the key and the decoded record of each entry under `prefix`, in key order, until it returns false or fails.
/// The records are decoded as the scan reaches them, so a stop leaves the later ones unread.
pub(crate) fn each_json<T: DeserializeOwned>(
    read: &dyn KvRead,
    prefix: &[u8],
    f: &mut dyn FnMut(&[u8], T) -> Result<bool>,
) -> Result<()> {
    let mut failure = None;
    scan_prefix(read, prefix, false, &mut |k, v| {
        let step = serde_json::from_slice::<T>(v)
            .map_err(StoreError::from)
            .and_then(|record| f(k, record));
        match step {
            Ok(more) => more,
            Err(e) => {
                failure = Some(e);
                false
            }
        }
    })?;
    failure.map_or(Ok(()), Err)
}

/// What a streamed probe hands each row to: false stops the scan.
pub(crate) type EachRow<'a> = &'a mut dyn FnMut(ProbeRow) -> Result<bool>;

/// Hands each row of `table` to `f` as the scan reaches it, until `f` returns false. `source_id` is the probe's source: a store
/// keyed by it scans only its rows. False when this store does not stream `table` (the caller reads it another way).
pub(crate) fn for_each_table_row(
    read: &dyn KvRead,
    table: &str,
    source_id: &str,
    f: EachRow,
) -> Result<bool> {
    match table {
        "derived_generations" => crate::generations::probe_generations(read, f)?,
        "derived_generation_items" => crate::generations::probe_items(read, f)?,
        "files" => crate::raw_files::probe_files(read, f)?,
        "open_loops" => super::loops::probe_loops(read, f)?,
        "page_aliases" => crate::aliases::probe_page_aliases(read, source_id, f)?,
        "page_body_manifest" => crate::page_body::purge_probe::probe_manifest(read, f)?,
        "page_body_stagings" => crate::page_body::purge_probe::probe_stagings(read, f)?,
        "page_body_staging_texts" => crate::page_body::purge_probe::probe_staging_texts(read, f)?,
        "page_segment_texts" => crate::page_body::purge_probe::probe_texts(read, source_id, f)?,
        "page_segment_derivations" => crate::page_body::purge_probe::probe_derivations(read, f)?,
        "page_segment_derivation_purges" => crate::page_body::purge_record::probe_records(read, f)?,
        "persistence_effects" => crate::persistence::effects::probe_effects(read, f)?,
        "belief_events" => crate::trust::belief_events::probe_events(read, source_id, f)?,
        "trust_proposals" => crate::trust::proposals::probe_proposals(read, f)?,
        "write_gate_holds" => crate::trust::write_gate::probe_holds(read, f)?,
        _ => return Ok(false),
    }
    Ok(true)
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
        "mention_gazetteer_entries" => crate::mention_state::purge_probe_rows(read)?,
        "minion_attachments" => crate::jobs::purge_probe_attachment_rows(read)?,
        "minion_inbox" => crate::jobs::purge_probe_inbox_rows(read)?,
        "minion_jobs" => crate::jobs::purge_probe_job_rows(read)?,
        "pinned_questions" => crate::jobs::purge_probe_pin_rows(read)?,
        "context_volunteer_events" => crate::volunteer_events::purge_probe_rows(read)?,
        "persistence_topology_changes" => crate::persistence::purge_probe_topology_rows(read)?,
        "subagent_messages" => crate::jobs::purge_probe_message_rows(read)?,
        "subagent_tool_executions" => crate::jobs::purge_probe_tool_rows(read)?,
        _ => return Ok(None),
    }))
}

/// Test helpers of the streamed probes.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// Runs `probe`, collecting each row it is handed as `source|name=value;...` (`-` for a row without a source, `NULL` for a NULL
    /// cell), and stopping the scan once `limit` rows are in.
    pub(crate) fn render(limit: usize, probe: impl FnOnce(EachRow) -> Result<()>) -> Vec<String> {
        let mut out = Vec::new();
        probe(&mut |row: ProbeRow| {
            let cells: Vec<String> = row
                .cells
                .iter()
                .map(|(name, cell)| {
                    let value = match cell {
                        ProbeCell::Null => "NULL".to_string(),
                        ProbeCell::Text(t) => t.clone(),
                        ProbeCell::Bytes(b) => format!("bytes:{}", String::from_utf8_lossy(b)),
                    };
                    format!("{name}={value}")
                })
                .collect();
            out.push(format!(
                "{}|{}",
                row.source_id.as_deref().unwrap_or("-"),
                cells.join(";")
            ));
            Ok(out.len() < limit)
        })
        .unwrap();
        out
    }
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

    fn effect(
        id: i64,
        source: Option<&str>,
        data: &str,
    ) -> crate::persistence::effects::EffectRecord {
        serde_json::from_value(serde_json::json!({
            "id": id, "request_id": format!("b0000000-0000-4000-8000-{id:012}"), "kind": "git",
            "revision": null, "data": { "note": data }, "state": "queued", "execution_token": null,
            "updated_at_us": 0, "source_id": source, "source_incarnation": null, "worktree_id": null,
            "claim_expires_at_us": null, "next_attempt_at_us": 0, "attempts": 0, "error_code": null,
            "recovery_bytes": 0,
        }))
        .unwrap()
    }

    #[test]
    fn the_effect_queue_streams_a_page_at_a_time_and_a_stop_leaves_the_rest_unread() {
        use super::test_support::render;
        use crate::kv::counting::Counting;
        let mut store = Counting::default();
        let effects: Vec<_> = (1..=40)
            .map(|id| effect(id, Some("default"), "removes notes/doomed"))
            .chain([effect(41, None, "no source")])
            .collect();
        store
            .entries
            .extend(crate::persistence::effects::effect_entries_for_test(
                &effects,
            ));
        let rows = render(usize::MAX, |f| {
            crate::persistence::effects::probe_effects(&store, f)
        });
        assert_eq!(rows.len(), 41);
        assert!(rows[0].starts_with("default|kind=git;data={\"note\": \"removes notes/doomed\"};state=queued;source_id=default;error_code=NULL;outcome=NULL"), "{}", rows[0]);
        assert!(
            rows[40].starts_with("-|"),
            "a NULL source belongs to no source"
        );
        store.delivered.set(0);
        store.gets.set(0);
        assert_eq!(
            render(1, |f| crate::persistence::effects::probe_effects(&store, f)).len(),
            1
        );
        // One index page of 8 entries, and the one record whose turn came.
        assert_eq!((store.delivered.get(), store.gets.get()), (8, 1));
    }

    #[test]
    fn a_streamed_table_stops_when_its_probe_does_and_an_unknown_table_is_not_streamed() {
        use crate::kv::counting::Counting;
        let mut store = Counting::default();
        for n in 0..50 {
            let file = crate::raw_files::FileRecord {
                id: n,
                source_id: "default".into(),
                page_slug: None,
                page_id: None,
                filename: format!("f{n}.png"),
                storage_path: format!("p/{n:03}.png"),
                mime_type: None,
                size_bytes: None,
                content_hash: "h".into(),
                metadata: serde_json::json!({}),
                created_at_us: 0,
            };
            let mut key = vec![crate::keys::RAW_FILES, 0x02];
            key.extend_from_slice(file.storage_path.as_bytes());
            store
                .entries
                .insert(key, serde_json::to_vec(&file).unwrap());
        }
        let mut seen = 0;
        assert!(
            for_each_table_row(&store, "files", "default", &mut |_| {
                seen += 1;
                Ok(seen < 3)
            })
            .unwrap()
        );
        assert_eq!((seen, store.delivered.get()), (3, 3));
        let mut none = |_: ProbeRow| Ok(true);
        assert!(!for_each_table_row(&store, "minion_jobs", "default", &mut none).unwrap());
        assert!(!for_each_table_row(&store, "retrieval_feedback", "default", &mut none).unwrap());
    }

    #[test]
    fn base64_decodes_with_and_without_padding() {
        assert_eq!(decode_base64("aGk=").unwrap(), b"hi");
        assert_eq!(decode_base64("aGk").unwrap(), b"hi");
        assert_eq!(decode_base64("c2F5cyBoaQ==").unwrap(), b"says hi");
        assert!(decode_base64("a*b").is_none());
    }
}
