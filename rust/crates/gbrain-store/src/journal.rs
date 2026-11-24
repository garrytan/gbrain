//! The write journal: single-writer admission, one durable record per write request, and the
//! receipt the TypeScript write path reads back.
//!
//! This ports the semantics of `src/core/persistence/` (`journal.ts`, `page-mutations.ts`,
//! `identity.ts`), not its SQL. One process owns the brain and the store runs one write
//! transaction at a time, so admission needs no row locks; what survives from the original is the
//! contract:
//!
//! - A write is identified by `(principal kind, principal id, request_id)`. Admitting the same
//!   request again with the same digest returns the stored request; with another digest it is
//!   `idempotency_conflict`.
//! - The number of unfinished requests is bounded per principal and per brain (`admission_refused`).
//! - Requests are numbered by a monotonic `sequence`.
//! - A request ends in one of `committed`, `conflict`, `failed` or `cancelled`, once.
//! - `submit_page_mutation` admits, applies and commits a page write in ONE transaction: the page,
//!   its chunks and postings, the version snapshot of what it replaced and the committed request
//!   are all there after a crash or none of them are. A write that fails on its own terms
//!   (`revision_conflict`, `empty_overwrite`, ...) leaves no page change and a terminal request,
//!   so repeating the call returns the same receipt.
//!
//! Not ported: leases, claims, recovery records, worktree fences and refresh deferral. They exist
//! for crash recovery of file publication, which this engine does not do; `deferred` and
//! `recovering` are accepted as states so a receipt reader that knows them keeps working.

use crate::env::{Env, is_uuid, iso};
use crate::error::{
    ADMISSION_REFUSED, IDEMPOTENCY_CONFLICT, INVALID_STATE, Result, SOURCE_CHANGED, STORE_CORRUPT,
    StoreError, WRITER_NOT_INITIALIZED, WRITER_REJECTED,
};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageInput, PutPageOptions, put_page_in, read_page, snapshot_in, validate_slug};
use crate::sources::{DEFAULT_SOURCE, require_source};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::collections::{BTreeMap, HashSet};

/// The single JSON counter record of format-1 brains, folded into the records below by the
/// format-2 upgrade (`fold_format_1_counters`).
const COUNTERS: &str = "journal_counters";
/// Unfinished-request counters, one record each (8-byte little-endian), so that admissions never
/// all touch one key: `journal_outstanding` for the brain and `journal_outstanding/<principal>`.
const OUTSTANDING: &str = "journal_outstanding";
const NEXT_SEQUENCE: &str = "next_sequence";

pub const PRINCIPAL_KINDS: &[&str] = &[
    "oauth_client",
    "legacy_token",
    "local_cli",
    "local_stdio",
    "application",
];
const STATES: &[&str] = &[
    "queued",
    "deferred",
    "running",
    "recovering",
    "committed",
    "conflict",
    "failed",
    "cancelled",
];
pub(crate) const TERMINAL: &[&str] = &["committed", "conflict", "failed", "cancelled"];

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Principal {
    pub kind: String,
    pub id: String,
}

/// The outstanding-request limits of `DEFAULT_JOURNAL_LIMITS` that apply to this engine.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct JournalLimits {
    pub principal_outstanding: u64,
    pub brain_outstanding: u64,
}

impl Default for JournalLimits {
    fn default() -> Self {
        Self {
            principal_outstanding: 100,
            brain_outstanding: 1000,
        }
    }
}

/// `WriteAdmission`: what a caller says about the write it wants admitted. `caller_intent` is the
/// normalized request (it is digested, so the same request id with other content is refused);
/// `intent` is what is stored for the write and defaults to it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WriteAdmission {
    pub principal: Principal,
    pub operation: String,
    pub source_id: Option<String>,
    /// When given, must equal the source's current incarnation (`source_changed` otherwise).
    pub source_incarnation: Option<String>,
    pub slug: String,
    pub page_id: Option<u64>,
    /// A UUID. Absent: the store mints one.
    pub request_id: Option<String>,
    /// The client's own id when it was not a UUID; stored beside `request_id`, never digested.
    pub client_request_id: Option<String>,
    pub caller_intent: Value,
    pub intent: Option<Value>,
    pub authority: Value,
}

