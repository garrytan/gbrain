//! Segmented page bodies: segment texts, manifests, stagings, the generation flip and per-segment
//! derivations, plus `refreshPageBody` (the narrow inline body rewrite). PGLite's SQL is
//! `src/core/engine-sql/page-body.ts` and `engine-sql/pages.ts` (`refreshPageBody`); each member
//! below follows it, refusals included. rust/docs/store/page_body.md lists what differs.
//!
//! Members served: allocateBodyOccurrenceIds, stageSegmentTexts, readSegmentTexts,
//! stageManifestRows, readManifest, stageSegmentChunks, createSegmentedPageShell,
//! flipBodyGeneration, openBodyStaging, setBodyStagingState, sweepSegments, readSegmentDerivations,
//! upsertSegmentDerivations, retireSegmentDerivations, refreshPageBody. Segment chunk rows go
//! through the chunks family's segment-chunk helper (`chunks::append_segment_chunks` and friends).
//! The sweep reads its other roots through narrow helpers: the generations version snapshots
//! reference (`pages::version_generations`) and the stagings outstanding requests name
//! (`journal::request_held_staging_ids`).
//!
//! Keys. Every record starts with `keys::PAGE_BODY` (`b`) and one kind byte. Page ids are
//! big-endian u64; occurrence ids and generations are signed and stored sign-flipped big-endian
//! (`v ^ 1<<63`), so keys sort by value.
//!
//! - `b 0x01 <source> 0x00 <sha256: 32 bytes>`: a segment text (`TextRecord`, body as hex).
//! - `b 0x02 <page id> <occurrence id> <gen_from> <staging id: 16 bytes>`: a manifest row
//!   (`ManifestRow`). Published rows carry the nil staging id, as Postgres `staging_key` does.
//! - `b 0x03 <staging id: lowercase uuid text>`: a body staging (`StagingRecord`).
//! - `b 0x04 <page id> <kind> 0x00 <occurrence id>`: a segment derivation (`DerivationRecord`), so
//!   a page's rows sort by kind, then occurrence.
//! - `b 0x05 <page id>`: the segmented-body columns of a page (`BodyState`). A page without one is
//!   inline at body generation 0.
//! - `b 0x06 <principal kind> 0x00 <principal id> 0x00 <client request id>`: the staging's unique
//!   client key; the value is the staging id.
//! - `b 0x07 <staging id text> <sha256>`: a text a staging recorded; the value is the source id.
//! - `b 0x08 <page id> <staging id text>`: stagings of a page, for the page-delete cascade.
//! - `b 0x09 <request id: lowercase uuid text>`: a fact purge's derivation sweep record (`purge_record::SweepRecord`).
//! - `M next_body_occurrence_id`: the occurrence id counter (big-endian u64 of the next id).
//!
//! Refusals Postgres raises from a CHECK, foreign key or unique index are `constraint_violation`
//! here; a value Postgres cannot parse (a bad uuid, hex or date) is `invalid_argument`. The flip
//! and staging refusals PGLite raises as operation errors are `invalid_state` with the message
//! `page_body:<json>`; `store-members/page-body.ts` rebuilds the PGLite error from the JSON.

use crate::env::{is_uuid, parse_iso};
use crate::error::{CONSTRAINT_VIOLATION, INVALID_STATE, REVISION_CONFLICT};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::page_columns::PageColumns;
use crate::pages::{
    PageRecord, PageText, clean, next_id, read_page, read_page_by_id, validate_slug, write_page,
};
use crate::{Result, Store, StoreError, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

pub mod derivation_sweep;
mod page_spend;
mod segment_rewrite;
mod segmented_embedding;
mod segmented_writes;
pub use segment_rewrite::{SegmentedGenerationLock, SegmentedRewritePage};
pub use segmented_embedding::{
    LiveEmbedSegment, RetiredChunkVector, SegmentChunkInputHash, SegmentChunkRow,
    SegmentedEmbedCounts, SegmentedStaleRow, SegmentedStaleRowsOpts, SegmentedVectorInput,
};
pub use segmented_writes::{
    OccurrenceChunkRow, RechunkCandidateScope, SegmentedLivePageRow, SegmentedProjectionPage,
    SegmentedRechunkPage,
};
pub(crate) mod health;
pub mod purge_probe;
pub mod purge_record;
pub(crate) mod purge_scan;
mod purge_sweep;

const TEXT: u8 = 0x01;
const MANIFEST: u8 = 0x02;
const STAGING: u8 = 0x03;
const DERIVATION: u8 = 0x04;
pub(crate) const BODY: u8 = 0x05;
const STAGING_CLIENT: u8 = 0x06;
const STAGING_TEXT: u8 = 0x07;
const STAGING_BY_PAGE: u8 = 0x08;
const DERIVATION_PURGE: u8 = 0x09;
/// `b 0x0A <source id> 0x00 <request id>`: the sweep records of a source, so a walk finds its own without reading every source's.
const DERIVATION_PURGE_BY_SOURCE: u8 = 0x0A;

/// The page id counter of `pages.rs` (its `NEXT_PAGE_ID`, private there): a shell takes its id
/// from the same sequence `putPage` does.
const NEXT_PAGE_ID: &str = "next_page_id";
const NEXT_OCCURRENCE_ID: &str = "next_body_occurrence_id";
/// `SEGMENTED_CHUNKER_VERSION` (src/core/page-body/segment-chunks.ts): the current segmented chunker.
const SEGMENTED_CHUNKER_VERSION: i16 = 5;
const NIL_STAGING: [u8; 16] = [0; 16];

const LIVE_STAGING_STATES: [&str; 3] = ["open", "sealed", "prepared"];
const TERMINAL_STAGING_STATES: [&str; 3] = ["committed", "aborted", "expired"];
const STAGING_STATES: [&str; 6] = [
    "open",
    "sealed",
    "prepared",
    "committed",
    "aborted",
    "expired",
];
const STAGING_KINDS: [&str; 7] = [
    "upload",
    "import",
    "sync",
    "put",
    "append",
    "edit",
    "resegment",
];
const STAGING_MODES: [&str; 3] = ["create", "replace", "append"];
const REGIONS: [&str; 2] = ["truth", "timeline"];
const CUT_KINDS: [&str; 7] = [
    "heading",
    "day",
    "message",
    "blank",
    "forced",
    "region_end",
    "eof",
];
const DERIVATION_KINDS: [&str; 7] = [
    "links",
    "mentions",
    "timeline",
    "fences",
    "conversation_facts",
    "facts_backstop",
    "synopsis",
];
const DERIVATION_STATES: [&str; 4] = ["done", "partial", "failed", "skipped"];
/// `page_segment_texts.byte_len BETWEEN 1 AND 1048576`.
const MAX_SEGMENT_BYTES: usize = 1_048_576;
/// `BODY_STAGING_IDLE_MS` (`src/core/page-body/limits.ts`) in microseconds.
const BODY_STAGING_IDLE_US: i64 = 60 * 60 * 1_000_000;
/// `BODY_STAGING_HARD_MS` in microseconds: a sweep deletes a terminal staging this long after its
/// last change.
const BODY_STAGING_HARD_US: i64 = 24 * 60 * 60 * 1_000_000;
/// `SEGMENT_TEXT_GC_GRACE_MS` (`src/core/page-body/limits.ts`): the default text grace window.
pub(crate) const SEGMENT_TEXT_GC_GRACE_MS: i64 = 60 * 60 * 1000;
/// `SAFE_FENCE_CHUNKER_VERSION` (`src/core/search/safe-chunks.ts`): a segmented write stores at
/// most one below it.
const SAFE_FENCE_CHUNKER_VERSION: i64 = 4;

// ---------------------------------------------------------------------------------------------
// Records and inputs
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TextRecord {
    byte_len: i64,
    line_count: i64,
    /// The segment bytes as lowercase hex.
    body: String,
    created_at_us: i64,
}

/// `SegmentTextInput`, its bytes as hex.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentTextInput {
    pub sha256: String,
    pub body: String,
    pub line_count: i64,
}

/// `ManifestRowInput` in, `ManifestRow` out (and the stored record): bytes as hex, dates as
/// `YYYY-MM-DD`. `genTo` is never read from input: staged rows start open.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestRow {
    pub page_id: i64,
    pub occurrence_id: i64,
    pub gen_from: i64,
    #[serde(default)]
    pub gen_to: Option<i64>,
    pub seq: i64,
    pub region: String,
    pub source_id: String,
    pub sha256: String,
    pub byte_start: i64,
    pub byte_len: i64,
    pub line_start: i64,
    pub line_count: i64,
    pub cut_kind: String,
    #[serde(default, deserialize_with = "crate::jsonb::de_value")]
    pub entry_state: Value,
    #[serde(default, deserialize_with = "crate::jsonb::de_value")]
    pub protected_regions: Value,
    #[serde(default, deserialize_with = "crate::jsonb::de_value")]
    pub facts_slots: Value,
    pub static_proj_bytes: i64,
    pub static_proj_lines: i64,
    #[serde(default, deserialize_with = "crate::jsonb::de_value")]
    pub outline: Value,
    #[serde(default)]
    pub date_min: Option<String>,
    #[serde(default)]
    pub date_max: Option<String>,
    pub hash_state: String,
    #[serde(default)]
    pub staging_id: Option<String>,
}

/// The segmented-body columns of a page. Postgres keeps them on `pages`; the page record does not
/// hold them, so they live under this family's tag.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct BodyState {
    pub(crate) body_storage: String,
    pub(crate) body_generation: i64,
    #[serde(default)]
    pub(crate) body_bytes: Option<i64>,
    #[serde(default)]
    pub(crate) truth_bytes: Option<i64>,
    #[serde(default)]
    pub(crate) body_lines: Option<i64>,
    #[serde(default)]
    pub(crate) segment_count: Option<i64>,
    #[serde(default)]
    pub(crate) segmenter_version: Option<i64>,
    #[serde(default)]
    pub(crate) truth_lead: Option<String>,
    #[serde(default)]
    pub(crate) timeline_lead: Option<String>,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    pub(crate) body_flags: Option<Value>,
    #[serde(default)]
    pub(crate) chunker_version: Option<i64>,
}

/// `BodyStagingInput`; dates as ISO strings, `declaredSha256` as hex.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyStagingInput {
    pub id: String,
    pub kind: String,
    pub principal_kind: String,
    pub principal_id: String,
    pub client_request_id: String,
    pub source_id: String,
    pub source_incarnation: String,
    pub slug: String,
    #[serde(default)]
    pub page_id: Option<i64>,
    pub mode: String,
    #[serde(default)]
    pub base_revision: Option<String>,
    #[serde(default)]
    pub base_generation: Option<i64>,
    pub declared_bytes: i64,
    #[serde(default)]
    pub declared_sha256: Option<String>,
    pub reserved_bytes: i64,
    pub idle_expires_at: String,
    pub hard_expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StagingRecord {
    id: String,
    kind: String,
    principal_kind: String,
    principal_id: String,
    client_request_id: String,
    source_id: String,
    source_incarnation: String,
    slug: String,
    page_id: Option<u64>,
    mode: String,
    base_revision: Option<String>,
    base_generation: Option<i64>,
    declared_bytes: i64,
    declared_sha256: Option<String>,
    received_bytes: i64,
    next_part: i64,
    reserved_bytes: i64,
    state: String,
    commit_request_id: Option<String>,
    idle_expires_at_us: i64,
    hard_expires_at_us: i64,
    created_at_us: i64,
    updated_at_us: i64,
}

/// `SegmentDerivationInput`; hashes as hex.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentDerivationInput {
    pub page_id: i64,
    pub kind: String,
    pub occurrence_id: i64,
    pub version: i64,
    pub segment_sha256: String,
    pub context_hash: String,
    pub state: String,
    #[serde(default)]
    pub output: Value,
    #[serde(default)]
    pub receipt: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DerivationRecord {
    pipeline_version: i64,
    segment_sha256: String,
    context_hash: String,
    state: String,
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    output: Value,
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    receipt: Value,
    created_at_us: i64,
    updated_at_us: i64,
}

/// `SegmentedPageMeta`; `effective_date` as an ISO string.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SegmentedPageMeta {
    #[serde(rename = "type")]
    pub page_type: Option<String>,
    pub title: String,
    pub frontmatter: Option<Map<String, Value>>,
    pub page_kind: Option<String>,
    pub effective_date: Option<String>,
    pub effective_date_source: Option<String>,
    pub import_filename: Option<String>,
    pub source_path: Option<String>,
    pub source_kind: Option<String>,
    pub source_uri: Option<String>,
    pub ingested_via: Option<String>,
    pub chunker_version: Option<i64>,
}

/// `SegmentedBodyColumns`.
#[derive(Debug, Clone, Deserialize)]
pub struct SegmentedBodyColumns {
    pub content_hash: String,
    pub body_bytes: i64,
    pub truth_bytes: i64,
    pub body_lines: i64,
    pub segment_count: i64,
    pub segmenter_version: i64,
    pub truth_lead: String,
    pub timeline_lead: String,
    #[serde(default)]
    pub body_flags: Value,
}

/// `BodyFlipInput`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyFlipInput {
    pub page_id: i64,
    pub expected_generation: i64,
    pub new_generation: i64,
    pub staging_id: String,
    #[serde(default)]
    pub close_occurrences: Vec<i64>,
    #[serde(default)]
    pub retire_chunk_occurrences: Vec<i64>,
    #[serde(default)]
    pub retire_inline_chunks: Option<bool>,
    pub retire_max_rows: i64,
    pub body: SegmentedBodyColumns,
    pub meta: SegmentedPageMeta,
    /// The `gbrain.materializing_revision` transaction setting of the caller (the TypeScript store
    /// member reads it from its transaction scope). When it names the page's revision and the flip
    /// leaves the page's identity, type, kind, title, frontmatter and deletion as they were, the flip
    /// keeps the revision and the seal, as Postgres's `gbrain_advance_page_revision` trigger does.
    #[serde(default)]
    pub keep_revision: Option<String>,
}

/// `BodyFlipResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyFlipResult {
    pub retired_chunks: u64,
    pub retire_deferred: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StageTextsOptions {
    pub staging_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReadManifestOptions {
    pub generation: Option<i64>,
    pub staging_id: Option<String>,
    pub region: Option<String>,
    pub last_n: Option<i64>,
}

/// `readSegmentedEmbedPage(ref)`: a page by id, or by source and slug.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum SegmentedEmbedRef {
    Id {
        id: i64,
    },
    #[serde(rename_all = "camelCase")]
    Slug {
        source_id: String,
        slug: String,
    },
}

