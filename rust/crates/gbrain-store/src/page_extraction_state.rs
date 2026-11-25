//! The extraction watermark and the partial-input receipt (PGLite's `page_extraction_state`,
//! migration v247).
//!
//! Members: readPageExtractionWatermark, commitPageExtraction, readPageExtractionReceipt,
//! clearPageExtractionState, writePageExtractionReceipt (src/core/engine-sql/page-extraction-state.ts
//! is the SQL copy; src/core/extraction-watermark.ts owns the policy). The doctor reads
//! `listAmbiguousExtractionInputs` and `listExtractionInputReceipts` read the rows through
//! [`all_states`] (`cli_reads/doctor_derived_ledgers.rs`).
//!
//! Key: `~e <page id> <pipeline>` (`keys::PAGE_EXTRACTION_STATE`, a two-byte family tag; the page id is 8 big-endian
//! bytes, the pipeline its text) -> the row (JSON, [`StateRecord`]). One row per page and
//! pipeline, as PGLite's primary key `(page_id, pipeline)`. The rows go with the page when it is
//! deleted for good ([`remove_page_rows`], called by `cascade::remove_page_rows`, which a page
//! delete, a purge and a source delete all reach), as PGLite's `ON DELETE CASCADE` drops them. A
//! page that is only soft-deleted keeps its rows, as in PGLite.
//!
//! What PGLite checks, this store checks: the page must exist (the foreign key), the pipeline
//! must be one of the three the table lists, and `watermark_bytes` must not be negative; each is
//! a `constraint_violation` and writes nothing. `input_truncated` is a JSONB object here (the TypeScript
//! caller only sends objects); it is stored with its keys in jsonb order and read the same way.
//! `updated_at` is the write's time in microseconds, as `now()`.

use crate::error::{CONSTRAINT_VIOLATION, StoreError};
use crate::jsonb::{de_opt_value, order};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, read_page, read_page_by_id};
use crate::{Result, Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// `CHECK (pipeline IN (...))` of the table.
const PIPELINES: [&str; 3] = ["facts_backstop", "extract_atoms", "conversation_facts"];

fn state_prefix(page_id: u64) -> Vec<u8> {
    let mut key = keys::PAGE_EXTRACTION_STATE.to_vec();
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

fn state_key(page_id: u64, pipeline: &str) -> Vec<u8> {
    let mut key = state_prefix(page_id);
    key.extend_from_slice(pipeline.as_bytes());
    key
}

/// One row: PGLite's columns, `updated_at` in microseconds. A column that is NULL is absent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StateRecord {
    pipeline_version: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    watermark_bytes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    watermark_sha256: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de_opt_value"
    )]
    input_truncated: Option<Value>,
    updated_at: i64,
}

impl StateRecord {
    /// The receipt (`input_truncated`), or `None` when the column is NULL.
    pub(crate) fn receipt(&self) -> Option<&Value> {
        self.input_truncated.as_ref()
    }

    /// `updated_at` in microseconds.
    pub(crate) fn updated_at_us(&self) -> i64 {
        self.updated_at
    }
}

/// One row with its key: `(page id, pipeline, row)`.
pub(crate) struct State {
    pub page_id: u64,
    pub pipeline: String,
    pub record: StateRecord,
}

/// Every row of every page, in key order: page id, then pipeline.
pub(crate) fn all_states(read: &dyn KvRead) -> Result<Vec<State>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(
        read,
        &keys::PAGE_EXTRACTION_STATE,
        false,
        &mut |key, value| {
            let record = match serde_json::from_slice::<StateRecord>(value) {
                Ok(record) => record,
                Err(e) => {
                    failure = Some(StoreError::from(e));
                    return false;
                }
            };
            // `~e <page id, 8 bytes> <pipeline>`
            let (Some(id), Some(pipeline)) = (key.get(2..10), key.get(10..)) else {
                return true;
            };
            if let (Ok(id), Ok(pipeline)) = (<[u8; 8]>::try_from(id), std::str::from_utf8(pipeline))
            {
                out.push(State {
                    page_id: u64::from_be_bytes(id),
                    pipeline: pipeline.to_string(),
                    record,
                });
            }
            true
        },
    )?;
    failure.map_or(Ok(out), Err)
}

/// Deletes every row of a page that is deleted for good (`cascade::remove_page_rows`).
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    let mut found = Vec::new();
    scan_prefix(&*tx, &state_prefix(page.id), false, &mut |key, _| {
        found.push(key.to_vec());
        true
    })?;
    for key in found {
        tx.delete(&key)?;
    }
    Ok(())
}

fn constraint(member: &str, what: String) -> StoreError {
    StoreError::new(CONSTRAINT_VIOLATION, format!("{member}: {what}"))
}

fn require_page(read: &dyn KvRead, page_id: u64, member: &str) -> Result<()> {
    if read_page_by_id(read, page_id)?.is_none() {
        return Err(constraint(
            member,
            format!(
                "page {page_id} does not exist (page_extraction_state.page_id references pages)"
            ),
        ));
    }
    Ok(())
}

fn require_pipeline(pipeline: &str, member: &str) -> Result<()> {
    if !PIPELINES.contains(&pipeline) {
        return Err(constraint(
            member,
            format!("pipeline {pipeline:?} is not one of {PIPELINES:?}"),
        ));
    }
    Ok(())
}