/// A page write for `submit_page_mutation`: the admission fields plus the page and its options.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PageMutation {
    pub principal: Principal,
    pub operation: Option<String>,
    pub request_id: Option<String>,
    pub client_request_id: Option<String>,
    pub source_incarnation: Option<String>,
    pub slug: String,
    pub page: Value,
    pub options: Value,
    pub authority: Value,
}

/// How a request ends (`finish_write`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FinishWrite {
    pub state: String,
    pub outcome: Option<Value>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Counters {
    brain: u64,
    principals: BTreeMap<String, u64>,
}

fn outstanding_key(principal: Option<&str>) -> Vec<u8> {
    match principal {
        None => keys::meta(OUTSTANDING),
        Some(p) => keys::meta(&format!("{OUTSTANDING}/{p}")),
    }
}

/// Format 1 kept the unfinished-request counters as one JSON `journal_counters` record; the
/// format-2 upgrade (`Store::open_kv`) adds it to the per-counter records and deletes it.
pub(crate) fn fold_format_1_counters(tx: &mut dyn KvWrite) -> Result<()> {
    let Some(legacy) = get_json::<Counters>(&*tx, &keys::meta(COUNTERS))? else {
        return Ok(());
    };
    if legacy.brain != 0 {
        tx.add_i64(&outstanding_key(None), legacy.brain as i64)?;
    }
    for (principal, n) in &legacy.principals {
        if *n != 0 {
            tx.add_i64(&outstanding_key(Some(principal)), *n as i64)?;
        }
    }
    tx.delete(&keys::meta(COUNTERS))
}

/// The unfinished-request counters, one record each. A principal whose count is 0 is left out.
fn read_counters(read: &dyn KvRead) -> Result<Counters> {
    let mut counters = Counters {
        brain: crate::kv::read_i64(read, &outstanding_key(None))?.max(0) as u64,
        principals: BTreeMap::new(),
    };
    let prefix = keys::meta(&format!("{OUTSTANDING}/"));
    let mut failure = None;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        let Ok(name) = std::str::from_utf8(&k[prefix.len()..]) else {
            failure = Some(StoreError::new(
                STORE_CORRUPT,
                "bad outstanding counter key",
            ));
            return false;
        };
        let Ok(bytes) = <[u8; 8]>::try_from(v) else {
            failure = Some(StoreError::new(STORE_CORRUPT, "bad outstanding counter"));
            return false;
        };
        let n = i64::from_le_bytes(bytes).max(0) as u64;
        counters.principals.insert(name.to_string(), n);
        true
    })?;
    if let Some(e) = failure {
        return Err(e);
    }
    counters.principals.retain(|_, n| *n > 0);
    Ok(counters)
}

/// What is stored for a request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RequestRecord {
    pub(crate) id: String,
    pub(crate) principal_kind: String,
    pub(crate) principal_id: String,
    pub(crate) request_id: String,
    #[serde(default)]
    pub(crate) client_request_id: Option<String>,
    pub(crate) operation: String,
    pub(crate) source_id: String,
    pub(crate) source_incarnation: String,
    #[serde(default)]
    pub(crate) page_id: Option<u64>,
    pub(crate) slug: String,
    pub(crate) digest: String,
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    pub(crate) intent: Value,
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    pub(crate) authority: Value,
    pub(crate) sequence: u64,
    pub(crate) state: String,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    pub(crate) outcome: Option<Value>,
    #[serde(default)]
    pub(crate) error_code: Option<String>,
    #[serde(default)]
    pub(crate) error_message: Option<String>,
    #[serde(default)]
    pub(crate) blocked_reason: Option<String>,
    pub(crate) created_at_us: i64,
    pub(crate) updated_at_us: i64,
    #[serde(default)]
    pub(crate) completed_at_us: Option<i64>,
    /// The `persistence_requests` columns the native journal does not keep, stored by the
    /// TypeScript journal members (`persistence.rs`). Empty for a natively admitted request.
    #[serde(default, flatten)]
    pub(crate) extra: Map<String, Value>,
}