/// The page fields a segmented embed reads (`SegmentedEmbedPage`): metadata only, never the body.
/// `body_bytes` is the stored count, `None` when the shell recorded none (PGLite's NULL column).
#[derive(Debug, Clone, Serialize)]
pub struct SegmentedEmbedPage {
    pub id: u64,
    pub slug: String,
    pub source_id: String,
    pub title: String,
    pub contextual_retrieval_mode: Option<String>,
    pub body_bytes: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ShellOptions {
    pub source_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StagingStateOptions {
    pub commit_request_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DerivationReadOptions {
    pub kind: Option<String>,
    pub occurrence_ids: Option<Vec<i64>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DerivationRetireOptions {
    pub kind: Option<String>,
}

/// `deleteRewrittenSegmentDerivations`' argument (engine-sql/segmented-purge-writes.ts).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RewrittenDerivationsDelete {
    pub page_id: i64,
    pub touched_occurrence_ids: Vec<i64>,
    pub link_reach_occurrence_ids: Vec<i64>,
    pub pipelines: Vec<String>,
    pub live_occurrence_ids: Vec<i64>,
}

/// `SegmentSweepOptions`; `now` as an ISO string.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SegmentSweepOptions {
    pub source_id: Option<String>,
    pub page_id: Option<i64>,
    pub grace_ms: Option<i64>,
    pub expire_stagings: Option<bool>,
    pub now: Option<String>,
}

/// `SegmentSweepResult`.
/// What `sealSegmentedPage` reads before it seals ([`Store::read_segmented_seal_lead`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealLead {
    /// The stored timeline lead, `""` when none was published.
    pub lead: String,
    /// The page's `knowledge_revision`.
    pub revision: String,
    pub slug: String,
    pub source_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentSweepResult {
    pub retired_chunks_deleted: u64,
    pub manifest_rows_deleted: u64,
    pub texts_deleted: u64,
    pub stagings_expired: u64,
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

fn violation(message: impl Into<String>) -> StoreError {
    StoreError::new(CONSTRAINT_VIOLATION, message)
}

/// A refusal PGLite raises as an operation error; page-body.ts rebuilds it from `detail`.
fn body_error(detail: Value) -> StoreError {
    StoreError::new(INVALID_STATE, format!("page_body:{detail}"))
}

fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}

fn from_hex(text: &str, what: &str) -> Result<Vec<u8>> {
    let digit = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return Err(StoreError::invalid(format!("{what}: odd-length hex")));
    }
    bytes
        .chunks(2)
        .map(|pair| match (digit(pair[0]), digit(pair[1])) {
            (Some(hi), Some(lo)) => Ok((hi << 4) | lo),
            _ => Err(StoreError::invalid(format!("{what}: not hex"))),
        })
        .collect()
}

/// A uuid in its lowercase 8-4-4-4-12 form; anything else is what Postgres's `::uuid` refuses.
fn norm_uuid(text: &str, what: &str) -> Result<String> {
    if !is_uuid(text) {
        return Err(StoreError::invalid(format!(
            "{what}: invalid input syntax for type uuid: \"{text}\""
        )));
    }
    Ok(text.to_ascii_lowercase())
}

fn uuid_bytes(normalized: &str) -> [u8; 16] {
    let digits: String = normalized.chars().filter(|c| *c != '-').collect();
    let mut out = [0u8; 16];
    if let Ok(bytes) = from_hex(&digits, "uuid") {
        out.copy_from_slice(&bytes);
    }
    out
}

fn no_nul(text: &str, what: &str) -> Result<()> {
    if text.contains('\0') {
        return Err(StoreError::invalid(format!(
            "{what}: a text value cannot contain a NUL byte"
        )));
    }
    Ok(())
}

/// An INTEGER column: Postgres refuses a value outside 32 bits.
fn int4(value: i64, what: &str) -> Result<()> {
    if i32::try_from(value).is_err() {
        return Err(StoreError::invalid(format!(
            "{what}: value {value} is out of range for type integer"
        )));
    }
    Ok(())
}

/// A `DATE` value: `YYYY-MM-DD`, optionally followed by a time part, stored as `YYYY-MM-DD`.
fn parse_date(text: &str, what: &str) -> Result<String> {
    let bad = || {
        StoreError::invalid(format!(
            "{what}: invalid input syntax for type date: \"{text}\""
        ))
    };
    let b = text.as_bytes();
    if b.len() < 10
        || b[4] != b'-'
        || b[7] != b'-'
        || (b.len() > 10 && b[10] != b'T' && b[10] != b' ')
    {
        return Err(bad());
    }
    let num = |a: usize, z: usize| -> Option<i64> {
        let s = text.get(a..z)?;
        if s.bytes().all(|c| c.is_ascii_digit()) {
            s.parse().ok()
        } else {
            None
        }
    };
    let (y, m, d) = (
        num(0, 4).ok_or_else(bad)?,
        num(5, 7).ok_or_else(bad)?,
        num(8, 10).ok_or_else(bad)?,
    );
    let days = crate::env::days_in_month(y, m).ok_or_else(bad)?;
    if d < 1 || d > days {
        return Err(bad());
    }
    Ok(text[..10].to_string())
}

fn parse_time(text: &str, what: &str) -> Result<i64> {
    parse_iso(text)
        .ok_or_else(|| StoreError::invalid(format!("{what}: not an ISO timestamp: \"{text}\"")))
}

fn signed(v: i64) -> [u8; 8] {
    ((v as u64) ^ (1u64 << 63)).to_be_bytes()
}

/// A page id from JavaScript; ids start at 1, so anything else names no page.
pub(crate) fn page_u64(id: i64) -> Option<u64> {
    u64::try_from(id).ok().filter(|v| *v > 0)
}

fn kind_key(kind: u8) -> Vec<u8> {
    vec![keys::PAGE_BODY, kind]
}

fn text_key(source_id: &str, sha: &[u8]) -> Vec<u8> {
    let mut key = kind_key(TEXT);
    key.extend_from_slice(source_id.as_bytes());
    key.push(0);
    key.extend_from_slice(sha);
    key
}

fn manifest_prefix(page_id: u64) -> Vec<u8> {
    let mut key = kind_key(MANIFEST);
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

fn manifest_key(page_id: u64, occurrence: i64, gen_from: i64, staging: &[u8; 16]) -> Vec<u8> {
    let mut key = manifest_prefix(page_id);
    key.extend_from_slice(&signed(occurrence));
    key.extend_from_slice(&signed(gen_from));
    key.extend_from_slice(staging);
    key
}

fn staging_key(id: &str) -> Vec<u8> {
    let mut key = kind_key(STAGING);
    key.extend_from_slice(id.as_bytes());
    key
}

fn derivation_prefix(page_id: u64) -> Vec<u8> {
    let mut key = kind_key(DERIVATION);
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

fn derivation_key(page_id: u64, kind: &str, occurrence: i64) -> Vec<u8> {
    let mut key = derivation_prefix(page_id);
    key.extend_from_slice(kind.as_bytes());
    key.push(0);
    key.extend_from_slice(&signed(occurrence));
    key
}

pub(crate) fn body_key(page_id: u64) -> Vec<u8> {
    let mut key = kind_key(BODY);
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

fn client_key(principal_kind: &str, principal_id: &str, client_request_id: &str) -> Vec<u8> {
    let mut key = kind_key(STAGING_CLIENT);
    key.extend_from_slice(principal_kind.as_bytes());
    key.push(0);
    key.extend_from_slice(principal_id.as_bytes());
    key.push(0);
    key.extend_from_slice(client_request_id.as_bytes());
    key
}

fn staging_text_prefix(staging_id: &str) -> Vec<u8> {
    let mut key = kind_key(STAGING_TEXT);
    key.extend_from_slice(staging_id.as_bytes());
    key
}

fn staging_by_page_prefix(page_id: u64) -> Vec<u8> {
    let mut key = kind_key(STAGING_BY_PAGE);
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

fn collect<T: serde::de::DeserializeOwned>(
    read: &dyn KvRead,
    prefix: &[u8],
) -> Result<Vec<(Vec<u8>, T)>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, prefix, false, &mut |k, v| {
        match serde_json::from_slice::<T>(v) {
            Ok(record) => out.push((k.to_vec(), record)),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

fn delete_prefix(tx: &mut dyn KvWrite, prefix: &[u8]) -> Result<()> {
    let mut found = Vec::new();
    scan_prefix(&*tx, prefix, false, &mut |k, _| {
        found.push(k.to_vec());
        true
    })?;
    for key in found {
        tx.delete(&key)?;
    }
    Ok(())
}

/// The shadow seed (`seed.rs`): stores a page's body columns (`body_storage`, `body_generation`,
/// `body_bytes`, `truth_bytes`, `body_lines`, `segment_count`, `segmenter_version`, `truth_lead`,
/// `timeline_lead`, `body_flags`, `chunker_version`) as another engine holds them.
pub(crate) fn seed_body_state(tx: &mut dyn KvWrite, page_id: u64, columns: Value) -> Result<()> {
    let state: BodyState = serde_json::from_value(columns)
        .map_err(|e| StoreError::invalid(format!("seed pages body columns: {e}")))?;
    put_json(tx, &body_key(page_id), &state)
}

/// The shadow follow (`seed/follow.rs`): removes a page's body columns and nothing else: its
/// manifest, derivations and stagings stay.
pub(crate) fn clear_body_state(tx: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    tx.delete(&body_key(page_id))
}

pub(crate) fn read_body_state(read: &dyn KvRead, page_id: u64) -> Result<Option<BodyState>> {
    get_json(read, &body_key(page_id))
}

/// The stored `timeline_lead` of page `page_id`: the lead a flip published, or `None` for an inline
/// page, a shell no flip has published, or a missing page (PGLite's NULL column). A page with a
/// NULL timeline (a segmented page) takes it for its keyword vector, as PGLite's
/// `update_page_search_vector` does with `coalesce(timeline, timeline_lead, '')`.
pub(crate) fn timeline_lead(read: &dyn KvRead, page_id: u64) -> Result<Option<String>> {
    Ok(read_body_state(read, page_id)?.and_then(|state| state.timeline_lead))
}

/// The `truth_lead` of segmented page `page_id`: the raw prefix of its compiled truth that the last flip stored, `None`
/// for an inline page, a shell no flip has published or a missing page (PGLite's NULL column). The bounded body prefix
/// reads (`left(coalesce(compiled_truth, truth_lead), ..)`, page-window/bounded-lead.ts) and the entity card
/// (`coalesce(compiled_truth, truth_lead)`) take it for a segmented page, whose `compiled_truth` is NULL.
pub(crate) fn truth_lead(read: &dyn KvRead, page_id: u64) -> Result<Option<String>> {
    Ok(read_body_state(read, page_id)?.and_then(|state| state.truth_lead))
}

/// The `body_bytes` of segmented page `page_id`: the size a flip published, `Some(0)` for a shell no flip has
/// published, `None` for an inline page, a missing page or a segmented page whose column is NULL (PGLite's NULL
/// column). The chunk_queries family reads it for its `body_storage = 'segmented' AND body_bytes > 0` test.
pub(crate) fn segmented_body_bytes(read: &dyn KvRead, page_id: u64) -> Result<Option<i64>> {
    Ok(read_body_state(read, page_id)?
        .filter(|state| state.body_storage == "segmented")
        .and_then(|state| state.body_bytes))
}

/// The `body_flags` of segmented page `page_id`: `Some(flags)` for a segmented page (`Some(None)` when its column is
/// NULL), `None` for an inline page or a missing page. The link reads test `body_flags->>'has_protected'` on it.
pub(crate) fn segmented_body_flags(
    read: &dyn KvRead,
    page_id: u64,
) -> Result<Option<Option<Value>>> {
    Ok(read_body_state(read, page_id)?
        .filter(|state| state.body_storage == "segmented")
        .map(|state| state.body_flags))
}

fn is_segmented(state: Option<&BodyState>) -> bool {
    state.is_some_and(|s| s.body_storage == "segmented")
}

pub(crate) fn manifest_rows(
    read: &dyn KvRead,
    page_id: u64,
) -> Result<Vec<(Vec<u8>, ManifestRow)>> {
    collect(read, &manifest_prefix(page_id))
}

fn live_published(row: &ManifestRow) -> bool {
    row.gen_to.is_none() && row.staging_id.is_none()
}

/// Rows of generation `g` that are published: Postgres's
/// `staging_id IS NULL AND gen_from <= g AND (gen_to IS NULL OR gen_to > g)`.
pub(crate) fn in_generation(row: &ManifestRow, g: i64) -> bool {
    row.staging_id.is_none() && row.gen_from <= g && row.gen_to.is_none_or(|to| to > g)
}

/// `metaParams`: `page_kind || 'markdown'`, and `ingested_at` is now when any provenance field is
/// a non-empty string.
fn meta_page_kind(meta: &SegmentedPageMeta) -> String {
    meta.page_kind
        .clone()
        .filter(|k| !k.is_empty())
        .unwrap_or_else(|| "markdown".into())
}

fn meta_ingested(meta: &SegmentedPageMeta) -> bool {
    [&meta.source_kind, &meta.source_uri, &meta.ingested_via]
        .iter()
        .any(|v| v.as_deref().is_some_and(|s| !s.is_empty()))
}

fn meta_chunker_version(meta: &SegmentedPageMeta) -> Option<i64> {
    meta.chunker_version
        .map(|v| v.min(SAFE_FENCE_CHUNKER_VERSION - 1))
}

/// The page row's `chunker_version`, a SMALLINT column: Postgres refuses a value outside 16 bits.
/// Postgres's `gbrain_advance_page_revision` exception: the revision stays when the
/// `gbrain.materializing_revision` setting equals the old revision and source_id, slug, type,
/// page_kind, title, frontmatter and deleted_at did not change.
fn keeps_revision(setting: Option<&str>, before: &PageRecord, after: &PageRecord) -> bool {
    setting.is_some_and(|s| !s.is_empty() && s == before.knowledge_revision)
        && before.source_id == after.source_id
        && before.slug == after.slug
        && before.page_type == after.page_type
        && before.page_kind == after.page_kind
        && before.title == after.title
        && before.frontmatter == after.frontmatter
        && before.deleted_at_us == after.deleted_at_us
}

fn smallint_chunker_version(meta: &SegmentedPageMeta) -> Result<Option<i16>> {
    meta_chunker_version(meta)
        .map(|v| {
            i16::try_from(v).map_err(|_| {
                StoreError::invalid(format!(
                    "chunker_version: value {v} is out of range for type smallint"
                ))
            })
        })
        .transpose()
}

fn meta_type(meta: &SegmentedPageMeta) -> Result<String> {
    meta.page_type.clone().ok_or_else(|| {
        violation(
            "null value in column \"type\" of relation \"pages\" violates not-null constraint",
        )
    })
}

/// `liveTilingSql` and `untiledSql`: the generation's published rows, by seq, start each at the
/// sum of the lengths before it, and their lengths sum to `body_bytes`.
pub(crate) fn tiling(rows: &[&ManifestRow]) -> (i64, i64, bool) {
    let mut sorted: Vec<&&ManifestRow> = rows.iter().collect();
    sorted.sort_by_key(|r| r.seq);
    let mut prior = 0i64;
    let mut gapless = true;
    for row in &sorted {
        if row.byte_start != prior {
            gapless = false;
        }
        prior += row.byte_len;
    }
    (sorted.len() as i64, prior, gapless)
}

/// Reads and checks a staging id (`::uuid`), returning its normalized text.
fn staging_id_arg(id: &str) -> Result<String> {
    norm_uuid(id, "staging id")
}

// ---------------------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------------------

/// Deletes this family's records of a page that is deleted for good (`cascade::remove_page_rows`):
/// its manifest rows, derivations and body columns, and the stagings that name the page (with
/// their client keys and recorded texts), as the Postgres foreign keys cascade. Segment texts stay
/// until a sweep, as in PGLite.
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    // The foreign key's cascade deletes the page's manifest rows, which the SQL trigger notes like any other delete of a live row.
    for (_, row) in manifest_rows(&*tx, page.id)? {
        derivation_sweep::note_row_gone(tx, &row)?;
    }
    delete_prefix(tx, &manifest_prefix(page.id))?;
    delete_prefix(tx, &derivation_prefix(page.id))?;
    tx.delete(&body_key(page.id))?;
    crate::chunks::forget_segment_view(tx, page.id)?;
    let by_page = staging_by_page_prefix(page.id);
    let mut stagings = Vec::new();
    scan_prefix(&*tx, &by_page, false, &mut |k, _| {
        stagings.push((
            k.to_vec(),
            String::from_utf8_lossy(&k[by_page.len()..]).into_owned(),
        ));
        true
    })?;
    for (index_key, id) in stagings {
        if let Some(staging) = get_json::<StagingRecord>(&*tx, &staging_key(&id))? {
            delete_staging(tx, &staging)?;
        }
        delete_prefix(tx, &staging_text_prefix(&id))?;
        tx.delete(&index_key)?;
    }
    Ok(())
}

/// The `(source id, sha256)` of every text a page's manifest rows name. A retention purge reads
/// them before `remove_page` deletes the rows, as PGLite's `purgeDeletedPages` selects them first.
pub(crate) fn page_text_refs(read: &dyn KvRead, page_id: u64) -> Result<Vec<(String, Vec<u8>)>> {
    manifest_rows(read, page_id)?
        .into_iter()
        .map(|(_, row)| Ok((row.source_id, from_hex(&row.sha256, "manifest sha256")?)))
        .collect()
}

/// Retention purge: deletes every staging at a purged `(source id, slug)`, whatever page id it
/// names (a create staging names none), with its client key and recorded texts, as PGLite's
/// `purgeDeletedPages` deletes them by source and slug before it deletes the texts.
pub(crate) fn delete_slug_stagings(
    tx: &mut dyn KvWrite,
    source_id: &str,
    slugs: &[String],
) -> Result<()> {
    let gone: Vec<StagingRecord> = collect::<StagingRecord>(&*tx, &kind_key(STAGING))?
        .into_iter()
        .map(|(_, staging)| staging)
        .filter(|staging| staging.source_id == source_id && slugs.contains(&staging.slug))
        .collect();
    for staging in &gone {
        delete_staging(tx, staging)?;
    }
    Ok(())
}

/// Retention purge: deletes each text in `refs` that no manifest row still names and no live
/// staging recorded, in the purge's transaction, as PGLite's `purgeDeletedPages` deletes them
/// (`NOT EXISTS` a manifest row, `NOT stagingNeedsTextSql`). A text another page shares stays.
/// This store has no persistence requests, so a staging is live by its state alone.
pub(crate) fn delete_purged_texts(
    tx: &mut dyn KvWrite,
    refs: &BTreeSet<(String, Vec<u8>)>,
) -> Result<()> {
    if refs.is_empty() {
        return Ok(());
    }
    let mut needed: HashSet<(String, Vec<u8>)> = HashSet::new();
    for (_, row) in collect::<ManifestRow>(&*tx, &kind_key(MANIFEST))? {
        needed.insert((row.source_id, from_hex(&row.sha256, "manifest sha256")?));
    }
    let prefix = kind_key(STAGING_TEXT);
    for (key, source_id) in collect::<String>(&*tx, &prefix)? {
        let Some(split) = key.len().checked_sub(32).filter(|s| *s >= prefix.len()) else {
            continue;
        };
        let staging = String::from_utf8_lossy(&key[prefix.len()..split]).into_owned();
        let live = get_json::<StagingRecord>(&*tx, &staging_key(&staging))?
            .is_some_and(|s| LIVE_STAGING_STATES.contains(&s.state.as_str()));
        if live {
            needed.insert((source_id, key[split..].to_vec()));
        }
    }
    for (source_id, sha) in refs {
        if !needed.contains(&(source_id.clone(), sha.clone())) {
            tx.delete(&text_key(source_id, sha))?;
        }
    }
    Ok(())
}

/// Deletes a staging with its client key, recorded texts and page index entry.
fn delete_staging(tx: &mut dyn KvWrite, staging: &StagingRecord) -> Result<()> {
    tx.delete(&client_key(
        &staging.principal_kind,
        &staging.principal_id,
        &staging.client_request_id,
    ))?;
    tx.delete(&staging_key(&staging.id))?;
    delete_prefix(tx, &staging_text_prefix(&staging.id))?;
    if let Some(page_id) = staging.page_id {
        let mut key = staging_by_page_prefix(page_id);
        key.extend_from_slice(staging.id.as_bytes());
        tx.delete(&key)?;
    }
    Ok(())
}

/// Deletes this family's records of a source that is deleted (`cascade::remove_source_rows`), as
/// the Postgres `ON DELETE CASCADE` of `sources.id` does: the source's segment texts and its
/// stagings (with their client keys and recorded texts). Core removes the source's pages first,
/// so their manifests, derivations and body columns are gone already. A manifest row of another
/// source's page that still names one of these texts refuses the delete, as the manifest's
/// `NO ACTION` foreign key to `page_segment_texts` does in Postgres.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let mut referenced = None;
    let mut failure = None;
    scan_prefix(&*tx, &kind_key(MANIFEST), false, &mut |_, v| {
        match serde_json::from_slice::<ManifestRow>(v) {
            Ok(row) if row.source_id == source_id => referenced = Some(row.page_id),
            Ok(_) => {}
            Err(e) => failure = Some(StoreError::from(e)),
        }
        referenced.is_none() && failure.is_none()
    })?;
    if let Some(e) = failure {
        return Err(e);
    }
    if let Some(page_id) = referenced {
        return Err(violation(format!(
            "update or delete on table \"page_segment_texts\" violates foreign key constraint on table \"page_body_manifest\" (page {page_id} still names a text of source \"{source_id}\")"
        )));
    }
    let mut texts = kind_key(TEXT);
    texts.extend_from_slice(source_id.as_bytes());
    texts.push(0);
    delete_prefix(tx, &texts)?;
    let stagings: Vec<StagingRecord> = collect::<StagingRecord>(&*tx, &kind_key(STAGING))?
        .into_iter()
        .map(|(_, s)| s)
        .filter(|s| s.source_id == source_id)
        .collect();
    for staging in &stagings {
        delete_staging(tx, staging)?;
    }
    purge_record::remove_source_records(tx, source_id)
}

/// Adds this family's `getPage` columns to a page (`page_columns::add_page_columns`): a segmented
/// page's `body_storage` and `body_bytes`, as PGLite's `rowToPage` adds them. An inline page gets
/// neither.
pub(crate) fn page_columns(
    read: &dyn KvRead,
    page: &PageRecord,
    columns: &mut PageColumns,
) -> Result<()> {
    let state = read_body_state(read, page.id)?;
    if let Some(state) = state.filter(|s| s.body_storage == "segmented") {
        columns.set("body_storage", Value::String(state.body_storage));
        columns.set("body_bytes", json!(state.body_bytes));
    }
    Ok(())
}

/// A page's `body_storage` and `body_bytes` columns: `('inline', None)` for a page with no body state, as the column
/// default reads.
pub(crate) fn body_storage_columns(
    read: &dyn KvRead,
    page_id: u64,
) -> Result<(String, Option<i64>)> {
    Ok(read_body_state(read, page_id)?.map_or_else(
        || ("inline".to_string(), None),
        |s| (s.body_storage, s.body_bytes),
    ))
}

/// Whether a published manifest row of the page (`gen_to IS NULL AND staging_id IS NULL`) has a facts slot
/// (`facts_slots <> '[]'::jsonb`; a NULL `facts_slots` compares as unknown, so it does not).
pub(crate) fn has_published_facts_slot(read: &dyn KvRead, page_id: u64) -> Result<bool> {
    Ok(manifest_rows(read, page_id)?.iter().any(|(_, row)| {
        live_published(row)
            && !row.facts_slots.is_null()
            && row.facts_slots != Value::Array(Vec::new())
    }))
}

/// The live body generation and `body_bytes` of a segmented page, which its version snapshot
/// references (`insertSegmentedVersion`); `None` for an inline page or a missing one.
pub(crate) fn segmented_reference(
    read: &dyn KvRead,
    page_id: u64,
) -> Result<Option<(i64, Option<i64>)>> {
    Ok(read_body_state(read, page_id)?
        .filter(|state| state.body_storage == "segmented")
        .map(|state| (state.body_generation, state.body_bytes)))
}

/// Whether a page body is segmented, its `body_bytes` and its `truth_bytes`.
pub(crate) type BodySizes = (bool, Option<i64>, Option<i64>);

/// The size columns of page `page_id`'s body state: whether it is segmented, `body_bytes` and
/// `truth_bytes`. `None` when the page has no body state (an inline page that was never segmented).
pub(crate) fn body_sizes(read: &dyn KvRead, page_id: u64) -> Result<Option<BodySizes>> {
    Ok(read_body_state(read, page_id)?.map(|state| {
        (
            state.body_storage == "segmented",
            state.body_bytes,
            state.truth_bytes,
        )
    }))
}

/// PGLite's `liveStagingIds`: stagings in a live state, plus the stagings an outstanding request
/// names (`held`, whatever their state).
fn live_staging_ids(read: &dyn KvRead, held: &HashSet<String>) -> Result<HashSet<String>> {
    let mut live = held.clone();
    for (_, staging) in collect::<StagingRecord>(read, &kind_key(STAGING))? {
        if LIVE_STAGING_STATES.contains(&staging.state.as_str()) {
            live.insert(staging.id);
        }
    }
    Ok(live)
}

fn staged_by(row: &ManifestRow, live: &HashSet<String>) -> Option<bool> {
    row.staging_id.as_ref().map(|id| live.contains(id))
}

/// Step 6 of `sweep_segments`: deletes the texts created before `before` in `source` (every
/// source when `None`; only the shas in `released` when given) that no manifest row names, that
/// no live staging of their source predates, and that no live staging recorded.
fn sweep_texts(
    tx: &mut dyn KvWrite,
    live: &HashSet<String>,
    before: i64,
    source: Option<&str>,
    released: Option<&HashSet<String>>,
) -> Result<u64> {
    let mut named: HashSet<(String, String)> = HashSet::new();
    for (_, row) in collect::<ManifestRow>(&*tx, &kind_key(MANIFEST))? {
        named.insert((row.source_id, row.sha256));
    }
    // The oldest live staging of each source, and the texts live stagings recorded.
    let mut oldest_live: HashMap<String, i64> = HashMap::new();
    let mut recorded: HashSet<(String, String)> = HashSet::new();
    for (_, staging) in collect::<StagingRecord>(&*tx, &kind_key(STAGING))? {
        if !live.contains(&staging.id) {
            continue;
        }
        let oldest = oldest_live
            .entry(staging.source_id.clone())
            .or_insert(staging.created_at_us);
        *oldest = (*oldest).min(staging.created_at_us);
        let prefix = staging_text_prefix(&staging.id);
        for (key, text_source) in collect::<String>(&*tx, &prefix)? {
            recorded.insert((text_source, to_hex(&key[prefix.len()..])));
        }
    }
    let mut prefix = kind_key(TEXT);
    if let Some(source) = source {
        prefix.extend_from_slice(source.as_bytes());
        prefix.push(0);
    }
    let mut gone = Vec::new();
    for (key, text) in collect::<TextRecord>(&*tx, &prefix)? {
        let tail = &key[2..];
        let Some(split) = tail.len().checked_sub(33).filter(|at| tail[*at] == 0) else {
            continue;
        };
        let text_source = String::from_utf8_lossy(&tail[..split]).into_owned();
        let sha = to_hex(&tail[split + 1..]);
        if source.is_some_and(|src| src != text_source) {
            continue;
        }
        if text.created_at_us >= before
            || released.is_some_and(|set| !set.contains(&sha))
            || oldest_live
                .get(&text_source)
                .is_some_and(|oldest| *oldest <= text.created_at_us)
        {
            continue;
        }
        let id = (text_source, sha);
        if !named.contains(&id) && !recorded.contains(&id) {
            gone.push(key);
        }
    }
    for key in &gone {
        tx.delete(key)?;
    }
    Ok(gone.len() as u64)
}

// ---------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------

impl Store {
    /// `allocateBodyOccurrenceIds(count)`: the next `count` occurrence ids, ascending; `[]` for a
    /// count of 0 or less.
    pub fn allocate_body_occurrence_ids(&self, count: i64) -> Result<Vec<i64>> {
        if count <= 0 {
            return Ok(Vec::new());
        }
        int4(count, "allocateBodyOccurrenceIds count")?;
        self.write(|tx| {
            let first = tx.allocate(&keys::meta(NEXT_OCCURRENCE_ID), count as u64)?;
            let next = first + count as u64;
            Ok((first..next).map(|v| v as i64).collect())
        })
    }

    /// `stageSegmentTexts(sourceId, texts, { stagingId? })`: stores each text once per source
    /// (the first of a repeated sha256 wins) and returns `{ inserted }`, the texts that were new.
    /// A text already stored keeps its body and gets a fresh `created_at`. With `stagingId`, each
    /// sha256 is recorded under the staging first.
    pub fn stage_segment_texts(
        &self,
        source_id: &str,
        texts: &[SegmentTextInput],
        options: &StageTextsOptions,
    ) -> Result<Value> {
        if texts.is_empty() {
            return Ok(json!({ "inserted": 0 }));
        }
        no_nul(source_id, "stageSegmentTexts sourceId")?;
        let staging = options
            .staging_id
            .as_deref()
            .map(staging_id_arg)
            .transpose()?;
        let mut seen = HashSet::new();
        let mut batch = Vec::new();
        for text in texts {
            let sha = from_hex(&text.sha256, "stageSegmentTexts sha256")?;
            if !seen.insert(sha.clone()) {
                continue;
            }
            batch.push((sha, text));
        }
        let mut decoded = Vec::with_capacity(batch.len());
        for (sha, text) in &batch {
            if sha.len() != 32 {
                return Err(violation(
                    "new row for relation \"page_segment_texts\" violates check constraint (sha256 is not 32 bytes)",
                ));
            }
            let body = from_hex(&text.body, "stageSegmentTexts body")?;
            if body.is_empty() || body.len() > MAX_SEGMENT_BYTES {
                return Err(violation(
                    "new row for relation \"page_segment_texts\" violates check constraint (byte_len BETWEEN 1 AND 1048576)",
                ));
            }
            int4(text.line_count, "stageSegmentTexts lineCount")?;
            if text.line_count < 0 {
                return Err(violation(
                    "new row for relation \"page_segment_texts\" violates check constraint (line_count >= 0)",
                ));
            }
            decoded.push((sha.clone(), body, text.line_count));
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            if let Some(staging) = &staging {
                if tx.get(&staging_key(staging))?.is_none() {
                    return Err(violation(format!(
                        "insert into \"page_body_staging_texts\" violates foreign key: staging {staging} does not exist"
                    )));
                }
                for (sha, _, _) in &decoded {
                    let mut key = staging_text_prefix(staging);
                    key.extend_from_slice(sha);
                    if tx.get(&key)?.is_none() {
                        put_json(tx, &key, &source_id)?;
                    }
                }
            }
            if crate::sources::read_source(&*tx, source_id)?.is_none() {
                return Err(violation(format!(
                    "insert into \"page_segment_texts\" violates foreign key: source \"{source_id}\" does not exist"
                )));
            }
            let mut inserted = 0u64;
            for (sha, body, line_count) in &decoded {
                let key = text_key(source_id, sha);
                let record = match get_json::<TextRecord>(&*tx, &key)? {
                    Some(old) => TextRecord {
                        created_at_us: now,
                        ..old
                    },
                    None => {
                        inserted += 1;
                        TextRecord {
                            byte_len: body.len() as i64,
                            line_count: *line_count,
                            body: to_hex(body),
                            created_at_us: now,
                        }
                    }
                };
                put_json(tx, &key, &record)?;
            }
            Ok(json!({ "inserted": inserted }))
        })
    }

    /// `readSegmentTexts(sourceId, sha256s)`: `[sha256 hex, body hex]` for each text of this
    /// source that exists, in request order, each once.
    pub fn read_segment_texts(
        &self,
        source_id: &str,
        sha256s: &[String],
    ) -> Result<Vec<(String, String)>> {
        if sha256s.is_empty() {
            return Ok(Vec::new());
        }
        no_nul(source_id, "readSegmentTexts sourceId")?;
        let read = self.read()?;
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for sha in sha256s {
            let bytes = from_hex(sha, "readSegmentTexts sha256")?;
            if !seen.insert(bytes.clone()) {
                continue;
            }
            if let Some(text) = get_json::<TextRecord>(&*read, &text_key(source_id, &bytes))? {
                out.push((to_hex(&bytes), text.body));
            }
        }
        Ok(out)
    }

    /// `stageManifestRows(rows)`: inserts each row open (`gen_to` null). Refuses the whole batch
    /// on a row whose page or text does not exist, whose region or cut kind is unknown, whose key
    /// (page, occurrence, gen_from, staging) is taken, or that would publish a second live row at
    /// one seq.
    pub fn stage_manifest_rows(&self, rows: &[ManifestRow]) -> Result<()> {
        let mut prepared = Vec::with_capacity(rows.len());
        for row in rows {
            prepared.push(prepare_manifest_row(row)?);
        }
        if prepared.is_empty() {
            return Ok(());
        }
        self.write(|tx| {
            let mut live_seqs: HashMap<u64, HashSet<i64>> = HashMap::new();
            for (row, staging) in &prepared {
                let Some(page_id) = page_u64(row.page_id).filter(|id| {
                    matches!(read_page_by_id(&*tx, *id), Ok(Some(_)))
                }) else {
                    return Err(violation(format!(
                        "insert into \"page_body_manifest\" violates foreign key: page {} does not exist",
                        row.page_id
                    )));
                };
                let sha = from_hex(&row.sha256, "manifest sha256")?;
                if tx.get(&text_key(&row.source_id, &sha))?.is_none() {
                    return Err(violation(format!(
                        "insert into \"page_body_manifest\" violates foreign key: no segment text {} in source \"{}\"",
                        row.sha256, row.source_id
                    )));
                }
                let key = manifest_key(page_id, row.occurrence_id, row.gen_from, staging);
                if tx.get(&key)?.is_some() {
                    return Err(violation(format!(
                        "duplicate key value violates unique constraint \"page_body_manifest_pkey\" (page {}, occurrence {}, gen_from {})",
                        row.page_id, row.occurrence_id, row.gen_from
                    )));
                }
                if row.staging_id.is_none() {
                    let seqs = match live_seqs.entry(page_id) {
                        std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
                        std::collections::hash_map::Entry::Vacant(e) => e.insert(
                            manifest_rows(&*tx, page_id)?
                                .into_iter()
                                .filter(|(_, r)| live_published(r))
                                .map(|(_, r)| r.seq)
                                .collect(),
                        ),
                    };
                    if !seqs.insert(row.seq) {
                        return Err(violation(format!(
                            "duplicate key value violates unique constraint \"page_body_manifest_live_seq\" (page {}, seq {})",
                            row.page_id, row.seq
                        )));
                    }
                }
                put_json(tx, &key, row)?;
            }
            Ok(())
        })
    }

    /// `readSegmentedEmbedPage(ref)`: the page `ref` names when it is segmented, not deleted, in a
    /// source that exists and is not archived, and sealed (its text projection is at its knowledge
    /// revision, `currentTextProjectionFilter`); `None` otherwise, an inline page included. The
    /// same tests as the `pages JOIN sources` read PGLite sends.
    pub fn read_segmented_embed_page(
        &self,
        reference: &SegmentedEmbedRef,
    ) -> Result<Option<SegmentedEmbedPage>> {
        let read = self.read()?;
        let page = match reference {
            SegmentedEmbedRef::Id { id } => match page_u64(*id) {
                Some(id) => read_page_by_id(&*read, id)?,
                None => None,
            },
            SegmentedEmbedRef::Slug { source_id, slug } => read_page(&*read, source_id, slug)?,
        };
        let Some(page) = page else {
            return Ok(None);
        };
        let Some((_, body_bytes)) = segmented_reference(&*read, page.id)? else {
            return Ok(None);
        };
        let sealed =
            page.text_projection_revision.as_deref() == Some(page.knowledge_revision.as_str());
        if page.deleted_at_us.is_some() || !sealed {
            return Ok(None);
        }
        match crate::sources::read_source(&*read, &page.source_id)? {
            Some(source) if !source.archived => {}
            _ => return Ok(None),
        }
        Ok(Some(SegmentedEmbedPage {
            id: page.id,
            contextual_retrieval_mode: crate::aliases::contextual_retrieval_mode(&*read, page.id)?,
            slug: page.slug,
            source_id: page.source_id,
            title: page.title,
            body_bytes,
        }))
    }

    /// `readManifest(pageId, { generation?, stagingId?, region?, lastN? })`: with `stagingId`, that
    /// staging's rows; otherwise the published rows of `generation` (default: the page's body
    /// generation; none for a page that does not exist). By seq; `lastN` keeps the last n.
    pub fn read_manifest(
        &self,
        page_id: i64,
        options: &ReadManifestOptions,
    ) -> Result<Vec<ManifestRow>> {
        let staging = options
            .staging_id
            .as_deref()
            .map(staging_id_arg)
            .transpose()?;
        if let Some(n) = options.last_n
            && n < 0
        {
            return Err(StoreError::invalid(
                "readManifest lastN: LIMIT must not be negative",
            ));
        }
        let Some(page) = page_u64(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let generation = match (&staging, options.generation) {
            (Some(_), _) => None,
            (None, Some(g)) => Some(g),
            (None, None) => match read_page_by_id(&*read, page)? {
                Some(_) => Some(read_body_state(&*read, page)?.map_or(0, |s| s.body_generation)),
                None => return Ok(Vec::new()),
            },
        };
        let region = options.region.as_deref().filter(|r| !r.is_empty());
        let mut rows: Vec<ManifestRow> = manifest_rows(&*read, page)?
            .into_iter()
            .map(|(_, r)| r)
            .filter(|r| match (&staging, generation) {
                (Some(id), _) => r.staging_id.as_deref() == Some(id.as_str()),
                (None, Some(g)) => in_generation(r, g),
                (None, None) => false,
            })
            .filter(|r| region.is_none_or(|want| r.region == want))
            .collect();
        rows.sort_by_key(|r| r.seq);
        if let Some(n) = options.last_n {
            let n = n as usize;
            if rows.len() > n {
                rows.drain(..rows.len() - n);
            }
        }
        Ok(rows)
    }

    /// `createSegmentedPageShell(slug, meta, { sourceId })`: a segmented page at body generation 0
    /// with an empty body; returns `{ id }`. Refuses a slug already taken in the source (deleted
    /// pages included).
    pub fn create_segmented_page_shell(
        &self,
        slug: &str,
        meta: &SegmentedPageMeta,
        options: &ShellOptions,
    ) -> Result<Value> {
        let slug = validate_slug(slug)?;
        let source_id = options.source_id.clone().ok_or_else(|| {
            violation("null value in column \"source_id\" of relation \"pages\" violates not-null constraint")
        })?;
        let page_type = meta_type(meta)?;
        let effective_date = meta
            .effective_date
            .as_deref()
            .map(|d| parse_time(d, "createSegmentedPageShell effective_date"))
            .transpose()?;
        let now = self.env.now_micros();
        self.write(|tx| {
            if crate::sources::read_source(&*tx, &source_id)?.is_none() {
                return Err(violation(format!(
                    "insert into \"pages\" violates foreign key: source \"{source_id}\" does not exist"
                )));
            }
            if read_page(&*tx, &source_id, &slug)?.is_some() {
                return Err(violation(format!(
                    "duplicate key value violates unique constraint \"pages_source_slug_key\" ({source_id}, {slug})"
                )));
            }
            // One live page per recorded origin (PGLite's pages_live_origin_key).
            crate::pages::assert_origin_unclaimed(&*tx, &source_id, &slug, None, meta.source_path.as_deref())?;
            let record = PageRecord {
                id: next_id(tx, NEXT_PAGE_ID)?,
                source_id: source_id.clone(),
                slug: slug.clone(),
                page_type: page_type.clone(),
                page_kind: meta_page_kind(meta),
                title: clean(&meta.title),
                // A shell holds no inline body and no hash until a flip publishes one, as in PGLite.
                compiled_truth: PageText::null(),
                timeline: PageText::null(),
                frontmatter: meta.frontmatter.clone().unwrap_or_default(),
                content_hash: None,
                chunker_version: Some(smallint_chunker_version(meta)?.unwrap_or(0)),
                source_path: meta.source_path.clone(),
                knowledge_revision: self.env.new_uuid(),
                text_projection_revision: None,
                created_at_us: now,
                updated_at_us: now,
                deleted_at_us: None,
                effective_date_us: effective_date,
                effective_date_source: meta.effective_date_source.clone(),
                import_filename: meta.import_filename.clone(),
                source_kind: meta.source_kind.clone(),
                source_uri: meta.source_uri.clone(),
                database_only_reason: None,
                ingested_via: meta.ingested_via.clone(),
                ingested_at_us: meta_ingested(meta).then_some(now),
                tags: Vec::new(),
                tag_sources: BTreeMap::new(),
                trust_tier: None,
                write_origin: None,
                version_history_gap_at_us: None,
                revision_receipt: Default::default(),
            };
            write_page(tx, &record)?;
            let state = BodyState {
                body_storage: "segmented".into(),
                body_generation: 0,
                body_bytes: Some(0),
                chunker_version: Some(meta_chunker_version(meta).unwrap_or(0)),
                ..BodyState::default()
            };
            put_json(tx, &body_key(record.id), &state)?;
            Ok(json!({ "id": record.id }))
        })
    }

    /// `flipBodyGeneration(input)`: publishes the staging's rows as generation
    /// `expectedGeneration + 1` in one write. Closes `closeOccurrences`, retires the page's inline
    /// chunks when `retireInlineChunks` (unless more than `retireMaxRows`, which defers them), sets
    /// the page segmented with the new body columns and meta, and refuses (writing nothing) when
    /// the page is gone, its generation moved, the staging is not live, or the new generation does
    /// not tile the body.
    pub fn flip_body_generation(&self, input: &BodyFlipInput) -> Result<BodyFlipResult> {
        if input.new_generation != input.expected_generation.wrapping_add(1) {
            return Err(StoreError::invalid(
                "newGeneration must be expectedGeneration + 1",
            ));
        }
        let staging = staging_id_arg(&input.staging_id)?;
        let page_type = meta_type(&input.meta)?;
        let effective_date = input
            .meta
            .effective_date
            .as_deref()
            .map(|d| parse_time(d, "flipBodyGeneration effective_date"))
            .transpose()?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut page) = page_u64(input.page_id)
                .map(|id| read_page_by_id(&*tx, id))
                .transpose()?
                .flatten()
            else {
                return Err(body_error(json!({ "kind": "page_identity_changed", "page_id": input.page_id })));
            };
            let old_state = read_body_state(&*tx, page.id)?;
            let current = old_state.as_ref().map_or(0, |s| s.body_generation);
            if current != input.expected_generation {
                return Err(body_error(json!({
                    "kind": "revision_changed", "slug": page.slug, "source_id": page.source_id,
                    "expected": input.expected_generation, "current": current,
                })));
            }
            // The flip keeps or sets the page's origin and revives a deleted page, so it must not take an
            // origin another live page holds (PGLite's pages_live_origin_key).
            crate::pages::assert_origin_unclaimed(&*tx, &page.source_id, &page.slug, Some(&page), input.meta.source_path.as_deref())?;
            let staged: Option<StagingRecord> = get_json(&*tx, &staging_key(&staging))?;
            if !staged
                .as_ref()
                .is_some_and(|s| LIVE_STAGING_STATES.contains(&s.state.as_str()))
            {
                return Err(body_error(json!({
                    "kind": "staging_gone", "slug": page.slug, "staging_id": staging,
                    "state": staged.map(|s| s.state),
                })));
            }
            let close: HashSet<i64> = input.close_occurrences.iter().copied().collect();
            let rows = manifest_rows(&*tx, page.id)?;
            // PGLite's retire predicate, read before any manifest row moves: chunks of
            // `retireChunkOccurrences` at or below the expected generation, the inline chunks
            // when asked, and chunks staged for the new generation whose occurrence is not live in
            // it (`newLive`: this staging's rows plus the open published rows it does not close).
            let new_live: BTreeSet<u64> = rows
                .iter()
                .filter(|(_, r)| {
                    r.staging_id.as_deref() == Some(staging.as_str())
                        || (live_published(r) && !close.contains(&r.occurrence_id))
                })
                .filter_map(|(_, r)| u64::try_from(r.occurrence_id).ok())
                .collect();
            let retire_occurrences: BTreeSet<u64> = input
                .retire_chunk_occurrences
                .iter()
                .filter_map(|o| u64::try_from(*o).ok())
                .collect();
            let retire_inline = input.retire_inline_chunks == Some(true);
            // Both generations are at least 0 here: the expected one equals the stored one.
            let expected_generation = u64::try_from(input.expected_generation).unwrap_or(0);
            let new_generation = u64::try_from(input.new_generation).unwrap_or(0);
            let retire = |c: &crate::chunks::ChunkRecord| {
                crate::chunks::occurrence_match(c.segment, &retire_occurrences, Some(expected_generation))
                    || (retire_inline && c.segment.is_none())
                    || crate::chunks::generation_match(c.segment, new_generation, &new_live)
            };
            let to_retire = crate::chunks::count_chunks_matching(&*tx, page.id, &retire)? as u64;
            let retire_deferred = i128::from(to_retire) > i128::from(input.retire_max_rows);
            let staging_bytes = uuid_bytes(&staging);
            let mut live_seqs: HashSet<i64> = HashSet::new();
            let mut moved = Vec::new();
            let mut closed_live: BTreeSet<(String, u64)> = BTreeSet::new();
            for (key, mut row) in rows {
                if live_published(&row) && close.contains(&row.occurrence_id) {
                    // A live published row closes: the trigger notes it under the row's own source, as `derivation_sweep::note_row_gone` does.
                    closed_live.insert((row.source_id.clone(), page.id));
                    row.gen_to = Some(input.new_generation);
                    put_json(tx, &key, &row)?;
                } else if row.staging_id.as_deref() == Some(staging.as_str()) {
                    moved.push((key, row));
                    continue;
                }
                if live_published(&row) {
                    live_seqs.insert(row.seq);
                }
            }
            // A live segment of the page is retired: rows its occurrence backed enter a fact purge's derivation sweep's scope.
            for (source, page_id) in &closed_live {
                derivation_sweep::note_scope_entry(tx, source, *page_id)?;
            }
            let retired = if retire_deferred || to_retire == 0 {
                0
            } else {
                crate::chunks::delete_chunks_matching(tx, page.id, &retire)?.len() as u64
            };
            for (key, _) in &moved {
                tx.delete(key)?;
            }
            for (key, mut row) in moved {
                debug_assert!(key.ends_with(&staging_bytes));
                row.staging_id = None;
                let page_id = page.id;
                let published = manifest_key(page_id, row.occurrence_id, row.gen_from, &NIL_STAGING);
                if tx.get(&published)?.is_some() {
                    return Err(violation(format!(
                        "duplicate key value violates unique constraint \"page_body_manifest_pkey\" (page {page_id}, occurrence {}, gen_from {})",
                        row.occurrence_id, row.gen_from
                    )));
                }
                if row.gen_to.is_none() && !live_seqs.insert(row.seq) {
                    return Err(violation(format!(
                        "duplicate key value violates unique constraint \"page_body_manifest_live_seq\" (page {page_id}, seq {})",
                        row.seq
                    )));
                }
                put_json(tx, &published, &row)?;
            }
            let meta = &input.meta;
            let body = &input.body;
            let before = page.clone();
            page.page_type = page_type.clone();
            page.page_kind = meta_page_kind(meta);
            page.title = clean(&meta.title);
            page.frontmatter = meta.frontmatter.clone().unwrap_or_default();
            page.compiled_truth = PageText::null();
            page.timeline = PageText::null();
            page.content_hash = Some(body.content_hash.clone());
            page.chunker_version = smallint_chunker_version(meta)?.or(page.chunker_version);
            page.updated_at_us = now;
            page.deleted_at_us = None;
            page.effective_date_us = effective_date.or(page.effective_date_us);
            page.effective_date_source = meta.effective_date_source.clone().or(page.effective_date_source.take());
            page.import_filename = meta.import_filename.clone().or(page.import_filename.take());
            page.source_path = meta.source_path.clone().or(page.source_path.take());
            page.source_kind = meta.source_kind.clone().or(page.source_kind.take());
            page.source_uri = meta.source_uri.clone().or(page.source_uri.take());
            page.ingested_via = meta.ingested_via.clone().or(page.ingested_via.take());
            if meta_ingested(meta) {
                page.ingested_at_us = Some(now);
            }
            // The body generation moved, so Postgres's revision trigger advances the revision, unless the
            // caller materializes the page's own revision and the flip changed none of its tracked columns.
            if !keeps_revision(input.keep_revision.as_deref(), &before, &page) {
                page.knowledge_revision = self.env.new_uuid();
                page.text_projection_revision = None;
            }
            let state = BodyState {
                body_storage: "segmented".into(),
                body_generation: input.new_generation,
                body_bytes: Some(body.body_bytes),
                truth_bytes: Some(body.truth_bytes),
                body_lines: Some(body.body_lines),
                segment_count: Some(body.segment_count),
                segmenter_version: Some(body.segmenter_version),
                truth_lead: Some(clean(&body.truth_lead)),
                timeline_lead: Some(clean(&body.timeline_lead)),
                body_flags: Some(body.body_flags.clone()),
                chunker_version: meta_chunker_version(meta)
                    .or(old_state.as_ref().and_then(|s| s.chunker_version)),
            };
            // The flip is one UPDATE that sets the title, the NULL timeline and the new lead together, so PGLite's
            // search vector trigger builds the vector from the incoming lead, and its error aborts the flip. The
            // state is stored first because the check reads the lead from it; a later refusal rolls both back. The
            // trigger fires also when the title is unchanged: the vector is checked and the sealed search timeline
            // goes.
            put_json(tx, &body_key(page.id), &state)?;
            crate::pages::write_page_setting_vector(tx, &page)?;
            let live: Vec<ManifestRow> = manifest_rows(&*tx, page.id)?
                .into_iter()
                .map(|(_, r)| r)
                .filter(|r| in_generation(r, input.new_generation))
                .collect();
            let refs: Vec<&ManifestRow> = live.iter().collect();
            let (n, covered, gapless) = tiling(&refs);
            if !gapless || covered != body.body_bytes {
                return Err(body_error(json!({
                    "kind": "generation_incomplete", "slug": page.slug, "staging_id": staging,
                    "rows": n, "covered": covered, "gapless": gapless,
                    "body_bytes": body.body_bytes, "segment_count": body.segment_count,
                })));
            }
            // Chunks staged for the new generation become visible, ordered by the byte_start of
            // their occurrence's live row.
            let offsets = live
                .iter()
                .filter_map(|r| Some((u64::try_from(r.occurrence_id).ok()?, u64::try_from(r.byte_start).ok()?)))
                .collect();
            crate::chunks::publish_segment_chunks(tx, page.id, new_generation, offsets)?;
            Ok(BodyFlipResult {
                retired_chunks: retired,
                retire_deferred,
            })
        })
    }

    /// `stageSegmentChunks(pageId, generation, chunks)`: writes the chunks of a segmented write
    /// for body generation `generation` at the indexes after the page's highest `chunk_index` and
    /// returns those indexes. They stay hidden until a flip publishes that generation. Refuses
    /// (writing nothing) with `revision_changed` when the page is gone, the generation is below the
    /// page's, or the generation is the page's and the page is inline or an occurrence has no
    /// published row in it, as PGLite does. No chunks: no read, no write, `[]`.
    pub fn stage_segment_chunks(
        &self,
        page_id: i64,
        generation: i64,
        chunks: &[crate::chunks::SegmentChunkInput],
    ) -> Result<Vec<u32>> {
        if chunks.is_empty() {
            return Ok(Vec::new());
        }
        self.write(|tx| {
            let page = page_u64(page_id)
                .map(|id| read_page_by_id(&*tx, id))
                .transpose()?
                .flatten();
            let refuse = |slug: Option<&str>, live: Option<i64>| {
                body_error(json!({
                    "kind": "chunks_stale", "page_id": page_id, "slug": slug,
                    "staged_generation": generation, "current_generation": live,
                }))
            };
            let Some(page) = page else {
                return Err(refuse(None, None));
            };
            let state = read_body_state(&*tx, page.id)?;
            let live = state.as_ref().map_or(0, |s| s.body_generation);
            let segmented = is_segmented(state.as_ref());
            let stale = generation < live
                || (generation == live && !segmented)
                || (generation == live && {
                    let rows = manifest_rows(&*tx, page.id)?;
                    let published: HashSet<i64> = rows
                        .iter()
                        .filter(|(_, r)| in_generation(r, generation))
                        .map(|(_, r)| r.occurrence_id)
                        .collect();
                    chunks.iter().any(|c| {
                        i64::try_from(c.occurrence_id).map_or(true, |o| !published.contains(&o))
                    })
                });
            if stale {
                return Err(refuse(Some(&page.slug), Some(live)));
            }
            // Not stale, so the generation is at or above the page's, which is at least 0.
            let at = u64::try_from(generation).unwrap_or(0);
            crate::chunks::append_segment_chunks(tx, page.id, at, chunks, self.env.now_micros())
        })
    }

    /// The stored timeline lead of page `page_id` (`""` when none was published) with the page's
    /// `knowledge_revision`, slug and source, or `None` for a missing page. Not a member:
    /// `sealSegmentedPage`'s TypeScript side reads it, overlays the lead with the page's ledger rows
    /// (read by slug and source), sanitizes it, and passes the revision back to
    /// [`Store::seal_segmented_page`].
    pub fn read_segmented_seal_lead(&self, page_id: i64) -> Result<Option<SealLead>> {
        let read = self.read()?;
        let Some(page) = page_u64(page_id)
            .map(|id| read_page_by_id(&*read, id))
            .transpose()?
            .flatten()
        else {
            return Ok(None);
        };
        let lead = timeline_lead(&*read, page.id)?.unwrap_or_default();
        Ok(Some(SealLead {
            lead,
            revision: page.knowledge_revision,
            slug: page.slug,
            source_id: page.source_id,
        }))
    }

    /// `sealSegmentedPage(pageId, opts)`: seals the page's text projection at its current revision
    /// (its chunks become visible) and records `timeline`, the lead TypeScript sanitized, as the
    /// timeline text of its keyword vector (`pages::record_search_timeline`). The chunker stamp
    /// keeps an older segmented chunker (at or above `SAFE_FENCE_CHUNKER_VERSION`, below
    /// `SEGMENTED_CHUNKER_VERSION`) while any segment chunk from before the page's body generation
    /// is still stored, and is `SEGMENTED_CHUNKER_VERSION` otherwise; an inline chunk never counts,
    /// as PGLite's NULL `body_generation` does not. A missing page is a no-op. Refuses with
    /// `revision_conflict` when `expected_revision` is given and the page moved past it since the
    /// lead was read.
    pub fn seal_segmented_page(
        &self,
        page_id: i64,
        timeline: &str,
        expected_revision: Option<&str>,
    ) -> Result<()> {
        self.write(|tx| {
            let Some(mut page) = page_u64(page_id)
                .map(|id| read_page_by_id(&*tx, id))
                .transpose()?
                .flatten()
            else {
                return Ok(());
            };
            if expected_revision.is_some_and(|r| !r.eq_ignore_ascii_case(&page.knowledge_revision)) {
                return Err(StoreError::new(
                    REVISION_CONFLICT,
                    "The page changed after its timeline lead was read. Read it again before sealing.",
                ));
            }
            let mut state = read_body_state(&*tx, page.id)?;
            let generation = state.as_ref().map_or(0, |s| s.body_generation);
            let stamped = page.chunker_version.unwrap_or(0);
            let older = (SAFE_FENCE_CHUNKER_VERSION..i64::from(SEGMENTED_CHUNKER_VERSION))
                .contains(&i64::from(stamped))
                && crate::chunks::count_chunks_matching(&*tx, page.id, &|c| {
                    c.segment
                        .is_some_and(|place| i64::try_from(place.body_generation).is_ok_and(|g| g < generation))
                })? > 0;
            let version = if older { stamped } else { SEGMENTED_CHUNKER_VERSION };
            page.chunker_version = Some(version);
            page.text_projection_revision = Some(page.knowledge_revision.clone());
            write_page(tx, &page)?;
            if let Some(state) = state.as_mut() {
                state.chunker_version = Some(i64::from(version));
                put_json(tx, &body_key(page.id), state)?;
            }
            crate::pages::record_search_timeline(
                tx,
                page.id,
                &page.knowledge_revision,
                &page.title,
                timeline,
            )
        })
    }

    /// `openBodyStaging(input)`: a new staging in state `open`. Refuses a taken id or client
    /// request (principal kind, principal id, client request id), an unknown source or page, an
    /// unknown kind or mode, and negative declared bytes.
    pub fn open_body_staging(&self, input: &BodyStagingInput) -> Result<()> {
        let id = norm_uuid(&input.id, "openBodyStaging id")?;
        let client_request_id =
            norm_uuid(&input.client_request_id, "openBodyStaging clientRequestId")?;
        let source_incarnation = norm_uuid(
            &input.source_incarnation,
            "openBodyStaging sourceIncarnation",
        )?;
        let base_revision = input
            .base_revision
            .as_deref()
            .map(|r| norm_uuid(r, "openBodyStaging baseRevision"))
            .transpose()?;
        let declared_sha256 = input
            .declared_sha256
            .as_deref()
            .map(|s| from_hex(s, "openBodyStaging declaredSha256").map(|b| to_hex(&b)))
            .transpose()?;
        for (text, what) in [
            (&input.principal_kind, "principalKind"),
            (&input.principal_id, "principalId"),
            (&input.source_id, "sourceId"),
            (&input.slug, "slug"),
        ] {
            no_nul(text, what)?;
        }
        let idle = parse_time(&input.idle_expires_at, "openBodyStaging idleExpiresAt")?;
        let hard = parse_time(&input.hard_expires_at, "openBodyStaging hardExpiresAt")?;
        if !STAGING_KINDS.contains(&input.kind.as_str()) {
            return Err(violation(format!(
                "new row for relation \"page_body_stagings\" violates check constraint (kind \"{}\")",
                input.kind
            )));
        }
        if !STAGING_MODES.contains(&input.mode.as_str()) {
            return Err(violation(format!(
                "new row for relation \"page_body_stagings\" violates check constraint (mode \"{}\")",
                input.mode
            )));
        }
        if input.declared_bytes < 0 {
            return Err(violation(
                "new row for relation \"page_body_stagings\" violates check constraint (declared_bytes >= 0)",
            ));
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            if tx.get(&staging_key(&id))?.is_some() {
                return Err(violation(format!(
                    "duplicate key value violates unique constraint \"page_body_stagings_pkey\" ({id})"
                )));
            }
            let client = client_key(&input.principal_kind, &input.principal_id, &client_request_id);
            if tx.get(&client)?.is_some() {
                return Err(violation(
                    "duplicate key value violates unique constraint (principal_kind, principal_id, client_request_id)",
                ));
            }
            if crate::sources::read_source(&*tx, &input.source_id)?.is_none() {
                return Err(violation(format!(
                    "insert into \"page_body_stagings\" violates foreign key: source \"{}\" does not exist",
                    input.source_id
                )));
            }
            let page_id = match input.page_id {
                None => None,
                Some(raw) => match page_u64(raw).filter(|id| matches!(read_page_by_id(&*tx, *id), Ok(Some(_)))) {
                    Some(id) => Some(id),
                    None => {
                        return Err(violation(format!(
                            "insert into \"page_body_stagings\" violates foreign key: page {raw} does not exist"
                        )));
                    }
                },
            };
            let record = StagingRecord {
                id: id.clone(),
                kind: input.kind.clone(),
                principal_kind: input.principal_kind.clone(),
                principal_id: input.principal_id.clone(),
                client_request_id: client_request_id.clone(),
                source_id: input.source_id.clone(),
                source_incarnation: source_incarnation.clone(),
                slug: input.slug.clone(),
                page_id,
                mode: input.mode.clone(),
                base_revision: base_revision.clone(),
                base_generation: input.base_generation,
                declared_bytes: input.declared_bytes,
                declared_sha256: declared_sha256.clone(),
                received_bytes: 0,
                next_part: 0,
                reserved_bytes: input.reserved_bytes,
                state: "open".into(),
                commit_request_id: None,
                idle_expires_at_us: idle,
                hard_expires_at_us: hard,
                created_at_us: now,
                updated_at_us: now,
            };
            put_json(tx, &staging_key(&id), &record)?;
            put_json(tx, &client, &id)?;
            if let Some(page_id) = page_id {
                let mut key = staging_by_page_prefix(page_id);
                key.extend_from_slice(id.as_bytes());
                tx.put(&key, b"")?;
            }
            Ok(())
        })
    }

    /// `setBodyStagingState(id, state, { commitRequestId? })`: moves a live staging to `state`
    /// (a live state restarts its idle deadline, never past the hard one). For a staging that is
    /// not live: an abort or expiry, or a move to the state it holds, changes nothing; anything
    /// else refuses as `staging_gone`.
    pub fn set_body_staging_state(
        &self,
        id: &str,
        state: &str,
        options: &StagingStateOptions,
    ) -> Result<()> {
        let id = staging_id_arg(id)?;
        let commit = options
            .commit_request_id
            .as_deref()
            .map(|c| norm_uuid(c, "setBodyStagingState commitRequestId"))
            .transpose()?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let record: Option<StagingRecord> = get_json(&*tx, &staging_key(&id))?;
            if let Some(mut record) = record
                .clone()
                .filter(|r| LIVE_STAGING_STATES.contains(&r.state.as_str()))
            {
                if !STAGING_STATES.contains(&state) {
                    return Err(violation(format!(
                        "new row for relation \"page_body_stagings\" violates check constraint (state \"{state}\")"
                    )));
                }
                record.state = state.to_string();
                record.updated_at_us = now;
                if LIVE_STAGING_STATES.contains(&state) {
                    record.idle_expires_at_us = record
                        .hard_expires_at_us
                        .min(now.saturating_add(BODY_STAGING_IDLE_US));
                }
                if let Some(commit) = &commit {
                    record.commit_request_id = Some(commit.clone());
                }
                return put_json(tx, &staging_key(&id), &record);
            }
            if state == "aborted" || state == "expired" {
                return Ok(());
            }
            if record.as_ref().is_some_and(|r| r.state == state) {
                return Ok(());
            }
            Err(body_error(json!({
                "kind": "staging_gone",
                "slug": record.as_ref().map(|r| r.slug.clone()),
                "staging_id": id,
                "state": record.map(|r| r.state),
            })))
        })
    }

    /// `sweepSegments({ sourceId?, pageId?, graceMs?, expireStagings?, now? })`: PGLite's garbage
    /// collection (spec 3.5), step for step in one write. Roots: a segmented page's live
    /// generation, every generation a version snapshot references, and the rows of live stagings
    /// (`live_staging_ids`: a live state or named by an outstanding request).
    ///
    /// 1. With `expireStagings`: live stagings in scope past a deadline that no request holds
    ///    become `expired`, and terminal stagings in scope unchanged for `BODY_STAGING_HARD_MS`
    ///    are deleted (with their client key and recorded texts).
    /// 2. Chunks staged above a page's generation go, unless a live staging stages that occurrence.
    /// 3. Chunks at or below it go when only dead stagings' rows name their occurrence.
    /// 4. Staged manifest rows of dead stagings go.
    /// 5. Published rows outside the live generation and every version's generation go.
    /// 6. Texts older than the grace window go when no manifest row names them, no live staging of
    ///    their source is as old, and no live staging recorded them. A `pageId` sweep considers only
    ///    the texts its own manifest deletes released.
    pub fn sweep_segments(&self, options: &SegmentSweepOptions) -> Result<SegmentSweepResult> {
        let now = match options.now.as_deref() {
            Some(text) => parse_time(text, "sweepSegments now")?,
            None => self.env.now_micros(),
        };
        let grace_us = options
            .grace_ms
            .unwrap_or(SEGMENT_TEXT_GC_GRACE_MS)
            .saturating_mul(1000);
        let source = options.source_id.as_deref();
        let expire = options.expire_stagings == Some(true);
        self.write(|tx| sweep_segments_in(tx, now, grace_us, source, options.page_id, expire))
    }

    /// `readSegmentDerivations(pageId, { kind?, occurrenceIds? })`: the page's derivation rows,
    /// by kind then occurrence; `[]` for an empty `occurrenceIds`.
    pub fn read_segment_derivations(
        &self,
        page_id: i64,
        options: &DerivationReadOptions,
    ) -> Result<Vec<Value>> {
        if options
            .occurrence_ids
            .as_ref()
            .is_some_and(|ids| ids.is_empty())
        {
            return Ok(Vec::new());
        }
        let Some(page) = page_u64(page_id) else {
            return Ok(Vec::new());
        };
        let wanted: Option<HashSet<i64>> = options
            .occurrence_ids
            .as_ref()
            .map(|ids| ids.iter().copied().collect());
        let read = self.read()?;
        let prefix = derivation_prefix(page);
        let mut out = Vec::new();
        for (key, record) in collect::<DerivationRecord>(&*read, &prefix)? {
            let rest = &key[prefix.len()..];
            let Some(split) = rest.iter().position(|b| *b == 0) else {
                continue;
            };
            let kind = String::from_utf8_lossy(&rest[..split]).into_owned();
            let Some(occurrence) = keys::be8(&rest[split + 1..]).map(|v| (v ^ (1u64 << 63)) as i64)
            else {
                continue;
            };
            if options.kind.as_deref().is_some_and(|k| k != kind) {
                continue;
            }
            if wanted.as_ref().is_some_and(|w| !w.contains(&occurrence)) {
                continue;
            }
            out.push(json!({
                "pageId": page_id,
                "kind": kind,
                "occurrenceId": occurrence,
                "version": record.pipeline_version,
                "segmentSha256": record.segment_sha256,
                "contextHash": record.context_hash,
                "state": record.state,
                "output": crate::jsonb::ordered(&record.output),
                "receipt": crate::jsonb::ordered(&record.receipt),
                "createdAt": crate::env::iso(record.created_at_us),
                "updatedAt": crate::env::iso(record.updated_at_us),
            }));
        }
        Ok(out)
    }

    /// `upsertSegmentDerivations(rows)`: inserts or replaces each row keyed (page, kind,
    /// occurrence); a replaced row keeps its `createdAt`. Refuses the batch on an unknown page,
    /// kind or state, a negative version, a hash that is not 32 bytes, or a key repeated in it.
    ///
    /// A row a recorded purge sweep drops (its trigger) is not stored; returns how many were dropped.
    pub fn upsert_segment_derivations(&self, rows: &[SegmentDerivationInput]) -> Result<u64> {
        let prepared = prepare_derivations(rows)?;
        if prepared.is_empty() {
            return Ok(0);
        }
        let now = self.env.now_micros();
        self.write(|tx| put_derivations(tx, &prepared, now))
    }

    /// `storeSegmentDerivationsIfLive(pageId, generation, rows)`: the derive pass's conditional store
    /// (`segment-derive.ts` storeRuns): the rows are upserted as `upsertSegmentDerivations` does only
    /// while the page is live, segmented and at body `generation`; returns how many rows were written
    /// (0 when the page moved, as the SQL's `RETURNING 1` over an empty `live` set; a row a recorded
    /// sweep drops is not written and not counted).
    pub fn store_segment_derivations_if_live(
        &self,
        page_id: i64,
        generation: i64,
        rows: &[SegmentDerivationInput],
    ) -> Result<u64> {
        let prepared = prepare_derivations(rows)?;
        if prepared.is_empty() {
            return Ok(0);
        }
        let Some(id) = page_u64(page_id) else {
            return Ok(0);
        };
        let now = self.env.now_micros();
        self.write(|tx| {
            let live = read_page_by_id(&*tx, id)?.is_some_and(|p| p.deleted_at_us.is_none());
            let state = read_body_state(&*tx, id)?;
            if !live
                || !is_segmented(state.as_ref())
                || state.is_none_or(|s| s.body_generation != generation)
            {
                return Ok(0);
            }
            let refused = put_derivations(tx, &prepared, now)?;
            Ok(prepared.len() as u64 - refused)
        })
    }

    /// `retireSegmentDerivations(pageId, liveOccurrenceIds, { kind? })`: deletes the page's rows
    /// (every kind, or `kind`) whose occurrence is not live; returns how many.
    pub fn retire_segment_derivations(
        &self,
        page_id: i64,
        live_occurrence_ids: &[i64],
        options: &DerivationRetireOptions,
    ) -> Result<u64> {
        let Some(page) = page_u64(page_id) else {
            return Ok(0);
        };
        let live: HashSet<i64> = live_occurrence_ids.iter().copied().collect();
        self.write(|tx| {
            let prefix = derivation_prefix(page);
            let mut doomed = Vec::new();
            scan_prefix(&*tx, &prefix, false, &mut |k, _| {
                let rest = &k[prefix.len()..];
                if let Some(split) = rest.iter().position(|b| *b == 0) {
                    let kind = &rest[..split];
                    let occurrence =
                        keys::be8(&rest[split + 1..]).map(|v| (v ^ (1u64 << 63)) as i64);
                    let kind_matches = options
                        .kind
                        .as_deref()
                        .is_none_or(|want| want.as_bytes() == kind);
                    if kind_matches && occurrence.is_some_and(|o| !live.contains(&o)) {
                        doomed.push(k.to_vec());
                    }
                }
                true
            })?;
            for key in &doomed {
                tx.delete(key)?;
            }
            Ok(doomed.len() as u64)
        })
    }

    /// `lockBodyStagingState(stagingId)`: the staging's state, or `None` when no staging has that
    /// id (PGLite's `SELECT state ... FOR UPDATE`; a store write already holds the brain). A value
    /// that is not a uuid is refused, as the `::uuid` cast refuses it.
    pub fn lock_body_staging_state(&self, staging_id: &str) -> Result<Option<String>> {
        let id = staging_id_arg(staging_id)?;
        let read = self.read()?;
        let record: Option<StagingRecord> = get_json(&*read, &staging_key(&id))?;
        Ok(record.map(|r| r.state))
    }

    /// `deleteUnstagedSegmentChunks(pageId, generation, keepChunkIndexes)`: deletes the page's
    /// chunk rows at `generation` whose chunk index is not kept (the rows a dead preparation
    /// staged), with their postings and the rows that hang off them.
    pub fn delete_unstaged_segment_chunks(
        &self,
        page_id: i64,
        generation: i64,
        keep_chunk_indexes: &[i64],
    ) -> Result<()> {
        let (Some(page), Ok(generation)) = (page_u64(page_id), u64::try_from(generation)) else {
            return Ok(());
        };
        let keep: HashSet<i64> = keep_chunk_indexes.iter().copied().collect();
        self.write(|tx| {
            crate::chunks::delete_chunks_matching(tx, page, &|c| {
                c.segment
                    .is_some_and(|place| place.body_generation == generation)
                    && !keep.contains(&i64::from(c.chunk_index))
            })?;
            Ok(())
        })
    }

    /// `deleteRewrittenSegmentDerivations({ pageId, touchedOccurrenceIds, linkReachOccurrenceIds,
    /// pipelines, liveOccurrenceIds })`: deletes the page's rows of a touched occurrence, its
    /// `links` rows of an occurrence in reach, and its rows of a listed pipeline whose occurrence
    /// is not live; returns how many.
    pub fn delete_rewritten_segment_derivations(
        &self,
        spec: &RewrittenDerivationsDelete,
    ) -> Result<u64> {
        let Some(page) = page_u64(spec.page_id) else {
            return Ok(0);
        };
        let touched: HashSet<i64> = spec.touched_occurrence_ids.iter().copied().collect();
        let reach: HashSet<i64> = spec.link_reach_occurrence_ids.iter().copied().collect();
        let live: HashSet<i64> = spec.live_occurrence_ids.iter().copied().collect();
        self.write(|tx| {
            let prefix = derivation_prefix(page);
            let mut doomed = Vec::new();
            scan_prefix(&*tx, &prefix, false, &mut |k, _| {
                let rest = &k[prefix.len()..];
                if let Some(split) = rest.iter().position(|b| *b == 0) {
                    let kind = &rest[..split];
                    if let Some(o) =
                        keys::be8(&rest[split + 1..]).map(|v| (v ^ (1u64 << 63)) as i64)
                        && (touched.contains(&o)
                            || (kind == b"links" && reach.contains(&o))
                            || (spec.pipelines.iter().any(|p| p.as_bytes() == kind)
                                && !live.contains(&o)))
                    {
                        doomed.push(k.to_vec());
                    }
                }
                true
            })?;
            for key in &doomed {
                tx.delete(key)?;
            }
            Ok(doomed.len() as u64)
        })
    }

    /// `refreshPageBody(slug, sourceId, compiledTruth, timeline, contentHash)`: rewrites the body,
    /// timeline and content hash of a live inline page and leaves everything else (chunks, tags,
    /// frontmatter) as it is. A missing or soft-deleted page is a no-op; a segmented page refuses
    /// (Postgres's `pages_body_storage_chk`). The text is stored as given: Postgres refuses a NUL
    /// byte, and so does this (`invalid_argument`).
    pub fn refresh_page_body(
        &self,
        slug: &str,
        source_id: &str,
        compiled_truth: &str,
        timeline: &str,
        content_hash: &str,
    ) -> Result<()> {
        for (text, what) in [
            (slug, "slug"),
            (source_id, "sourceId"),
            (compiled_truth, "compiledTruth"),
            (timeline, "timeline"),
            (content_hash, "contentHash"),
        ] {
            no_nul(text, &format!("refreshPageBody {what}"))?;
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut page) = read_page(&*tx, source_id, slug)? else {
                return Ok(());
            };
            if page.deleted_at_us.is_some() {
                return Ok(());
            }
            if is_segmented(read_body_state(&*tx, page.id)?.as_ref()) {
                return Err(violation(
                    "new row for relation \"pages\" violates check constraint \"pages_body_storage_chk\"",
                ));
            }
            if page.compiled_truth != compiled_truth || page.timeline != timeline {
                page.knowledge_revision = self.env.new_uuid();
                page.text_projection_revision = None;
            }
            page.compiled_truth = compiled_truth.into();
            page.timeline = timeline.into();
            page.content_hash = Some(content_hash.to_string());
            page.updated_at_us = now;
            // The statement sets the timeline, so PGLite's search vector trigger fires, also when
            // the text is unchanged: the vector is checked again and the sealed search timeline goes.
            crate::pages::write_page_setting_vector(tx, &page)
        })
    }
}

