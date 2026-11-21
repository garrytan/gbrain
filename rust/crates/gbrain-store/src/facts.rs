//! Facts and their supersession chains: the `facts` table of the PGLite engine.
//!
//! Members: insertFact, insertFacts, deleteFactsForPage, expireFact, listFactsByEntity,
//! listFactsSince, listFactsKeyset, listFactsBySession, listSupersessions,
//! countUnconsolidatedFacts, findCandidateDuplicates, consolidateFact, findTrajectory,
//! getFactsHealth, migrateFactsToCanonical, the `listUnattributedFacts` review-list read and
//! the `pageCollapseFacts` search read (`facts/collapse.rs`). Other families read the rows
//! through `fact_exists`
//! (eval capture) and write them through `write_fact` / `delete_fact` (ontology).
//!
//! Keys (every one starts with `keys::FACT`, `F`; a text part ends with a NUL byte, and no text
//! column may hold one):
//! - `F 0x01 id -> FactRecord`: one fact row, the `id` primary key (8 big-endian bytes).
//! - `F 0x02 source_id id -> ()`: the rows of a source.
//! - `F 0x03 source_id entity_slug id -> ()`: the rows of an entity (`entity_slug` not NULL).
//! - `F 0x04 source_id source_markdown_slug id -> ()`: the rows of a page (slug not NULL).
//! - `F 0x05 source_id source_markdown_slug row_num -> id`: the `idx_facts_fence_key` unique
//!   index (`row_num` not NULL). `row_num` is 4 big-endian bytes with the sign bit flipped.
//! - `F 0x06 superseded_by id -> ()`: the rows that name a row as their successor, for the
//!   `ON DELETE SET NULL` foreign key.
//! - `F 0x07 source_id entity_slug dimension value_hash source_markdown_slug valid_from -> id`:
//!   the `idx_facts_ontology_stint_dedup` unique index (every part not NULL, as Postgres counts
//!   NULLs distinct).
//! - `F 0x08` and `F 0x09`: the `open_loops` table (`facts/loops.rs` lists them).
//! - `F 0x0A` and `F 0x0B`: the `fact_relink_attempts` table (`facts/relink.rs` lists them).
//! - `F 0x0C`: the `page_purges` ledger (`facts/page_purges.rs`), read only.
//! - `F 0x0D page_id`: the `page_facts_reconcile` watermark (`facts/reconcile.rs`), read only.
//! - `F 0x0E generation_id`: the `derived_generations` ledger with its items
//!   (`facts/generations.rs`), read only.
//! - meta `next_facts_id`: the id sequence. An insert that `ON CONFLICT DO NOTHING` skips still
//!   takes an id, as `nextval` does.
//!
//! Time: every `*_us` field is a UTC microsecond time from the store's clock; one write or read
//! reads the clock once, as `now()` is the transaction's start time.
//!
//! Vectors: `embedding` is the `halfvec(N)` column, held in the row as `f16` bit patterns;
//! `facts/embedding.rs` reads the literal, rounds it and computes the cosine distance as pgvector.
//!
//! Text: `ILIKE` and `gbrain_fact_normalize` lower-case with `pg_lower` (Postgres `lower()` on a
//! UTF-8 database); `ILIKE` and `LIKE` read `\` as the escape character.

mod collapse;
pub mod cycle;
pub mod doctor;
mod embedding;
mod fence;
pub mod generations;
pub mod loops;
mod page_purges;
mod privacy;
pub mod purge;
pub mod reconcile;
pub mod relink;
pub mod relink_writes;
pub mod repair;
pub mod trust;
pub mod trust_reads;

pub use fence::{FenceContext, FenceTarget};
use privacy::hidden_by_private_provenance;
pub use privacy::{OwnerOnly, PrivacyPolicy};
pub(crate) use privacy::{
    OwnerOnlyCache, OwnerOnlySources, page_hidden, page_hidden_with, version_hidden,
};

use crate::chunks::embedding_dimensions;
use crate::config::read_config;
use crate::dream::int4;
use crate::env::{iso, parse_iso};
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::keyword::{
    or_of_lexemes, plainto_tsquery, to_tsvector, ts_matches, ts_rank_cd, with_query_stack,
};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::{next_id, read_page};
use crate::sources::read_source;
use crate::timeline_queries::timestamptz_text;
use crate::trust::{OriginStamp, StampRow, TrustPolicy, TrustTable, TrustTier, WriteTrust, stamp};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

const ROW: u8 = 0x01;
const BY_SOURCE: u8 = 0x02;
const BY_ENTITY: u8 = 0x03;
const BY_PAGE: u8 = 0x04;
const FENCE: u8 = 0x05;
const REFS: u8 = 0x06;
const STINT: u8 = 0x07;

pub(crate) const COUNTER: &str = "next_facts_id";
const TABLE: &str = "facts";
const FENCE_INDEX: &str = "idx_facts_fence_key";
const STINT_INDEX: &str = "idx_facts_ontology_stint_dedup";

/// `AUDIT_ROW_SOURCES` (src/core/facts/audit-sources.ts): checkpoint rows, never user facts.
pub(crate) const AUDIT_ROW_SOURCES: [&str; 3] = [
    "cli:extract-conversation-facts:terminal:v2",
    "cli:extract-conversation-facts:non-extractable:v2",
    "cli:extract-conversation-facts:terminal",
];
/// `CONVERSATION_FACTS_SOURCE_PREFIX`: `COALESCE(source, '') LIKE '<prefix>%'` is a conversation fact.
pub(crate) const CONVERSATION_PREFIX: &str = "cli:extract-conversation-facts";
const MEMBER_PAGE_PREFIX: &str = "memory/members/";
const SCOPE_PAGE_SLUG: &str = "memory/scope";
const QUARANTINE_KEY: &str = "quarantine";

const KINDS: [&str; 6] = [
    "event",
    "preference",
    "commitment",
    "belief",
    "fact",
    "idea",
];
const VISIBILITIES: [&str; 2] = ["private", "world"];
const NOTABILITIES: [&str; 3] = ["high", "medium", "low"];
const ATTRIBUTIONS: [&str; 3] = ["user", "assistant", "other"];

const DAY_US: i64 = 86_400_000_000;

/// One `facts` row. The ontology family reads and writes the same rows.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub(crate) struct FactRecord {
    pub id: u64,
    pub source_id: String,
    pub entity_slug: Option<String>,
    pub fact: String,
    pub kind: String,
    pub visibility: String,
    pub notability: String,
    pub context: Option<String>,
    pub valid_from_us: i64,
    pub valid_until_us: Option<i64>,
    pub expired_at_us: Option<i64>,
    pub superseded_by: Option<u64>,
    pub consolidated_at_us: Option<i64>,
    pub consolidated_into: Option<i64>,
    pub source: String,
    pub source_session: Option<String>,
    /// A `REAL` column: stored as the `f32` Postgres keeps.
    pub confidence: f32,
    /// The `halfvec(N)` column: every element an `f16` value, held as its 16-bit pattern.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "embedding::half_hex"
    )]
    pub embedding: Option<Vec<f32>>,
    pub embedding_model: Option<String>,
    pub embedded_text_hash: Option<String>,
    pub embedded_at_us: Option<i64>,
    pub created_at_us: i64,
    pub row_num: Option<i32>,
    pub source_markdown_slug: Option<String>,
    pub claim_metric: Option<String>,
    pub claim_value: Option<f64>,
    pub claim_unit: Option<String>,
    pub claim_period: Option<String>,
    pub event_type: Option<String>,
    pub dimension: Option<String>,
    pub value: Option<String>,
    pub value_hash: Option<String>,
    pub dim_status: Option<String>,
    pub attributed_to: Option<String>,
    /// `trust_tier`: the tier name [`write_fact`] stamped (`trust::stamp`). Empty, as in a record
    /// written before the store kept the column, reads as `unknown` ([`TrustTier::stored`]).
    pub trust_tier: String,
    /// `write_origin`: the provenance JSON of the write that stamped the row (NULL: none).
    pub write_origin: Option<Value>,
}

impl FactRecord {
    /// The stored tier (`storedTrustTier`).
    pub(crate) fn tier(&self) -> TrustTier {
        TrustTier::stored(Some(&self.trust_tier))
    }

    /// Whether a [`TrustTable::Facts`] content column differs between `self` and `new` (the
    /// trigger's `IS DISTINCT FROM` chain): fact, entity_slug, kind, the four claim columns,
    /// value, event_type, dimension and context.
    fn trust_content_changed(&self, new: &FactRecord) -> bool {
        let float = |a: Option<f64>, b: Option<f64>| match (a, b) {
            (Some(a), Some(b)) => !(a == b || (a.is_nan() && b.is_nan())),
            (a, b) => a.is_some() != b.is_some(),
        };
        self.fact != new.fact
            || self.entity_slug != new.entity_slug
            || self.kind != new.kind
            || self.claim_metric != new.claim_metric
            || float(self.claim_value, new.claim_value)
            || self.claim_unit != new.claim_unit
            || self.claim_period != new.claim_period
            || self.value != new.value
            || self.event_type != new.event_type
            || self.dimension != new.dimension
            || self.context != new.context
    }

    /// `expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())`.
    pub(crate) fn active(&self, now: i64) -> bool {
        self.expired_at_us.is_none() && self.valid_until_us.is_none_or(|until| until > now)
    }

    /// The cosine arm's comparability: a vector from `model`, of `len` elements, whose
    /// `embedded_text_hash` is `md5(fact)` (the text has not changed since it was embedded).
    fn comparable(&self, model: &str, len: usize) -> bool {
        self.embedding.as_ref().is_some_and(|v| v.len() == len)
            && self.embedding_model.as_deref() == Some(model)
            && self.embedded_text_hash.as_deref() == Some(embedding::md5_hex(&self.fact).as_str())
    }

    fn audit_row(&self) -> bool {
        AUDIT_ROW_SOURCES.contains(&self.source.as_str())
    }

    /// `COALESCE(source, '') LIKE 'cli:extract-conversation-facts%'` (the prefix holds no wildcard).
    pub(crate) fn conversation_slot(&self) -> bool {
        self.source.starts_with(CONVERSATION_PREFIX)
    }

    /// `onOwnedMemoryPageSql`: the row sits on a member page or the scope page.
    fn on_owned_memory_page(&self) -> bool {
        let slug = self.source_markdown_slug.as_deref().unwrap_or("");
        slug.starts_with(MEMBER_PAGE_PREFIX) || slug == SCOPE_PAGE_SLUG
    }

    /// `rowToFact` before the TypeScript member turns the times into `Date`.
    fn to_json(&self, fingerprint: bool, created_at_iso: bool) -> Value {
        let time = |us: Option<i64>| us.map(iso);
        let mut out = Map::new();
        out.insert("id".into(), json!(self.id));
        out.insert("source_id".into(), json!(self.source_id));
        out.insert("entity_slug".into(), json!(self.entity_slug));
        out.insert("fact".into(), json!(self.fact));
        out.insert("kind".into(), json!(self.kind));
        out.insert("visibility".into(), json!(self.visibility));
        out.insert("notability".into(), json!(self.notability));
        out.insert("context".into(), json!(self.context));
        out.insert("valid_from".into(), json!(iso(self.valid_from_us)));
        out.insert("valid_until".into(), json!(time(self.valid_until_us)));
        out.insert("expired_at".into(), json!(time(self.expired_at_us)));
        out.insert("superseded_by".into(), json!(self.superseded_by));
        out.insert(
            "consolidated_at".into(),
            json!(time(self.consolidated_at_us)),
        );
        out.insert("consolidated_into".into(), json!(self.consolidated_into));
        out.insert("source".into(), json!(self.source));
        out.insert("source_session".into(), json!(self.source_session));
        out.insert("confidence".into(), json!(real(self.confidence)));
        out.insert("embedding".into(), vector_json(self.embedding.as_deref()));
        out.insert("embedding_model".into(), json!(self.embedding_model));
        out.insert("embedded_text_hash".into(), json!(self.embedded_text_hash));
        out.insert("embedded_at".into(), json!(time(self.embedded_at_us)));
        out.insert("created_at".into(), json!(iso(self.created_at_us)));
        if fingerprint {
            out.insert(
                "fact_fingerprint".into(),
                json!(fact_fingerprint(&self.fact)),
            );
        }
        if created_at_iso {
            out.insert("created_at_iso".into(), json!(iso(self.created_at_us)));
        }
        if let Some(who) = self.attributed_to.as_deref().filter(|s| !s.is_empty()) {
            out.insert("attributed_to".into(), json!(who));
        }
        out.insert("trust_tier".into(), json!(self.tier().as_str()));
        out.insert("write_origin".into(), json!(self.write_origin));
        if let Some(m) = self.claim_metric.as_deref().filter(|s| !s.is_empty()) {
            out.insert("claim_metric".into(), json!(m));
        }
        if let Some(v) = self.claim_value {
            out.insert("claim_value".into(), json!(v));
        }
        if let Some(u) = self.claim_unit.as_deref().filter(|s| !s.is_empty()) {
            out.insert("claim_unit".into(), json!(u));
        }
        if let Some(p) = self.claim_period.as_deref().filter(|s| !s.is_empty()) {
            out.insert("claim_period".into(), json!(p));
        }
        Value::Object(out)
    }
}

