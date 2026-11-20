//! Captured eval candidates and capture failures: the `eval_candidates` and
//! `eval_capture_failures` tables of the PGLite engine.
//!
//! Members: logEvalCandidate, listEvalCandidates, deleteEvalCandidatesBefore,
//! logEvalCaptureFailure, listEvalCaptureFailures. The decide proposal tables share this key tag:
//! `decide_proposals.rs` (rust/docs/store/decide-proposals.md).
//!
//! Keys (every record starts with `keys::EVAL_CAPTURE`, `Z`):
//! - `Z 0x01 <candidate id u64 BE>` -> `CandidateRecord` (JSON).
//! - `Z 0x02 <failure id u64 BE>` -> `FailureRecord` (JSON).
//! - Id counters: `M next_eval_candidate_id`, `M next_eval_failure_id`.
//! - `Z 0x20` and `Z 0x21`: the `calibration_profiles` table, a child module
//!   (`eval_capture/calibration_profiles.rs`, rust/docs/store/calibration-profiles.md).
//! - `Z 0x30..=0x3F`: the decide proposal tables (`decide_proposals.rs`): sub-tags 0x30, 0x31, 0x32,
//!   0x38, 0x39, 0x3C and 0x3D.
//! - Sub-tags `0x10..=0x1F` belong to the decide store ([`decide_store`], rust/docs/store/decide-store.md):
//!   `0x10` state, `0x11` spend, `0x12` spend time index, `0x13` receipts, `0x14` receipt time index,
//!   `0x15` calibrations.
//!
//! Both tables are small logs read whole: the list members scan every record of their table,
//! filter, and sort `created_at DESC, id DESC` (candidates) or `ts DESC, id DESC` (failures).
//! Postgres orders failures by `ts DESC` alone; ties are rare (microsecond stamps) and this
//! engine breaks them by `id DESC`.
//!
//! Page deletes do not cascade here (no foreign key). `deletePages` and `purgeDeletedPages`
//! (page_ops) call `remove_retrieved_slugs` to strip the deleted slugs from
//! `retrieved_slugs`, as PGLite's `scrubPurgedSlugs` does.
//!
//! A captured `facts/<id>` slug (`^facts/[0-9]{1,18}$`) is kept while that fact row exists in
//! one of the candidate's sources (any source when it names none), as PGLite does: an expired,
//! superseded or consolidated fact, or one whose page is soft-deleted, still counts
//! (`facts::fact_exists`).

pub mod calibration_profiles;
pub mod decide_store;

use crate::env::{iso, parse_iso};
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::facts::fact_exists;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::{next_id, read_page, scope_sources};
use crate::{Store, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub mod decide_proposals;

const NEXT_CANDIDATE_ID: &str = "next_eval_candidate_id";
const NEXT_FAILURE_ID: &str = "next_eval_failure_id";
const CANDIDATE: u8 = 0x01;
const FAILURE: u8 = 0x02;

/// `CHECK (length(query) <= 51200)`, in characters.
const MAX_QUERY_CHARS: usize = 51_200;
/// `listEvalCandidates` without a usable limit.
const DEFAULT_LIST_LIMIT: usize = 1000;
/// The cap `listEvalCandidates` puts on any limit.
const MAX_LIST_LIMIT: usize = 100_000;
const TOOLS: [&str; 2] = ["query", "search"];
const DETAILS: [&str; 3] = ["low", "medium", "high"];
const REASONS: [&str; 5] = [
    "db_down",
    "rls_reject",
    "check_violation",
    "scrubber_exception",
    "other",
];

fn record_key(kind: u8, id: u64) -> Vec<u8> {
    let mut key = vec![keys::EVAL_CAPTURE, kind];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn table_prefix(kind: u8) -> [u8; 2] {
    [keys::EVAL_CAPTURE, kind]
}

/// One `eval_candidates` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CandidateRecord {
    pub id: u64,
    pub tool_name: String,
    pub query: String,
    /// Only slugs a page held at capture time, in retrieval order.
    pub retrieved_slugs: Vec<String>,
    /// `INTEGER[]`: no foreign key, so chunk deletes leave it alone. Null elements are kept.
    pub retrieved_chunk_ids: Vec<Option<i32>>,
    pub source_ids: Vec<Option<String>>,
    #[serde(default)]
    pub expand_enabled: Option<bool>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub detail_resolved: Option<String>,
    pub vector_enabled: bool,
    pub expansion_applied: bool,
    pub latency_ms: i32,
    pub remote: bool,
    #[serde(default)]
    pub job_id: Option<i32>,
    #[serde(default)]
    pub subagent_id: Option<i32>,
    pub created_at_us: i64,
    #[serde(default)]
    pub embedding_column: Option<String>,
}

impl CandidateRecord {
    /// The `SELECT *` row. The columns no writer of this engine sets (`as_of_ts`,
    /// `schema_pack_per_source` and the salience/recency columns) are null, as they are for every
    /// row `logEvalCandidate` inserts.
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "tool_name": self.tool_name,
            "query": self.query,
            "retrieved_slugs": self.retrieved_slugs,
            "retrieved_chunk_ids": self.retrieved_chunk_ids,
            "source_ids": self.source_ids,
            "expand_enabled": self.expand_enabled,
            "detail": self.detail,
            "detail_resolved": self.detail_resolved,
            "vector_enabled": self.vector_enabled,
            "expansion_applied": self.expansion_applied,
            "latency_ms": self.latency_ms,
            "remote": self.remote,
            "job_id": self.job_id,
            "subagent_id": self.subagent_id,
            "created_at": iso(self.created_at_us),
            "as_of_ts": Value::Null,
            "salience_param": Value::Null,
            "recency_param": Value::Null,
            "salience_resolved": Value::Null,
            "recency_resolved": Value::Null,
            "salience_source": Value::Null,
            "recency_source": Value::Null,
            "embedding_column": self.embedding_column,
            "schema_pack_per_source": Value::Null,
        })
    }
}