/// Checks one manifest row against what Postgres checks before touching a table (types, CHECKs
/// and NOT NULLs) and returns it normalized (lowercase hex and uuid, `YYYY-MM-DD` dates, open).
fn prepare_manifest_row(row: &ManifestRow) -> Result<(ManifestRow, [u8; 16])> {
    let mut out = row.clone();
    out.gen_to = None;
    for (value, what) in [
        (row.seq, "seq"),
        (row.byte_len, "byteLen"),
        (row.line_count, "lineCount"),
        (row.static_proj_lines, "staticProjLines"),
        (row.page_id, "pageId"),
    ] {
        int4(value, &format!("stageManifestRows {what}"))?;
    }
    no_nul(&row.source_id, "stageManifestRows sourceId")?;
    out.sha256 = to_hex(&from_hex(&row.sha256, "stageManifestRows sha256")?);
    out.hash_state = to_hex(&from_hex(&row.hash_state, "stageManifestRows hashState")?);
    out.date_min = row
        .date_min
        .as_deref()
        .map(|d| parse_date(d, "stageManifestRows dateMin"))
        .transpose()?;
    out.date_max = row
        .date_max
        .as_deref()
        .map(|d| parse_date(d, "stageManifestRows dateMax"))
        .transpose()?;
    let staging = match row.staging_id.as_deref() {
        Some(id) => {
            let id = norm_uuid(id, "stageManifestRows stagingId")?;
            let bytes = uuid_bytes(&id);
            out.staging_id = Some(id);
            bytes
        }
        None => NIL_STAGING,
    };
    if !REGIONS.contains(&row.region.as_str()) {
        return Err(violation(format!(
            "new row for relation \"page_body_manifest\" violates check constraint (region \"{}\")",
            row.region
        )));
    }
    if !CUT_KINDS.contains(&row.cut_kind.as_str()) {
        return Err(violation(format!(
            "new row for relation \"page_body_manifest\" violates check constraint (cut_kind \"{}\")",
            row.cut_kind
        )));
    }
    for (value, what) in [
        (&row.entry_state, "entry_state"),
        (&row.protected_regions, "protected_regions"),
        (&row.facts_slots, "facts_slots"),
        (&row.outline, "outline"),
    ] {
        if value.is_null() {
            return Err(violation(format!(
                "null value in column \"{what}\" of relation \"page_body_manifest\" violates not-null constraint"
            )));
        }
    }
    Ok((out, staging))
}