/// A stored vector as the plain number list the TypeScript member turns into a `Float32Array`.
fn vector_json(vector: Option<&[f32]>) -> Value {
    vector.map_or(Value::Null, |v| {
        Value::Array(v.iter().map(|&x| json!(f64::from(x))).collect())
    })
}

// ---------------------------------------------------------------------------------------------
// Keys and the row writer every member goes through.

/// `F 0x01 id`: the key of fact row `id`.
pub(crate) fn fact_key(id: u64) -> Vec<u8> {
    let mut key = vec![keys::FACT, ROW];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn text_key(tag: u8, parts: &[&str]) -> Vec<u8> {
    let mut key = vec![keys::FACT, tag];
    for part in parts {
        key.extend_from_slice(part.as_bytes());
        key.push(0);
    }
    key
}

fn with_id(mut key: Vec<u8>, id: u64) -> Vec<u8> {
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn refs_prefix(target: u64) -> Vec<u8> {
    with_id(vec![keys::FACT, REFS], target)
}

fn time_bytes(us: i64) -> [u8; 8] {
    ((us as u64) ^ (1 << 63)).to_be_bytes()
}

fn row_bytes(n: i32) -> [u8; 4] {
    ((n as u32) ^ (1 << 31)).to_be_bytes()
}

/// `F 0x05`: the fence key of `(source, slug, row_num)`.
fn fence_key(source_id: &str, slug: &str, row_num: i32) -> Vec<u8> {
    let mut key = text_key(FENCE, &[source_id, slug]);
    key.extend_from_slice(&row_bytes(row_num));
    key
}

/// The index entries of a row: each key and, for a unique index, its name.
fn index_keys(r: &FactRecord) -> Vec<(Vec<u8>, Option<&'static str>)> {
    let mut out = vec![(with_id(text_key(BY_SOURCE, &[&r.source_id]), r.id), None)];
    if let Some(entity) = &r.entity_slug {
        out.push((
            with_id(text_key(BY_ENTITY, &[&r.source_id, entity]), r.id),
            None,
        ));
    }
    if let Some(slug) = &r.source_markdown_slug {
        out.push((
            with_id(text_key(BY_PAGE, &[&r.source_id, slug]), r.id),
            None,
        ));
        if let Some(n) = r.row_num {
            out.push((fence_key(&r.source_id, slug, n), Some(FENCE_INDEX)));
        }
    }
    if let Some(target) = r.superseded_by {
        out.push((with_id(refs_prefix(target), r.id), None));
    }
    if let (Some(dim), Some(entity), Some(hash), Some(slug)) = (
        &r.dimension,
        &r.entity_slug,
        &r.value_hash,
        &r.source_markdown_slug,
    ) {
        let mut key = text_key(STINT, &[&r.source_id, entity, dim, hash, slug]);
        key.extend_from_slice(&time_bytes(r.valid_from_us));
        out.push((key, Some(STINT_INDEX)));
    }
    out
}

fn duplicate(index: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!("duplicate key value violates unique constraint \"{index}\""),
    )
}

fn check_violation(constraint: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!("new row for relation \"{TABLE}\" violates check constraint \"{constraint}\""),
    )
}

fn foreign_key(constraint: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "insert or update on table \"{TABLE}\" violates foreign key constraint \"{constraint}\""
        ),
    )
}

fn not_null(column: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "null value in column \"{column}\" of relation \"{TABLE}\" violates not-null constraint"
        ),
    )
}

fn invalid(message: String) -> StoreError {
    StoreError::new(INVALID_ARGUMENT, message)
}

/// The `CHECK` constraints and the NUL rule of a row about to be written.
pub(crate) fn check_row(op: &str, r: &FactRecord) -> Result<()> {
    let texts: [(&str, Option<&str>); 18] = [
        ("source_id", Some(&r.source_id)),
        ("entity_slug", r.entity_slug.as_deref()),
        ("fact", Some(&r.fact)),
        ("kind", Some(&r.kind)),
        ("visibility", Some(&r.visibility)),
        ("notability", Some(&r.notability)),
        ("context", r.context.as_deref()),
        ("source", Some(&r.source)),
        ("source_session", r.source_session.as_deref()),
        ("source_markdown_slug", r.source_markdown_slug.as_deref()),
        ("claim_metric", r.claim_metric.as_deref()),
        ("claim_unit", r.claim_unit.as_deref()),
        ("claim_period", r.claim_period.as_deref()),
        ("event_type", r.event_type.as_deref()),
        ("dimension", r.dimension.as_deref()),
        ("value", r.value.as_deref()),
        ("value_hash", r.value_hash.as_deref()),
        ("attributed_to", r.attributed_to.as_deref()),
    ];
    for (column, text) in texts {
        if let Some(text) = text {
            no_nul(op, &[(column, text)])?;
        }
    }
    if !KINDS.contains(&r.kind.as_str()) {
        return Err(check_violation("facts_kind_check"));
    }
    if !VISIBILITIES.contains(&r.visibility.as_str()) {
        return Err(check_violation("facts_visibility_check"));
    }
    if !NOTABILITIES.contains(&r.notability.as_str()) {
        return Err(check_violation("facts_notability_check"));
    }
    if r.attributed_to
        .as_deref()
        .is_some_and(|a| !ATTRIBUTIONS.contains(&a))
    {
        return Err(check_violation("facts_attributed_to_check"));
    }
    let confidence = f64::from(r.confidence);
    if !(0.0..=1.0).contains(&confidence) {
        return Err(check_violation("facts_confidence_check"));
    }
    Ok(())
}

/// The row holding the ontology stint key `(source, entity, dimension, value_hash, page,
/// valid_from)` of `idx_facts_ontology_stint_dedup`, when one does.
pub(crate) fn stint_holder(
    read: &dyn KvRead,
    source_id: &str,
    entity: &str,
    dimension: &str,
    value_hash: &str,
    slug: &str,
    valid_from_us: i64,
) -> Result<Option<u64>> {
    let mut key = text_key(STINT, &[source_id, entity, dimension, value_hash, slug]);
    key.extend_from_slice(&time_bytes(valid_from_us));
    Ok(read.get(&key)?.as_deref().and_then(keys::be8))
}

/// Fact row `id`, when it exists.
pub(crate) fn read_fact(read: &dyn KvRead, id: u64) -> Result<Option<FactRecord>> {
    get_json(read, &fact_key(id))
}

/// The `facts` row trigger `gbrain_stamp_trust_tier` (`trust::stamp`): the row `new` with the tier
/// and write origin the trust context `trust` gives it, as an insert (`old` `None`) or an update
/// of `old`. A refused raise or an undeclared-above-floor writer is the trigger's error.
pub(crate) fn stamp_fact(
    trust: &WriteTrust,
    old: Option<&FactRecord>,
    new: &FactRecord,
) -> Result<FactRecord> {
    let row = match old {
        None => StampRow::Insert {
            supplied: new.tier(),
        },
        Some(old) => StampRow::Update {
            old: old.tier(),
            new: new.tier(),
            content_changed: old.trust_content_changed(new),
            origin_set: old.write_origin != new.write_origin,
        },
    };
    let stamped = stamp(trust, TrustTable::Facts, row)?;
    let mut out = new.clone();
    out.trust_tier = stamped.tier.as_str().to_string();
    if let OriginStamp::Set(origin) = stamped.origin {
        out.write_origin = origin;
    }
    Ok(out)
}

/// Writes `new` (replacing `old`, the same row as stored) and its index entries, stamped first
/// with the trust context `trust` ([`stamp_fact`], a `BEFORE` row trigger, so a refusal comes
/// before a unique-index refusal). A unique index another row holds refuses as Postgres does
/// (`23505`); the caller's write then rolls back.
pub(crate) fn write_fact(
    tx: &mut dyn KvWrite,
    trust: &WriteTrust,
    old: Option<&FactRecord>,
    new: &FactRecord,
) -> Result<()> {
    let mut stamped = stamp_fact(trust, old, new)?;
    preserve_withdrawal(tx, old, &mut stamped)?;
    let new = &stamped;
    if let Some(old) = old {
        for (key, _) in index_keys(old) {
            tx.delete(&key)?;
        }
    }
    let entries = index_keys(new);
    for (key, unique) in &entries {
        if let Some(name) = unique
            && let Some(holder) = tx.get(key)?
            && keys::be8(&holder) != Some(new.id)
        {
            return Err(duplicate(name));
        }
    }
    let id = new.id.to_be_bytes();
    for (key, unique) in &entries {
        tx.put(key, if unique.is_some() { &id } else { &[] })?;
    }
    put_json(tx, &fact_key(new.id), new)
}

/// `gbrain_preserve_fact_withdrawal`, the `BEFORE INSERT OR UPDATE OF fact, source_id, visibility,
/// entity_slug, expired_at` trigger: a row that is not expired and matches a withdrawal of its
/// claim is saved expired at the earliest such withdrawal, and its `valid_until` is no later than
/// it ([`purge::earliest_withdrawal`]). An update that changes none of those columns does not fire it.
fn preserve_withdrawal(
    read: &dyn KvRead,
    old: Option<&FactRecord>,
    new: &mut FactRecord,
) -> Result<()> {
    if new.expired_at_us.is_some() {
        return Ok(());
    }
    if old.is_some_and(|o| {
        o.fact == new.fact
            && o.source_id == new.source_id
            && o.visibility == new.visibility
            && o.entity_slug == new.entity_slug
            && o.expired_at_us == new.expired_at_us
    }) {
        return Ok(());
    }
    if let Some(withdrawn) = purge::earliest_withdrawal(read, new)? {
        new.expired_at_us = Some(withdrawn);
        new.valid_until_us = Some(new.valid_until_us.map_or(withdrawn, |v| v.min(withdrawn)));
    }
    Ok(())
}

/// Deletes a row and its index entries, then clears `superseded_by` on the rows that named it
/// (`facts_superseded_by_fkey ... ON DELETE SET NULL`), an update the trust stamp sees under
/// `trust`.
pub(crate) fn delete_fact(
    tx: &mut dyn KvWrite,
    trust: &WriteTrust,
    row: &FactRecord,
) -> Result<()> {
    for (key, _) in index_keys(row) {
        tx.delete(&key)?;
    }
    tx.delete(&fact_key(row.id))?;
    for referrer in ids_under(tx, &refs_prefix(row.id))? {
        if let Some(old) = read_fact(tx, referrer)? {
            let mut new = old.clone();
            new.superseded_by = None;
            write_fact(tx, trust, Some(&old), &new)?;
        }
    }
    Ok(())
}

/// The trailing 8-byte ids of the keys under `prefix`, in key order.
fn ids_under(read: &dyn KvRead, prefix: &[u8]) -> Result<Vec<u64>> {
    let mut ids = Vec::new();
    scan_prefix(read, prefix, false, &mut |k, _| {
        if let Some(id) = k.get(k.len().saturating_sub(8)..).and_then(keys::be8) {
            ids.push(id);
        }
        true
    })?;
    Ok(ids)
}

fn rows_under(read: &dyn KvRead, prefix: &[u8]) -> Result<Vec<FactRecord>> {
    let mut out = Vec::new();
    for id in ids_under(read, prefix)? {
        if let Some(row) = read_fact(read, id)? {
            out.push(row);
        }
    }
    Ok(out)
}

pub(crate) fn source_rows(read: &dyn KvRead, source_id: &str) -> Result<Vec<FactRecord>> {
    rows_under(read, &text_key(BY_SOURCE, &[source_id]))
}

pub(crate) fn entity_rows(
    read: &dyn KvRead,
    source_id: &str,
    entity: &str,
) -> Result<Vec<FactRecord>> {
    rows_under(read, &text_key(BY_ENTITY, &[source_id, entity]))
}