/// One `eval_capture_failures` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct FailureRecord {
    pub id: u64,
    pub ts_us: i64,
    pub reason: String,
}

impl FailureRecord {
    fn to_json(&self) -> Value {
        json!({ "id": self.id, "ts": iso(self.ts_us), "reason": self.reason })
    }
}

/// `EvalCandidateInput`. Every field is optional here so a missing one fails as Postgres
/// fails it (a `NOT NULL` column refuses with `constraint_violation`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct EvalCandidateInput {
    pub tool_name: Option<String>,
    pub query: Option<String>,
    pub retrieved_slugs: Option<Vec<Option<String>>>,
    pub retrieved_chunk_ids: Option<Vec<Value>>,
    pub source_ids: Option<Vec<Option<String>>>,
    pub expand_enabled: Option<bool>,
    pub detail: Option<String>,
    pub detail_resolved: Option<String>,
    pub vector_enabled: Option<bool>,
    pub expansion_applied: Option<bool>,
    pub latency_ms: Option<Value>,
    pub remote: Option<bool>,
    pub job_id: Option<Value>,
    pub subagent_id: Option<Value>,
    pub embedding_column: Option<String>,
}

/// The filter of `listEvalCandidates`. `since` is an ISO timestamp.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ListEvalCandidatesOptions {
    pub since: Option<String>,
    pub limit: Option<f64>,
    pub tool: Option<String>,
}

/// The filter of `listEvalCaptureFailures`. `since` is an ISO timestamp.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ListEvalCaptureFailuresOptions {
    pub since: Option<String>,
}

fn not_null(table: &str, column: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "null value in column \"{column}\" of relation \"{table}\" violates not-null constraint"
        ),
    )
}

fn check_failed(table: &str, column: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "new row for relation \"{table}\" violates check constraint \"{table}_{column}_check\""
        ),
    )
}

/// An `INTEGER` parameter: null stays null; a whole number inside `i32` is the value; anything
/// else is `invalid_argument`, as Postgres refuses it before the row is built.
fn int4(value: &Value, column: &str) -> Result<Option<i32>> {
    let refused = || {
        StoreError::invalid(format!(
            "logEvalCandidate: {column} must be an integer in the int4 range, got {value}"
        ))
    };
    match value {
        Value::Null => Ok(None),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                return i32::try_from(i).map(Some).map_err(|_| refused());
            }
            let f = n.as_f64().ok_or_else(refused)?;
            if f.fract() != 0.0 || f < f64::from(i32::MIN) || f > f64::from(i32::MAX) {
                return Err(refused());
            }
            // Whole and in range, so the cast is exact.
            Ok(Some(f as i32))
        }
        _ => Err(refused()),
    }
}