/// The page's published manifest rows a later generation closed (`gen_to IS NOT NULL AND
/// staging_id IS NULL`): the rows only a version snapshot can keep, which segmented retention
/// counts as pinned bytes.
pub(crate) fn closed_manifest_rows(read: &dyn KvRead, page_id: u64) -> Result<Vec<ManifestRow>> {
    Ok(manifest_rows(read, page_id)?
        .into_iter()
        .map(|(_, row)| row)
        .filter(|row| row.gen_to.is_some() && row.staging_id.is_none())
        .collect())
}

/// The live published manifest rows of segmented page `page_id` that carry facts slots
/// (`gen_to IS NULL AND staging_id IS NULL AND facts_slots <> '[]'`), each with the bytes of its
/// segment text (`None` when the source holds no text of that sha). An inline or missing page has
/// none. Withdrawal discovery (facts/withdrawal_discovery.rs) scans them for facts fences.
pub(crate) fn live_facts_slot_rows(
    read: &dyn KvRead,
    page_id: u64,
) -> Result<Vec<(ManifestRow, Option<Vec<u8>>)>> {
    if !is_segmented(read_body_state(read, page_id)?.as_ref()) {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for (_, row) in manifest_rows(read, page_id)? {
        if !live_published(&row) || row.facts_slots.as_array().is_none_or(Vec::is_empty) {
            continue;
        }
        let sha = from_hex(&row.sha256, "sha256")?;
        let text = get_json::<TextRecord>(read, &text_key(&row.source_id, &sha))?
            .map(|t| from_hex(&t.body, "body"))
            .transpose()?;
        out.push((row, text));
    }
    Ok(out)
}

/// The body of `sweepSegments`, run in the open write `tx`: `prune_versions` calls it after a
/// segmented prune deletes versions, as PGLite's `insertSegmentedVersion` calls
/// `sweepSegments({ pageId })` in the version's transaction.
pub(crate) fn sweep_segments_in(
    tx: &mut dyn KvWrite,
    now: i64,
    grace_us: i64,
    source: Option<&str>,
    page_scope: Option<i64>,
    expire_stagings: bool,
) -> Result<SegmentSweepResult> {
    let held = crate::journal::request_held_staging_ids(&*tx)?;
    let mut result = SegmentSweepResult::default();
    let in_scope = |staging: &StagingRecord| {
        page_scope.is_none_or(|id| staging.page_id.and_then(|p| i64::try_from(p).ok()) == Some(id))
            && source.is_none_or(|src| staging.source_id == src)
    };
    if expire_stagings {
        for (_, mut staging) in collect::<StagingRecord>(&*tx, &kind_key(STAGING))? {
            let due = staging.hard_expires_at_us <= now
                || (staging.idle_expires_at_us <= now
                    && (staging.kind != "upload" || staging.state == "open"));
            if LIVE_STAGING_STATES.contains(&staging.state.as_str())
                && in_scope(&staging)
                && due
                && !held.contains(&staging.id)
            {
                staging.state = "expired".to_string();
                staging.updated_at_us = now;
                put_json(tx, &staging_key(&staging.id), &staging)?;
                result.stagings_expired += 1;
            }
        }
        let live = live_staging_ids(&*tx, &held)?;
        for (_, staging) in collect::<StagingRecord>(&*tx, &kind_key(STAGING))? {
            if TERMINAL_STAGING_STATES.contains(&staging.state.as_str())
                && staging.updated_at_us <= now.saturating_sub(BODY_STAGING_HARD_US)
                && in_scope(&staging)
                && !live.contains(&staging.id)
            {
                delete_staging(tx, &staging)?;
            }
        }
    }
    let live = live_staging_ids(&*tx, &held)?;
    let pages: Vec<PageRecord> = match page_scope {
        Some(id) => match page_u64(id) {
            Some(id) => read_page_by_id(&*tx, id)?.into_iter().collect(),
            None => Vec::new(),
        },
        None => crate::pages::all_pages(&*tx)?,
    };
    let mut released: HashSet<String> = HashSet::new();
    for page in pages
        .iter()
        .filter(|page| source.is_none_or(|src| page.source_id == src))
    {
        let state = read_body_state(&*tx, page.id)?;
        let generation = state.as_ref().map_or(0, |s| s.body_generation);
        let segmented = is_segmented(state.as_ref());
        let rows = manifest_rows(&*tx, page.id)?;
        // Occurrences a live staging stages, and those a published or live row names.
        let live_staged: HashSet<i64> = rows
            .iter()
            .filter(|(_, r)| staged_by(r, &live) == Some(true))
            .map(|(_, r)| r.occurrence_id)
            .collect();
        let kept: HashSet<i64> = rows
            .iter()
            .filter(|(_, r)| staged_by(r, &live) != Some(false))
            .map(|(_, r)| r.occurrence_id)
            .collect();
        let dead: HashSet<i64> = rows
            .iter()
            .filter(|(_, r)| staged_by(r, &live) == Some(false))
            .map(|(_, r)| r.occurrence_id)
            .collect();
        let above = |place: &crate::chunks::SegmentPlace| {
            i128::from(place.body_generation) > i128::from(generation)
        };
        let occurrence =
            |place: &crate::chunks::SegmentPlace| i64::try_from(place.occurrence_id).ok();
        let gone = crate::chunks::delete_chunks_matching(tx, page.id, &|c| {
            c.segment.as_ref().is_some_and(|place| {
                let occ = occurrence(place);
                if above(place) {
                    occ.is_none_or(|o| !live_staged.contains(&o))
                } else {
                    occ.is_some_and(|o| dead.contains(&o) && !kept.contains(&o))
                }
            })
        })?;
        result.retired_chunks_deleted += gone.len() as u64;
        let versions = crate::pages::version_generations(&*tx, page.id)?;
        for (key, row) in &rows {
            let drop = match staged_by(row, &live) {
                Some(live) => !live,
                None => {
                    !(segmented && in_generation(row, generation))
                        && !versions
                            .iter()
                            .any(|v| *v >= row.gen_from && row.gen_to.is_none_or(|to| *v < to))
                }
            };
            if drop {
                tx.delete(key)?;
                derivation_sweep::note_row_gone(tx, row)?;
                result.manifest_rows_deleted += 1;
                if page_scope.is_some() {
                    released.insert(row.sha256.clone());
                }
            }
        }
    }
    if page_scope.is_some() && released.is_empty() {
        return Ok(result);
    }
    let page_source = match page_scope {
        Some(_) => pages.first().map(|p| p.source_id.clone()),
        None => None,
    };
    if page_scope.is_some() && page_source.is_none() {
        return Ok(result);
    }
    result.texts_deleted = sweep_texts(
        tx,
        &live,
        now.saturating_sub(grace_us),
        page_source.as_deref().or(source),
        page_scope.is_some().then_some(&released),
    )?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions, ReadScope};

    fn sha(text: &str) -> String {
        use sha2::{Digest, Sha256};
        to_hex(&Sha256::digest(text.as_bytes()))
    }

    fn text(body: &str) -> SegmentTextInput {
        SegmentTextInput {
            sha256: sha(body),
            body: to_hex(body.as_bytes()),
            line_count: 1,
        }
    }

    fn meta(title: &str) -> SegmentedPageMeta {
        SegmentedPageMeta {
            page_type: Some("note".into()),
            title: title.into(),
            ..SegmentedPageMeta::default()
        }
    }

    #[test]
    fn hex_and_dates_round_trip() {
        assert_eq!(to_hex(&from_hex("00Ff10", "x").unwrap()), "00ff10");
        assert!(from_hex("abc", "x").is_err());
        assert!(from_hex("zz", "x").is_err());
        assert_eq!(parse_date("2026-01-02", "d").unwrap(), "2026-01-02");
        assert_eq!(
            parse_date("2026-01-02T10:00:00Z", "d").unwrap(),
            "2026-01-02"
        );
        assert!(parse_date("2026-02-30", "d").is_err());
        assert!(parse_date("2026/01/02", "d").is_err());
        assert_eq!(uuid_bytes("00000000-0000-0000-0000-000000000001")[15], 1);
    }

    #[test]
    fn signed_keys_sort_by_value() {
        let mut values = [5i64, -3, 0, i64::MAX, i64::MIN, 1];
        let mut keyed: Vec<[u8; 8]> = values.iter().map(|v| signed(*v)).collect();
        keyed.sort();
        values.sort();
        assert_eq!(keyed, values.iter().map(|v| signed(*v)).collect::<Vec<_>>());
    }

    #[test]
    fn a_segmented_page_reports_its_body_columns_and_an_inline_page_none() {
        let store = crate::test_support::store();
        let shell = store
            .create_segmented_page_shell(
                "notes/seg",
                &meta("Seg"),
                &ShellOptions {
                    source_id: Some("default".into()),
                },
            )
            .unwrap();
        assert!(shell["id"].as_u64().unwrap() > 0);
        store
            .put_page(
                "notes/inline",
                &PageInput {
                    page_type: "note".into(),
                    title: "Inline".into(),
                    compiled_truth: "body".into(),
                    ..PageInput::default()
                },
                &PutPageOptions::default(),
            )
            .unwrap();
        let seg = store
            .read_page_snapshot("notes/seg", &ReadScope::default())
            .unwrap()
            .unwrap()["page"]
            .clone();
        assert_eq!(seg["body_storage"], json!("segmented"));
        assert_eq!(seg["body_bytes"], json!(0));
        let inline = store
            .read_page_snapshot("notes/inline", &ReadScope::default())
            .unwrap()
            .unwrap()["page"]
            .clone();
        assert!(inline.get("body_storage").is_none());
        assert!(inline.get("body_bytes").is_none());
    }

    #[test]
    fn deleting_a_page_for_good_removes_its_body_records() {
        let store = crate::test_support::store();
        let id = store
            .create_segmented_page_shell(
                "notes/gone",
                &meta("Gone"),
                &ShellOptions {
                    source_id: Some("default".into()),
                },
            )
            .unwrap()["id"]
            .as_u64()
            .unwrap();
        let one = text("one\n");
        store
            .stage_segment_texts(
                "default",
                std::slice::from_ref(&one),
                &StageTextsOptions::default(),
            )
            .unwrap();
        store
            .upsert_segment_derivations(&[SegmentDerivationInput {
                page_id: id as i64,
                kind: "links".into(),
                occurrence_id: 1,
                version: 1,
                segment_sha256: sha("a"),
                context_hash: sha("b"),
                state: "done".into(),
                output: Value::Null,
                receipt: Value::Null,
            }])
            .unwrap();
        store.delete_page("notes/gone", None).unwrap();
        let read = store.read().unwrap();
        for prefix in [manifest_prefix(id), derivation_prefix(id), body_key(id)] {
            let mut n = 0;
            scan_prefix(&*read, &prefix, false, &mut |_, _| {
                n += 1;
                true
            })
            .unwrap();
            assert_eq!(n, 0);
        }
        // Texts stay until a sweep, as in PGLite.
        assert_eq!(
            store
                .read_segment_texts("default", &[one.sha256])
                .unwrap()
                .len(),
            1
        );
    }

    fn staging_input(
        id: &str,
        source: &str,
        page_id: Option<i64>,
        client: &str,
    ) -> BodyStagingInput {
        serde_json::from_value(json!({
            "id": id, "kind": "put", "principalKind": "local", "principalId": "cli",
            "clientRequestId": client, "sourceId": source,
            "sourceIncarnation": "33333333-3333-4333-8333-333333333333", "slug": "notes/a",
            "pageId": page_id, "mode": "replace", "declaredBytes": 1, "reservedBytes": 1,
            "idleExpiresAt": "2099-01-01T00:00:00Z", "hardExpiresAt": "2099-01-02T00:00:00Z",
        }))
        .unwrap()
    }

    #[test]
    fn a_staging_locks_its_state_and_an_unknown_one_reads_none() {
        let store = crate::test_support::store();
        let staging = "11111111-1111-4111-8111-111111111111";
        assert_eq!(store.lock_body_staging_state(staging).unwrap(), None);
        store
            .open_body_staging(&staging_input(
                staging,
                "default",
                None,
                "44444444-4444-4444-8444-444444444444",
            ))
            .unwrap();
        assert_eq!(
            store.lock_body_staging_state(staging).unwrap().as_deref(),
            Some("open")
        );
        store
            .set_body_staging_state(staging, "aborted", &StagingStateOptions::default())
            .unwrap();
        assert_eq!(
            store.lock_body_staging_state(staging).unwrap().as_deref(),
            Some("aborted")
        );
        assert!(store.lock_body_staging_state("not-a-uuid").is_err());
    }

    fn count(store: &Store, prefix: &[u8]) -> usize {
        let read = store.read().unwrap();
        let mut n = 0;
        scan_prefix(&*read, prefix, false, &mut |_, _| {
            n += 1;
            true
        })
        .unwrap();
        n
    }

    fn other_source(store: &Store) {
        store
            .upsert_source(
                &serde_json::from_value(json!({"id": "other", "name": "other"})).unwrap(),
            )
            .unwrap();
    }

    #[test]
    fn deleting_a_source_removes_its_texts_and_stagings_only() {
        let store = crate::test_support::store();
        other_source(&store);
        let other_page = store
            .create_segmented_page_shell(
                "notes/o",
                &meta("O"),
                &ShellOptions {
                    source_id: Some("other".into()),
                },
            )
            .unwrap()["id"]
            .as_i64()
            .unwrap();
        let gone = "11111111-1111-4111-8111-111111111111";
        let kept = "22222222-2222-4222-8222-222222222222";
        let gone_client = "44444444-4444-4444-8444-444444444444";
        store
            .open_body_staging(&staging_input(gone, "default", None, gone_client))
            .unwrap();
        store
            .open_body_staging(&staging_input(
                kept,
                "other",
                Some(other_page),
                "55555555-5555-4555-8555-555555555555",
            ))
            .unwrap();
        let in_staging = StageTextsOptions {
            staging_id: Some(gone.into()),
        };
        store
            .stage_segment_texts("default", &[text("one\n"), text("two\n")], &in_staging)
            .unwrap();
        store
            .stage_segment_texts("other", &[text("one\n")], &StageTextsOptions::default())
            .unwrap();

        store.write(|tx| remove_source_rows(tx, "default")).unwrap();

        assert!(
            store
                .read_segment_texts("default", &[sha("one\n"), sha("two\n")])
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .read_segment_texts("other", &[sha("one\n")])
                .unwrap()
                .len(),
            1
        );
        assert_eq!(count(&store, &staging_key(gone)), 0);
        assert_eq!(count(&store, &staging_text_prefix(gone)), 0);
        assert_eq!(count(&store, &client_key("local", "cli", gone_client)), 0);
        assert_eq!(count(&store, &staging_key(kept)), 1);
        assert_eq!(count(&store, &staging_by_page_prefix(other_page as u64)), 1);
        // The id and client request are free again.
        store
            .open_body_staging(&staging_input(gone, "default", None, gone_client))
            .unwrap();
    }

    #[test]
    fn deleting_a_source_refuses_while_another_page_names_its_text() {
        let store = crate::test_support::store();
        other_source(&store);
        let page = store
            .create_segmented_page_shell(
                "notes/o",
                &meta("O"),
                &ShellOptions {
                    source_id: Some("other".into()),
                },
            )
            .unwrap()["id"]
            .as_i64()
            .unwrap();
        store
            .stage_segment_texts("default", &[text("one\n")], &StageTextsOptions::default())
            .unwrap();
        let row: ManifestRow = serde_json::from_value(json!({
            "pageId": page, "occurrenceId": 1, "genFrom": 1, "seq": 0, "region": "truth",
            "sourceId": "default", "sha256": sha("one\n"), "byteStart": 0, "byteLen": 4,
            "lineStart": 0, "lineCount": 1, "cutKind": "eof", "entryState": {},
            "protectedRegions": [], "factsSlots": [], "staticProjBytes": 4, "staticProjLines": 1,
            "outline": [], "hashState": sha("s"),
        }))
        .unwrap();
        store.stage_manifest_rows(&[row]).unwrap();
        let err = store
            .write(|tx| remove_source_rows(tx, "default"))
            .unwrap_err();
        assert_eq!(err.code, CONSTRAINT_VIOLATION);
        assert_eq!(
            store
                .read_segment_texts("default", &[sha("one\n")])
                .unwrap()
                .len(),
            1
        );
    }
}

