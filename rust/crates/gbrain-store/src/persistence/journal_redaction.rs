//! The journal statements of a page purge's sweep and intent redaction (src/core/engine-sql/page-purge-journal.ts):
//! the slug read, the sequence ceiling, one chunk of the carrying predicate, the request lock, the effect byte sum, the
//! redaction of one request row and the counter release.
//!
//! Text matching follows the SQL: `lower(COALESCE(x::text,''))` of a jsonb column is `pg_lower(jsonb_text(x))` (a SQL NULL, or
//! a value this store keeps as JSON null, is the empty text), `lower(COALESCE(error_message,''))` is `pg_lower(error_message)`,
//! and `strpos(text, needle) > 0` is `text.contains(needle)` (an empty needle matches). The needles are not lowered here: the
//! caller sends them lowercased, as the SQL does.
//!
//! A request keeps its source and slug, so every read is one scan of the request records (as the purge plan's journal reads
//! are). The writes are one store write transaction each, the one `redactRequestIntents` runs its statements in.

use super::{
    all_requests, effects, extra_bool, extra_is_null, jsonb_param, read_counter, request_by_id,
    uuid_param, write_counter,
};
use crate::Store;
use crate::cli_reads::pg_text::{jsonb_text, pg_lower};
use crate::error::{Result, StoreError};
use crate::journal::{RequestRecord, write_request};
use crate::links::no_nul;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

/// `(state IN ('queued','deferred','running','recovering') OR recovery IS NOT NULL)`.
const PENDING_STATES: [&str; 4] = ["queued", "deferred", "running", "recovering"];

/// `JournalChunkQuery` of `src/core/engine-sql/page-purge-journal.ts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SweepChunkArgs {
    pub source_id: String,
    pub needles: Vec<String>,
    pub after: String,
    pub ceiling: Option<String>,
    pub limit: i64,
    pub ids: Option<Vec<String>>,
    pub exclude: Option<String>,
}

/// `RequestRedaction` of `src/core/engine-sql/page-purge-journal.ts`: the outcome and error detail as JSON text (null: SQL NULL).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct RedactRequestArgs {
    pub id: String,
    pub terminal_reservation: i64,
    pub outcome: Option<String>,
    pub error_detail: Option<String>,
}

/// A `::bigint` parameter given as text: surrounding whitespace is allowed, anything else that is not an integer is refused.
fn bigint(op: &str, what: &str, text: &str) -> Result<i64> {
    text.trim().parse().map_err(|_| {
        StoreError::invalid(format!(
            "{op}: invalid input syntax for type bigint: \"{text}\" ({what})"
        ))
    })
}

fn limit_of(op: &str, limit: i64) -> Result<usize> {
    usize::try_from(limit)
        .map_err(|_| StoreError::invalid(format!("{op}: LIMIT must not be negative")))
}

/// `lower(COALESCE(x::text,''))` of an optional jsonb value.
fn lowered(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(v) => pg_lower(&jsonb_text(v)),
    }
}

fn target(r: &RequestRecord) -> Value {
    json!({ "id": r.id, "principal_kind": r.principal_kind, "principal_id": r.principal_id, "sequence": r.sequence.to_string() })
}

impl Store {
    /// `listRequestsForSlugs(sourceId, slugs, limit, after)`: `{ id, principal_kind, principal_id, sequence }` of the source's
    /// requests under one of the slugs that are not compacted and still hold an intent, with a sequence past `after`, by
    /// sequence (numerically), up to `limit`. Sequences are text.
    pub fn list_requests_for_slugs(
        &self,
        source_id: &str,
        slugs: &[String],
        limit: i64,
        after: &str,
    ) -> Result<Value> {
        const OP: &str = "listRequestsForSlugs";
        no_nul(OP, &[("sourceId", source_id)])?;
        for slug in slugs {
            no_nul(OP, &[("slugs", slug)])?;
        }
        let limit = limit_of(OP, limit)?;
        let after = bigint(OP, "after", after)?;
        let wanted: HashSet<&str> = slugs.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut rows: Vec<RequestRecord> = all_requests(&*read)?
            .into_iter()
            .filter(|r| {
                r.source_id == source_id
                    && wanted.contains(r.slug.as_str())
                    && !extra_bool(r, "compacted")
                    && !r.intent.is_null()
                    && i64::try_from(r.sequence).is_ok_and(|s| s > after)
            })
            .collect();
        rows.sort_by_key(|r| r.sequence);
        Ok(Value::Array(rows.iter().take(limit).map(target).collect()))
    }