/// The staging ids that outstanding (not terminal) requests name in `intent.body_ref.staging_id`:
/// the journal arm of PGLite's `liveStagingIds` (`engine-sql/page-body.ts`), a root of the
/// segment sweep. It scans every request, never trusting the journal's own outstanding counter:
/// `insert_write_request` (`persistence.rs`) writes a queued request into this same family and
/// charges only the persistence counters, so that counter can read zero while a request still
/// names a staging.
pub(crate) fn request_held_staging_ids(read: &dyn KvRead) -> Result<HashSet<String>> {
    let mut out = HashSet::new();
    let mut failure = None;
    scan_prefix(read, &[keys::REQUEST], false, &mut |_, v| {
        match serde_json::from_slice::<RequestRecord>(v) {
            Ok(request) if !request.terminal() => {
                if let Some(id) = request
                    .intent
                    .pointer("/body_ref/staging_id")
                    .and_then(Value::as_str)
                {
                    out.insert(id.to_string());
                }
            }
            Ok(_) => {}
            Err(e) => failure = Some(crate::StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

impl RequestRecord {
    fn terminal(&self) -> bool {
        TERMINAL.contains(&self.state.as_str())
    }

    /// `WriteRequest` of `src/core/persistence/model.ts` (the fields this engine keeps).
    pub(crate) fn to_row(&self) -> Value {
        let mut row = json!({
            "id": self.id,
            "principal_kind": self.principal_kind,
            "principal_id": self.principal_id,
            "request_id": self.request_id,
            "client_request_id": self.client_request_id,
            "operation": self.operation,
            "source_id": self.source_id,
            "source_incarnation": self.source_incarnation,
            "page_id": self.page_id,
            "slug": self.slug,
            "digest": self.digest,
            "intent": crate::jsonb::order(self.intent.clone()),
            "authority": crate::jsonb::order(self.authority.clone()),
            "sequence": self.sequence,
            "state": self.state,
            "outcome": self.outcome.clone().map(crate::jsonb::order),
            "error_code": self.error_code,
            "error_message": self.error_message,
            "blocked_reason": self.blocked_reason,
            "created_at": iso(self.created_at_us),
            "updated_at": iso(self.updated_at_us),
            "completed_at": self.completed_at_us.map(iso),
        });
        let Value::Object(fields) = &mut row else {
            unreachable!("json! builds an object")
        };
        crate::persistence::fill_request_columns(fields, &self.extra);
        row
    }

    /// `receiptFor`: the outcome's fields, `outcome`, `request_id`, `client_request_id`, `state`
    /// (`deferred` reads as `queued`), `write_error`, `blocked_reason` and the two timestamps.
    /// `write_error_message` is an addition: this engine has no separate failure detail row.
    pub(crate) fn receipt(&self) -> Value {
        let state = if self.state == "deferred" {
            "queued"
        } else {
            &self.state
        };
        let mut out = Map::new();
        let outcome = self.outcome.clone().map(crate::jsonb::order);
        if let Some(Value::Object(fields)) = &outcome {
            out.extend(fields.clone());
        }
        if let Some(outcome) = outcome {
            out.insert("outcome".into(), outcome);
        }
        out.insert("request_id".into(), json!(self.request_id));
        if let Some(client) = self.client_request_id.as_ref().filter(|c| !c.is_empty()) {
            out.insert("client_request_id".into(), json!(client));
        }
        out.insert("state".into(), json!(state));
        if self.state == "deferred" {
            out.insert("deferred".into(), json!({}));
        }
        if let Some(code) = self.error_code.as_ref().filter(|c| !c.is_empty()) {
            out.insert("write_error".into(), json!(code));
            if let Some(message) = &self.error_message {
                out.insert("write_error_message".into(), json!(message));
            }
        }
        if let Some(reason) = self.blocked_reason.as_ref().filter(|c| !c.is_empty()) {
            out.insert("blocked_reason".into(), json!(reason));
        }
        out.insert("created_at".into(), json!(iso(self.created_at_us)));
        out.insert("updated_at".into(), json!(iso(self.updated_at_us)));
        Value::Object(out)
    }
}

fn principal_key(kind: &str, id: &str) -> String {
    format!("principal:{kind}:{id}")
}

fn check_principal(p: &Principal) -> Result<()> {
    if !PRINCIPAL_KINDS.contains(&p.kind.as_str()) {
        return Err(StoreError::invalid(format!(
            "principal.kind \"{}\" is not one of {}",
            p.kind,
            PRINCIPAL_KINDS.join(", ")
        )));
    }
    if p.id.is_empty() || p.id.contains('\0') {
        return Err(StoreError::invalid(
            "principal.id must be a non-empty string",
        ));
    }
    Ok(())
}

/// JSON with object keys sorted at every level, so equal content digests equal.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let sorted: BTreeMap<&String, Value> =
                map.iter().map(|(k, v)| (k, canonical(v))).collect();
            Value::Object(sorted.into_iter().map(|(k, v)| (k.clone(), v)).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

fn digest_of(operation: &str, source_id: &str, slug: &str, intent: &Value) -> String {
    let text = canonical(&json!({
        "operation": operation,
        "source_id": source_id,
        "slug": slug,
        "intent": intent,
    }))
    .to_string();
    let mut out = String::with_capacity(64);
    for byte in Sha256::digest(text.as_bytes()) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub(crate) fn next_sequence(tx: &mut dyn KvWrite) -> Result<u64> {
    tx.allocate(&keys::meta(NEXT_SEQUENCE), 1)
}

/// The last sequence handed out, 0 before the first. Requests are never deleted on this engine,
/// so this is `max(sequence)` over every request row.
pub(crate) fn max_sequence(read: &dyn KvRead) -> Result<u64> {
    match read.get(&keys::meta(NEXT_SEQUENCE))? {
        Some(bytes) => keys::be8(&bytes)
            .map(|next| next.saturating_sub(1))
            .ok_or_else(|| StoreError::new(STORE_CORRUPT, "bad sequence counter")),
        None => Ok(0),
    }
}

pub(crate) fn read_request(
    read: &dyn KvRead,
    principal: &Principal,
    request_id: &str,
) -> Result<Option<RequestRecord>> {
    if principal.kind.contains('\0') || principal.id.contains('\0') || request_id.contains('\0') {
        return Ok(None);
    }
    let Some(id) = read.get(&keys::request_by_principal(
        &principal.kind,
        &principal.id,
        request_id,
    ))?
    else {
        return Ok(None);
    };
    let id =
        String::from_utf8(id).map_err(|_| StoreError::new(STORE_CORRUPT, "bad request index"))?;
    get_json(read, &keys::request(&id))
}

pub(crate) fn write_request(tx: &mut dyn KvWrite, record: &RequestRecord) -> Result<()> {
    put_json(tx, &keys::request(&record.id), record)
}

/// Admits a write inside `tx`. `true` when the request is new; `false` when the same request was
/// already admitted (its stored record is returned, whatever state it is in).
fn admit_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    admission: &WriteAdmission,
    limits: JournalLimits,
) -> Result<(RequestRecord, bool)> {
    check_principal(&admission.principal)?;
    if admission.operation.is_empty() {
        return Err(StoreError::invalid("operation is required"));
    }
    let slug = validate_slug(&admission.slug)?;
    let source_id = admission
        .source_id
        .clone()
        .unwrap_or_else(|| DEFAULT_SOURCE.into());
    let source = require_source(&*tx, &source_id)?;
    if let Some(given) = &admission.source_incarnation
        && *given != source.incarnation
    {
        return Err(StoreError::new(
            SOURCE_CHANGED,
            format!("source \"{source_id}\" changed after the write was prepared"),
        ));
    }
    let request_id = match &admission.request_id {
        Some(id) if is_uuid(id) => id.to_lowercase(),
        Some(_) => return Err(StoreError::invalid("requestId must be a UUID")),
        None => env.new_uuid(),
    };
    let intent = if admission.caller_intent.is_null() {
        json!({})
    } else {
        admission.caller_intent.clone()
    };
    let digest = digest_of(&admission.operation, &source_id, &slug, &intent);
    if let Some(existing) = read_request(&*tx, &admission.principal, &request_id)? {
        if existing.digest != digest {
            return Err(StoreError::new(
                IDEMPOTENCY_CONFLICT,
                format!("request_id {request_id} was already used for a different write"),
            ));
        }
        return Ok((existing, false));
    }
    // Postgres counts unfinished requests under a row lock; here each counter is its own record
    // and the check is re-run at commit (`counter_below`), so admissions do not conflict with
    // each other unless one of them would cross a limit.
    let pkey = principal_key(&admission.principal.kind, &admission.principal.id);
    let cap = limits.principal_outstanding as i64;
    if let Some(n) = tx.counter_below(&outstanding_key(Some(&pkey)), cap)? {
        return Err(StoreError::new(
            ADMISSION_REFUSED,
            format!(
                "this principal already has {} unfinished writes (limit {})",
                n.max(0),
                limits.principal_outstanding
            ),
        ));
    }
    let cap = limits.brain_outstanding as i64;
    if let Some(n) = tx.counter_below(&outstanding_key(None), cap)? {
        return Err(StoreError::new(
            ADMISSION_REFUSED,
            format!(
                "this brain already has {} unfinished writes (limit {})",
                n.max(0),
                limits.brain_outstanding
            ),
        ));
    }
    tx.add_i64(&outstanding_key(None), 1)?;
    tx.add_i64(&outstanding_key(Some(&pkey)), 1)?;
    let now = env.now_micros();
    let record = RequestRecord {
        id: env.new_uuid(),
        principal_kind: admission.principal.kind.clone(),
        principal_id: admission.principal.id.clone(),
        request_id: request_id.clone(),
        client_request_id: admission.client_request_id.clone(),
        operation: admission.operation.clone(),
        source_id,
        source_incarnation: source.incarnation,
        page_id: admission.page_id,
        slug,
        digest,
        intent: admission.intent.clone().unwrap_or(intent),
        authority: if admission.authority.is_null() {
            json!({})
        } else {
            admission.authority.clone()
        },
        sequence: next_sequence(tx)?,
        state: "queued".into(),
        outcome: None,
        error_code: None,
        error_message: None,
        blocked_reason: None,
        created_at_us: now,
        updated_at_us: now,
        completed_at_us: None,
        extra: Map::new(),
    };
    write_request(tx, &record)?;
    tx.put(
        &keys::request_by_principal(&record.principal_kind, &record.principal_id, &request_id),
        record.id.as_bytes(),
    )?;
    Ok((record, true))
}

/// Ends a request inside `tx`.
fn finish_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    mut record: RequestRecord,
    finish: &FinishWrite,
) -> Result<RequestRecord> {
    if !STATES.contains(&finish.state.as_str()) || !TERMINAL.contains(&finish.state.as_str()) {
        return Err(StoreError::new(
            INVALID_STATE,
            format!("\"{}\" is not a state a write can end in", finish.state),
        ));
    }
    if record.terminal() {
        return Err(StoreError::new(
            INVALID_STATE,
            format!(
                "request {} already ended as {}",
                record.request_id, record.state
            ),
        ));
    }
    crate::persistence::guard_deferred_transition(&record.state, &finish.state)?;
    let now = env.now_micros();
    record.state = finish.state.clone();
    record.outcome = finish.outcome.clone();
    record.error_code = finish.error_code.clone();
    record.error_message = finish.error_message.clone();
    record.blocked_reason = finish.blocked_reason.clone();
    record.updated_at_us = now;
    record.completed_at_us = Some(now);
    write_request(tx, &record)?;
    let pkey = principal_key(&record.principal_kind, &record.principal_id);
    tx.add_i64(&outstanding_key(None), -1)?;
    tx.add_i64(&outstanding_key(Some(&pkey)), -1)?;
    Ok(record)
}

/// Failures of the store itself are never recorded as a write's outcome: the write may succeed
/// when it is tried again.
fn recordable(error: &StoreError) -> bool {
    !error.code.starts_with("store_")
}

impl PageMutation {
    fn admission(&self, operation: &str, source_id: &str) -> WriteAdmission {
        WriteAdmission {
            principal: self.principal.clone(),
            operation: operation.into(),
            source_id: Some(source_id.into()),
            source_incarnation: self.source_incarnation.clone(),
            slug: self.slug.clone(),
            page_id: None,
            request_id: self.request_id.clone(),
            client_request_id: self.client_request_id.clone(),
            caller_intent: json!({"page": self.page, "options": self.options}),
            intent: None,
            authority: self.authority.clone(),
        }
    }
}

impl Store {
    /// `getBrainIdentity()`: `{ brain_id }`. `writer_not_initialized` when the brain has none.
    pub fn get_brain_identity(&self) -> Result<Value> {
        if self.brain_id().is_empty() {
            return Err(StoreError::new(
                WRITER_NOT_INITIALIZED,
                "this brain has no persistence identity",
            ));
        }
        Ok(json!({"brain_id": self.brain_id()}))
    }

    /// `admitWrite(admission, overrides?)`: the stored `WriteRequest`, state `queued` for a new
    /// request.
    pub fn admit_write(
        &self,
        admission: &WriteAdmission,
        limits: Option<JournalLimits>,
    ) -> Result<Value> {
        self.write(|tx| {
            admit_in(tx, &*self.env, admission, limits.unwrap_or_default()).map(|(r, _)| r.to_row())
        })
    }

    /// `getWriteRequest(principal, requestId)`: the stored `WriteRequest` or `None`.
    pub fn get_write_request(
        &self,
        principal: &Principal,
        request_id: &str,
    ) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(read_request(&*read, principal, &request_id.to_lowercase())?.map(|r| r.to_row()))
    }

    /// `receiptFor(getWriteRequest(...))`, or `None`.
    pub fn get_write_receipt(
        &self,
        principal: &Principal,
        request_id: &str,
    ) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(read_request(&*read, principal, &request_id.to_lowercase())?.map(|r| r.receipt()))
    }

    /// Ends an admitted request as `committed`, `conflict`, `failed` or `cancelled`. Returns its
    /// receipt. `invalid_state` for a request that already ended or a state that is not terminal;
    /// `invalid_argument` for a request the principal never admitted.
    pub fn finish_write(
        &self,
        principal: &Principal,
        request_id: &str,
        finish: &FinishWrite,
    ) -> Result<Value> {
        self.write(|tx| {
            let Some(record) = read_request(&*tx, principal, &request_id.to_lowercase())? else {
                return Err(StoreError::invalid(format!(
                    "no write request {request_id} for this principal"
                )));
            };
            finish_in(tx, &*self.env, record, finish).map(|r| r.receipt())
        })
    }

    /// `{ brain, principals: { "principal:<kind>:<id>": n } }`: unfinished requests.
    pub fn journal_outstanding(&self) -> Result<Value> {
        let counters = read_counters(&*self.read()?)?;
        Ok(json!({"brain": counters.brain, "principals": counters.principals}))
    }

    /// Admits, applies and commits a page write in one transaction and returns its receipt.
    ///
    /// The receipt's `state` is `committed` and its outcome is `{ status: "created" | "updated" |
    /// "unchanged", slug, page_id, source_id, knowledge_revision, content_hash, chunks,
    /// version_id }`. When the write fails on its own terms the page is untouched, the request
    /// ends `conflict` (`revision_conflict`, `revision_required`) or `failed`, and the receipt
    /// says so in `write_error`; calling again returns that same receipt. Errors before admission
    /// (`invalid_argument`, `invalid_slug`, `source_not_found`, `source_changed`,
    /// `idempotency_conflict`, `admission_refused`) and store errors are returned as errors.
    pub fn submit_page_mutation(
        &self,
        mutation: &PageMutation,
        limits: Option<JournalLimits>,
    ) -> Result<Value> {
        let limits = limits.unwrap_or_default();
        let operation = mutation.operation.as_deref().unwrap_or("put_page");
        let input: PageInput = serde_json::from_value(mutation.page.clone())
            .map_err(|e| StoreError::invalid(format!("submitPageMutation page: {e}")))?;
        let options: PutPageOptions = if mutation.options.is_null() {
            PutPageOptions::default()
        } else {
            serde_json::from_value(mutation.options.clone())
                .map_err(|e| StoreError::invalid(format!("submitPageMutation options: {e}")))?
        };
        let source_id = options
            .source_id
            .clone()
            .unwrap_or_else(|| DEFAULT_SOURCE.into());
        let admission = mutation.admission(operation, &source_id);
        let applying = Cell::new(false);
        let attempt = self.write(|tx| {
            applying.set(false);
            let (record, fresh) = admit_in(tx, &*self.env, &admission, limits)?;
            if !fresh {
                return Ok(record);
            }
            applying.set(true);
            let outcome = self.apply_put(tx, &record, &input, &options)?;
            applying.set(false);
            let finish = FinishWrite {
                state: "committed".into(),
                outcome: Some(outcome),
                ..FinishWrite::default()
            };
            finish_in(tx, &*self.env, record, &finish)
        });
        match attempt {
            Ok(record) => Ok(record.receipt()),
            Err(error) if applying.get() && recordable(&error) => {
                // The page write rolled back with the admission. Record the failure on its own.
                let state = if matches!(
                    error.code,
                    crate::error::REVISION_CONFLICT | crate::error::REVISION_REQUIRED
                ) {
                    "conflict"
                } else {
                    "failed"
                };
                self.write(|tx| {
                    let (record, fresh) = admit_in(tx, &*self.env, &admission, limits)?;
                    if !fresh {
                        return Ok(record);
                    }
                    let finish = FinishWrite {
                        state: state.into(),
                        error_code: Some(error.code.into()),
                        error_message: Some(error.message.clone()),
                        ..FinishWrite::default()
                    };
                    finish_in(tx, &*self.env, record, &finish)
                })
                .map(|r| r.receipt())
            }
            Err(error) => Err(error),
        }
    }

    fn apply_put(
        &self,
        tx: &mut dyn KvWrite,
        request: &RequestRecord,
        input: &PageInput,
        options: &PutPageOptions,
    ) -> Result<Value> {
        let prior = read_page(&*tx, &request.source_id, &request.slug)?;
        let record = put_page_in(tx, &*self.env, &request.slug, input, options)?;
        let mut version_id = Value::Null;
        let mut status = "created";
        if let Some(prior) = &prior {
            let unchanged = prior.knowledge_revision == record.knowledge_revision
                && prior.content_hash == record.content_hash
                && prior.deleted_at_us.is_none();
            status = if unchanged { "unchanged" } else { "updated" };
            if !unchanged {
                version_id = json!(snapshot_in(tx, &*self.env, prior)?.id);
            }
        }
        let chunks = crate::chunks::read_chunks(&*tx, record.id)?.len();
        Ok(json!({
            "status": status,
            "slug": record.slug,
            "page_id": record.id,
            "source_id": record.source_id,
            "knowledge_revision": record.knowledge_revision,
            "content_hash": record.content_hash,
            "chunks": chunks,
            "version_id": version_id,
        }))
    }
}

/// `registerLocalWriter` input: a UUID id, the lane (`cli` or `stdio`), the SHA-256 of the
/// credential (the credential itself never reaches the store) and the grant ceiling.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WriterRegistration {
    pub id: String,
    pub lane: String,
    pub credential_hash: String,
    pub grant_ceiling: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WriterRecord {
    id: String,
    lane: String,
    credential_hash: String,
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    grant_ceiling: Value,
    created_at_us: i64,
    #[serde(default)]
    revoked_at_us: Option<i64>,
}

/// The stored id and lane of the local writer `id` (case-folded key), revoked or not.
pub(crate) fn read_writer_record(read: &dyn KvRead, id: &str) -> Result<Option<(String, String)>> {
    Ok(get_json::<WriterRecord>(read, &keys::writer(&id.to_lowercase()))?.map(|w| (w.id, w.lane)))
}

impl WriterRecord {
    fn to_row(&self) -> Value {
        json!({
            "id": self.id,
            "lane": self.lane,
            "credential_hash": self.credential_hash,
            "grant_ceiling": crate::jsonb::ordered(&self.grant_ceiling),
            "created_at": iso(self.created_at_us),
            "revoked_at": self.revoked_at_us.map(iso),
        })
    }
}

impl Store {
    /// `registerLocalWriter`: records the writer unless it is already there. Idempotent for the
    /// same id, lane and credential hash; `writer_rejected` for a revoked registration, another
    /// lane or credential under the same id, or a credential already registered under another id.
    pub fn register_local_writer(&self, registration: &WriterRegistration) -> Result<Value> {
        if !is_uuid(&registration.id) {
            return Err(StoreError::invalid("a local writer id is a UUID"));
        }
        if registration.lane != "cli" && registration.lane != "stdio" {
            return Err(StoreError::invalid("a local writer lane is cli or stdio"));
        }
        if registration.credential_hash.is_empty() {
            return Err(StoreError::invalid("credentialHash is required"));
        }
        let id = registration.id.to_lowercase();
        self.write(|tx| {
            if let Some(existing) = get_json::<WriterRecord>(&*tx, &keys::writer(&id))? {
                if existing.revoked_at_us.is_some() {
                    return Err(StoreError::new(
                        WRITER_REJECTED,
                        "this local writer registration was revoked",
                    ));
                }
                if existing.lane != registration.lane
                    || existing.credential_hash != registration.credential_hash
                {
                    return Err(StoreError::new(
                        WRITER_REJECTED,
                        format!("registration {id} exists with another credential or lane"),
                    ));
                }
                return Ok(existing.to_row());
            }
            let mut taken = false;
            scan_prefix(&*tx, &[keys::WRITER], false, &mut |_, v| {
                if let Ok(other) = serde_json::from_slice::<WriterRecord>(v)
                    && other.credential_hash == registration.credential_hash
                {
                    taken = true;
                }
                !taken
            })?;
            if taken {
                return Err(StoreError::new(
                    WRITER_REJECTED,
                    "this local writer credential is registered under another id",
                ));
            }
            let record = WriterRecord {
                id: id.clone(),
                lane: registration.lane.clone(),
                credential_hash: registration.credential_hash.clone(),
                grant_ceiling: registration
                    .grant_ceiling
                    .clone()
                    .unwrap_or_else(|| json!({})),
                created_at_us: self.env.now_micros(),
                revoked_at_us: None,
            };
            put_json(tx, &keys::writer(&id), &record)?;
            Ok(record.to_row())
        })
    }

    /// `insertLocalWriterRow`: the `INSERT .. ON CONFLICT DO NOTHING` of PGLite's
    /// `persistence_local_writers`. True when this call stored the row; false, with nothing
    /// written, when a row already holds the id or the credential hash (the table's two unique
    /// keys), whatever that row's lane, revocation or grant. The lane and id checks are the
    /// table's own constraints, so a bad lane or a non-UUID id is an error, not a false.
    pub fn insert_local_writer_row(&self, registration: &WriterRegistration) -> Result<bool> {
        if !is_uuid(&registration.id) {
            return Err(StoreError::invalid("a local writer id is a UUID"));
        }
        if registration.lane != "cli" && registration.lane != "stdio" {
            return Err(StoreError::invalid("a local writer lane is cli or stdio"));
        }
        let id = registration.id.to_lowercase();
        self.write(|tx| {
            if get_json::<WriterRecord>(&*tx, &keys::writer(&id))?.is_some() {
                return Ok(false);
            }
            let mut taken = false;
            scan_prefix(&*tx, &[keys::WRITER], false, &mut |_, v| {
                if let Ok(other) = serde_json::from_slice::<WriterRecord>(v)
                    && other.credential_hash == registration.credential_hash
                {
                    taken = true;
                }
                !taken
            })?;
            if taken {
                return Ok(false);
            }
            let record = WriterRecord {
                id: id.clone(),
                lane: registration.lane.clone(),
                credential_hash: registration.credential_hash.clone(),
                grant_ceiling: registration
                    .grant_ceiling
                    .clone()
                    .unwrap_or_else(|| json!({})),
                created_at_us: self.env.now_micros(),
                revoked_at_us: None,
            };
            put_json(tx, &keys::writer(&id), &record)?;
            Ok(true)
        })
    }

    /// `persistence_local_writers` row of `id`, or `None`.
    pub fn read_local_writer(&self, id: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        if id.contains('\0') {
            return Ok(None);
        }
        Ok(
            get_json::<WriterRecord>(&*read, &keys::writer(&id.to_lowercase()))?
                .map(|w| w.to_row()),
        )
    }

    /// `revokeLocalWriter`: true when the registration exists (a second revoke keeps the first time).
    pub fn revoke_local_writer(&self, id: &str) -> Result<bool> {
        self.write(|tx| {
            let key = keys::writer(&id.to_lowercase());
            let Some(mut record) = get_json::<WriterRecord>(&*tx, &key)? else {
                return Ok(false);
            };
            if record.revoked_at_us.is_none() {
                record.revoked_at_us = Some(self.env.now_micros());
                put_json(tx, &key, &record)?;
            }
            Ok(true)
        })
    }
}