/// Segment chunks through the page-body members. A flip unseals the page (as in PGLite), and
/// `get_chunks` answers nothing for an unsealed page, so visibility is read with
/// `chunks::visible_chunks`, the list `get_chunks` returns once the page is sealed.
#[cfg(test)]
mod segment_chunk_tests {
    use super::*;
    use crate::chunks::{SegmentChunkInput, visible_chunks};

    pub(super) const STAGING: &str = "11111111-1111-4111-8111-111111111111";
    pub(super) const STAGING_2: &str = "22222222-2222-4222-8222-222222222222";

    fn sha(text: &str) -> String {
        use sha2::{Digest, Sha256};
        to_hex(&Sha256::digest(text.as_bytes()))
    }

    pub(super) fn text(body: &str) -> SegmentTextInput {
        SegmentTextInput {
            sha256: sha(body),
            body: to_hex(body.as_bytes()),
            line_count: 1,
        }
    }

    pub(super) fn staging(id: &str, page_id: i64, client: &str) -> BodyStagingInput {
        serde_json::from_value(json!({
            "id": id, "kind": "put", "principalKind": "local", "principalId": "cli",
            "clientRequestId": client, "sourceId": "default",
            "sourceIncarnation": "33333333-3333-4333-8333-333333333333", "slug": "notes/a",
            "pageId": page_id, "mode": "replace", "declaredBytes": 1, "reservedBytes": 1,
            "idleExpiresAt": "2099-01-01T00:00:00Z", "hardExpiresAt": "2099-01-02T00:00:00Z",
        }))
        .unwrap()
    }