    /// `readJournalCeiling(sourceId)`: the source's highest request sequence as text; null when it has no request.
    pub fn read_journal_ceiling(&self, source_id: &str) -> Result<Value> {
        no_nul("readJournalCeiling", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let top = all_requests(&*read)?
            .into_iter()
            .filter(|r| r.source_id == source_id)
            .map(|r| r.sequence)
            .max();
        Ok(top.map_or(Value::Null, |s| json!(s.to_string())))
    }

    /// `sweepJournalChunk(query)`: the source's requests with `after < sequence <= ceiling` (no upper bound when `ceiling` is
    /// null), among `ids` when given, but for `exclude`, by sequence, at most `limit`: the chunk. Of it, only the requests that
    /// match a needle or are still pending come back, with the 0-based indexes of the needles each carries (`hits`), plus the
    /// chunk's size (`scanned`) and last sequence (`last`, text; null for an empty chunk).
    pub fn sweep_journal_chunk(&self, q: &SweepChunkArgs) -> Result<Value> {
        const OP: &str = "sweepJournalChunk";
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        for needle in &q.needles {
            no_nul(OP, &[("needles", needle)])?;
        }
        let after = bigint(OP, "after", &q.after)?;
        let ceiling = q
            .ceiling
            .as_deref()
            .map(|c| bigint(OP, "ceiling", c))
            .transpose()?;
        let limit = limit_of(OP, q.limit)?;
        let ids = q
            .ids
            .as_ref()
            .map(|ids| {
                ids.iter()
                    .map(|id| uuid_param(id, "ids"))
                    .collect::<Result<HashSet<String>>>()
            })
            .transpose()?;
        let exclude = q
            .exclude
            .as_deref()
            .map(|e| uuid_param(e, "exclude"))
            .transpose()?;
        let read = self.read()?;
        let mut chunk: Vec<RequestRecord> = all_requests(&*read)?
            .into_iter()
            .filter(|r| {
                r.source_id == q.source_id
                    && i64::try_from(r.sequence)
                        .is_ok_and(|s| s > after && ceiling.is_none_or(|c| s <= c))
                    && ids.as_ref().is_none_or(|ids| ids.contains(&r.id))
                    && exclude.as_ref().is_none_or(|e| &r.id != e)
            })
            .collect();
        chunk.sort_by_key(|r| r.sequence);
        chunk.truncate(limit);
        let rows: Vec<Value> = chunk
            .iter()
            .filter_map(|r| {
                let texts = [
                    lowered(Some(&r.intent)),
                    lowered(r.outcome.as_ref()),
                    lowered(r.extra.get("error_detail")),
                    r.error_message.as_deref().map(pg_lower).unwrap_or_default(),
                ];
                let hits: Vec<usize> = q
                    .needles
                    .iter()
                    .enumerate()
                    .filter(|(_, n)| texts.iter().any(|t| t.contains(n.as_str())))
                    .map(|(i, _)| i)
                    .collect();
                let pending =
                    PENDING_STATES.contains(&r.state.as_str()) || !extra_is_null(r, "recovery");
                (!hits.is_empty() || pending).then(|| {
                    json!({
                        "id": r.id,
                        "principal_kind": r.principal_kind,
                        "principal_id": r.principal_id,
                        "sequence": r.sequence.to_string(),
                        "pending": pending,
                        "matched": !hits.is_empty(),
                        "hits": hits,
                    })
                })
            })
            .collect();
        Ok(json!({
            "rows": rows,
            "scanned": chunk.len(),
            "last": chunk.last().map_or(Value::Null, |r| json!(r.sequence.to_string())),
        }))
    }

    /// `readEffectBytes(requestId)`: the bytes the request's effect rows hold on its receipt (kind, data and the 1 KiB
    /// each carries); 0 when it has none.
    pub fn read_effect_bytes(&self, request_id: &str) -> Result<i64> {
        let id = uuid_param(request_id, "readEffectBytes requestId")?;
        Ok(effects::effect_totals(&*self.read()?, &id)?.0)
    }

    /// `redactWriteRequestRow({ id, terminalReservation, outcome, errorDetail })`: the request's intent and error message removed,
    /// marked compacted, its terminal reservation, outcome and error detail replaced. Nothing changes for an id no request has.
    pub fn redact_write_request_row(&self, a: &RedactRequestArgs) -> Result<()> {
        let id = uuid_param(&a.id, "redactWriteRequestRow id")?;
        let outcome = jsonb_param(&a.outcome, "redactWriteRequestRow outcome")?;
        let detail = jsonb_param(&a.error_detail, "redactWriteRequestRow errorDetail")?;
        self.write(|tx| {
            let Some(mut record) = request_by_id(&*tx, &id)? else {
                return Ok(());
            };
            record.intent = Value::Null;
            record.error_message = None;
            record.outcome = outcome.as_ref().map(crate::jsonb::ordered);
            record.extra.insert("compacted".into(), json!(true));
            record
                .extra
                .insert("terminal_reservation".into(), json!(a.terminal_reservation));
            record.extra.insert(
                "error_detail".into(),
                detail.as_ref().map_or(Value::Null, crate::jsonb::ordered),
            );
            write_request(tx, &record)
        })
    }

    /// `releaseTerminalBytes(key, bytes)`: the counter's `terminal_bytes` less `LEAST(bytes, terminal_bytes)`. Nothing changes
    /// for a key no counter has.
    pub fn release_terminal_bytes(&self, key: &str, bytes: i64) -> Result<()> {
        self.write(|tx| {
            let Some(mut counter) = read_counter(&*tx, key)? else {
                return Ok(());
            };
            counter.terminal_bytes = counter
                .terminal_bytes
                .checked_sub(bytes.min(counter.terminal_bytes))
                .ok_or_else(|| {
                    StoreError::invalid(
                        "releaseTerminalBytes: a byte count is out of range for type bigint",
                    )
                })?;
            write_counter(tx, key, &counter)
        })
    }
}