/// An ISO timestamp argument (what `Date#toISOString` gives), as microseconds.
fn timestamp(text: &str, what: &str) -> Result<i64> {
    parse_iso(text).ok_or_else(|| {
        StoreError::invalid(format!(
            "{what}: invalid input syntax for type timestamp with time zone: \"{text}\""
        ))
    })
}

fn read_all<T: serde::de::DeserializeOwned>(read: &dyn KvRead, kind: u8) -> Result<Vec<T>> {
    let mut raw = Vec::new();
    scan_prefix(read, &table_prefix(kind), false, &mut |_, v| {
        raw.push(v.to_vec());
        true
    })?;
    raw.iter()
        .map(|v| serde_json::from_slice(v).map_err(StoreError::from))
        .collect()
}

/// Whether some page named `slug` lives in one of `sources` (any source when `sources` is
/// empty). Soft-deleted pages count: the PGLite probe has no `deleted_at` filter.
fn page_held(read: &dyn KvRead, slug: &str, sources: &[String]) -> Result<bool> {
    let scope = scope_sources(read, &None, &Some(sources.to_vec()))?;
    for source in scope {
        if read_page(read, &source, slug)?.is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The fact id a facts-arm slug names: `^facts/[0-9]{1,18}$` (18 digits always fit a `u64`).
fn fact_slug_id(slug: &str) -> Option<u64> {
    let digits = slug.strip_prefix("facts/")?;
    if digits.is_empty() || digits.len() > 18 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// The `eval_candidates.retrieved_slugs` scrub of PGLite's `scrubPurgedSlugs`, run by page_ops
/// in the delete's transaction, after the pages of `source_id` named by `slugs` are gone.
///
/// A candidate is touched when `source_id` is one of its `source_ids` and one of its retrieved
/// slugs is purged: the slug is in `slugs` and no page by that name lives in another source the
/// candidate covers. Purged slugs leave the array; the rest keep their order. Returns the number
/// of candidates updated. A candidate with no `source_ids` is never touched (as in PGLite, where
/// `$1 = ANY('{}')` is false), even though its capture matched pages in every source.
// page_ops (`deletePages`, `purgeDeletedPages`) is its caller; until that lands only tests call it.
#[allow(dead_code)]
pub(crate) fn remove_retrieved_slugs(
    tx: &mut dyn KvWrite,
    source_id: &str,
    slugs: &[String],
) -> Result<u64> {
    if slugs.is_empty() {
        return Ok(0);
    }
    let candidates: Vec<CandidateRecord> = read_all(&*tx, CANDIDATE)?;
    let mut updated = 0u64;
    for mut candidate in candidates {
        if !candidate
            .source_ids
            .iter()
            .any(|s| s.as_deref() == Some(source_id))
        {
            continue;
        }
        let others: Vec<&str> = candidate
            .source_ids
            .iter()
            .filter_map(|s| s.as_deref())
            .filter(|s| *s != source_id)
            .collect();
        let mut kept = Vec::with_capacity(candidate.retrieved_slugs.len());
        let mut changed = false;
        for slug in &candidate.retrieved_slugs {
            let purged = slugs.iter().any(|s| s == slug) && {
                let mut elsewhere = false;
                for other in &others {
                    if read_page(&*tx, other, slug)?.is_some() {
                        elsewhere = true;
                        break;
                    }
                }
                !elsewhere
            };
            if purged {
                changed = true;
            } else {
                kept.push(slug.clone());
            }
        }
        if changed {
            candidate.retrieved_slugs = kept;
            put_json(tx, &record_key(CANDIDATE, candidate.id), &candidate)?;
            updated += 1;
        }
    }
    Ok(updated)
}

impl Store {
    /// `logEvalCandidate(input)`: inserts one candidate and returns its id. `retrieved_slugs`
    /// keeps, in order, only the slugs a page of `source_ids` holds (any source when it names
    /// none). The `CHECK` and `NOT NULL` constraints of the table refuse with
    /// `constraint_violation`; a NUL byte or a non-integer number with `invalid_argument`.
    pub fn log_eval_candidate(&self, input: &EvalCandidateInput) -> Result<u64> {
        const TABLE: &str = "eval_candidates";
        let mut texts: Vec<(&str, &str)> = Vec::new();
        for (name, value) in [
            ("tool_name", &input.tool_name),
            ("query", &input.query),
            ("detail", &input.detail),
            ("detail_resolved", &input.detail_resolved),
            ("embedding_column", &input.embedding_column),
        ] {
            if let Some(text) = value.as_deref() {
                texts.push((name, text));
            }
        }
        for list in [&input.retrieved_slugs, &input.source_ids] {
            for text in list.iter().flatten().flatten() {
                texts.push(("array element", text));
            }
        }
        no_nul("logEvalCandidate", &texts)?;
        let chunk_ids = match &input.retrieved_chunk_ids {
            Some(ids) => Some(
                ids.iter()
                    .map(|v| int4(v, "retrieved_chunk_ids"))
                    .collect::<Result<Vec<_>>>()?,
            ),
            None => None,
        };
        let latency = match &input.latency_ms {
            Some(v) => int4(v, "latency_ms")?,
            None => None,
        };
        let job_id = match &input.job_id {
            Some(v) => int4(v, "job_id")?,
            None => None,
        };
        let subagent_id = match &input.subagent_id {
            Some(v) => int4(v, "subagent_id")?,
            None => None,
        };

        // Constraints, in column order (Postgres reports the first failing column).
        let tool_name = input
            .tool_name
            .clone()
            .ok_or_else(|| not_null(TABLE, "tool_name"))?;
        if !TOOLS.contains(&tool_name.as_str()) {
            return Err(check_failed(TABLE, "tool_name"));
        }
        let query = input
            .query
            .clone()
            .ok_or_else(|| not_null(TABLE, "query"))?;
        if query.chars().count() > MAX_QUERY_CHARS {
            return Err(check_failed(TABLE, "query"));
        }
        let chunk_ids = chunk_ids.ok_or_else(|| not_null(TABLE, "retrieved_chunk_ids"))?;
        let source_ids = input
            .source_ids
            .clone()
            .ok_or_else(|| not_null(TABLE, "source_ids"))?;
        for (column, value) in [
            ("detail", &input.detail),
            ("detail_resolved", &input.detail_resolved),
        ] {
            if value.as_deref().is_some_and(|d| !DETAILS.contains(&d)) {
                return Err(check_failed(TABLE, column));
            }
        }
        let vector_enabled = input
            .vector_enabled
            .ok_or_else(|| not_null(TABLE, "vector_enabled"))?;
        let expansion_applied = input
            .expansion_applied
            .ok_or_else(|| not_null(TABLE, "expansion_applied"))?;
        let latency_ms = latency.ok_or_else(|| not_null(TABLE, "latency_ms"))?;
        let remote = input.remote.ok_or_else(|| not_null(TABLE, "remote"))?;

        let scope: Vec<String> = source_ids.iter().flatten().cloned().collect();
        let named_none = source_ids.is_empty();
        self.write(|tx| {
            let mut retrieved = Vec::new();
            for slug in input.retrieved_slugs.iter().flatten().flatten() {
                // `cardinality($5) = 0` widens to every source; a list of only nulls does not.
                let held = if named_none {
                    page_held(&*tx, slug, &[])?
                } else {
                    let mut held = false;
                    for source in &scope {
                        if read_page(&*tx, source, slug)?.is_some() {
                            held = true;
                            break;
                        }
                    }
                    held
                };
                let held = held
                    || match fact_slug_id(slug) {
                        // A list of only null sources matches no fact (`f.source_id = ANY`).
                        Some(id) if named_none || !scope.is_empty() => {
                            fact_exists(&*tx, id, if named_none { &[] } else { &scope })?
                        }
                        _ => false,
                    };
                if held {
                    retrieved.push(slug.clone());
                }
            }
            let id = next_id(tx, NEXT_CANDIDATE_ID)?;
            let record = CandidateRecord {
                id,
                tool_name: tool_name.clone(),
                query: query.clone(),
                retrieved_slugs: retrieved,
                retrieved_chunk_ids: chunk_ids.clone(),
                source_ids: source_ids.clone(),
                expand_enabled: input.expand_enabled,
                detail: input.detail.clone(),
                detail_resolved: input.detail_resolved.clone(),
                vector_enabled,
                expansion_applied,
                latency_ms,
                remote,
                job_id,
                subagent_id,
                created_at_us: self.env.now_micros(),
                embedding_column: input.embedding_column.clone(),
            };
            put_json(tx, &record_key(CANDIDATE, id), &record)?;
            Ok(id)
        })
    }

    /// `listEvalCandidates({ since?, limit?, tool? })`: rows with `created_at >= since` (epoch
    /// when absent) and the given tool, newest first (`created_at DESC, id DESC`). The limit is
    /// 1000 when absent, not finite or not positive, else `min(floor(limit), 100000)`.
    pub fn list_eval_candidates(&self, options: &ListEvalCandidatesOptions) -> Result<Vec<Value>> {
        let since = match options.since.as_deref() {
            Some(text) => timestamp(text, "listEvalCandidates since")?,
            None => 0,
        };
        let limit = match options.limit {
            Some(n) if n.is_finite() && n > 0.0 => {
                // Clamped first, so the cast is exact.
                n.floor().min(MAX_LIST_LIMIT as f64) as usize
            }
            _ => DEFAULT_LIST_LIMIT,
        };
        if let Some(tool) = options.tool.as_deref() {
            no_nul("listEvalCandidates", &[("tool", tool)])?;
        }
        let read = self.read()?;
        let mut rows: Vec<CandidateRecord> = read_all::<CandidateRecord>(&*read, CANDIDATE)?
            .into_iter()
            .filter(|c| c.created_at_us >= since)
            .filter(|c| options.tool.as_deref().is_none_or(|t| c.tool_name == t))
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse((r.created_at_us, r.id)));
        rows.truncate(limit);
        Ok(rows.iter().map(CandidateRecord::to_json).collect())
    }

    /// `deleteEvalCandidatesBefore(date)`: deletes rows with `created_at < date`; returns how many.
    pub fn delete_eval_candidates_before(&self, date: &str) -> Result<u64> {
        let before = timestamp(date, "deleteEvalCandidatesBefore date")?;
        self.write(|tx| {
            let doomed: Vec<u64> = read_all::<CandidateRecord>(&*tx, CANDIDATE)?
                .into_iter()
                .filter(|c| c.created_at_us < before)
                .map(|c| c.id)
                .collect();
            for id in &doomed {
                tx.delete(&record_key(CANDIDATE, *id))?;
            }
            Ok(doomed.len() as u64)
        })
    }

    /// `logEvalCaptureFailure(reason)`: records one failure stamped now. A reason outside the
    /// table's `CHECK` list refuses with `constraint_violation`.
    pub fn log_eval_capture_failure(&self, reason: Option<&str>) -> Result<()> {
        const TABLE: &str = "eval_capture_failures";
        let reason = reason.ok_or_else(|| not_null(TABLE, "reason"))?;
        no_nul("logEvalCaptureFailure", &[("reason", reason)])?;
        if !REASONS.contains(&reason) {
            return Err(check_failed(TABLE, "reason"));
        }
        self.write(|tx| {
            let id = next_id(tx, NEXT_FAILURE_ID)?;
            let record = FailureRecord {
                id,
                ts_us: self.env.now_micros(),
                reason: reason.to_string(),
            };
            put_json(tx, &record_key(FAILURE, id), &record)
        })
    }

    /// `listEvalCaptureFailures({ since? })`: rows with `ts >= since` (epoch when absent), newest
    /// first. Postgres orders by `ts DESC` alone; equal stamps come `id DESC` here.
    pub fn list_eval_capture_failures(
        &self,
        options: &ListEvalCaptureFailuresOptions,
    ) -> Result<Vec<Value>> {
        let since = match options.since.as_deref() {
            Some(text) => timestamp(text, "listEvalCaptureFailures since")?,
            None => 0,
        };
        let read = self.read()?;
        let mut rows: Vec<FailureRecord> = read_all::<FailureRecord>(&*read, FAILURE)?
            .into_iter()
            .filter(|f| f.ts_us >= since)
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse((r.ts_us, r.id)));
        Ok(rows.iter().map(FailureRecord::to_json).collect())
    }
}

#[cfg(test)]
mod tests {
    //! `remove_retrieved_slugs` is crate-private; its contract is tested here. The members are
    //! tested through the public API in `tests/eval_capture.rs`.
    use super::*;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::sources::SourceInput;
    use crate::{OpenOptions, Store};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static NEXT: AtomicU32 = AtomicU32::new(0);

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn open() -> (Dir, Store) {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/unit-tmp")
            .join(format!(
                "eval-capture-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::open_dir(&dir, OpenOptions::default()).unwrap();
        (Dir(dir), store)
    }

    fn put(store: &Store, source: &str, slug: &str) {
        let input: PageInput =
            serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "x"}))
                .unwrap();
        let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
        store.put_page(slug, &input, &opts).unwrap();
    }

    fn source(store: &Store, id: &str) {
        let input: SourceInput = serde_json::from_value(json!({"id": id, "name": id})).unwrap();
        store.upsert_source(&input).unwrap();
    }

    fn log(store: &Store, slugs: &[&str], sources: &[&str]) -> u64 {
        let input: EvalCandidateInput = serde_json::from_value(json!({
            "tool_name": "query", "query": "q", "retrieved_slugs": slugs, "retrieved_chunk_ids": [],
            "source_ids": sources, "vector_enabled": true, "expansion_applied": false,
            "latency_ms": 1, "remote": false,
        }))
        .unwrap();
        store.log_eval_candidate(&input).unwrap()
    }

    fn slugs_of(store: &Store, id: u64) -> Vec<String> {
        let rows = store
            .list_eval_candidates(&ListEvalCandidatesOptions::default())
            .unwrap();
        let row = rows.iter().find(|r| r["id"] == json!(id)).unwrap();
        serde_json::from_value(row["retrieved_slugs"].clone()).unwrap()
    }

    #[test]
    fn keeps_a_facts_slug_while_the_fact_row_exists_in_scope() {
        use crate::facts::{FactRecord, fact_key};
        let (_dir, store) = open();
        source(&store, "other");
        store
            .write(|tx| {
                for (id, source_id, expired) in [(7u64, "default", true), (8, "other", false)] {
                    let fact = FactRecord {
                        id,
                        source_id: source_id.into(),
                        // An expired row still counts: only a deleted row is gone.
                        expired_at_us: expired.then_some(1),
                        ..FactRecord::default()
                    };
                    put_json(tx, &fact_key(id), &fact)?;
                }
                Ok(())
            })
            .unwrap();
        let slugs = [
            "facts/7",
            "facts/8",
            "facts/9",
            "facts/",
            "facts/07",
            "facts/x7",
            "facts/1234567890123456789",
        ];
        let any = log(&store, &slugs, &[]);
        let default_only = log(&store, &slugs, &["default"]);
        let other_only = log(&store, &slugs, &["other"]);
        // `facts/07` names fact 7 too (`substr(...)::bigint`); 19 digits is no facts slug.
        assert_eq!(
            slugs_of(&store, any),
            vec!["facts/7", "facts/8", "facts/07"]
        );
        assert_eq!(slugs_of(&store, default_only), vec!["facts/7", "facts/07"]);
        assert_eq!(slugs_of(&store, other_only), vec!["facts/8"]);
        // A source list of only nulls matches no fact.
        let input: EvalCandidateInput = serde_json::from_value(json!({
            "tool_name": "query", "query": "q", "retrieved_slugs": ["facts/7"],
            "retrieved_chunk_ids": [], "source_ids": [null], "vector_enabled": true,
            "expansion_applied": false, "latency_ms": 1, "remote": false,
        }))
        .unwrap();
        let nulls = store.log_eval_candidate(&input).unwrap();
        assert!(slugs_of(&store, nulls).is_empty());
    }

    #[test]
    fn strips_purged_slugs_keeps_order_and_spares_other_sources() {
        let (_dir, store) = open();
        source(&store, "other");
        for slug in ["a", "b", "c"] {
            put(&store, "default", slug);
        }
        put(&store, "other", "b");
        let both = log(&store, &["a", "b", "c"], &["default", "other"]);
        let only_default = log(&store, &["c", "b", "a"], &["default"]);
        let only_other = log(&store, &["b"], &["other"]);
        let unscoped = log(&store, &["a", "b"], &[]);

        let count = store
            .write(|tx| remove_retrieved_slugs(tx, "default", &["a".into(), "b".into()]))
            .unwrap();
        // `both` loses only `a` (`other` still has `b`); `only_default` loses both; `only_other`
        // does not cover `default`; `unscoped` names no source and is never touched.
        assert_eq!(count, 2);
        assert_eq!(slugs_of(&store, both), vec!["b", "c"]);
        assert_eq!(slugs_of(&store, only_default), vec!["c"]);
        assert_eq!(slugs_of(&store, only_other), vec!["b"]);
        assert_eq!(slugs_of(&store, unscoped), vec!["a", "b"]);

        // Nothing left to strip: no candidate is counted again.
        let again = store
            .write(|tx| remove_retrieved_slugs(tx, "default", &["a".into()]))
            .unwrap();
        assert_eq!(again, 0);
        let none = store
            .write(|tx| remove_retrieved_slugs(tx, "default", &[]))
            .unwrap();
        assert_eq!(none, 0);
    }
}