    /// A live staging of the page `notes/b`, which a purge of `notes/a` must keep.
    fn other_page_staging(page_id: i64) -> BodyStagingInput {
        let mut input = staging(STAGING_2, page_id, "55555555-5555-4555-8555-555555555555");
        input.slug = "notes/b".into();
        input
    }

    pub(super) fn row(
        page_id: i64,
        occurrence: i64,
        gen_from: i64,
        seq: i64,
        start: i64,
        body: &str,
        staging: &str,
    ) -> ManifestRow {
        serde_json::from_value(json!({
            "pageId": page_id, "occurrenceId": occurrence, "genFrom": gen_from, "seq": seq,
            "region": "truth", "sourceId": "default", "sha256": sha(body), "byteStart": start,
            "byteLen": body.len(), "lineStart": 0, "lineCount": 1, "cutKind": "heading",
            "entryState": {"depth": 0}, "protectedRegions": [], "factsSlots": [], "outline": [],
            "staticProjBytes": body.len(), "staticProjLines": 1, "hashState": sha("state"),
            "stagingId": staging,
        }))
        .unwrap()
    }

    pub(super) fn flip(
        page_id: i64,
        expected: i64,
        staging: &str,
        body_bytes: i64,
        extra: Value,
    ) -> BodyFlipInput {
        let mut input = json!({
            "pageId": page_id, "expectedGeneration": expected, "newGeneration": expected + 1,
            "stagingId": staging, "retireMaxRows": 1000,
            "body": {
                "content_hash": "h", "body_bytes": body_bytes, "truth_bytes": body_bytes,
                "body_lines": 2, "segment_count": 2, "segmenter_version": 1,
                "truth_lead": "", "timeline_lead": "", "body_flags": {},
            },
            "meta": {"type": "note", "title": "Flipped"},
        });
        for (k, v) in extra.as_object().unwrap() {
            input[k] = v.clone();
        }
        serde_json::from_value(input).unwrap()
    }

    pub(super) fn chunk(occurrence: i64, ordinal: i64, body: &str) -> SegmentChunkInput {
        serde_json::from_value(json!({
            "chunk_text": body, "chunk_source": "compiled_truth", "model": "m",
            "occurrence_id": occurrence, "local_ordinal": ordinal,
            "raw_byte_start": 0, "raw_byte_end": body.len(),
        }))
        .unwrap()
    }

    fn visible(store: &Store, id: i64) -> Vec<String> {
        visible_chunks(&*store.read().unwrap(), id as u64)
            .unwrap()
            .into_iter()
            .map(|c| c.chunk_text)
            .collect()
    }

    /// A shell published at generation 1 from occurrences 1 ("one\n" at 0) and 2 ("two\n" at 4).
    pub(super) fn published(store: &Store) -> i64 {
        published_with(store, json!({}))
    }

    /// `published`, the flip's input changed by `extra` (as `flip` takes it).
    pub(super) fn published_with(store: &Store, extra: Value) -> i64 {
        let id = store
            .create_segmented_page_shell(
                "notes/a",
                &serde_json::from_value(json!({"type": "note", "title": "A"})).unwrap(),
                &ShellOptions {
                    source_id: Some("default".into()),
                },
            )
            .unwrap()["id"]
            .as_i64()
            .unwrap();
        store
            .open_body_staging(&staging(
                STAGING,
                id,
                "44444444-4444-4444-8444-444444444444",
            ))
            .unwrap();
        store
            .stage_segment_texts(
                "default",
                &[text("one\n"), text("two\n")],
                &StageTextsOptions {
                    staging_id: Some(STAGING.into()),
                },
            )
            .unwrap();
        store
            .stage_manifest_rows(&[
                row(id, 1, 1, 0, 0, "one\n", STAGING),
                row(id, 2, 1, 1, 4, "two\n", STAGING),
            ])
            .unwrap();
        store
            .flip_body_generation(&flip(id, 0, STAGING, 8, extra))
            .unwrap();
        id
    }

    /// A published segmented page renames: its version references the live generation and keeps no
    /// body copy, and the moved page reads the same body under its new slug.
    #[test]
    fn update_slug_moves_a_segmented_page_and_versions_it_by_reference() {
        let store = crate::test_support::store();
        let id = published(&store);
        assert_eq!(store.update_slug("notes/a", "notes/b", None).unwrap(), 1);
        let read = store.read().unwrap();
        let page = read_page_by_id(&*read, id as u64).unwrap().unwrap();
        assert_eq!(page.slug, "notes/b");
        assert!(page.compiled_truth.is_null());
        assert_eq!(
            segmented_reference(&*read, id as u64).unwrap(),
            Some((1, Some(8)))
        );
        drop(read);
        let versions = store
            .get_versions("notes/b", &crate::pages::VersionsOptions::default())
            .unwrap();
        assert_eq!(versions.len(), 1);
        let v = &versions[0];
        assert_eq!(
            (
                &v["body_storage"],
                &v["body_generation"],
                &v["body_bytes"],
                &v["compiled_truth"]
            ),
            (&json!("segmented"), &json!(1), &json!(8), &Value::Null)
        );
    }