fn pipeline_version(version: i64, member: &str) -> Result<i32> {
    i32::try_from(version).map_err(|_| {
        constraint(
            member,
            format!("pipeline_version {version} is out of range"),
        )
    })
}

fn receipt_object(receipt: &Value, member: &str) -> Result<Value> {
    if !receipt.is_object() {
        return Err(StoreError::invalid(format!(
            "{member}: the receipt is a JSON object"
        )));
    }
    Ok(order(receipt.clone()))
}

/// `commitPageExtraction`'s input.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInput {
    pub page_id: u64,
    pub pipeline: String,
    pub pipeline_version: i64,
    pub watermark_bytes: i64,
    pub watermark_sha256: String,
    /// The new receipt; `null` clears it.
    pub receipt: Option<Value>,
    /// A complete tail read keeps the receipt an earlier read left.
    pub keep_receipt: bool,
}

impl Store {
    /// `readPageExtractionWatermark(sourceId, slug, pipeline)`: the live page's `{ page_id,
    /// pipeline_version, watermark_bytes, watermark_sha256 }` (the last three null when the page
    /// has no row for the pipeline), or null when no live page has that slug in the source.
    pub fn read_page_extraction_watermark(
        &self,
        source_id: &str,
        slug: &str,
        pipeline: &str,
    ) -> Result<Value> {
        let read = self.read()?;
        let Some(page) = read_page(&*read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
        else {
            return Ok(Value::Null);
        };
        let state: Option<StateRecord> = get_json(&*read, &state_key(page.id, pipeline))?;
        Ok(json!({
            "page_id": page.id,
            "pipeline_version": state.as_ref().map(|s| s.pipeline_version),
            "watermark_bytes": state.as_ref().and_then(|s| s.watermark_bytes),
            "watermark_sha256": state.as_ref().and_then(|s| s.watermark_sha256.clone()),
        }))
    }

    /// `commitPageExtraction(commit)`: stores a successful extraction. A new row takes the
    /// receipt; a row that exists takes the watermark and keeps its receipt when `keepReceipt`.
    pub fn commit_page_extraction(&self, input: &CommitInput) -> Result<()> {
        const MEMBER: &str = "commitPageExtraction";
        require_pipeline(&input.pipeline, MEMBER)?;
        let version = pipeline_version(input.pipeline_version, MEMBER)?;
        if input.watermark_bytes < 0 {
            return Err(constraint(
                MEMBER,
                format!("watermark_bytes {} is negative", input.watermark_bytes),
            ));
        }
        let receipt = input
            .receipt
            .as_ref()
            .filter(|r| !r.is_null())
            .map(|r| receipt_object(r, MEMBER))
            .transpose()?;
        let now = self.env.now_micros();
        self.write(|tx| {
            require_page(&*tx, input.page_id, MEMBER)?;
            let key = state_key(input.page_id, &input.pipeline);
            let old: Option<StateRecord> = get_json(&*tx, &key)?;
            let input_truncated = match old {
                Some(old) if input.keep_receipt => old.input_truncated,
                _ => receipt.clone(),
            };
            let record = StateRecord {
                pipeline_version: version,
                watermark_bytes: Some(input.watermark_bytes),
                watermark_sha256: Some(input.watermark_sha256.clone()),
                input_truncated,
                updated_at: now,
            };
            put_json(tx, &key, &record)
        })
    }

    /// `readPageExtractionReceipt(pageId, pipeline)`: the row's receipt, null when the page has no
    /// row for the pipeline or the row has no receipt.
    pub fn read_page_extraction_receipt(&self, page_id: u64, pipeline: &str) -> Result<Value> {
        let read = self.read()?;
        let state: Option<StateRecord> = get_json(&*read, &state_key(page_id, pipeline))?;
        Ok(state.and_then(|s| s.input_truncated).unwrap_or(Value::Null))
    }

    /// `clearPageExtractionState(pageId, pipeline)`: deletes the row, watermark and receipt both;
    /// no row is a no-op.
    pub fn clear_page_extraction_state(&self, page_id: u64, pipeline: &str) -> Result<()> {
        self.write(|tx| tx.delete(&state_key(page_id, pipeline)))
    }

    /// `writePageExtractionReceipt(pageId, pipeline, pipelineVersion, receipt)`: a new row holds
    /// the receipt and no watermark; a row that exists takes the receipt and keeps its watermark
    /// and version.
    pub fn write_page_extraction_receipt(
        &self,
        page_id: u64,
        pipeline: &str,
        pipeline_version_in: i64,
        receipt: &Value,
    ) -> Result<()> {
        const MEMBER: &str = "writePageExtractionReceipt";
        require_pipeline(pipeline, MEMBER)?;
        let version = pipeline_version(pipeline_version_in, MEMBER)?;
        let receipt = receipt_object(receipt, MEMBER)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            require_page(&*tx, page_id, MEMBER)?;
            let key = state_key(page_id, pipeline);
            let record = match get_json::<StateRecord>(&*tx, &key)? {
                Some(mut row) => {
                    row.input_truncated = Some(receipt.clone());
                    row.updated_at = now;
                    row
                }
                None => StateRecord {
                    pipeline_version: version,
                    watermark_bytes: None,
                    watermark_sha256: None,
                    input_truncated: Some(receipt.clone()),
                    updated_at: now,
                },
            };
            put_json(tx, &key, &record)
        })
    }
}