fn page_rows(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<Vec<FactRecord>> {
    rows_under(read, &text_key(BY_PAGE, &[source_id, slug]))
}

fn fence_row(
    read: &dyn KvRead,
    source_id: &str,
    slug: &str,
    row_num: i32,
) -> Result<Option<FactRecord>> {
    match read.get(&fence_key(source_id, slug, row_num))? {
        Some(id) => match keys::be8(&id) {
            Some(id) => read_fact(read, id),
            None => Err(StoreError::new(
                crate::error::STORE_CORRUPT,
                "bad facts fence entry",
            )),
        },
        None => Ok(None),
    }
}

/// Whether fact row `id` exists in one of `source_ids` (any source when `source_ids` is empty).
///
/// This is PGLite's rule for a `facts/<id>` slug on a captured eval candidate
/// (`insertEvalCandidate`, src/core/feedback/store.ts): the slug stays while the fact row does.
/// The row counts whatever its state: an expired, superseded or consolidated row, and a row
/// whose page was soft-deleted, still exist. Only a deleted row (a page re-extract, a source
/// delete) is gone. The caller matches the slug against `^facts/[0-9]{1,18}$` first.
// Called by eval_capture (lane 5) once it drops its `facts/<id>` refusal.
#[allow(dead_code)]
pub(crate) fn fact_exists(read: &dyn KvRead, id: u64, source_ids: &[String]) -> Result<bool> {
    Ok(read_fact(read, id)?
        .is_some_and(|row| source_ids.is_empty() || source_ids.contains(&row.source_id)))
}

/// Deletes this family's records keyed by a source that is deleted (`cascade::remove_source_rows`):
/// every fact row of the source, as `facts_source_id_fkey ... ON DELETE CASCADE` does. A row of
/// another source that named one of them as its successor keeps its row with `superseded_by`
/// cleared (`ON DELETE SET NULL`).
///
/// No store member deletes a source yet, so no trust context reaches here: the `SET NULL` update
/// is stamped as an undeclared writer's, which changes no content column and keeps each tier.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let trust = &WriteTrust::default();
    for row in source_rows(tx, source_id)? {
        delete_fact(tx, trust, &row)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Postgres text functions the members use.

/// Code points Postgres `lower()` leaves alone that Rust's `char::to_lowercase` maps (the two
/// Unicode tables differ). Probed on PGLite.
const LOWER_KEEP: [(u32, u32); 41] = [
    (0x1C89, 0x1C89),
    (0x24B6, 0x24CF),
    (0x2C2F, 0x2C2F),
    (0xA7C0, 0xA7C0),
    (0xA7C7, 0xA7C7),
    (0xA7C9, 0xA7C9),
    (0xA7CB, 0xA7CC),
    (0xA7CE, 0xA7CE),
    (0xA7D0, 0xA7D0),
    (0xA7D2, 0xA7D2),
    (0xA7D4, 0xA7D4),
    (0xA7D6, 0xA7D6),
    (0xA7D8, 0xA7D8),
    (0xA7DA, 0xA7DA),
    (0xA7DC, 0xA7DD),
    (0xA7E2, 0xA7E2),
    (0xA7F5, 0xA7F5),
    (0xAB6C, 0xAB6D),
    (0x10570, 0x1057A),
    (0x1057C, 0x1058A),
    (0x1058C, 0x10592),
    (0x10594, 0x10595),
    (0x10D50, 0x10D65),
    (0x16EA0, 0x16EB8),
    (0x1DF40, 0x1DF40),
    (0x1DF48, 0x1DF48),
    (0x1DF4A, 0x1DF4A),
    (0x1DF4D, 0x1DF4D),
    (0x1DF51, 0x1DF51),
    (0x1DF68, 0x1DF68),
    (0x1DF6A, 0x1DF6A),
    (0x1DF6C, 0x1DF6C),
    (0x1DF6E, 0x1DF6E),
    (0x1DF72, 0x1DF72),
    (0x1DF74, 0x1DF74),
    (0x1DF76, 0x1DF76),
    (0x1DF78, 0x1DF78),
    (0x1DF7A, 0x1DF7A),
    (0x1DF7C, 0x1DF7C),
    (0x1DF7E, 0x1DF7E),
    (0xFEFF, 0xFEFF),
];

/// Postgres `lower()` of one code point: one code point out, the first of the full mapping
/// ('İ' gives 'i').
pub(crate) fn pg_lower_char(c: char) -> char {
    let cp = c as u32;
    if LOWER_KEEP.iter().any(|&(lo, hi)| (lo..=hi).contains(&cp)) {
        return c;
    }
    c.to_lowercase().next().unwrap_or(c)
}

/// `[[:space:]]` in a Postgres regular expression.
fn pg_space(c: char) -> bool {
    matches!(c as u32, 9..=13 | 32 | 133 | 8192..=8198 | 8200..=8202 | 8232 | 8233 | 8287 | 12288)
}

/// `text LIKE pattern` (or `ILIKE` when `fold`) with `\` as the escape character. A pattern that
/// ends with the escape character refuses, as Postgres does.
pub(crate) fn like(text: &str, pattern: &str, fold: bool) -> Result<bool> {
    let map = |s: &str| -> Vec<char> {
        if fold {
            s.chars().map(pg_lower_char).collect()
        } else {
            s.chars().collect()
        }
    };
    #[derive(Clone, Copy, PartialEq)]
    enum Tok {
        Any,
        One,
        Lit(char),
    }
    let mut toks = Vec::new();
    let mut chars = map(pattern).into_iter();
    while let Some(c) = chars.next() {
        toks.push(match c {
            '%' => Tok::Any,
            '_' => Tok::One,
            '\\' => match chars.next() {
                Some(next) => Tok::Lit(next),
                None => {
                    return Err(invalid(
                        "LIKE pattern must not end with escape character".into(),
                    ));
                }
            },
            other => Tok::Lit(other),
        });
    }
    let text = map(text);
    // Greedy match with one backtrack point per `%`.
    let (mut t, mut p) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        match toks.get(p) {
            Some(Tok::Any) => {
                star = Some((p, t));
                p += 1;
            }
            Some(Tok::One) => {
                t += 1;
                p += 1;
            }
            Some(Tok::Lit(c)) if *c == text[t] => {
                t += 1;
                p += 1;
            }
            _ => match star {
                Some((sp, st)) => {
                    p = sp + 1;
                    t = st + 1;
                    star = Some((sp, st + 1));
                }
                None => return Ok(false),
            },
        }
    }
    Ok(toks[p..].iter().all(|tok| *tok == Tok::Any))
}

/// Characters `gbrain_fact_normalize` turns into a space (`FINGERPRINT_PUNCTUATION`).
const FINGERPRINT_PUNCTUATION: &str = "!\"$%&'()*,-/:;<=>?@[\\]^_`{|}~\u{2018}\u{2019}\u{201a}\u{201c}\u{201d}\u{201e}\u{00ab}\u{00bb}\u{2039}\u{203a}\u{2013}\u{2014}\u{2015}\u{2026}\u{00b7}\u{2022}\u{00a1}\u{00bf}";

/// `gbrain_fact_normalize(text)`: lower-case, punctuation and whitespace runs to one space, a
/// sentence-ending dot dropped, trimmed.
pub(crate) fn fact_normalize(text: &str) -> String {
    let mut spaced = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars().map(pg_lower_char) {
        let c = if FINGERPRINT_PUNCTUATION.contains(c) {
            ' '
        } else {
            c
        };
        if pg_space(c) {
            if !in_space {
                spaced.push(' ');
            }
            in_space = true;
        } else {
            spaced.push(c);
            in_space = false;
        }
    }
    // `\.(?=[. ]|$)` to a space, then `' +'` to one space, then btrim.
    let chars: Vec<char> = spaced.chars().collect();
    let mut out = String::with_capacity(spaced.len());
    let mut last_space = false;
    for (i, &c) in chars.iter().enumerate() {
        let c = if c == '.' && chars.get(i + 1).is_none_or(|n| *n == '.' || *n == ' ') {
            ' '
        } else {
            c
        };
        if c == ' ' {
            if !last_space {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out.trim_matches(' ').to_string()
}

/// `gbrain_fact_fingerprint(text)`: the sha256 hex of `gbrain_fact_normalize(text)`.
pub(crate) fn fact_fingerprint(text: &str) -> String {
    Sha256::digest(fact_normalize(text).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A `REAL` read back: the shortest decimal that names the stored `f32`, as an `f64`.
pub(crate) fn real(value: f32) -> f64 {
    format!("{value}").parse().unwrap_or(f64::from(value))
}

/// A JavaScript number as `String(n)` prints it, for the warning texts.
fn js_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{}", n as i128)
    } else {
        format!("{n}")
    }
}

// ---------------------------------------------------------------------------------------------
// Arguments.

/// One `NewFact` (plus the fence columns `insertFacts` reads). Times are ISO text; the
/// TypeScript member fills `valid_from` and computes `value_hash`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NewFactInput {
    pub fact: Option<String>,
    pub kind: Option<String>,
    pub entity_slug: Option<String>,
    pub visibility: Option<String>,
    pub context: Option<String>,
    pub valid_from: Option<String>,
    pub valid_until: Option<String>,
    pub expired_at: Option<String>,
    pub source: Option<String>,
    pub source_session: Option<String>,
    pub confidence: Option<f64>,
    pub notability: Option<String>,
    pub claim_metric: Option<String>,
    pub claim_value: Option<f64>,
    pub claim_unit: Option<String>,
    pub claim_period: Option<String>,
    pub event_type: Option<String>,
    pub attributed_to: Option<String>,
    pub dimension: Option<String>,
    pub value: Option<String>,
    pub value_hash: Option<String>,
    pub row_num: Option<f64>,
    pub source_markdown_slug: Option<String>,
    pub superseded_by_row: Option<f64>,
    /// The vector as the literal PGLite casts (`'[a,b,...]'`); absent when the fact has none.
    pub embedding: Option<String>,
    /// The model the vector came from; read only with `embedding`.
    pub embedding_model: Option<String>,
    /// `insertFacts` only: the confidence was not a finite number, which `JSON.stringify` sends
    /// as `null` into the NOT NULL column.
    pub confidence_null: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct InsertFactArgs {
    pub input: NewFactInput,
    pub source_id: String,
    pub supersede_id: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpireFactArgs {
    pub id: f64,
    pub superseded_by: Option<f64>,
    pub at: Option<String>,
    pub successor_from: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PageDeleteArgs {
    pub slug: String,
    pub source_id: String,
    pub exclude_source_prefixes: Vec<String>,
    pub preserve_expired_legacy: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct InsertFactsArgs {
    pub rows: Vec<NewFactInput>,
    pub source_id: String,
    pub delete_for_page_first: Option<PageDeleteArgs>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeysetAfter {
    pub created_at: String,
    pub id: Option<f64>,
}

/// The filters of the four list reads. The TypeScript member clamps `limit`, builds the `grep`
/// pattern, and passes `visibility` as the plain list (`Some(empty)` matches nothing).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct FactQuery {
    pub source_id: String,
    pub entity_slug: Option<String>,
    pub source_markdown_slug: Option<String>,
    pub session_id: Option<String>,
    pub active_only: bool,
    pub unconsolidated_only: bool,
    pub kinds: Option<Vec<String>>,
    pub visibility: Option<Vec<String>>,
    pub exclude_audit_rows: bool,
    pub grep: Option<String>,
    pub fingerprint: bool,
    pub limit: f64,
    pub offset: f64,
    pub since: Option<String>,
    pub event_time: bool,
    pub after: Option<KeysetAfter>,
    /// `excludePrivate`: the private-provenance policy (`facts/privacy.rs`).
    pub exclude_private: Option<PrivacyPolicy>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SupersessionQuery {
    pub source_id: String,
    pub since: Option<String>,
    pub limit: f64,
    pub visibility: Option<Vec<String>>,
    /// `excludePrivate`: the private-provenance policy (`facts/privacy.rs`).
    pub exclude_private: Option<PrivacyPolicy>,
    /// The caller passed a read eligibility: `projectionEligibleSql('facts')` replaces the
    /// deleted-page clause, so a row whose live provenance page is quarantined is hidden too.
    pub eligible: bool,
    /// `eligibility.floor`: `trustFloorSql` over the fact's stored tier; null sets none.
    pub min_trust: Option<String>,
    /// `eligibility.suppressFlagged`: drop a fact `activationSuppressedSql('facts')` flags.
    pub suppress_flagged: bool,
}

/// The `listUnattributedFacts` read of src/core/review-lists.ts. The caller passes the page size
/// it asks the database for (the review list asks for one row more than it shows), decides the
/// world-only rule, and passes the private-provenance policy when
/// `resolveExcludePrivatePages(engine, ctx.remote)` asks for it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct UnattributedQuery {
    pub source_ids: Vec<String>,
    /// `worldOnlyFacts(ctx.remote)`: keep only `visibility = 'world'` rows.
    pub world_only: bool,
    pub limit: f64,
    pub offset: f64,
    /// `privateProvenanceFilterUnderPolicy('facts')` (`facts/privacy.rs`).
    pub exclude_private: Option<PrivacyPolicy>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DuplicateQuery {
    pub source_id: String,
    pub entity_slug: String,
    pub k: f64,
    pub attributed_to: Option<String>,
    pub only_page: Option<String>,
    pub exclude_member_pages: bool,
    /// `arm: 'keyword'`: rank by `ts_rank_cd` against `fact_text` instead of recency.
    pub keyword: bool,
    /// The new claim's text, read by the keyword arm.
    pub fact_text: String,
    /// The new claim's vector, as a vector literal: the cosine arm ranks by it; the keyword arm
    /// reads only its length.
    pub embedding: Option<String>,
    /// The model of `embedding`: only rows stamped with it compare.
    pub embedding_model: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct TrajectoryQuery {
    pub source_ids: Vec<String>,
    pub entity_slug: String,
    pub world_only: bool,
    pub metric: Option<String>,
    pub kind: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
    pub limit: f64,
    /// `excludePrivate`: the private-provenance policy (`facts/privacy.rs`).
    pub exclude_private: Option<PrivacyPolicy>,
}

fn time_arg(op: &str, what: &str, text: &str) -> Result<i64> {
    parse_iso(text).ok_or_else(|| invalid(format!("{op}: {what} is not an ISO time: \"{text}\"")))
}

fn opt_time(op: &str, what: &str, text: &Option<String>) -> Result<Option<i64>> {
    text.as_deref().map(|t| time_arg(op, what, t)).transpose()
}

/// A JavaScript number bound to a `bigint` parameter.
fn bigint(op: &str, what: &str, value: f64) -> Result<i64> {
    if !value.is_finite() || value.fract() != 0.0 || value.abs() > 9.223_372_036_854_775e18 {
        return Err(invalid(format!(
            "{op}: invalid input syntax for type bigint: \"{value}\" ({what})"
        )));
    }
    Ok(value as i64)
}

/// A non-negative row count (`LIMIT` / `OFFSET`).
fn count_arg(op: &str, what: &str, value: f64) -> Result<usize> {
    let n = bigint(op, what, value)?;
    if n < 0 {
        return Err(invalid(format!("{op}: {what} must not be negative")));
    }
    Ok(usize::try_from(n).unwrap_or(usize::MAX))
}

/// A fact id named by a caller: the stored row, or `None` for an id no row can have.
fn fact_by_number(read: &dyn KvRead, op: &str, what: &str, id: f64) -> Result<Option<FactRecord>> {
    let id = bigint(op, what, id)?;
    if id < 1 {
        return Ok(None);
    }
    read_fact(read, id as u64)
}

/// `valid_until` of a row a successor starting at `successor` closes: the successor's start when
/// it falls inside the row's window, else the window's end clipped to now
/// (src/core/facts/supersede-interval.ts).
fn closed_until(row: &FactRecord, successor: i64, now: i64) -> i64 {
    let end = row.valid_until_us.unwrap_or(now);
    if row.valid_from_us < successor && successor < end {
        successor
    } else {
        row.valid_from_us.max(end.min(now))
    }
}

/// The row `input` describes, before its id is taken. `fence` reads the columns only
/// `insertFacts` writes (`expired_at`, `row_num`, `source_markdown_slug`, `event_type`, the
/// ontology columns).
fn new_record(
    op: &str,
    input: &NewFactInput,
    source_id: &str,
    now: i64,
    fence: bool,
    dims: usize,
) -> Result<FactRecord> {
    let confidence = input.confidence.unwrap_or(1.0);
    let confidence32 = confidence as f32;
    if !input.confidence_null && confidence.is_finite() && confidence32.is_infinite() {
        return Err(invalid(format!(
            "{op}: value out of range: overflow (confidence)"
        )));
    }
    // The vector cast runs before the row's NOT NULL checks, as it does in the INSERT.
    let vector = match &input.embedding {
        Some(literal) => Some(embedding::to_halfvec(
            &embedding::parse_vector(literal)?,
            Some(dims),
        )?),
        None => None,
    };
    let fact = input.fact.clone().ok_or_else(|| not_null("fact"))?;
    let source = input.source.clone().ok_or_else(|| not_null("source"))?;
    if input.confidence_null {
        return Err(not_null("confidence"));
    }
    let mut row = FactRecord {
        source_id: source_id.to_string(),
        entity_slug: input.entity_slug.clone(),
        fact,
        kind: input.kind.clone().unwrap_or_else(|| "fact".into()),
        visibility: input.visibility.clone().unwrap_or_else(|| "private".into()),
        notability: input.notability.clone().unwrap_or_else(|| "medium".into()),
        context: input.context.clone(),
        valid_from_us: opt_time(op, "valid_from", &input.valid_from)?.unwrap_or(now),
        valid_until_us: opt_time(op, "valid_until", &input.valid_until)?,
        source,
        source_session: input.source_session.clone(),
        confidence: confidence32,
        created_at_us: now,
        claim_metric: input.claim_metric.clone(),
        claim_value: input.claim_value,
        claim_unit: input.claim_unit.clone(),
        claim_period: input.claim_period.clone(),
        attributed_to: input.attributed_to.clone(),
        ..FactRecord::default()
    };
    if let Some(vector) = vector {
        // `embedded_text_hash = md5(fact)` only when the model is a non-empty text.
        row.embedded_text_hash = input
            .embedding_model
            .as_deref()
            .filter(|m| !m.is_empty())
            .map(|_| embedding::md5_hex(&row.fact));
        row.embedding_model = input.embedding_model.clone();
        row.embedded_at_us = Some(now);
        row.embedding = Some(vector);
    }
    if fence {
        row.expired_at_us = opt_time(op, "expired_at", &input.expired_at)?;
        row.row_num = input.row_num.map(|n| int4(op, "row_num", n)).transpose()?;
        row.source_markdown_slug = input.source_markdown_slug.clone();
        row.event_type = input.event_type.clone();
        if let (Some(dim), Some(value)) = (
            input.dimension.as_ref().filter(|d| !d.is_empty()),
            &input.value,
        ) {
            row.dimension = Some(dim.clone());
            row.value = Some(value.clone());
            row.value_hash = input.value_hash.clone();
            row.dim_status = Some("active".into());
        }
    }
    Ok(row)
}

pub(crate) fn require_fact_source(read: &dyn KvRead, source_id: &str) -> Result<()> {
    match read_source(read, source_id)? {
        Some(_) => Ok(()),
        None => Err(foreign_key("facts_source_id_fkey")),
    }
}

/// `deleteFactsForPage`'s filter, inside the caller's write. Returns the rows deleted.
fn delete_for_page(
    tx: &mut dyn KvWrite,
    trust: &WriteTrust,
    op: &str,
    args: &PageDeleteArgs,
) -> Result<u64> {
    no_nul(op, &[("slug", &args.slug), ("source_id", &args.source_id)])?;
    let patterns: Vec<String> = args
        .exclude_source_prefixes
        .iter()
        .map(|p| format!("{p}%"))
        .collect();
    for pattern in &patterns {
        no_nul(op, &[("excludeSourcePrefixes", pattern)])?;
    }
    let mut deleted = 0;
    for row in page_rows(tx, &args.source_id, &args.slug)? {
        let mut kept = false;
        for pattern in &patterns {
            if like(&row.source, pattern, false)? {
                kept = true;
                break;
            }
        }
        if kept
            || (args.preserve_expired_legacy
                && row.row_num.is_none()
                && row.expired_at_us.is_some())
        {
            continue;
        }
        delete_fact(tx, trust, &row)?;
        deleted += 1;
    }
    Ok(deleted)
}

// ---------------------------------------------------------------------------------------------
// Read helpers.

/// `deletedPageProjectionHiddenSql('facts')`: a soft-deleted page in the row's source whose slug
/// is the row's page or its entity hides the row.
/// `facts.source` values written by page-extraction paths, whose context head is the source page
/// slug (`PAGE_EXTRACTION_SOURCE_LIST`, `src/core/facts/gone-page-facts.ts`).
const PAGE_EXTRACTION_SOURCES: [&str; 4] =
    ["mcp:put_page", "sync:import", "file_upload", "code_import"];

/// `split_part(context, ' — ', 1)`: the text before the first context-note separator.
fn context_head(context: &str) -> &str {
    context.split(" \u{2014} ").next().unwrap_or(context)
}

/// `expireGonePageFacts` (`src/core/facts/gone-page-facts.ts`): the facts the purged pages of
/// `source_id` take with them. Run it in the purge transaction, after the page rows are removed.
/// Rows are expired (kept, never deleted), in the four cases of the SQL updates, in their order:
/// filed on the page (not an ontology observation); a conversation slot filed on the page (it
/// also gives up its slot); extracted from the page and filed on none; about the page and held by
/// no page row that remains (a live or soft-deleted holder keeps it).
pub(crate) fn expire_gone_page_facts(
    tx: &mut dyn KvWrite,
    trust: &WriteTrust,
    source_id: &str,
    slugs: &[String],
    now: i64,
) -> Result<()> {
    if slugs.is_empty() {
        return Ok(());
    }
    let gone: HashSet<&str> = slugs.iter().map(String::as_str).collect();
    for old in source_rows(&*tx, source_id)? {
        if old.expired_at_us.is_some() {
            continue;
        }
        let filed = old
            .source_markdown_slug
            .as_deref()
            .is_some_and(|s| gone.contains(s));
        let mut new = old.clone();
        if filed && old.dimension.is_none() {
            // EXPIRE_FILED_SQL
        } else if filed && old.row_num.is_some() && old.conversation_slot() {
            // EXPIRE_FILED_SLOT_SQL
            new.dimension = None;
            new.value = None;
            new.value_hash = None;
            new.dim_status = None;
        } else if old.source_markdown_slug.is_none()
            && PAGE_EXTRACTION_SOURCES.contains(&old.source.as_str())
            && old
                .context
                .as_deref()
                .is_some_and(|c| gone.contains(context_head(c)))
        {
            // EXPIRE_EXTRACTED_SQL
        } else if old.entity_slug.as_deref().is_some_and(|e| gone.contains(e))
            && match old.source_markdown_slug.as_deref() {
                None => true,
                Some(holder) => read_page(&*tx, source_id, holder)?.is_none(),
            }
        {
            // EXPIRE_ABOUT_SQL: the purged pages are already removed, so a holder that remains is
            // another page.
        } else {
            continue;
        }
        new.expired_at_us = Some(now);
        new.row_num = None;
        write_fact(tx, trust, Some(&old), &new)?;
    }
    Ok(())
}

pub(crate) fn hidden_by_deleted_page(read: &dyn KvRead, row: &FactRecord) -> Result<bool> {
    for slug in [&row.source_markdown_slug, &row.entity_slug]
        .into_iter()
        .flatten()
    {
        if read_page(read, &row.source_id, slug)?.is_some_and(|p| p.deleted_at_us.is_some()) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `privateProvenanceFilterUnderPolicy('facts')`, when the read passes `excludePrivate`. The owner-only sources are
/// read from the same snapshot for each row (a short scan of the source records).
pub(crate) fn hidden_by_policy(
    read: &dyn KvRead,
    row: &FactRecord,
    policy: &Option<PrivacyPolicy>,
) -> Result<bool> {
    match policy {
        Some(policy) => hidden_by_private_provenance(read, row, policy),
        None => Ok(false),
    }
}

/// `quarantinedProjectionHiddenSql('facts')`: the row's live page carries a `quarantine` key.
pub(crate) fn hidden_by_quarantine(read: &dyn KvRead, row: &FactRecord) -> Result<bool> {
    let Some(slug) = &row.source_markdown_slug else {
        return Ok(false);
    };
    Ok(read_page(read, &row.source_id, slug)?
        .is_some_and(|p| p.deleted_at_us.is_none() && p.frontmatter.contains_key(QUARANTINE_KEY)))
}

fn listed(list: &Option<Vec<String>>, value: &str) -> bool {
    list.as_ref().is_none_or(|l| l.iter().any(|v| v == value))
}

impl FactQuery {
    /// The rows the narrowest index holds.
    fn candidates(&self, read: &dyn KvRead) -> Result<Vec<FactRecord>> {
        if let Some(entity) = &self.entity_slug {
            entity_rows(read, &self.source_id, entity)
        } else if let Some(slug) = &self.source_markdown_slug {
            page_rows(read, &self.source_id, slug)
        } else {
            source_rows(read, &self.source_id)
        }
    }

    fn admits(&self, read: &dyn KvRead, row: &FactRecord, now: i64) -> Result<bool> {
        let eq = |want: &Option<String>, have: &Option<String>| want.is_none() || want == have;
        if !(eq(&self.entity_slug, &row.entity_slug)
            && eq(&self.source_markdown_slug, &row.source_markdown_slug)
            && eq(&self.session_id, &row.source_session))
        {
            return Ok(false);
        }
        if (self.active_only && !row.active(now))
            || (self.unconsolidated_only && row.consolidated_at_us.is_some())
            || !listed(&self.kinds, &row.kind)
            || !listed(&self.visibility, &row.visibility)
            || (self.exclude_audit_rows && row.audit_row())
        {
            return Ok(false);
        }
        if let Some(pattern) = &self.grep
            && !like(&row.fact, pattern, true)?
        {
            return Ok(false);
        }
        Ok(!hidden_by_deleted_page(read, row)?
            && !hidden_by_policy(read, row, &self.exclude_private)?)
    }

    fn check(&self, op: &str) -> Result<()> {
        let mut texts = vec![("sourceId", self.source_id.as_str())];
        for (name, text) in [
            ("entitySlug", &self.entity_slug),
            ("sourceMarkdownSlug", &self.source_markdown_slug),
            ("sessionId", &self.session_id),
            ("grep", &self.grep),
        ] {
            if let Some(text) = text {
                texts.push((name, text));
            }
        }
        no_nul(op, &texts)
    }
}

/// Rows sorted by `key` then `id`, both descending (or both ascending), paged.
fn page_of(
    mut rows: Vec<FactRecord>,
    key: impl Fn(&FactRecord) -> i64,
    descending: bool,
    offset: usize,
    limit: usize,
) -> Vec<FactRecord> {
    rows.sort_by(|a, b| {
        let order = key(a).cmp(&key(b)).then(a.id.cmp(&b.id));
        if descending { order.reverse() } else { order }
    });
    rows.into_iter().skip(offset).take(limit).collect()
}

impl Store {
    #[allow(clippy::too_many_arguments)]
    fn list_facts(
        &self,
        op: &str,
        q: &FactQuery,
        key: impl Fn(&FactRecord) -> i64,
        descending: bool,
        offset: usize,
        extra: impl Fn(&FactRecord) -> bool,
        iso_created: bool,
    ) -> Result<Vec<Value>> {
        q.check(op)?;
        let limit = count_arg(op, "limit", q.limit)?;
        let read = self.read()?;
        let now = self.env.now_micros();
        let mut rows = Vec::new();
        for row in q.candidates(&*read)? {
            if q.source_id == row.source_id && extra(&row) && q.admits(&*read, &row, now)? {
                rows.push(row);
            }
        }
        Ok(page_of(rows, key, descending, offset, limit)
            .iter()
            .map(|r| r.to_json(q.fingerprint, iso_created))
            .collect())
    }

    /// `insertFact(input, { source_id, supersedeId })`: `{ id, status }`. With `supersedeId` the
    /// named row (in any source, when it is still unexpired) is expired now and closed at the new
    /// row's `valid_from`; the status is `superseded` whether or not a row was there.
    pub fn insert_fact(&self, args: &InsertFactArgs) -> Result<Value> {
        const OP: &str = "insertFact";
        let now = self.env.now_micros();
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let dims = match args.input.embedding {
                Some(_) => embedding_dimensions(tx)?,
                None => 0,
            };
            let mut row = new_record(OP, &args.input, &args.source_id, now, false, dims)?;
            check_row(OP, &row)?;
            require_fact_source(tx, &args.source_id)?;
            row.id = next_id(tx, COUNTER)?;
            write_fact(tx, trust, None, &row)?;
            let Some(supersede) = args.supersede_id else {
                return Ok(json!({ "id": row.id, "status": "inserted" }));
            };
            if let Some(old) = fact_by_number(tx, OP, "supersedeId", supersede)?
                && old.expired_at_us.is_none()
            {
                let mut new = old.clone();
                new.expired_at_us = Some(now);
                new.superseded_by = Some(row.id);
                new.valid_until_us = Some(closed_until(&old, row.valid_from_us, now));
                write_fact(tx, trust, Some(&old), &new)?;
            }
            Ok(json!({ "id": row.id, "status": "superseded" }))
        })
    }

    /// `expireFact(id, { supersededBy, at, successorFrom })`: true when an unexpired row changed.
    pub fn expire_fact(&self, args: &ExpireFactArgs) -> Result<bool> {
        const OP: &str = "expireFact";
        let now = self.env.now_micros();
        let at = opt_time(OP, "at", &args.at)?.unwrap_or(now);
        let successor = opt_time(OP, "successorFrom", &args.successor_from)?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let Some(old) = fact_by_number(tx, OP, "id", args.id)? else {
                return Ok(false);
            };
            if old.expired_at_us.is_some() {
                return Ok(false);
            }
            let mut new = old.clone();
            new.expired_at_us = Some(at);
            if let Some(by) = args.superseded_by {
                let by = bigint(OP, "supersededBy", by)?;
                let exists = by >= 1 && read_fact(tx, by as u64)?.is_some();
                if !exists {
                    return Err(foreign_key("facts_superseded_by_fkey"));
                }
                new.superseded_by = Some(by as u64);
            }
            if let Some(successor) = successor {
                new.valid_until_us = Some(closed_until(&old, successor, now));
            }
            write_fact(tx, trust, Some(&old), &new)?;
            Ok(true)
        })
    }

    /// `insertFacts(rows, { source_id }, { deleteForPageFirst })`: one write that runs the page
    /// delete, inserts the rows in order (a row whose fence key is taken, by an older row or an
    /// earlier one of the batch, is skipped), then links each `superseded by #N` reference.
    pub fn insert_facts(&self, args: &InsertFactsArgs) -> Result<Value> {
        const OP: &str = "insertFacts";
        if args.rows.is_empty() {
            return Ok(json!({ "inserted": 0, "ids": [], "warnings": [], "deleted": 0 }));
        }
        let now = self.env.now_micros();
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let deleted = match &args.delete_for_page_first {
                Some(del) => {
                    let del = PageDeleteArgs { source_id: args.source_id.clone(), ..del.clone() };
                    delete_for_page(tx, trust, OP, &del)?
                }
                None => 0,
            };
            let dims = if args.rows.iter().any(|r| r.embedding.is_some()) {
                embedding_dimensions(tx)?
            } else {
                0
            };
            let mut records = Vec::with_capacity(args.rows.len());
            for input in &args.rows {
                let row = new_record(OP, input, &args.source_id, now, true, dims)?;
                check_row(OP, &row)?;
                records.push(row);
            }
            let mut row_ids: Vec<Option<u64>> = Vec::with_capacity(records.len());
            for mut row in records {
                row.id = next_id(tx, COUNTER)?;
                let taken = match (&row.source_markdown_slug, row.row_num) {
                    (Some(slug), Some(n)) => tx.get(&fence_key(&row.source_id, slug, n))?.is_some(),
                    _ => false,
                };
                if taken {
                    // The BEFORE INSERT trust trigger runs before ON CONFLICT skips the row, so a
                    // writer the stamp refuses is refused here too.
                    stamp_fact(trust, None, &row)?;
                    row_ids.push(None);
                    continue;
                }
                require_fact_source(tx, &args.source_id)?;
                write_fact(tx, trust, None, &row)?;
                row_ids.push(Some(row.id));
            }
            let warnings = link_supersessions(tx, trust, &args.source_id, &args.rows, &row_ids)?;
            let ids: Vec<u64> = row_ids.iter().flatten().copied().collect();
            Ok(json!({ "inserted": ids.len(), "ids": ids, "warnings": warnings, "deleted": deleted }))
        })
    }

    /// `deleteFactsForPage(slug, source_id, { excludeSourcePrefixes, preserveExpiredLegacy })`.
    pub fn delete_facts_for_page(&self, args: &PageDeleteArgs) -> Result<u64> {
        let trust = &self.write_trust()?;
        self.write(|tx| delete_for_page(tx, trust, "deleteFactsForPage", args))
    }

    /// `listFactsByEntity`: `valid_from DESC, id DESC`.
    pub fn list_facts_by_entity(&self, q: &FactQuery) -> Result<Vec<Value>> {
        const OP: &str = "listFactsByEntity";
        let offset = count_arg(OP, "offset", q.offset)?;
        self.list_facts(OP, q, |r| r.valid_from_us, true, offset, |_| true, false)
    }

    /// `listFactsSince`: rows at or after `since` on `created_at` (or `valid_from` with
    /// `eventTime`), newest first.
    pub fn list_facts_since(&self, q: &FactQuery) -> Result<Vec<Value>> {
        const OP: &str = "listFactsSince";
        let offset = count_arg(OP, "offset", q.offset)?;
        let since = time_arg(OP, "since", q.since.as_deref().unwrap_or(""))?;
        let event_time = q.event_time;
        let time = move |r: &FactRecord| {
            if event_time {
                r.valid_from_us
            } else {
                r.created_at_us
            }
        };
        self.list_facts(OP, q, time, true, offset, move |r| time(r) >= since, false)
    }

    /// `listFactsKeyset`: rows after the `(created_at, id)` keyset, oldest first, each with
    /// `created_at_iso`.
    pub fn list_facts_keyset(&self, q: &FactQuery) -> Result<Vec<Value>> {
        const OP: &str = "listFactsKeyset";
        let after = match &q.after {
            Some(a) => Some((time_arg(OP, "after.createdAt", &a.created_at)?, a.id)),
            None => None,
        };
        let past = move |r: &FactRecord| match after {
            None => true,
            Some((t, None)) => r.created_at_us > t,
            Some((t, Some(id))) => {
                r.created_at_us > t || (r.created_at_us == t && (r.id as f64) > id)
            }
        };
        self.list_facts(OP, q, |r| r.created_at_us, false, 0, past, true)
    }

    /// `listFactsBySession`: `created_at DESC, id DESC`.
    pub fn list_facts_by_session(&self, q: &FactQuery) -> Result<Vec<Value>> {
        const OP: &str = "listFactsBySession";
        let offset = count_arg(OP, "offset", q.offset)?;
        self.list_facts(OP, q, |r| r.created_at_us, true, offset, |_| true, false)
    }

    /// `listSupersessions`: rows with a successor, by `COALESCE(expired_at, valid_until)` (NULL
    /// first) then id, both descending. With a read eligibility it also hides a row whose live
    /// provenance page is quarantined and applies the trust floor and flag suppression; the store
    /// keeps no `needs_rederive` queue, so that clause hides nothing.
    pub fn list_supersessions(&self, q: &SupersessionQuery) -> Result<Vec<Value>> {
        const OP: &str = "listSupersessions";
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        let limit = count_arg(OP, "limit", q.limit)?;
        let since = opt_time(OP, "since", &q.since)?;
        let trust = TrustPolicy::parse(q.min_trust.as_deref(), q.suppress_flagged)?;
        let read = self.read()?;
        let mut rows = Vec::new();
        for row in source_rows(&*read, &q.source_id)? {
            let ended = row.expired_at_us.or(row.valid_until_us);
            if row.superseded_by.is_none()
                || since.is_some_and(|s| ended.is_none_or(|e| e < s))
                || !listed(&q.visibility, &row.visibility)
                || hidden_by_policy(&*read, &row, &q.exclude_private)?
                || hidden_by_deleted_page(&*read, &row)?
                || (q.eligible && hidden_by_quarantine(&*read, &row)?)
                || !trust.admits(&*read, "facts", row.id, row.tier())?
            {
                continue;
            }
            rows.push(row);
        }
        // DESC puts NULL first: NULL sorts as the largest key.
        let key = |r: &FactRecord| r.expired_at_us.or(r.valid_until_us).unwrap_or(i64::MAX);
        Ok(page_of(rows, key, true, 0, limit)
            .iter()
            .map(|r| r.to_json(false, false))
            .collect())
    }

    /// `countUnconsolidatedFacts(source_id)`: active rows with an entity, not consolidated, not
    /// audit checkpoints.
    pub fn count_unconsolidated_facts(&self, source_id: &str) -> Result<u64> {
        no_nul("countUnconsolidatedFacts", &[("source_id", source_id)])?;
        let read = self.read()?;
        let now = self.env.now_micros();
        Ok(source_rows(&*read, source_id)?
            .iter()
            .filter(|r| {
                r.entity_slug.is_some()
                    && r.consolidated_at_us.is_none()
                    && r.active(now)
                    && !r.audit_row()
            })
            .count() as u64)
    }

    /// `findCandidateDuplicates`: the entity's active rows, in one of three arms.
    /// - Recency (no `keyword`, no `embedding`): the newest `k`.
    /// - Cosine (`embedding`, no `keyword`): drops audit checkpoint rows and keeps the comparable
    ///   rows (a vector from `embedding_model`, `embedded_text_hash = md5(fact)`, the query's
    ///   length), ordered by `halfvec` cosine distance to the query (NaN last).
    /// - Keyword (`keyword`): drops audit checkpoint rows (and, with an `embedding`, the rows that
    ///   are not comparable), keeps the rows whose `to_tsvector('english', fact)` matches the OR of
    ///   the lexemes of `plainto_tsquery('english', fact_text)`, and orders them by `ts_rank_cd`
    ///   descending, then `created_at` and `id` descending. A claim with no lexemes matches nothing.
    ///
    /// An `embedding` with no (or an empty) `embedding_model` finds nothing.
    pub fn find_candidate_duplicates(&self, q: &DuplicateQuery) -> Result<Vec<Value>> {
        const OP: &str = "findCandidateDuplicates";
        let mut texts = vec![
            ("sourceId", q.source_id.as_str()),
            ("entitySlug", q.entity_slug.as_str()),
        ];
        if q.keyword {
            texts.push(("factText", &q.fact_text));
        }
        if q.embedding.is_some()
            && let Some(model) = &q.embedding_model
        {
            texts.push(("embeddingModel", model));
        }
        no_nul(OP, &texts)?;
        let k = count_arg(OP, "k", q.k)?;
        let model = q.embedding_model.as_deref().filter(|m| !m.is_empty());
        if q.embedding.is_some() && model.is_none() {
            return Ok(Vec::new());
        }
        // The comparable rows' model and length, when the caller sent a vector.
        let comparable = match (&q.embedding, model) {
            (Some(literal), Some(model)) => Some((model, embedding::literal_len(literal))),
            _ => None,
        };
        let cosine_query = match (&q.embedding, q.keyword) {
            (Some(literal), false) => Some(embedding::to_halfvec(
                &embedding::parse_vector(literal)?,
                None,
            )?),
            _ => None,
        };
        let query = if q.keyword {
            match or_of_lexemes(&plainto_tsquery(&q.fact_text)?) {
                Some(query) => Some(query),
                None => return Ok(Vec::new()),
            }
        } else {
            None
        };
        let read = self.read()?;
        let now = self.env.now_micros();
        let filtered = q.keyword || cosine_query.is_some();
        let rows: Vec<FactRecord> = entity_rows(&*read, &q.source_id, &q.entity_slug)?
            .into_iter()
            .filter(|r| {
                r.active(now)
                    && !(filtered && r.audit_row())
                    && comparable.is_none_or(|(model, len)| r.comparable(model, len))
                    && q.attributed_to
                        .as_ref()
                        .is_none_or(|who| r.attributed_to.as_ref().is_none_or(|a| a == who))
                    && match &q.only_page {
                        Some(page) => r.source_markdown_slug.as_ref() == Some(page),
                        None => !(q.exclude_member_pages && r.on_owned_memory_page()),
                    }
            })
            .collect();
        if let Some(target) = cosine_query {
            let mut ranked: Vec<(f64, FactRecord)> = rows
                .into_iter()
                .map(|r| {
                    let d =
                        embedding::cosine_distance(r.embedding.as_deref().unwrap_or(&[]), &target);
                    (d, r)
                })
                .collect();
            // Ascending, NaN after every number; equal distances keep insertion order.
            ranked.sort_by(|(da, a), (db, b)| {
                da.is_nan()
                    .cmp(&db.is_nan())
                    .then(da.total_cmp(db))
                    .then(a.id.cmp(&b.id))
            });
            return Ok(ranked
                .iter()
                .take(k)
                .map(|(_, r)| r.to_json(false, false))
                .collect());
        }
        let Some(query) = query else {
            return Ok(page_of(rows, |r| r.created_at_us, true, 0, k)
                .iter()
                .map(|r| r.to_json(false, false))
                .collect());
        };
        // One deep-stack thread for the whole walk when the query is deep, not one per fact.
        let mut ranked = with_query_stack(query.items.len(), || -> Result<Vec<_>> {
            let mut ranked = Vec::new();
            for row in rows {
                let vector = to_tsvector(&row.fact)?;
                if ts_matches(&vector, &query) {
                    ranked.push((ts_rank_cd(&vector, &query), row));
                }
            }
            Ok(ranked)
        })?;
        // Postgres sorts `real` with NaN above every number, as `total_cmp` does for a positive NaN.
        ranked.sort_by(|(sa, a), (sb, b)| {
            sb.total_cmp(sa)
                .then(b.created_at_us.cmp(&a.created_at_us))
                .then(b.id.cmp(&a.id))
        });
        Ok(ranked
            .iter()
            .take(k)
            .map(|(_, r)| r.to_json(false, false))
            .collect())
    }

    /// `consolidateFact(id, takeId)`: stamps the row consolidated now into take `takeId`.
    pub fn consolidate_fact(&self, id: f64, take_id: f64) -> Result<()> {
        const OP: &str = "consolidateFact";
        let take = bigint(OP, "takeId", take_id)?;
        let now = self.env.now_micros();
        let trust = &self.write_trust()?;
        self.write(|tx| {
            if let Some(old) = fact_by_number(tx, OP, "id", id)? {
                let mut new = old.clone();
                new.consolidated_at_us = Some(now);
                new.consolidated_into = Some(take);
                write_fact(tx, trust, Some(&old), &new)?;
            }
            Ok(())
        })
    }

    /// `findTrajectory`: the newest `limit` unexpired rows of the entity in time order (oldest
    /// first), as trajectory points.
    pub fn find_trajectory(&self, q: &TrajectoryQuery) -> Result<Vec<Value>> {
        const OP: &str = "findTrajectory";
        no_nul(OP, &[("entitySlug", &q.entity_slug)])?;
        let limit = count_arg(OP, "limit", q.limit)?;
        let since = opt_time(OP, "since", &q.since)?;
        let until = opt_time(OP, "until", &q.until)?;
        let kind = q.kind.as_deref().unwrap_or("all");
        let read = self.read()?;
        // The vector rides along only when it is from the brain's model and the text is current.
        let brain_model = read_config(&*read, "embedding_model")?;
        let mut seen = HashSet::new();
        let mut rows = Vec::new();
        for source in &q.source_ids {
            if source.contains('\0') || !seen.insert(source.clone()) {
                continue;
            }
            for row in entity_rows(&*read, source, &q.entity_slug)? {
                if row.expired_at_us.is_some()
                    || (q.world_only && row.visibility != "world")
                    || q.metric
                        .as_ref()
                        .is_some_and(|m| row.claim_metric.as_ref() != Some(m))
                    || (kind == "metric" && row.claim_metric.is_none())
                    || (kind == "event" && row.event_type.is_none())
                    || since.is_some_and(|s| row.valid_from_us < s)
                    || until.is_some_and(|u| row.valid_from_us > u)
                    || hidden_by_deleted_page(&*read, &row)?
                    || hidden_by_quarantine(&*read, &row)?
                    || hidden_by_policy(&*read, &row, &q.exclude_private)?
                {
                    continue;
                }
                rows.push(row);
            }
        }
        let mut newest = page_of(rows, |r| r.valid_from_us, true, 0, limit);
        newest.reverse();
        Ok(newest
            .iter()
            .map(|r| {
                json!({
                    "fact_id": r.id,
                    "valid_from": iso(r.valid_from_us),
                    "valid_until": r.valid_until_us.map(iso),
                    "metric": r.claim_metric,
                    "value": r.claim_value,
                    "unit": r.claim_unit,
                    "period": r.claim_period,
                    "event_type": r.event_type,
                    "text": r.fact,
                    "source_session": r.source_session.clone(),
                    "source_markdown_slug": r.source_markdown_slug,
                    "embedding": vector_json(r.embedding.as_deref().filter(|_| {
                        brain_model.as_deref().is_some_and(|m| r.embedding_model.as_deref() == Some(m))
                            && r.embedded_text_hash.as_deref()
                                == Some(embedding::md5_hex(&r.fact).as_str())
                    })),
                })
            })
            .collect())
    }

    /// `getFactsHealth(source_id)`: the active / expired / consolidated counts and the five
    /// entities with the most active rows.
    pub fn get_facts_health(&self, source_id: &str) -> Result<Value> {
        no_nul("getFactsHealth", &[("source_id", source_id)])?;
        let read = self.read()?;
        let now = self.env.now_micros();
        let rows = source_rows(&*read, source_id)?;
        let active: Vec<&FactRecord> = rows.iter().filter(|r| r.active(now)).collect();
        let mut by_entity: HashMap<&str, u64> = HashMap::new();
        for r in &active {
            if let Some(e) = &r.entity_slug {
                *by_entity.entry(e).or_default() += 1;
            }
        }
        let mut top: Vec<(&str, u64)> = by_entity.into_iter().collect();
        top.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        top.truncate(5);
        Ok(json!({
            "source_id": source_id,
            "total_active": active.len(),
            "total_today": active.iter().filter(|r| r.created_at_us > now - DAY_US).count(),
            "total_week": active.iter().filter(|r| r.created_at_us > now - 7 * DAY_US).count(),
            "total_expired": rows.iter().filter(|r| !r.active(now)).count(),
            "total_consolidated": rows.iter().filter(|r| r.consolidated_at_us.is_some()).count(),
            "top_entities": top.iter().map(|(e, n)| json!({ "entity_slug": e, "count": n })).collect::<Vec<_>>(),
        }))
    }

    /// `listUnattributedFacts` (src/core/review-lists.ts): the active rows with no entity in any of
    /// `source_ids`, less the rows a soft-deleted page hides, newest id first, after `offset`, at
    /// most `limit`. Each row is `id, fact, kind, visibility, source_id, created_at, source`, with
    /// `created_at` the `timestamptz::text` form (`2026-06-18 09:00:00.5+00`).
    pub fn list_unattributed_facts(&self, q: &UnattributedQuery) -> Result<Vec<Value>> {
        const OP: &str = "listUnattributedFacts";
        let sources: BTreeSet<&str> = q.source_ids.iter().map(String::as_str).collect();
        let texts: Vec<(&str, &str)> = sources.iter().map(|s| ("sourceIds", *s)).collect();
        no_nul(OP, &texts)?;
        let limit = count_arg(OP, "limit", q.limit)?;
        let offset = count_arg(OP, "offset", q.offset)?;
        let read = self.read()?;
        let now = self.env.now_micros();
        let mut rows = Vec::new();
        for source in sources {
            for row in source_rows(&*read, source)? {
                if row.entity_slug.is_none()
                    && row.active(now)
                    && (!q.world_only || row.visibility == "world")
                    && !hidden_by_deleted_page(&*read, &row)?
                    && !hidden_by_policy(&*read, &row, &q.exclude_private)?
                {
                    rows.push(row);
                }
            }
        }
        rows.sort_by_key(|r| std::cmp::Reverse(r.id));
        Ok(rows
            .iter()
            .skip(offset)
            .take(limit)
            .map(|r| {
                json!({
                    "id": r.id,
                    "fact": r.fact,
                    "kind": r.kind,
                    "visibility": r.visibility,
                    "source_id": r.source_id,
                    "created_at": timestamptz_text(r.created_at_us),
                    "source": r.source,
                })
            })
            .collect())
    }

    /// `migrateFactsToCanonical(phantom, canonical, sourceId)`: the phantom page's unexpired rows
    /// move onto the canonical slug (entity and page), their `row_num` offset past the canonical
    /// page's largest. First the ontology observations the move would duplicate are dropped
    /// (src/core/facts/ontology-rekey.ts `dropRekeyDuplicates`).
    pub fn migrate_facts_to_canonical(
        &self,
        phantom: &str,
        canonical: &str,
        source_id: &str,
    ) -> Result<u64> {
        const OP: &str = "migrateFactsToCanonical";
        no_nul(
            OP,
            &[
                ("phantomSlug", phantom),
                ("canonicalSlug", canonical),
                ("sourceId", source_id),
            ],
        )?;
        // PGLite runs the duplicate drop and the move as two statements outside one transaction:
        // a move that then fails keeps the drop.
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let moving = page_rows(tx, source_id, phantom)?
                .into_iter()
                .filter(|r| r.expired_at_us.is_none() && r.dimension.is_some())
                .collect();
            let to = || Some(canonical.to_string());
            drop_rekey_duplicates(tx, trust, source_id, moving, |_| (to(), to()))
        })?;
        self.write(|tx| {
            let offset = page_rows(tx, source_id, canonical)?
                .iter()
                .filter_map(|r| r.row_num)
                .max()
                .unwrap_or(0);
            let moving: Vec<FactRecord> = page_rows(tx, source_id, phantom)?
                .into_iter()
                .filter(|r| r.expired_at_us.is_none())
                .collect();
            for old in &moving {
                let mut new = old.clone();
                new.entity_slug = Some(canonical.to_string());
                new.source_markdown_slug = Some(canonical.to_string());
                new.row_num =
                    match old.row_num {
                        Some(n) => Some(n.checked_add(offset).ok_or_else(|| {
                            invalid(format!("{OP}: integer out of range (row_num)"))
                        })?),
                        None => None,
                    };
                write_fact(tx, trust, Some(old), &new)?;
            }
            Ok(moving.len() as u64)
        })
    }
}

/// `dropRekeyDuplicates` (src/core/facts/ontology-rekey.ts): `moving` are the ontology rows (a
/// dimension set) about to be rekeyed, and `target` gives each one's (entity_slug,
/// source_markdown_slug) after the move. Of each set of rows that would share an
/// `idx_facts_ontology_stint_dedup` key after the move (the moving rows plus the rows already
/// under that key), keep the first by (conversation fact last, active first, already-at-target
/// first, id), repoint links to a dropped row at the keeper, give a dropped conversation fact's
/// slot up, and delete the other dropped rows.
fn drop_rekey_duplicates(
    tx: &mut dyn KvWrite,
    trust: &WriteTrust,
    source_id: &str,
    moving: Vec<FactRecord>,
    target: impl Fn(&FactRecord) -> (Option<String>, Option<String>),
) -> Result<()> {
    if moving.is_empty() {
        return Ok(());
    }
    // (entity, sms, dimension, value_hash, valid_from) after the move.
    type Key = (String, String, String, String, i64);
    let key_of = |r: &FactRecord, entity: Option<String>, sms: Option<String>| -> Option<Key> {
        Some((
            entity?,
            sms?,
            r.dimension.clone()?,
            r.value_hash.clone()?,
            r.valid_from_us,
        ))
    };
    let moving_ids: HashSet<u64> = moving.iter().map(|r| r.id).collect();
    let mut cand: Vec<(Key, FactRecord, bool)> = Vec::new();
    let mut moving_keys: HashSet<Key> = HashSet::new();
    for r in moving {
        let (entity, sms) = target(&r);
        if let Some(key) = key_of(&r, entity, sms) {
            moving_keys.insert(key.clone());
            cand.push((key, r, true));
        }
    }
    let target_pages: BTreeSet<String> = moving_keys.iter().map(|k| k.1.clone()).collect();
    for page in &target_pages {
        for t in page_rows(tx, source_id, page)? {
            if t.dimension.is_none() || moving_ids.contains(&t.id) {
                continue;
            }
            if let Some(key) = key_of(&t, t.entity_slug.clone(), t.source_markdown_slug.clone())
                && moving_keys.contains(&key)
            {
                cand.push((key, t, false));
            }
        }
    }
    let mut groups: BTreeMap<Key, Vec<(FactRecord, bool)>> = BTreeMap::new();
    for (key, row, moving) in cand {
        groups.entry(key).or_default().push((row, moving));
    }
    let mut losers: Vec<(FactRecord, u64)> = Vec::new();
    for (_, mut group) in groups {
        group.sort_by(|(a, am), (b, bm)| {
            a.conversation_slot()
                .cmp(&b.conversation_slot())
                .then(b.expired_at_us.is_none().cmp(&a.expired_at_us.is_none()))
                .then(am.cmp(bm))
                .then(a.id.cmp(&b.id))
        });
        let keep = group[0].0.id;
        losers.extend(group.into_iter().skip(1).map(|(row, _)| (row, keep)));
    }
    losers.sort_by_key(|(row, _)| row.id);
    for (loser, keep) in &losers {
        for referrer in ids_under(tx, &refs_prefix(loser.id))? {
            if let Some(old) = read_fact(tx, referrer)? {
                let mut new = old.clone();
                new.superseded_by = if old.id == *keep { None } else { Some(*keep) };
                write_fact(tx, trust, Some(&old), &new)?;
            }
        }
    }
    for (loser, _) in &losers {
        let Some(old) = read_fact(tx, loser.id)? else {
            continue;
        };
        if old.conversation_slot() {
            let mut new = old.clone();
            new.dimension = None;
            new.value = None;
            new.value_hash = None;
            new.dim_status = None;
            write_fact(tx, trust, Some(&old), &new)?;
        } else if old.dimension.is_some() {
            delete_fact(tx, trust, &old)?;
        }
    }
    Ok(())
}

/// The facts half of PGLite's `moveSlugBindings` (src/core/page-state/rename-alias.ts) for a page
/// renamed from `old` to `new` in `source_id`, in its statement order: drop the ontology rows the
/// entity move would duplicate, move `entity_slug`, delete the fence rows still at `new` whose
/// row_num a row at `old` holds (they belong to a purged page), drop the ontology rows the fence
/// move would duplicate, then move `source_markdown_slug` (statements 1 to 6 of "Rename slug
/// rows" in docs/designs/RUST_ENGINE_INTERFACES.md). Statement 1 moves the `fact_withdrawals`
/// rows by `subject` (`trust::withdrawals::move_subject_in`), so a withdrawn claim stays withdrawn
/// under the new slug. Called by `cascade::rename_slug_rows`.
pub(crate) fn rename_slug_rows(
    tx: &mut dyn KvWrite,
    trust: &WriteTrust,
    source_id: &str,
    old: &str,
    new: &str,
) -> Result<()> {
    if old == new {
        return Ok(());
    }
    crate::trust::withdrawals::move_subject_in(tx, source_id, old, new)?;
    let about = entity_rows(tx, source_id, old)?;
    let moving = about
        .iter()
        .filter(|r| r.dimension.is_some())
        .cloned()
        .collect();
    drop_rekey_duplicates(tx, trust, source_id, moving, |r| {
        (Some(new.to_string()), r.source_markdown_slug.clone())
    })?;
    for row in entity_rows(tx, source_id, old)? {
        let mut moved = row.clone();
        moved.entity_slug = Some(new.to_string());
        write_fact(tx, trust, Some(&row), &moved)?;
    }
    let held: HashSet<i32> = page_rows(tx, source_id, old)?
        .iter()
        .filter_map(|r| r.row_num)
        .collect();
    for row in page_rows(tx, source_id, new)? {
        if row.row_num.is_some_and(|n| held.contains(&n))
            && let Some(current) = read_fact(tx, row.id)?
        {
            delete_fact(tx, trust, &current)?;
        }
    }
    let moving = page_rows(tx, source_id, old)?
        .into_iter()
        .filter(|r| r.dimension.is_some())
        .collect();
    drop_rekey_duplicates(tx, trust, source_id, moving, |r| {
        (r.entity_slug.clone(), Some(new.to_string()))
    })?;
    for row in page_rows(tx, source_id, old)? {
        let mut moved = row.clone();
        moved.source_markdown_slug = Some(new.to_string());
        write_fact(tx, trust, Some(&row), &moved)?;
    }
    Ok(())
}

/// A batch row's `superseded by #N` reference: `#N` must be an int4 row number to be looked up.
fn int4_ref(n: f64) -> Option<i32> {
    (n.fract() == 0.0 && (1.0..=f64::from(i32::MAX)).contains(&n)).then_some(n as i32)
}

/// A `Map` key for a JavaScript number (`SameValueZero`: `-0` is `0`).
fn num_key(n: f64) -> u64 {
    if n == 0.0 { 0 } else { n.to_bits() }
}

struct Target {
    id: u64,
    struck: bool,
    next_row: Option<f64>,
}

/// `insertFacts`' second pass (src/core/facts/supersede-resolve.ts): resolves each inserted
/// row's `superseded by #N` to the fact id at row N of the same page, refusing a self, absent,
/// struck-but-not-superseded or cyclic reference with a warning. Returns the warnings.
fn link_supersessions(
    tx: &mut dyn KvWrite,
    trust: &WriteTrust,
    source_id: &str,
    rows: &[NewFactInput],
    row_ids: &[Option<u64>],
) -> Result<Vec<String>> {
    let mut targets: HashMap<(String, i32), Target> = HashMap::new();
    for (row, id) in rows.iter().zip(row_ids) {
        let (Some(target_row), Some(_), Some(slug)) =
            (row.superseded_by_row, id, &row.source_markdown_slug)
        else {
            continue;
        };
        let Some(n) = int4_ref(target_row) else {
            continue;
        };
        if targets.contains_key(&(slug.clone(), n)) {
            continue;
        }
        if let Some(found) = fence_row(tx, source_id, slug, n)? {
            let next_row = match found.superseded_by {
                Some(next) => read_fact(tx, next)?.and_then(|r| r.row_num).map(f64::from),
                None => None,
            };
            targets.insert(
                (slug.clone(), n),
                Target {
                    id: found.id,
                    struck: found.expired_at_us.is_some(),
                    next_row,
                },
            );
        }
    }
    let mut warnings = Vec::new();
    let mut links: Vec<(u64, u64)> = Vec::new();
    for (row, id) in rows.iter().zip(row_ids) {
        let (Some(target_row), Some(id)) = (row.superseded_by_row, id) else {
            continue;
        };
        let own = row.row_num.unwrap_or(f64::NAN);
        let slug = row.source_markdown_slug.clone();
        let name = slug.as_deref().unwrap_or("null").to_string();
        // supersessionChainOf: the struck rows of this page that name a successor.
        let mut chain: HashMap<u64, f64> = HashMap::new();
        for other in rows {
            if other.source_markdown_slug == slug
                && other.expired_at.is_some()
                && let (Some(from), Some(to)) = (other.row_num, other.superseded_by_row)
            {
                chain.insert(num_key(from), to);
            }
        }
        let key = match (&slug, int4_ref(target_row)) {
            (Some(s), Some(n)) => Some((s.clone(), n)),
            _ => None,
        };
        let found = key.as_ref().and_then(|k| targets.get(k));
        if let Some(next) = found.and_then(|f| f.next_row) {
            chain.entry(num_key(target_row)).or_insert(next);
        }
        let prefix = format!(
            "{name} row {}: \"superseded by #{}\"",
            js_number(own),
            js_number(target_row)
        );
        let warning = if target_row == own {
            Some(format!(
                "{prefix} references itself — leaving superseded_by NULL"
            ))
        } else if found.is_none() {
            Some(format!(
                "{prefix} names a row absent from the fence — leaving superseded_by NULL"
            ))
        } else if found.is_some_and(|f| f.struck) && !chain.contains_key(&num_key(target_row)) {
            Some(format!(
                "{prefix} names a row that is itself struck (inactive) without being superseded — a supersession target must be a live or superseded row; leaving superseded_by NULL"
            ))
        } else {
            let mut seen: HashSet<u64> = HashSet::from([num_key(own)]);
            let mut at = Some(target_row);
            let mut cycle = false;
            while let Some(r) = at {
                if !seen.insert(num_key(r)) {
                    cycle = true;
                    break;
                }
                at = chain.get(&num_key(r)).copied();
            }
            cycle.then(|| {
                format!("{prefix} forms a supersession cycle — leaving superseded_by NULL")
            })
        };
        if let Some(w) = warning {
            warnings.push(w);
            continue;
        }
        let target_id = found.map(|f| f.id).unwrap_or_default();
        links.push((*id, target_id));
        if let (Some(s), Some(own_n)) = (&slug, row.row_num.and_then(int4_ref))
            && let Some(own_target) = targets.get_mut(&(s.clone(), own_n))
        {
            own_target.next_row = Some(target_row);
        }
    }
    for (id, target) in links {
        if let Some(old) = read_fact(tx, id)? {
            let mut new = old.clone();
            new.superseded_by = Some(target);
            write_fact(tx, trust, Some(&old), &new)?;
        }
    }
    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kv::KvRead;
    use std::collections::BTreeMap;

    struct MapRead(BTreeMap<Vec<u8>, Vec<u8>>);

    impl KvRead for MapRead {
        fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
            Ok(self.0.get(key).cloned())
        }
        fn scan(
            &self,
            start: &[u8],
            end: &[u8],
            reverse: bool,
            f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
        ) -> Result<()> {
            let range = self.0.range(start.to_vec()..end.to_vec());
            let entries: Vec<_> = if reverse {
                range.rev().collect()
            } else {
                range.collect()
            };
            for (k, v) in entries {
                if !f(k, v) {
                    break;
                }
            }
            Ok(())
        }
    }

    fn row(id: u64, source_id: &str, expired: bool) -> FactRecord {
        FactRecord {
            id,
            source_id: source_id.into(),
            fact: format!("fact {id}"),
            kind: "fact".into(),
            visibility: "private".into(),
            notability: "medium".into(),
            source: "test".into(),
            confidence: 1.0,
            expired_at_us: expired.then_some(5),
            ..FactRecord::default()
        }
    }

    fn brain(rows: &[FactRecord]) -> MapRead {
        let mut map = BTreeMap::new();
        for r in rows {
            map.insert(fact_key(r.id), serde_json::to_vec(r).unwrap());
        }
        MapRead(map)
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn fact_exists_follows_the_eval_capture_rule() {
        let read = brain(&[row(1, "default", false), row(2, "wiki", true)]);
        // Any source when the candidate names none.
        assert!(fact_exists(&read, 1, &[]).unwrap());
        assert!(fact_exists(&read, 2, &[]).unwrap());
        // Only the named sources otherwise.
        assert!(fact_exists(&read, 1, &ids(&["default"])).unwrap());
        assert!(fact_exists(&read, 1, &ids(&["wiki", "default"])).unwrap());
        assert!(!fact_exists(&read, 1, &ids(&["wiki"])).unwrap());
        // An expired row still exists, as in PGLite.
        assert!(fact_exists(&read, 2, &ids(&["wiki"])).unwrap());
        // A row that is not there, and id 0 (Postgres never assigns it).
        assert!(!fact_exists(&read, 3, &[]).unwrap());
        assert!(!fact_exists(&read, 0, &[]).unwrap());
        assert!(!fact_exists(&read, u64::MAX, &ids(&["default"])).unwrap());
    }

    #[test]
    fn fact_keys_sort_by_id() {
        assert!(fact_key(2) < fact_key(256));
        assert_eq!(fact_key(1)[..2], [keys::FACT, ROW]);
        let read = brain(&[row(7, "default", false)]);
        assert_eq!(read_fact(&read, 7).unwrap().unwrap().id, 7);
    }

    #[test]
    fn remove_source_rows_deletes_every_fact_of_the_source() {
        use crate::sources::SourceInput;
        let store = crate::test_support::store();
        store
            .upsert_source(&SourceInput {
                id: "wiki".into(),
                ..SourceInput::default()
            })
            .unwrap();
        let add = |source: &str, fact: &str| -> u64 {
            let args = InsertFactArgs {
                input: NewFactInput {
                    fact: Some(fact.into()),
                    source: Some("test".into()),
                    entity_slug: Some("people/alice-example".into()),
                    ..NewFactInput::default()
                },
                source_id: source.into(),
                supersede_id: None,
            };
            store.insert_fact(&args).unwrap()["id"].as_u64().unwrap()
        };
        let gone_a = add("wiki", "a");
        let gone_b = add("wiki", "b");
        let kept = add("default", "c");
        // A row of another source names a wiki row as its successor: it stays, unlinked.
        store
            .expire_fact(&ExpireFactArgs {
                id: kept as f64,
                superseded_by: Some(gone_b as f64),
                ..Default::default()
            })
            .unwrap();
        store.write(|tx| remove_source_rows(tx, "wiki")).unwrap();
        let read = store.read().unwrap();
        assert!(read_fact(&*read, gone_a).unwrap().is_none());
        assert!(read_fact(&*read, gone_b).unwrap().is_none());
        assert!(source_rows(&*read, "wiki").unwrap().is_empty());
        assert!(
            entity_rows(&*read, "wiki", "people/alice-example")
                .unwrap()
                .is_empty()
        );
        let survivor = read_fact(&*read, kept).unwrap().unwrap();
        assert_eq!(survivor.superseded_by, None);
        assert!(survivor.expired_at_us.is_some());
        assert!(ids_under(&*read, &refs_prefix(gone_b)).unwrap().is_empty());
        assert_eq!(source_rows(&*read, "default").unwrap().len(), 1);
    }

    #[test]
    fn fingerprint_and_text_rules_match_postgres() {
        assert_eq!(
            fact_fingerprint("Alice  likes Tea."),
            "b93bc28474baf9644a7ac21462da07350b4215e5a9ad3a54ecfff9ebb8485883"
        );
        assert_eq!(
            fact_normalize("Hello... World. e.g. x.y  ."),
            "hello world e.g x.y"
        );
        // ILIKE folds with lower(), one code point at a time.
        assert!(!like("Straße", "%STRASSE%", true).unwrap());
        assert!(!like("σ", "ς", true).unwrap());
        assert!(like("\u{212A}", "k", true).unwrap());
        assert!(like("50%", "50\\%", false).unwrap());
        assert!(!like("50x", "50\\%", false).unwrap());
        assert!(like("abcabc", "a%c", false).unwrap());
        assert!(like("a_b", "a\\_b", false).unwrap());
        let err = like("x", "x\\", false).unwrap_err();
        assert!(
            err.message
                .contains("LIKE pattern must not end with escape character")
        );
    }

    /// A test fence row: (fact, entity, row_num, (dimension, value, value_hash)).
    type Row<'a> = (&'a str, &'a str, f64, Option<(&'a str, &'a str, &'a str)>);

    #[test]
    fn rename_slug_rows_matches_move_slug_bindings() {
        // PGLite moveSlugBindings on these rows gives the outcome below (probed). The rename goes
        // through the cascade list, as the aliases family's updateSlug will call it.
        let store = crate::test_support::store();
        let page = |sms: &str, rows: &[Row]| -> Vec<u64> {
            let rows = rows
                .iter()
                .map(|(fact, entity, row_num, dim)| NewFactInput {
                    fact: Some((*fact).into()),
                    source: Some("test".into()),
                    valid_from: Some("2026-01-01T00:00:00.000Z".into()),
                    entity_slug: Some((*entity).into()),
                    row_num: Some(*row_num),
                    source_markdown_slug: Some(sms.into()),
                    dimension: dim.map(|d| d.0.into()),
                    value: dim.map(|d| d.1.into()),
                    value_hash: dim.map(|d| d.2.into()),
                    ..NewFactInput::default()
                })
                .collect();
            let out = store
                .insert_facts(&InsertFactsArgs {
                    rows,
                    source_id: "default".into(),
                    delete_for_page_first: None,
                })
                .unwrap();
            serde_json::from_value(out["ids"].clone()).unwrap()
        };
        let old = page(
            "people/old",
            &[
                ("r1", "people/old", 1.0, Some(("employer", "Acme", "h1"))),
                ("r2", "people/old", 2.0, None),
            ],
        );
        let new = page(
            "people/new",
            &[
                ("r3", "people/new", 1.0, None),
                ("r4", "people/new", 3.0, Some(("employer", "Acme", "h1"))),
            ],
        );
        let meeting = page(
            "meetings/m1",
            &[
                ("r5", "people/old", 1.0, Some(("title", "CEO", "h2"))),
                ("r6", "people/new", 2.0, Some(("title", "CEO", "h2"))),
                ("r7", "people/old", 3.0, None),
            ],
        );
        store
            .expire_fact(&ExpireFactArgs {
                id: old[1] as f64,
                superseded_by: Some(old[0] as f64),
                ..Default::default()
            })
            .unwrap();
        store
            .write(|tx| {
                crate::cascade::rename_slug_rows(
                    tx,
                    &WriteTrust::default(),
                    "default",
                    "people/old",
                    "people/new",
                )
            })
            .unwrap();
        let read = store.read().unwrap();
        let view = |id: u64| {
            read_fact(&*read, id).unwrap().map(|r| {
                (
                    r.entity_slug.unwrap(),
                    r.source_markdown_slug.unwrap(),
                    r.row_num.unwrap(),
                    r.superseded_by,
                    r.dimension,
                )
            })
        };
        let at = |e: &str, s: &str, n: i32, sup: Option<u64>, d: Option<&str>| {
            Some((e.to_string(), s.to_string(), n, sup, d.map(String::from)))
        };
        // r1 loses to r4 once its fence moves; r3 yields its row_num to r2; r5 loses to r6.
        assert_eq!(view(old[0]), None);
        assert_eq!(view(new[0]), None);
        assert_eq!(view(meeting[0]), None);
        assert_eq!(
            view(old[1]),
            at("people/new", "people/new", 2, Some(new[1]), None)
        );
        assert_eq!(
            view(new[1]),
            at("people/new", "people/new", 3, None, Some("employer"))
        );
        assert_eq!(
            view(meeting[1]),
            at("people/new", "meetings/m1", 2, None, Some("title"))
        );
        assert_eq!(
            view(meeting[2]),
            at("people/new", "meetings/m1", 3, None, None)
        );
        assert!(
            entity_rows(&*read, "default", "people/old")
                .unwrap()
                .is_empty()
        );
        assert!(
            page_rows(&*read, "default", "people/old")
                .unwrap()
                .is_empty()
        );
        assert_eq!(source_rows(&*read, "default").unwrap().len(), 4);
        // A rename onto the same slug changes nothing.
        drop(read);
        store
            .write(|tx| {
                rename_slug_rows(
                    tx,
                    &WriteTrust::default(),
                    "default",
                    "people/new",
                    "people/new",
                )
            })
            .unwrap();
        assert_eq!(
            source_rows(&*store.read().unwrap(), "default")
                .unwrap()
                .len(),
            4
        );
    }

    #[test]
    fn update_slug_moves_the_facts_of_the_renamed_page() {
        // A rename through the public `updateSlug` moves the page's facts, as PGLite
        // `moveSlugBindings` does: the entity lists them at the new slug, and deleting the
        // new page's facts removes them.
        let store = crate::test_support::store();
        let input = crate::pages::PageInput {
            page_type: "person".into(),
            title: "Old".into(),
            compiled_truth: "body".into(),
            ..crate::pages::PageInput::default()
        };
        store
            .put_page(
                "people/old",
                &input,
                &crate::pages::PutPageOptions::default(),
            )
            .unwrap();
        let out = store
            .insert_facts(&InsertFactsArgs {
                rows: vec![NewFactInput {
                    fact: Some("works at acme".into()),
                    source: Some("test".into()),
                    valid_from: Some("2026-01-01T00:00:00.000Z".into()),
                    entity_slug: Some("people/old".into()),
                    row_num: Some(1.0),
                    source_markdown_slug: Some("people/old".into()),
                    ..NewFactInput::default()
                }],
                source_id: "default".into(),
                delete_for_page_first: None,
            })
            .unwrap();
        let ids: Vec<u64> = serde_json::from_value(out["ids"].clone()).unwrap();
        assert_eq!(
            store.update_slug("people/old", "people/new", None).unwrap(),
            1
        );
        let read = store.read().unwrap();
        let row = read_fact(&*read, ids[0]).unwrap().unwrap();
        assert_eq!(row.entity_slug.as_deref(), Some("people/new"));
        assert_eq!(row.source_markdown_slug.as_deref(), Some("people/new"));
        assert!(
            entity_rows(&*read, "default", "people/old")
                .unwrap()
                .is_empty()
        );
        assert!(
            page_rows(&*read, "default", "people/old")
                .unwrap()
                .is_empty()
        );
        assert_eq!(page_rows(&*read, "default", "people/new").unwrap().len(), 1);
    }

    #[test]
    fn a_retention_purge_expires_the_facts_of_the_purged_page() {
        // `expireGonePageFacts`: once the tombstone that hid them is gone, the purged page's
        // facts stay expired, and a new page at the slug does not pick them up.
        let store = crate::test_support::store();
        let input = crate::pages::PageInput {
            page_type: "person".into(),
            title: "Alice".into(),
            compiled_truth: "body".into(),
            ..crate::pages::PageInput::default()
        };
        let put = |slug: &str| {
            store
                .put_page(slug, &input, &crate::pages::PutPageOptions::default())
                .unwrap()
        };
        put("people/alice-example");
        put("notes/holder");
        let row = |fact: &str,
                   source: &str,
                   entity: Option<&str>,
                   filed: Option<&str>,
                   context: Option<&str>,
                   dim: Option<&str>,
                   row_num: Option<f64>| NewFactInput {
            fact: Some(fact.into()),
            source: Some(source.into()),
            valid_from: Some("2026-01-01T00:00:00.000Z".into()),
            entity_slug: entity.map(String::from),
            source_markdown_slug: filed.map(String::from),
            context: context.map(String::from),
            dimension: dim.map(String::from),
            value: dim.map(|_| "v".to_string()),
            row_num,
            ..NewFactInput::default()
        };
        let a = Some("people/alice-example");
        let rows = vec![
            row("filed", "test", a, a, None, None, Some(1.0)),
            row(
                "held elsewhere",
                "test",
                a,
                Some("notes/holder"),
                None,
                None,
                Some(1.0),
            ),
            row(
                "extracted",
                "sync:import",
                None,
                None,
                Some("people/alice-example \u{2014} note"),
                None,
                None,
            ),
            row("about, unfiled", "test", a, None, None, None, None),
            row(
                "slot",
                "cli:extract-conversation-facts:x",
                a,
                a,
                None,
                Some("role"),
                Some(2.0),
            ),
            row(
                "observation",
                "test",
                Some("people/bob-example"),
                a,
                None,
                Some("role"),
                None,
            ),
            row(
                "other page",
                "sync:import",
                None,
                None,
                Some("people/bob-example"),
                None,
                None,
            ),
        ];
        let out = store
            .insert_facts(&InsertFactsArgs {
                rows,
                source_id: "default".into(),
                delete_for_page_first: None,
            })
            .unwrap();
        let ids: Vec<u64> = serde_json::from_value(out["ids"].clone()).unwrap();
        assert_eq!(ids.len(), 7);
        let past = store.env.now_micros() - 2 * DAY_US;
        store
            .write(|tx| {
                let mut page = read_page(&*tx, "default", "people/alice-example")?.unwrap();
                page.deleted_at_us = Some(past);
                crate::pages::write_page(tx, &page)
            })
            .unwrap();
        let purged = store
            .purge_deleted_pages(0.0, &crate::page_ops::PurgeOptions::default())
            .unwrap();
        assert_eq!(purged["slugs"], json!(["people/alice-example"]));
        put("people/alice-example");
        let read = store.read().unwrap();
        let state: Vec<(bool, Option<i32>, Option<String>)> = ids
            .iter()
            .map(|id| {
                let r = read_fact(&*read, *id).unwrap().unwrap();
                (r.expired_at_us.is_some(), r.row_num, r.dimension)
            })
            .collect();
        assert_eq!(
            state,
            vec![
                (true, None, None),
                (false, Some(1), None),
                (true, None, None),
                (true, None, None),
                (true, None, None),
                (false, None, Some("role".into())),
                (false, None, None),
            ]
        );
    }

    #[test]
    fn a_deep_keyword_duplicate_query_walks_every_fact_on_one_deep_thread() {
        // Minder row 3: one deep-query thread for the walk, not one per fact.
        let store = crate::test_support::store();
        let words: Vec<String> = (0..1100).map(|i| format!("alpha{i}")).collect();
        let text = words.join(" ");
        for _ in 0..12 {
            let input = json!({ "fact": text, "source": "s", "entity_slug": "people/eve" });
            store
                .insert_fact(
                    &serde_json::from_value(json!({ "input": input, "sourceId": "default" }))
                        .unwrap(),
                )
                .unwrap();
        }
        let q: DuplicateQuery = serde_json::from_value(json!({ "sourceId": "default",
            "entitySlug": "people/eve", "k": 50, "keyword": true, "factText": text }))
        .unwrap();
        crate::keyword::reset_deep_spawns();
        assert_eq!(store.find_candidate_duplicates(&q).unwrap().len(), 12);
        let spawned = crate::keyword::deep_spawns();
        // Building the query takes a fixed few; the walk over the 12 facts adds one.
        assert!(
            spawned <= 4,
            "the duplicate search started {spawned} deep-query threads"
        );
    }
}