    /// PGLite's `readPageSnapshot` and `readPageSnapshotsBatch` add `bodyGeneration` (the page's
    /// live body generation) to the snapshot of a segmented page only: a published page and an
    /// unpublished shell (generation 0) carry it, an inline page has no such key.
    #[test]
    fn a_segmented_page_snapshot_carries_its_body_generation_single_and_batched() {
        let store = crate::test_support::store();
        published(&store);
        store
            .create_segmented_page_shell(
                "notes/shell",
                &serde_json::from_value(json!({"type": "note", "title": "Shell"})).unwrap(),
                &ShellOptions {
                    source_id: Some("default".into()),
                },
            )
            .unwrap();
        store
            .put_page(
                "notes/inline",
                &crate::pages::PageInput {
                    page_type: "note".into(),
                    title: "Inline".into(),
                    compiled_truth: "body".into(),
                    ..crate::pages::PageInput::default()
                },
                &crate::pages::PutPageOptions::default(),
            )
            .unwrap();
        let slugs = ["notes/a", "notes/shell", "notes/inline"];
        let single: Vec<Option<Value>> = slugs
            .iter()
            .map(|slug| {
                store
                    .read_page_snapshot(slug, &crate::pages::ReadScope::default())
                    .unwrap()
                    .unwrap()
                    .get("bodyGeneration")
                    .cloned()
            })
            .collect();
        assert_eq!(single, [Some(json!(1)), Some(json!(0)), None]);
        let refs: Vec<crate::page_ops::PageRef> = slugs
            .iter()
            .map(|slug| crate::page_ops::PageRef {
                slug: (*slug).into(),
                source_id: "default".into(),
            })
            .collect();
        let batch = store
            .read_page_snapshots_batch(&refs, &crate::page_ops::SnapshotBatchOptions::default())
            .unwrap();
        let batched: Vec<Option<Value>> = batch["snapshots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|snapshot| snapshot.get("bodyGeneration").cloned())
            .collect();
        assert_eq!(batched, single);
    }

    #[test]
    fn a_retention_purge_deletes_the_texts_only_the_purged_page_needed() {
        // PGLite's purgeDeletedPages deletes the purged pages' segment texts in the same
        // transaction, keeping a text a live staging still recorded.
        let store = crate::test_support::store();
        let id = published(&store);
        let other = store
            .create_segmented_page_shell(
                "notes/b",
                &serde_json::from_value(json!({"type": "note", "title": "B"})).unwrap(),
                &ShellOptions {
                    source_id: Some("default".into()),
                },
            )
            .unwrap()["id"]
            .as_i64()
            .unwrap();
        store.open_body_staging(&other_page_staging(other)).unwrap();
        store
            .stage_segment_texts(
                "default",
                &[text("two\n")],
                &StageTextsOptions {
                    staging_id: Some(STAGING_2.into()),
                },
            )
            .unwrap();
        let texts = |store: &Store| -> Vec<String> {
            store
                .read_segment_texts("default", &[sha("one\n"), sha("two\n")])
                .unwrap()
                .into_iter()
                .map(|(s, _)| s)
                .collect()
        };
        assert_eq!(texts(&store), vec![sha("one\n"), sha("two\n")]);
        let at = store.env.now_micros() - 3_600_000_000;
        store
            .write(|tx| {
                let mut page = read_page(&*tx, "default", "notes/a")?.unwrap();
                page.deleted_at_us = Some(at);
                write_page(tx, &page)
            })
            .unwrap();
        let out = store
            .purge_deleted_pages(0.0, &serde_json::from_value(json!({})).unwrap())
            .unwrap();
        assert_eq!(out["slugs"], json!(["notes/a"]));
        assert!(
            read_page_by_id(&*store.read().unwrap(), id as u64)
                .unwrap()
                .is_none()
        );
        assert_eq!(texts(&store), vec![sha("two\n")]);
    }

    #[test]
    fn a_retention_purge_deletes_a_create_staging_at_the_purged_slug_and_its_texts() {
        // PGLite's purgeDeletedPages deletes every staging at the purged source and slug, also one
        // with no page id, before it deletes the texts; a staging of another page keeps its text.
        let store = crate::test_support::store();
        published(&store);
        let other = store
            .create_segmented_page_shell(
                "notes/b",
                &serde_json::from_value(json!({"type": "note", "title": "B"})).unwrap(),
                &ShellOptions {
                    source_id: Some("default".into()),
                },
            )
            .unwrap()["id"]
            .as_i64()
            .unwrap();
        let create = "44444444-4444-4444-8444-444444444444";
        let input: BodyStagingInput = serde_json::from_value(json!({
            "id": create, "kind": "put", "principalKind": "local", "principalId": "cli",
            "clientRequestId": "66666666-6666-4666-8666-666666666666", "sourceId": "default",
            "sourceIncarnation": "33333333-3333-4333-8333-333333333333", "slug": "notes/a",
            "pageId": null, "mode": "create", "declaredBytes": 1, "reservedBytes": 1,
            "idleExpiresAt": "2099-01-01T00:00:00Z", "hardExpiresAt": "2099-01-02T00:00:00Z",
        }))
        .unwrap();
        store.open_body_staging(&input).unwrap();
        store.open_body_staging(&other_page_staging(other)).unwrap();
        for (id, body) in [(create, "one\n"), (STAGING_2, "two\n")] {
            store
                .stage_segment_texts(
                    "default",
                    &[text(body)],
                    &StageTextsOptions {
                        staging_id: Some(id.into()),
                    },
                )
                .unwrap();
        }
        let at = store.env.now_micros() - 3_600_000_000;
        store
            .write(|tx| {
                let mut page = read_page(&*tx, "default", "notes/a")?.unwrap();
                page.deleted_at_us = Some(at);
                write_page(tx, &page)
            })
            .unwrap();
        let out = store
            .purge_deleted_pages(0.0, &serde_json::from_value(json!({})).unwrap())
            .unwrap();
        assert_eq!(out["slugs"], json!(["notes/a"]));
        let read = store.read().unwrap();
        assert!(
            get_json::<StagingRecord>(&*read, &staging_key(create))
                .unwrap()
                .is_none()
        );
        assert!(
            get_json::<StagingRecord>(&*read, &staging_key(STAGING_2))
                .unwrap()
                .is_some()
        );
        drop(read);
        let texts: Vec<String> = store
            .read_segment_texts("default", &[sha("one\n"), sha("two\n")])
            .unwrap()
            .into_iter()
            .map(|(s, _)| s)
            .collect();
        assert_eq!(texts, vec![sha("two\n")]);
    }

    #[test]
    fn a_shell_holds_a_null_body_and_hash_until_a_flip_publishes_the_hash() {
        let store = crate::test_support::store();
        let id = store
            .create_segmented_page_shell(
                "notes/shell",
                &serde_json::from_value(json!({"type": "note", "title": "Shell"})).unwrap(),
                &ShellOptions {
                    source_id: Some("default".into()),
                },
            )
            .unwrap()["id"]
            .as_i64()
            .unwrap();
        let shell = read_page_by_id(&*store.read().unwrap(), id as u64)
            .unwrap()
            .unwrap();
        assert!(shell.compiled_truth.is_null() && shell.timeline.is_null());
        assert_eq!(shell.content_hash, None);
        assert_eq!(shell.chunker_version, Some(0));
        let id = published(&store);
        let page = read_page_by_id(&*store.read().unwrap(), id as u64)
            .unwrap()
            .unwrap();
        assert!(page.compiled_truth.is_null() && page.timeline.is_null());
        assert_eq!(page.content_hash.as_deref(), Some("h"));
    }

    /// Generation 2 staged: occurrence 3 replaces occurrence 2 at byte 4, with a chunk for
    /// occurrence 3 and one for occurrence 9, which has no row in generation 2.
    pub(super) fn second_generation(store: &Store, id: i64) {
        store
            .open_body_staging(&staging(
                STAGING_2,
                id,
                "55555555-5555-4555-8555-555555555555",
            ))
            .unwrap();
        store
            .stage_segment_texts(
                "default",
                &[text("TWO!\n")],
                &StageTextsOptions {
                    staging_id: Some(STAGING_2.into()),
                },
            )
            .unwrap();
        store
            .stage_manifest_rows(&[row(id, 3, 2, 1, 4, "TWO!\n", STAGING_2)])
            .unwrap();
        store
            .stage_segment_chunks(id, 2, &[chunk(3, 0, "TWO!"), chunk(9, 0, "orphan")])
            .unwrap();
    }

    /// The `body` of a flip of `body_bytes` bytes that publishes `lead` as the timeline lead.
    fn body_with_lead(body_bytes: i64, lead: &str) -> Value {
        json!({
            "content_hash": "h", "body_bytes": body_bytes, "truth_bytes": body_bytes,
            "body_lines": 2, "segment_count": 2, "segmenter_version": 1,
            "truth_lead": "", "timeline_lead": lead, "body_flags": {},
        })
    }

    /// 104,000 distinct six-character tokens, a tsvector of about 1,040,000 bytes: inside the 1,048,575-byte cap with
    /// room for a short lead, not for a lead of 65,536 characters.
    fn near_cap_title() -> String {
        (0..104_000)
            .map(|i| {
                if i < 100_000 {
                    format!("n{i:05}")
                } else {
                    format!("m{:05}", i - 100_000)
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// The flip is one UPDATE that sets the title, the NULL timeline and the NEW lead together, so the search vector
    /// trigger reads the incoming lead. A page with a small title and a long lead that is flipped to a near-cap title
    /// with a short lead is therefore accepted; the same title beside a long lead is refused whole. Before, the
    /// vector was built from the lead the page held before the flip, and the valid flip was refused.
    #[test]
    fn a_flip_builds_the_search_vector_from_its_incoming_lead_not_the_one_it_replaces() {
        let store = crate::test_support::store();
        let long_lead = (0..9_000)
            .map(|i| format!("lead{i}z"))
            .collect::<Vec<_>>()
            .join(" ");
        assert!(long_lead.len() > 65_536);
        let id = published_with(&store, json!({ "body": body_with_lead(8, &long_lead) }));
        second_generation(&store, id);
        let page = |store: &Store| {
            crate::pages::read_page_by_id(&*store.read().unwrap(), id as u64)
                .unwrap()
                .unwrap()
        };
        let incoming = |lead: &str| {
            json!({
                "closeOccurrences": [2],
                "body": body_with_lead(9, lead),
                "meta": { "type": "note", "title": near_cap_title() },
            })
        };
        // The title alone fits; beside a long incoming lead it does not.
        let err = store
            .flip_body_generation(&flip(id, 1, STAGING_2, 9, incoming(&long_lead)))
            .unwrap_err();
        assert!(
            err.message.starts_with("string is too long for tsvector ("),
            "{}",
            err.message
        );
        assert_eq!(page(&store).title, "Flipped");
        assert_eq!(
            read_body_state(&*store.read().unwrap(), id as u64)
                .unwrap()
                .unwrap()
                .body_generation,
            1
        );
        // With a short incoming lead it fits, whatever lead the page held.
        store
            .flip_body_generation(&flip(id, 1, STAGING_2, 9, incoming("short lead")))
            .unwrap();
        assert_eq!(page(&store).title, near_cap_title());
        let state = read_body_state(&*store.read().unwrap(), id as u64)
            .unwrap()
            .unwrap();
        assert_eq!(state.body_generation, 2);
        assert_eq!(state.timeline_lead.as_deref(), Some("short lead"));
    }

    #[test]
    fn staged_chunks_take_new_indexes_and_read_in_document_order() {
        let store = crate::test_support::store();
        let id = published(&store);
        assert_eq!(
            store.stage_segment_chunks(id, 1, &[]).unwrap(),
            Vec::<u32>::new()
        );
        // Occurrence 2 first: document order is the occurrence's byte_start, then the ordinal.
        let first = store
            .stage_segment_chunks(id, 1, &[chunk(2, 0, "two"), chunk(1, 1, "one b")])
            .unwrap();
        assert_eq!(first, vec![0, 1]);
        assert_eq!(
            store
                .stage_segment_chunks(id, 1, &[chunk(1, 0, "one a")])
                .unwrap(),
            vec![2]
        );
        assert_eq!(visible(&store, id), vec!["one a", "one b", "two"]);
    }

    #[test]
    fn a_replace_deletes_the_staged_chunks_it_did_not_keep_for_its_generation_only() {
        let store = crate::test_support::store();
        let id = published(&store);
        store
            .stage_segment_chunks(
                id,
                1,
                &[chunk(1, 0, "a"), chunk(1, 1, "b"), chunk(2, 0, "c")],
            )
            .unwrap();
        store
            .stage_segment_chunks(id, 2, &[chunk(3, 0, "d"), chunk(3, 1, "e")])
            .unwrap();
        let rows = |store: &Store| -> Vec<(u32, String)> {
            let mut rows: Vec<_> = crate::chunks::read_chunks(&*store.read().unwrap(), id as u64)
                .unwrap()
                .into_iter()
                .map(|c| (c.chunk_index, c.chunk_text))
                .collect();
            rows.sort();
            rows
        };
        let all = |texts: &[&str]| -> Vec<(u32, String)> {
            texts
                .iter()
                .enumerate()
                .map(|(i, t)| (i as u32, (*t).to_string()))
                .collect()
        };
        assert_eq!(rows(&store), all(&["a", "b", "c", "d", "e"]));
        // Generation 2 keeps index 3 only; generation 1 is not its to delete.
        store.delete_unstaged_segment_chunks(id, 2, &[3]).unwrap();
        let after = rows(&store);
        assert_eq!(after.len(), 4);
        assert!(after.iter().any(|(i, t)| *i == 3 && t == "d"));
        assert!(!after.iter().any(|(_, t)| t == "e"));
        // Nothing kept deletes the generation's chunks; a generation that has none changes nothing.
        store.delete_unstaged_segment_chunks(id, 2, &[]).unwrap();
        assert_eq!(rows(&store).len(), 3);
        store.delete_unstaged_segment_chunks(id, 9, &[]).unwrap();
        assert_eq!(rows(&store).len(), 3);
        store.delete_unstaged_segment_chunks(-1, 2, &[]).unwrap();
    }

    fn lead(store: &Store, id: i64) -> Option<String> {
        timeline_lead(&*store.read().unwrap(), id as u64).unwrap()
    }

    #[test]
    fn the_timeline_lead_is_the_one_a_flip_published_and_none_otherwise() {
        let store = crate::test_support::store();
        let id = published(&store);
        // The fixture flips with an empty lead: a published lead is never NULL.
        assert_eq!(lead(&store, id), Some(String::new()));
        second_generation(&store, id);
        let mut input = flip(id, 1, STAGING_2, 9, json!({"closeOccurrences": [2]}));
        input.body.timeline_lead = "- 2026-01-02: lead\0 entry".into();
        store.flip_body_generation(&input).unwrap();
        // NUL goes, as with every stored body column.
        assert_eq!(
            lead(&store, id).as_deref(),
            Some("- 2026-01-02: lead entry")
        );

        // A shell no flip has published, an inline page and a missing page have none.
        let shell = store
            .create_segmented_page_shell(
                "notes/shell",
                &serde_json::from_value(json!({"type": "note", "title": "S"})).unwrap(),
                &ShellOptions {
                    source_id: Some("default".into()),
                },
            )
            .unwrap()["id"]
            .as_i64()
            .unwrap();
        assert_eq!(lead(&store, shell), None);
        let inline = store
            .put_page(
                "notes/inline",
                &crate::pages::PageInput {
                    page_type: "note".into(),
                    title: "Inline".into(),
                    compiled_truth: "body".into(),
                    timeline: Some("- 2026-01-02: entry".into()),
                    ..crate::pages::PageInput::default()
                },
                &crate::pages::PutPageOptions::default(),
            )
            .unwrap();
        assert_eq!(lead(&store, inline["id"].as_i64().unwrap()), None);
        assert_eq!(lead(&store, 999_999), None);
    }

    fn kept_timeline(store: &Store, id: i64) -> Option<crate::pages::SearchTimeline> {
        crate::pages::search_timeline(&*store.read().unwrap(), id as u64).unwrap()
    }

    fn keep_timeline(store: &Store, id: i64) {
        store
            .write(|tx| crate::pages::record_search_timeline(tx, id as u64, "rev", "t", "sealed"))
            .unwrap();
        assert!(kept_timeline(store, id).is_some());
    }

    #[test]
    fn a_flip_forgets_the_search_timeline_and_a_refused_flip_keeps_it() {
        let store = crate::test_support::store();
        let id = published(&store);
        keep_timeline(&store, id);
        second_generation(&store, id);
        // A flip refused after the page write (the rows do not tile 99 bytes) writes nothing, so
        // the record stays.
        assert!(
            store
                .flip_body_generation(&flip(
                    id,
                    1,
                    STAGING_2,
                    99,
                    json!({"closeOccurrences": [2]})
                ))
                .is_err()
        );
        assert!(kept_timeline(&store, id).is_some());
        // The fixture's title is "Flipped" both times: the flip forgets the record anyway.
        store
            .flip_body_generation(&flip(id, 1, STAGING_2, 9, json!({"closeOccurrences": [2]})))
            .unwrap();
        assert_eq!(kept_timeline(&store, id), None);
    }

    #[test]
    fn a_refresh_forgets_the_search_timeline_also_with_the_same_text() {
        let store = crate::test_support::store();
        let page = store
            .put_page(
                "notes/r",
                &crate::pages::PageInput {
                    page_type: "note".into(),
                    title: "R".into(),
                    compiled_truth: "body".into(),
                    timeline: Some("tl".into()),
                    ..crate::pages::PageInput::default()
                },
                &crate::pages::PutPageOptions::default(),
            )
            .unwrap();
        let id = page["id"].as_i64().unwrap();
        // A seal that sends the text records it.
        store
            .upsert_chunks(
                "notes/r",
                &[],
                &crate::chunks::UpsertChunksOptions {
                    seal: true,
                    search_timeline: Some("tl".into()),
                    ..crate::chunks::UpsertChunksOptions::default()
                },
            )
            .unwrap();
        assert!(kept_timeline(&store, id).is_some());
        // A refresh of another page, or of a missing one, leaves it.
        store
            .refresh_page_body("notes/missing", "default", "x", "", "h")
            .unwrap();
        assert!(kept_timeline(&store, id).is_some());
        // The same body and timeline: PGLite's trigger still fires on the SET list.
        store
            .refresh_page_body("notes/r", "default", "body", "tl", "h2")
            .unwrap();
        assert_eq!(kept_timeline(&store, id), None);
    }

    fn sealed_texts(store: &Store) -> Vec<String> {
        let mut texts: Vec<String> = store
            .get_chunks("notes/a", &crate::pages::ReadScope::default())
            .unwrap()
            .into_iter()
            .map(|c| c["chunk_text"].as_str().unwrap().to_owned())
            .collect();
        texts.sort();
        texts
    }

    fn stamp(store: &Store, id: i64) -> Option<i16> {
        read_page_by_id(&*store.read().unwrap(), id as u64)
            .unwrap()
            .unwrap()
            .chunker_version
    }

    #[test]
    fn a_seal_shows_the_chunks_and_records_the_lead_at_the_revision() {
        let store = crate::test_support::store();
        let id = published(&store);
        store
            .stage_segment_chunks(id, 1, &[chunk(1, 0, "one"), chunk(2, 0, "two")])
            .unwrap();
        assert!(sealed_texts(&store).is_empty());
        // The fixture flip publishes an empty lead.
        let SealLead {
            lead,
            revision,
            slug,
            source_id,
        } = store.read_segmented_seal_lead(id).unwrap().unwrap();
        assert_eq!(lead, "");
        assert_eq!((slug.as_str(), source_id.as_str()), ("notes/a", "default"));
        store
            .seal_segmented_page(id, "lead\0 text", Some(&revision))
            .unwrap();
        assert_eq!(sealed_texts(&store), ["one", "two"]);
        let kept = kept_timeline(&store, id).unwrap();
        assert_eq!(
            (kept.revision.as_str(), kept.timeline.as_str()),
            (revision.as_str(), "lead text")
        );
        assert_eq!(stamp(&store, id), Some(SEGMENTED_CHUNKER_VERSION));
    }

    #[test]
    fn a_seal_keeps_an_older_chunker_only_while_older_segment_chunks_remain() {
        // Stamped 4 (an older segmented chunker; a flip stores at most 3, so the test sets it), with
        // occurrence 1's generation-1 chunk still stored after the flip to generation 2: the seal keeps 4.
        let store = crate::test_support::store();
        let id = published(&store);
        store
            .stage_segment_chunks(id, 1, &[chunk(1, 0, "one"), chunk(2, 0, "two")])
            .unwrap();
        store.seal_segmented_page(id, "", None).unwrap();
        second_generation(&store, id);
        store
            .flip_body_generation(&flip(
                id,
                1,
                STAGING_2,
                9,
                json!({"closeOccurrences": [2], "retireChunkOccurrences": [2]}),
            ))
            .unwrap();
        store
            .write(|tx| {
                let mut page = read_page_by_id(&*tx, id as u64)?.unwrap();
                page.chunker_version = Some(4);
                write_page(tx, &page)
            })
            .unwrap();
        store.seal_segmented_page(id, "", None).unwrap();
        assert_eq!(stamp(&store, id), Some(4));
        assert_eq!(sealed_texts(&store), ["TWO!", "one"]);
        // Once no chunk predates the generation, the next seal stamps the current chunker.
        store
            .write(|tx| {
                crate::chunks::delete_chunks_matching(tx, id as u64, &|c| {
                    c.segment.is_some_and(|place| place.body_generation < 2)
                })
                .map(|_| ())
            })
            .unwrap();
        store.seal_segmented_page(id, "", None).unwrap();
        assert_eq!(stamp(&store, id), Some(SEGMENTED_CHUNKER_VERSION));
    }

    #[test]
    fn a_seal_of_a_missing_page_is_a_no_op_and_a_moved_revision_refuses() {
        let store = crate::test_support::store();
        assert!(
            store
                .read_segmented_seal_lead(987_654_321)
                .unwrap()
                .is_none()
        );
        store.seal_segmented_page(987_654_321, "x", None).unwrap();
        store.seal_segmented_page(0, "x", None).unwrap();
        let id = published(&store);
        let err = store
            .seal_segmented_page(id, "x", Some("00000000-0000-4000-8000-000000000000"))
            .unwrap_err();
        assert_eq!(err.code, REVISION_CONFLICT);
        assert_eq!(kept_timeline(&store, id), None);
        assert!(sealed_texts(&store).is_empty());
    }

    #[test]
    fn a_flip_publishes_staged_chunks_and_defers_retirement_past_the_cap() {
        let store = crate::test_support::store();
        let id = published(&store);
        store
            .stage_segment_chunks(id, 1, &[chunk(1, 0, "one"), chunk(2, 0, "two")])
            .unwrap();
        second_generation(&store, id);
        assert_eq!(visible(&store, id), vec!["one", "two"]);
        // Two rows match (occurrence 2 at generation 1, and the orphan), over the cap of 1.
        let result = store
            .flip_body_generation(&flip(
                id,
                1,
                STAGING_2,
                9,
                json!({"closeOccurrences": [2], "retireChunkOccurrences": [2], "retireMaxRows": 1}),
            ))
            .unwrap();
        assert_eq!(
            result,
            BodyFlipResult {
                retired_chunks: 0,
                retire_deferred: true
            }
        );
        // Deferred rows stay until a later delete. Rows without a live offset read last.
        assert_eq!(visible(&store, id), vec!["one", "TWO!", "two", "orphan"]);
    }

    #[test]
    fn a_frozen_hit_on_a_chunk_a_deferred_retire_left_reads_no_chunk() {
        use crate::chunk_queries::{ChunkReadScope, FrozenHit, FrozenHitsInput};
        let store = crate::test_support::store();
        let id = published(&store);
        store
            .stage_segment_chunks(id, 1, &[chunk(1, 0, "one"), chunk(2, 0, "two")])
            .unwrap();
        second_generation(&store, id);
        let result = store
            .flip_body_generation(&flip(
                id,
                1,
                STAGING_2,
                9,
                json!({"closeOccurrences": [2], "retireChunkOccurrences": [2], "retireMaxRows": 1}),
            ))
            .unwrap();
        assert!(result.retire_deferred);
        // The page serves its projection, so a frozen hit on it resolves.
        store
            .write(|tx| {
                let mut page = crate::pages::read_page_by_id(&*tx, id as u64)?.unwrap();
                page.text_projection_revision = Some(page.knowledge_revision.clone());
                crate::pages::write_page(tx, &page)
            })
            .unwrap();
        let chunk_id = |text: &str| {
            crate::chunks::read_chunks(&*store.read().unwrap(), id as u64)
                .unwrap()
                .into_iter()
                .find(|c| c.chunk_text == text)
                .unwrap()
                .id as i64
        };
        let hit = |chunk_id: i64, ord: i64| FrozenHit {
            source_id: "default".into(),
            slug: "notes/a".into(),
            chunk_id,
            ord,
        };
        let rows = store
            .resolve_frozen_hits(&FrozenHitsInput {
                hits: vec![hit(chunk_id("two"), 1), hit(chunk_id("one"), 2)],
                scope: ChunkReadScope::default(),
            })
            .unwrap();
        // The retired occurrence's chunk is not part of the live body: its hit keeps the page row with no chunk.
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["ord"], json!(1));
        assert_eq!(rows[0]["chunk_text"], Value::Null);
        assert_eq!(rows[1]["chunk_text"], json!("one"));
    }

    #[test]
    fn a_flip_deletes_retired_segment_chunks_under_the_cap() {
        let store = crate::test_support::store();
        let id = published(&store);
        store
            .stage_segment_chunks(id, 1, &[chunk(1, 0, "one"), chunk(2, 0, "two")])
            .unwrap();
        second_generation(&store, id);
        let result = store
            .flip_body_generation(&flip(
                id,
                1,
                STAGING_2,
                9,
                json!({"closeOccurrences": [2], "retireChunkOccurrences": [2]}),
            ))
            .unwrap();
        assert_eq!(
            result,
            BodyFlipResult {
                retired_chunks: 2,
                retire_deferred: false
            }
        );
        assert_eq!(visible(&store, id), vec!["one", "TWO!"]);
        // The next index follows the highest row left (index 2), as PGLite's MAX(chunk_index) + 1.
        assert_eq!(
            store
                .stage_segment_chunks(id, 2, &[chunk(1, 1, "more")])
                .unwrap(),
            vec![3]
        );
    }

    #[test]
    fn a_refused_flip_publishes_nothing() {
        let store = crate::test_support::store();
        let id = published(&store);
        second_generation(&store, id);
        // The body would end at 10 while the rows cover 9: the flip refuses and the staged
        // chunks stay hidden.
        assert!(
            store
                .flip_body_generation(&flip(
                    id,
                    1,
                    STAGING_2,
                    10,
                    json!({"closeOccurrences": [2]})
                ))
                .is_err()
        );
        assert!(visible(&store, id).is_empty());
    }

    #[test]
    fn deleting_a_page_for_good_forgets_its_segment_view() {
        let store = crate::test_support::store();
        let id = published(&store);
        let view = keys::meta(&format!("chunk_segment_view/{id}"));
        assert!(store.read().unwrap().get(&view).unwrap().is_some());
        store.delete_page("notes/a", None).unwrap();
        assert!(store.read().unwrap().get(&view).unwrap().is_none());
    }

    const LATER: &str = "2100-01-01T00:00:00Z";

    fn sweep(store: &Store, options: Value) -> SegmentSweepResult {
        store
            .sweep_segments(&serde_json::from_value(options).unwrap())
            .unwrap()
    }

    fn swept(chunks: u64, rows: u64, texts: u64, expired: u64) -> SegmentSweepResult {
        SegmentSweepResult {
            retired_chunks_deleted: chunks,
            manifest_rows_deleted: rows,
            texts_deleted: texts,
            stagings_expired: expired,
        }
    }

    fn settle(store: &Store, ids: &[&str]) {
        for id in ids {
            store
                .set_body_staging_state(id, "committed", &StagingStateOptions::default())
                .unwrap();
        }
    }

    fn texts(store: &Store, bodies: &[&str]) -> usize {
        let shas: Vec<String> = bodies.iter().map(|b| sha(b)).collect();
        store.read_segment_texts("default", &shas).unwrap().len()
    }

    fn manifest_len(store: &Store, id: i64) -> usize {
        manifest_rows(&*store.read().unwrap(), id as u64)
            .unwrap()
            .len()
    }

    /// Generation 2 closes occurrence 2 ("two\n") and publishes occurrence 3 ("TWO!\n").
    fn flipped(store: &Store, id: i64) {
        second_generation(store, id);
        store
            .flip_body_generation(&flip(id, 1, STAGING_2, 9, json!({"closeOccurrences": [2]})))
            .unwrap();
        settle(store, &[STAGING, STAGING_2]);
    }

    #[test]
    fn a_sweep_drops_a_closed_generation_and_its_released_text() {
        let store = crate::test_support::store();
        let id = published(&store);
        flipped(&store, id);
        assert_eq!(manifest_len(&store, id), 3);
        // Inside the grace window the row goes and the text stays.
        assert_eq!(sweep(&store, json!({})), swept(0, 1, 0, 0));
        assert_eq!(texts(&store, &["two\n"]), 1);
        // Later the text goes too: no row names it, no live staging is older.
        assert_eq!(sweep(&store, json!({"now": LATER})), swept(0, 0, 1, 0));
        assert_eq!(texts(&store, &["one\n", "two\n", "TWO!\n"]), 2);
        assert_eq!(visible(&store, id), vec!["TWO!"]);
        assert_eq!(sweep(&store, json!({"now": LATER})), swept(0, 0, 0, 0));
    }

    #[test]
    fn a_version_snapshot_keeps_the_generation_it_references() {
        let store = crate::test_support::store();
        let id = published(&store);
        let created = store.create_version("notes/a", Some("default")).unwrap();
        assert_eq!(created["body_storage"], "segmented");
        assert_eq!(created["body_generation"], 1);
        assert_eq!(created["body_bytes"], 8);
        assert_eq!(created["compiled_truth"], Value::Null);
        assert_eq!(created["timeline"], Value::Null);
        flipped(&store, id);
        assert_eq!(sweep(&store, json!({"now": LATER})), swept(0, 0, 0, 0));
        assert_eq!(manifest_len(&store, id), 3);
        assert_eq!(texts(&store, &["two\n"]), 1);
        let versions = store
            .get_versions("notes/a", &crate::pages::VersionsOptions::default())
            .unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0]["body_generation"], 1);
        // An inline page's snapshot carries no segmented columns.
        store
            .put_page(
                "notes/inline",
                &crate::pages::PageInput {
                    page_type: "note".into(),
                    title: "Inline".into(),
                    compiled_truth: "body".into(),
                    ..crate::pages::PageInput::default()
                },
                &crate::pages::PutPageOptions::default(),
            )
            .unwrap();
        let inline = store
            .create_version("notes/inline", Some("default"))
            .unwrap();
        assert!(inline.get("body_storage").is_none() && inline.get("body_generation").is_none());
        assert_eq!(inline["compiled_truth"], "body");
    }

    #[test]
    fn a_request_held_staging_is_not_expired_and_keeps_its_staged_rows() {
        let run = |held: bool| {
            let store = crate::test_support::store();
            let id = published(&store);
            second_generation(&store, id);
            if held {
                let admission: crate::journal::WriteAdmission = serde_json::from_value(json!({
                    "principal": {"kind": "local_cli", "id": "cli"}, "operation": "put_page",
                    "sourceId": "default", "slug": "notes/a",
                    "requestId": "66666666-6666-4666-8666-666666666666",
                    "callerIntent": {"slug": "notes/a"},
                    "intent": {"body_ref": {"staging_id": STAGING_2}},
                }))
                .unwrap();
                store.admit_write(&admission, None).unwrap();
            }
            let result = sweep(&store, json!({"expireStagings": true, "now": LATER}));
            (result, manifest_len(&store, id))
        };
        // Held: only the fixture's first staging expires; the staged row and the staged chunk of
        // occurrence 3 stay, the chunk of occurrence 9 (no row) goes.
        assert_eq!(run(true), (swept(1, 0, 0, 1), 3));
        // Not held: both expire, and the staged row, both staged chunks and the staged text go.
        assert_eq!(run(false), (swept(2, 1, 1, 2), 2));
    }

    #[test]
    fn a_request_inserted_through_the_persistence_api_keeps_its_staging() {
        // The persistence API (`insert_write_request`) writes a queued request into the same
        // REQUEST family as `admit_write`, but charges only the persistence counters, never the
        // journal's own. A request it inserted must still root its staging, so the sweep keeps
        // the staged rows: dropping them would delete text the queued write still needs.
        let run = |held: bool| {
            let store = crate::test_support::store();
            let id = published(&store);
            second_generation(&store, id);
            if held {
                let insert: crate::persistence::WriteRequestInsert =
                    serde_json::from_value(json!({
                        "principalKind": "local_cli", "principalId": "cli",
                        "requestId": "77777777-7777-4777-8777-777777777777",
                        "operation": "put_page", "sourceId": "default",
                        "sourceIncarnation": "88888888-8888-4888-8888-888888888888",
                        "pageId": null, "slug": "notes/a", "worktreeId": null,
                        "topologyGeneration": null, "digest": "digest",
                        "intent": {"body_ref": {"staging_id": STAGING_2}},
                        "authority": {}, "intentBytes": 10, "terminalReservation": 4096,
                        "targetKind": "page", "protocolVersion": 1,
                        "admitterVersion": "v-test", "admitterHostId": null,
                        "counterKeys": [], "clientRequestId": null,
                        "state": "queued", "deferredRefreshId": null,
                    }))
                    .unwrap();
                store.insert_write_request(&insert).unwrap();
            }
            let result = sweep(&store, json!({"expireStagings": true, "now": LATER}));
            (result, manifest_len(&store, id))
        };
        assert_eq!(run(true), (swept(1, 0, 0, 1), 3));
        assert_eq!(run(false), (swept(2, 1, 1, 2), 2));
    }

    #[test]
    fn a_terminal_staging_is_deleted_a_day_after_its_last_change() {
        let store = crate::test_support::store();
        let id = published(&store);
        store
            .set_body_staging_state(STAGING, "aborted", &StagingStateOptions::default())
            .unwrap();
        let present = |store: &Store| {
            store
                .read()
                .unwrap()
                .get(&staging_key(STAGING))
                .unwrap()
                .is_some()
        };
        assert_eq!(
            sweep(&store, json!({"expireStagings": true})),
            swept(0, 0, 0, 0)
        );
        assert!(present(&store));
        // Another page's scope, or another source's, leaves it.
        assert_eq!(
            sweep(
                &store,
                json!({"expireStagings": true, "now": LATER, "pageId": id + 1})
            ),
            swept(0, 0, 0, 0)
        );
        sweep(
            &store,
            json!({"expireStagings": true, "now": LATER, "sourceId": "other"}),
        );
        assert!(present(&store));
        sweep(
            &store,
            json!({"expireStagings": true, "now": LATER, "pageId": id}),
        );
        assert!(!present(&store));
        assert_eq!(count(&store, &staging_text_prefix(STAGING)), 0);
    }

    fn count(store: &Store, prefix: &[u8]) -> usize {
        let mut n = 0;
        scan_prefix(&*store.read().unwrap(), prefix, false, &mut |_, _| {
            n += 1;
            true
        })
        .unwrap();
        n
    }

    #[test]
    fn chunks_only_a_dead_staging_names_go_at_or_below_the_live_generation() {
        let run = |abort: bool| {
            let store = crate::test_support::store();
            let id = published(&store);
            settle(&store, &[STAGING]);
            store
                .open_body_staging(&staging(
                    STAGING_2,
                    id,
                    "55555555-5555-4555-8555-555555555555",
                ))
                .unwrap();
            store
                .stage_segment_texts("default", &[text("late\n")], &StageTextsOptions::default())
                .unwrap();
            store
                .stage_manifest_rows(&[row(id, 7, 2, 2, 8, "late\n", STAGING_2)])
                .unwrap();
            // A late batch at the live generation (the flip went to another write first).
            store
                .write(|tx| {
                    crate::chunks::append_segment_chunks(
                        tx,
                        id as u64,
                        1,
                        &[chunk(7, 0, "late")],
                        0,
                    )
                    .map(|_| ())
                })
                .unwrap();
            if abort {
                store
                    .set_body_staging_state(STAGING_2, "aborted", &StagingStateOptions::default())
                    .unwrap();
            }
            sweep(&store, json!({"pageId": id}))
        };
        assert_eq!(run(false), swept(0, 0, 0, 0));
        assert_eq!(run(true), swept(1, 1, 0, 0));
    }

    #[test]
    fn a_page_scoped_sweep_considers_only_the_texts_its_rows_released() {
        let store = crate::test_support::store();
        let id = published(&store);
        settle(&store, &[STAGING]);
        // A live staging opened before the text: the text may be the one it is about to name.
        store
            .open_body_staging(&staging(
                STAGING_2,
                id,
                "55555555-5555-4555-8555-555555555555",
            ))
            .unwrap();
        store
            .stage_segment_texts("default", &[text("loose\n")], &StageTextsOptions::default())
            .unwrap();
        assert_eq!(
            sweep(&store, json!({"pageId": id, "now": LATER})),
            swept(0, 0, 0, 0)
        );
        assert_eq!(
            sweep(&store, json!({"sourceId": "other", "now": LATER})),
            swept(0, 0, 0, 0)
        );
        assert_eq!(texts(&store, &["loose\n"]), 1);
        assert_eq!(sweep(&store, json!({"now": LATER})), swept(0, 0, 0, 0));
        settle(&store, &[STAGING_2]);
        assert_eq!(
            sweep(&store, json!({"sourceId": "default", "now": LATER})),
            swept(0, 0, 1, 0)
        );
        assert_eq!(texts(&store, &["loose\n", "one\n", "two\n"]), 2);
    }

    fn holder(store: &Store, slug: &str, origin: &str) {
        let input = crate::pages::PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: "inline body".into(),
            source_path: Some(origin.into()),
            ..crate::pages::PageInput::default()
        };
        store
            .put_page(slug, &input, &crate::pages::PutPageOptions::default())
            .unwrap();
    }

    #[test]
    fn a_shell_cannot_claim_an_origin_a_live_page_holds() {
        let store = crate::test_support::store();
        holder(&store, "notes/holder", "docs/a.md");
        let err = store
            .create_segmented_page_shell(
                "notes/twin",
                &serde_json::from_value(
                    json!({"type": "note", "title": "Twin", "source_path": "docs/a.md"}),
                )
                .unwrap(),
                &ShellOptions {
                    source_id: Some("default".into()),
                },
            )
            .unwrap_err();
        assert_eq!(err.code, crate::error::ORIGIN_CLAIMED);
        assert!(
            read_page(&*store.read().unwrap(), "default", "notes/twin")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_flip_cannot_move_a_page_onto_or_revive_it_into_a_claimed_origin() {
        let store = crate::test_support::store();
        let id = published(&store);
        holder(&store, "notes/holder", "docs/a.md");
        let stage = |staging_id: &str, client: &str| {
            store
                .open_body_staging(&staging(staging_id, id, client))
                .unwrap();
            store
                .stage_segment_texts(
                    "default",
                    &[text("one\n"), text("two\n")],
                    &StageTextsOptions {
                        staging_id: Some(staging_id.into()),
                    },
                )
                .unwrap();
            store
                .stage_manifest_rows(&[
                    row(id, 3, 2, 0, 0, "one\n", staging_id),
                    row(id, 4, 2, 1, 4, "two\n", staging_id),
                ])
                .unwrap();
        };
        stage(STAGING_2, "55555555-5555-4555-8555-555555555555");
        // A flip that names the holder's origin.
        let err = store
            .flip_body_generation(&flip(
                id,
                1,
                STAGING_2,
                8,
                json!({"meta": {"type": "note", "title": "Moved", "source_path": "docs/a.md"}}),
            ))
            .unwrap_err();
        assert_eq!(err.code, crate::error::ORIGIN_CLAIMED);
        let page = read_page(&*store.read().unwrap(), "default", "notes/a")
            .unwrap()
            .unwrap();
        assert_eq!(page.title, "Flipped");
        assert_eq!(page.source_path, None);
        assert_eq!(
            read_body_state(&*store.read().unwrap(), id as u64)
                .unwrap()
                .unwrap()
                .body_generation,
            1
        );
        // A deleted page whose origin another page took is not revived by a flip that keeps its origin.
        store
            .write(|tx| {
                let mut page = read_page(&*tx, "default", "notes/a")?.unwrap();
                page.source_path = Some("docs/b.md".into());
                page.deleted_at_us = Some(1);
                write_page(tx, &page)
            })
            .unwrap();
        holder(&store, "notes/taker", "docs/b.md");
        let err = store
            .flip_body_generation(&flip(id, 1, STAGING_2, 8, json!({})))
            .unwrap_err();
        assert_eq!(err.code, crate::error::ORIGIN_CLAIMED);
        let page = read_page(&*store.read().unwrap(), "default", "notes/a")
            .unwrap()
            .unwrap();
        assert!(page.deleted_at_us.is_some());
        assert_eq!(
            read_body_state(&*store.read().unwrap(), id as u64)
                .unwrap()
                .unwrap()
                .body_generation,
            1
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Fact purge statements (src/core/engine-sql/facts-purge.ts), served here because they read and
// write this family's records. The TypeScript members are in store-members/facts-purge-tx.ts.
// ---------------------------------------------------------------------------------------------

/// `listSegmentedVersionsForPurge({ sourceId, needle, pageIds, after })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentedVersionsQuery {
    pub source_id: String,
    pub needle: String,
    pub page_ids: Vec<i64>,
    pub after: i64,
}

/// `deleteUnreferencedPurgedTexts({ sourceId, replaced, claim, fenced })`: `replaced` are hex digests; `claim` and
/// `fenced` are already lowered (the plain claim and the claim as a fence cell stores it).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnreferencedTextsArgs {
    pub source_id: String,
    pub replaced: Vec<String>,
    pub claim: String,
    pub fenced: String,
}

/// `strpos(lower(convert_from(body, 'UTF8')), needle) > 0` for a stored text (body as hex).
fn text_holds(record: &TextRecord, needles: &[&str]) -> Result<bool> {
    let bytes = from_hex(&record.body, "segment text")?;
    let text = crate::cli_reads::pg_text::pg_lower(&String::from_utf8_lossy(&bytes));
    Ok(needles.iter().any(|n| text.contains(n)))
}

impl Store {
    /// `listSegmentedVersionsForPurge`: the next 5000 saved versions with `body_storage = 'segmented'` of the source's
    /// pages after id `after`, in id order, whose page is one of `pageIds` or whose generation's published manifest
    /// rows hold a text that contains `needle` (`SEGMENTED_VERSION_CARRIES`).
    pub fn list_segmented_versions_for_purge(
        &self,
        q: &SegmentedVersionsQuery,
    ) -> Result<Vec<Value>> {
        no_nul(&q.source_id, "listSegmentedVersionsForPurge sourceId")?;
        no_nul(&q.needle, "listSegmentedVersionsForPurge needle")?;
        let named: std::collections::BTreeSet<i64> = q.page_ids.iter().copied().collect();
        let read = self.read()?;
        let mut versions: Vec<_> = crate::trust::tier_reads::all_versions(&*read)?
            .into_iter()
            .filter(|v| {
                v.body_storage.as_deref() == Some("segmented")
                    && i64::try_from(v.id).is_ok_and(|id| id > q.after)
            })
            .collect();
        versions.sort_by_key(|v| v.id);
        let mut out = Vec::new();
        for v in versions {
            let Some(page) = crate::pages::read_page_by_id(&*read, v.page_id)? else {
                continue;
            };
            if page.source_id != q.source_id {
                continue;
            }
            let generation = v.body_generation.unwrap_or_default();
            let carries = || -> Result<bool> {
                for (_, row) in manifest_rows(&*read, v.page_id)? {
                    if !in_generation(&row, generation) {
                        continue;
                    }
                    let sha = from_hex(&row.sha256, "manifest sha256")?;
                    if let Some(text) =
                        get_json::<TextRecord>(&*read, &text_key(&row.source_id, &sha))?
                        && text_holds(&text, &[q.needle.as_str()])?
                    {
                        return Ok(true);
                    }
                }
                Ok(false)
            };
            if !(i64::try_from(v.page_id).is_ok_and(|id| named.contains(&id)) || carries()?) {
                continue;
            }
            let mut tags = v.tags.clone();
            tags.sort();
            out.push(json!({
                "id": v.id, "page_id": v.page_id, "generation": v.body_generation, "slug": page.slug, "title": v.title,
                "type": v.page_type, "frontmatter": crate::jsonb::order_map(v.frontmatter.clone()), "tags": tags,
            }));
            if out.len() == 5000 {
                break;
            }
        }
        Ok(out)
    }

    /// `abortPurgedStagings(stagingIds)`: sets every named staging that is not committed to `aborted`; the page id of
    /// each it aborted that has one, in staging id order (the SQL's `RETURNING` has no order).
    pub fn abort_purged_stagings(&self, ids: &[String]) -> Result<Vec<u64>> {
        let ids: std::collections::BTreeSet<String> = ids
            .iter()
            .map(|id| staging_id_arg(id))
            .collect::<Result<_>>()?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let mut pages = Vec::new();
            for id in &ids {
                let Some(mut record) = get_json::<StagingRecord>(&*tx, &staging_key(id))? else {
                    continue;
                };
                if record.state == "committed" {
                    continue;
                }
                record.state = "aborted".into();
                record.updated_at_us = now;
                put_json(tx, &staging_key(id), &record)?;
                pages.extend(record.page_id);
            }
            Ok(pages)
        })
    }

    /// `deleteUnreferencedPurgedTexts`: deletes the source's segment texts that no manifest row references and whose
    /// digest is in `replaced` or whose lowered text contains `claim` or `fenced`; how many.
    pub fn delete_unreferenced_purged_texts(&self, a: &UnreferencedTextsArgs) -> Result<u64> {
        no_nul(&a.source_id, "deleteUnreferencedPurgedTexts sourceId")?;
        let replaced: std::collections::BTreeSet<Vec<u8>> = a
            .replaced
            .iter()
            .map(|h| from_hex(h, "deleteUnreferencedPurgedTexts replaced"))
            .collect::<Result<_>>()?;
        self.write(|tx| {
            let mut referenced = std::collections::BTreeSet::new();
            for (_, row) in collect::<ManifestRow>(&*tx, &kind_key(MANIFEST))? {
                if row.source_id == a.source_id {
                    referenced.insert(from_hex(&row.sha256, "manifest sha256")?);
                }
            }
            let mut prefix = kind_key(TEXT);
            prefix.extend_from_slice(a.source_id.as_bytes());
            prefix.push(0);
            let mut deleted = 0;
            for (key, text) in collect::<TextRecord>(&*tx, &prefix)? {
                let sha = key[prefix.len()..].to_vec();
                if referenced.contains(&sha) {
                    continue;
                }
                if replaced.contains(&sha)
                    || text_holds(&text, &[a.claim.as_str(), a.fenced.as_str()])?
                {
                    tx.delete(&key)?;
                    deleted += 1;
                }
            }
            Ok(deleted)
        })
    }
}

type PreparedDerivation<'a> = (&'a SegmentDerivationInput, String, String, bool);

/// The rows of `upsertSegmentDerivations`, decoded: each hash decoded, and whether the table's CHECK constraints
/// (kind, state, version, 32-byte hashes) would refuse it. Postgres evaluates the CHECKs after the BEFORE trigger,
/// so a row the trigger drops never reaches them: the refusal is raised in [`put_derivations`].
fn prepare_derivations(rows: &[SegmentDerivationInput]) -> Result<Vec<PreparedDerivation<'_>>> {
    let mut prepared = Vec::with_capacity(rows.len());
    for row in rows {
        let segment = from_hex(
            &row.segment_sha256,
            "upsertSegmentDerivations segmentSha256",
        )?;
        let context = from_hex(&row.context_hash, "upsertSegmentDerivations contextHash")?;
        int4(row.version, "upsertSegmentDerivations version")?;
        let check_failed = !DERIVATION_KINDS.contains(&row.kind.as_str())
            || !DERIVATION_STATES.contains(&row.state.as_str())
            || row.version < 0
            || segment.len() != 32
            || context.len() != 32;
        prepared.push((row, to_hex(&segment), to_hex(&context), check_failed));
    }
    Ok(prepared)
}

/// Upserts decoded derivation rows in the caller's write transaction; a replaced row keeps its `created_at`.
/// Returns how many rows the page-purge sweep trigger dropped (not stored).
fn put_derivations(
    tx: &mut dyn KvWrite,
    prepared: &[PreparedDerivation<'_>],
    now: i64,
) -> Result<u64> {
    let mut seen = HashSet::new();
    let mut refused = 0;
    // The foreign key is checked at the end of the statement, after every row's trigger, CHECK and conflict handling.
    let mut missing_page = None;
    for (row, segment, context, check_failed) in prepared {
        let found = page_u64(row.page_id).and_then(|id| match read_page_by_id(&*tx, id) {
            Ok(Some(page)) => Some((id, page)),
            _ => None,
        });
        let built = match &found {
            Some((page_id, _)) => {
                let key = derivation_key(*page_id, &row.kind, row.occurrence_id);
                let created =
                    get_json::<DerivationRecord>(&*tx, &key)?.map_or(now, |old| old.created_at_us);
                let record = DerivationRecord {
                    pipeline_version: row.version,
                    segment_sha256: segment.clone(),
                    context_hash: context.clone(),
                    state: row.state.clone(),
                    output: row.output.clone(),
                    receipt: row.receipt.clone(),
                    created_at_us: created,
                    updated_at_us: now,
                };
                Some((*page_id, key, record))
            }
            None => None,
        };
        // The trigger on page_segment_derivations runs first: a row a recorded sweep would delete and that holds
        // its claim is not stored, and reaches neither the CHECK constraints nor the conflict handling.
        if let (Some((_, page)), Some((_, _, record))) = (&found, &built)
            && purge_record::sweep_drops(&*tx, record, page, row.occurrence_id)?
        {
            refused += 1;
            continue;
        }
        if *check_failed {
            return Err(violation(format!(
                "new row for relation \"page_segment_derivations\" violates check constraint (page {}, kind \"{}\", occurrence {})",
                row.page_id, row.kind, row.occurrence_id
            )));
        }
        let Some((page_id, key, record)) = built else {
            missing_page.get_or_insert(row.page_id);
            continue;
        };
        if !seen.insert((page_id, row.kind.clone(), row.occurrence_id)) {
            return Err(violation(
                "ON CONFLICT DO UPDATE command cannot affect row a second time (a derivation key repeats in the batch)",
            ));
        }
        put_json(tx, &key, &record)?;
    }
    if let Some(page) = missing_page {
        return Err(violation(format!(
            "insert into \"page_segment_derivations\" violates foreign key: page {page} does not exist"
        )));
    }
    Ok(refused)
}
