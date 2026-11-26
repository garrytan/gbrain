//! The edge-contradiction dream phase and its proposals: the `link_edge_proposals` table of the
//! PGLite engine and the candidate read over `link_relationships`
//! (src/core/engine-sql/contradictions-cycle.ts).
//!
//! Members: listEdgeContradictionCandidates, listKnownEdgeProposals, recordEdgeProposal,
//! readEdgeProposal, edgeClosureLanded, readEdgeProposalEvidence, readEdgeProposalHash,
//! markEdgeProposalStale, setEdgeProposalStatus, rejectOpenEdgeProposal, markEdgeProposalUndone
//! and markRevertedEdgeProposals.
//! The six members of `gbrain edge-proposals` (listEdgeProposalCliRows and the rest) live in
//! edge_proposals/cli.rs.
//!
//! Keys (every one starts with `keys::CONTRADICTIONS`, `Q`; contradictions.rs owns the sub-tags
//! 0x01 to 0x03 of the same prefix):
//! - `Q 0x04 id -> ProposalRecord`: one proposal, the `BIGSERIAL` primary key as 8 big-endian
//!   bytes.
//! - `Q 0x05 from a b link_type \0 evidence_hash -> id`: the five-part unique key. The three page
//!   ids are 8 big-endian bytes each, so `Q 0x05 from` is the prefix of one subject's proposals.
//!
//! The relationship and transition rows this module reads belong to link_temporal.rs:
//! `q <source> \0 R from to link_type \0 ...` and `q <source> \0 T from to link_type \0 id`, keyed
//! by the source of the from page. tests/edge_proposals.rs pins that layout through the public
//! writers.
//!
//! Ids: every record draws the next id, also when the evidence conflicts and nothing is inserted,
//! as `DEFAULT nextval` draws one for each `INSERT ... ON CONFLICT`.
//!
//! Order: the candidate rows are ordered in byte order. PGLite compares text the same way; a
//! Postgres database with an `en_US` collation can order mixed-case or punctuated slugs another
//! way. Groups that tie on their newest `refreshed_at` are cut by `maxSubjects` at the lowest
//! `from_page_id`, then `link_type` in byte order, as the SQL's `ORDER BY max(refreshed_at) DESC,
//! from_page_id, link_type COLLATE "C"` cuts them (a page id belongs to one source, so the source
//! never orders two groups).

use crate::dream::int4;
use crate::env::{iso, parse_iso};
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::link_queries::link_temporal::{
    ProposalCounts, RelationshipKey, RelationshipRecord, TransitionRecord, is_date,
    multirange_contains, relationship,
};
use crate::links::no_nul;
use crate::pages::{PageRecord, next_id, read_page_by_id};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

mod cli;
pub use cli::EdgeProposalCliFilter;

const PROPOSAL: u8 = 0x04;
const PROPOSAL_BY_EVIDENCE: u8 = 0x05;
const PROPOSAL_ID: &str = "link_edge_proposal_id";
const TABLE: &str = "link_edge_proposals";
/// The sub-tags of link_temporal.rs after `q <source> \0`.
const RELATIONSHIP: u8 = b'R';
const TRANSITION: u8 = b'T';
const STATUSES: [&str; 10] = [
    "proposed",
    "applied",
    "rejected",
    "undone",
    "stale",
    "reverted_by_user",
    "undated_unresolved",
    "ambiguous_same_date",
    "compatible",
    "error",
];
/// The statuses `rejectOpenEdgeProposal` may reject.
const OPEN: [&str; 3] = ["proposed", "undated_unresolved", "ambiguous_same_date"];
const DAY_US: i64 = 86_400_000_000;

/// One `link_edge_proposals` row. `cost_usd` has no writer and is not kept.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct ProposalRecord {
    id: u64,
    source_id: String,
    from_page_id: u64,
    a_to_page_id: u64,
    b_to_page_id: u64,
    link_type: String,
    evidence_hash: String,
    status: String,
    ending_to_page_id: Option<u64>,
    close_date: Option<String>,
    born_closed: bool,
    model: Option<String>,
    /// `REAL`: rounded to `f32` on write.
    confidence: Option<f32>,
    generated_line: Option<String>,
    detail: Option<String>,
    created_at_us: i64,
    updated_at_us: i64,
}

/// `recordEdgeProposal(proposal)`: the camelCase `EdgeProposalInput`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EdgeProposalInput {
    pub source_id: String,
    pub from_page_id: f64,
    pub a_to_page_id: f64,
    pub b_to_page_id: f64,
    pub link_type: String,
    pub evidence_hash: String,
    pub status: String,
    pub ending_to_page_id: Option<f64>,
    pub close_date: Option<String>,
    pub born_closed: bool,
    pub model: Option<String>,
    pub confidence: Option<f64>,
    pub generated_line: Option<String>,
    pub detail: Option<String>,
}

/// One per-source arm of an `EntityTypeFilter`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SourceTypes {
    pub source_id: String,
    pub types: Vec<String>,
}

/// `EntityTypeFilter`: the person-like page types, per source when an arm names the source.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct EntityTypeFilter {
    pub types: Vec<String>,
    pub per_source: Vec<SourceTypes>,
}

impl EntityTypeFilter {
    /// `type = ANY(CASE source_id WHEN ... THEN ... ELSE types END)`: the first arm that names the
    /// page's source decides.
    fn admits(&self, page: &PageRecord) -> bool {
        let types = self
            .per_source
            .iter()
            .find(|arm| arm.source_id == page.source_id)
            .map_or(&self.types, |arm| &arm.types);
        types.contains(&page.page_type)
    }
}

/// `listEdgeContradictionCandidates(query)`: `EdgeCandidateQuery` plus the non-employer roles the
/// statement binds (src/core/link-target-roles.ts).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EdgeCandidateQuery {
    pub today: String,
    pub max_subjects: f64,
    pub pending_cutoff: Option<String>,
    pub person_filter: EntityTypeFilter,
    pub non_employer_types: Vec<String>,
    pub non_employer_prefixes: Vec<String>,
}

fn proposal_key(id: u64) -> Vec<u8> {
    let mut key = vec![keys::CONTRADICTIONS, PROPOSAL];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn subject_prefix(from: u64) -> Vec<u8> {
    let mut key = vec![keys::CONTRADICTIONS, PROPOSAL_BY_EVIDENCE];
    key.extend_from_slice(&from.to_be_bytes());
    key
}

fn evidence_key(from: u64, a: u64, b: u64, link_type: &str, evidence_hash: &str) -> Vec<u8> {
    let mut key = subject_prefix(from);
    key.extend_from_slice(&a.to_be_bytes());
    key.extend_from_slice(&b.to_be_bytes());
    key.extend_from_slice(link_type.as_bytes());
    key.push(0);
    key.extend_from_slice(evidence_hash.as_bytes());
    key
}

fn record_evidence_key(r: &ProposalRecord) -> Vec<u8> {
    evidence_key(
        r.from_page_id,
        r.a_to_page_id,
        r.b_to_page_id,
        &r.link_type,
        &r.evidence_hash,
    )
}

/// A `BIGINT` or `INTEGER` id argument: a whole number at or above zero, else no row matches.
fn id_arg(n: f64) -> Option<u64> {
    (n.fract() == 0.0 && (0.0..=u64::MAX as f64).contains(&n)).then_some(n as u64)
}

fn decode_under<T: for<'de> Deserialize<'de>>(
    read: &dyn KvRead,
    prefix: &[u8],
    keep: &mut dyn FnMut(&[u8]) -> bool,
) -> Result<Vec<(Vec<u8>, T)>> {
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(read, prefix, false, &mut |k, v| {
        if !keep(k) {
            return true;
        }
        match serde_json::from_slice(v) {
            Ok(record) => {
                out.push((k.to_vec(), record));
                true
            }
            Err(e) => {
                bad = Some(StoreError::from(e));
                false
            }
        }
    })?;
    match bad {
        Some(e) => Err(e),
        None => Ok(out),
    }
}

fn all_proposals(read: &dyn KvRead) -> Result<Vec<ProposalRecord>> {
    Ok(
        decode_under(read, &[keys::CONTRADICTIONS, PROPOSAL], &mut |_| true)?
            .into_iter()
            .map(|(_, r)| r)
            .collect(),
    )
}

fn read_proposal(read: &dyn KvRead, id: f64) -> Result<Option<ProposalRecord>> {
    match id_arg(id) {
        Some(id) => get_json(read, &proposal_key(id)),
        None => Ok(None),
    }
}

/// `q <source> \0 <tag> from to link_type \0`: the rows of one relationship in link_temporal.rs.
fn pair_prefix(source_id: &str, tag: u8, from: u64, to: u64, link_type: &str) -> Vec<u8> {
    let mut key = vec![keys::LINK_QUERIES];
    key.extend_from_slice(source_id.as_bytes());
    key.push(0);
    key.push(tag);
    key.extend_from_slice(&from.to_be_bytes());
    key.extend_from_slice(&to.to_be_bytes());
    key.extend_from_slice(link_type.as_bytes());
    key.push(0);
    key
}

/// `EXISTS (SELECT 1 FROM link_transitions WHERE origin_page_id = from AND from_page_id = from AND
/// to_page_id = ending AND link_type = .. AND kind = 'end' AND producer = 'dream' AND occurred_on
/// = close_date)`. A NULL ending or close date matches nothing.
fn closure_exists(
    read: &dyn KvRead,
    from: u64,
    ending: Option<u64>,
    link_type: &str,
    close_date: Option<&str>,
) -> Result<bool> {
    let (Some(ending), Some(close_date)) = (ending, close_date) else {
        return Ok(false);
    };
    let Some(subject) = read_page_by_id(read, from)? else {
        return Ok(false);
    };
    let prefix = pair_prefix(&subject.source_id, TRANSITION, from, ending, link_type);
    Ok(
        decode_under::<TransitionRecord>(read, &prefix, &mut |_| true)?
            .into_iter()
            .any(|(_, t)| {
                t.origin_page_id == Some(from)
                    && t.kind == "end"
                    && t.producer == "dream"
                    && t.occurred_on == close_date
            }),
    )
}

/// Every relationship row of every source (`q <source> \0 R ...`).
fn all_relationships(read: &dyn KvRead) -> Result<Vec<RelationshipRecord>> {
    Ok(
        decode_under::<RelationshipRecord>(read, &[keys::LINK_QUERIES], &mut |k| {
            k.iter()
                .skip(1)
                .position(|b| *b == 0)
                .is_some_and(|nul| k.get(nul + 2) == Some(&RELATIONSHIP))
        })?
        .into_iter()
        .map(|(_, r)| r)
        .collect(),
    )
}

fn check_status(status: &str) -> Result<()> {
    if STATUSES.contains(&status) {
        return Ok(());
    }
    Err(StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "new row for relation \"{TABLE}\" violates check constraint \"{TABLE}_status_check\""
        ),
    ))
}

fn check_page(read: &dyn KvRead, column: &str, id: u64) -> Result<()> {
    if read_page_by_id(read, id)?.is_some() {
        return Ok(());
    }
    Err(StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "insert or update on table \"{TABLE}\" violates foreign key constraint \"{TABLE}_{column}_fkey\""
        ),
    ))
}

fn page_id(op: &str, column: &str, value: f64) -> Result<u64> {
    let id = int4(op, column, value)?;
    // A negative id names no page; the foreign key check refuses it.
    Ok(u64::try_from(id).unwrap_or(u64::MAX))
}

/// `listEdgeContradictionCandidates`: whether a works_at target is a non-employer.
fn non_employer(q: &EdgeCandidateQuery, target: &PageRecord) -> bool {
    if target.page_type.is_empty() {
        q.non_employer_prefixes
            .iter()
            .any(|p| target.slug.as_bytes().starts_with(p.as_bytes()))
    } else {
        q.non_employer_types.contains(&target.page_type)
    }
}

/// The proposal counts of `edgeValidityCounts`: `proposed`, `undated_unresolved` and `applied`
/// proposals whose source passes `in_scope` (`source_id = ANY(scope)`, every source when the scope
/// is null).
/// Whether a link edge proposal that names page `page_id` (as its from, either to, or its ending to) was decided by a person:
/// rejected, undone or reverted (the concept rebuild's stated check).
pub(crate) fn person_decided_proposal_names(read: &dyn KvRead, page_id: u64) -> Result<bool> {
    Ok(all_proposals(read)?.iter().any(|p| {
        (p.from_page_id == page_id
            || p.a_to_page_id == page_id
            || p.b_to_page_id == page_id
            || p.ending_to_page_id == Some(page_id))
            && matches!(
                p.status.as_str(),
                "rejected" | "undone" | "reverted_by_user"
            )
    }))
}

pub(crate) fn proposal_counts(
    read: &dyn KvRead,
    in_scope: impl Fn(&str) -> bool,
) -> Result<ProposalCounts> {
    let mut counts = ProposalCounts {
        proposed: 0,
        undated: 0,
        applied: 0,
    };
    for r in all_proposals(read)? {
        if !in_scope(&r.source_id) {
            continue;
        }
        match r.status.as_str() {
            "proposed" => counts.proposed += 1,
            "undated_unresolved" => counts.undated += 1,
            "applied" => counts.applied += 1,
            _ => {}
        }
    }
    Ok(counts)
}

/// Deletes the proposals whose subject or either target is hard-deleted and clears the ending of
/// those that end at it (`ON DELETE CASCADE` / `ON DELETE SET NULL`; `cascade::remove_page_rows`).
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    let id = page.id;
    for mut r in all_proposals(&*tx)? {
        if r.from_page_id == id || r.a_to_page_id == id || r.b_to_page_id == id {
            tx.delete(&proposal_key(r.id))?;
            tx.delete(&record_evidence_key(&r))?;
        } else if r.ending_to_page_id == Some(id) {
            r.ending_to_page_id = None;
            put_json(tx, &proposal_key(r.id), &r)?;
        }
    }
    Ok(())
}

impl Store {
    /// `listEdgeContradictionCandidates(query)`: the live state relationships of subjects with two
    /// or more targets of one link type, the `maxSubjects` groups with the newest `refreshed_at`.
    /// A works_at row needs a person-like subject and a target that is neither person-like nor a
    /// non-employer. With a `pendingCutoff`, only subjects whose links were extracted at or after
    /// it answer.
    pub fn list_edge_contradiction_candidates(&self, q: &EdgeCandidateQuery) -> Result<Vec<Value>> {
        const OP: &str = "listEdgeContradictionCandidates";
        if !is_date(&q.today) {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                format!("{OP}: invalid input syntax for type date: \"{}\"", q.today),
            ));
        }
        if q.max_subjects.fract() != 0.0 || !q.max_subjects.is_finite() {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                format!(
                    "{OP}: invalid input syntax for type bigint: \"{}\"",
                    q.max_subjects
                ),
            ));
        }
        if q.max_subjects < 0.0 {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                "LIMIT must not be negative",
            ));
        }
        let cutoff = match &q.pending_cutoff {
            None => None,
            Some(text) => Some(parse_iso(text).ok_or_else(|| {
                StoreError::new(
                    INVALID_ARGUMENT,
                    format!(
                        "{OP}: invalid input syntax for type timestamp with time zone: \"{text}\" (the rust engine reads ISO 8601 UTC strings ending in Z)"
                    ),
                )
            })?),
        };
        let read = self.read()?;
        let mut pages: BTreeMap<u64, Option<PageRecord>> = BTreeMap::new();
        let mut live_page = |id: u64| -> Result<Option<PageRecord>> {
            if let Some(p) = pages.get(&id) {
                return Ok(p.clone());
            }
            let p = read_page_by_id(&*read, id)?.filter(|p| p.deleted_at_us.is_none());
            pages.insert(id, p.clone());
            Ok(p)
        };
        let mut live = Vec::new();
        for r in all_relationships(&*read)? {
            if r.scope != "all"
                || r.semantics != "state"
                || !multirange_contains(&r.valid_ranges, &q.today)
            {
                continue;
            }
            let (Some(f), Some(t)) = (live_page(r.from_page_id)?, live_page(r.to_page_id)?) else {
                continue;
            };
            if r.link_type == "works_at"
                && !(q.person_filter.admits(&f)
                    && !q.person_filter.admits(&t)
                    && !non_employer(q, &t))
            {
                continue;
            }
            live.push((r, f, t));
        }
        type Group = (String, u64, String);
        let mut groups: BTreeMap<Group, (BTreeSet<u64>, i64)> = BTreeMap::new();
        for (r, _, _) in &live {
            let g = groups
                .entry((r.source_id.clone(), r.from_page_id, r.link_type.clone()))
                .or_insert_with(|| (BTreeSet::new(), i64::MIN));
            g.0.insert(r.to_page_id);
            g.1 = g.1.max(r.refreshed_at_us);
        }
        let mut multi: Vec<(Group, i64)> = groups
            .into_iter()
            .filter(|(_, (targets, _))| targets.len() >= 2)
            .map(|(g, (_, newest))| (g, newest))
            .collect();
        multi.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then_with(|| (a.0.1, &a.0.2).cmp(&(b.0.1, &b.0.2)))
        });
        let limit = usize::try_from(q.max_subjects as u64).unwrap_or(usize::MAX);
        let chosen: BTreeSet<Group> = multi.into_iter().take(limit).map(|(g, _)| g).collect();
        let mut rows = Vec::new();
        for (r, f, t) in live {
            if !chosen.contains(&(r.source_id.clone(), r.from_page_id, r.link_type.clone())) {
                continue;
            }
            if let Some(cutoff) = cutoff {
                let extracted = crate::extraction::links_extracted_at_us(&*read, f.id)?;
                if !extracted.is_some_and(|at| at >= cutoff) {
                    continue;
                }
            }
            rows.push((r, f, t));
        }
        rows.sort_by(|(ra, _, ta), (rb, _, tb)| {
            ra.from_page_id
                .cmp(&rb.from_page_id)
                .then_with(|| ra.link_type.cmp(&rb.link_type))
                .then_with(|| match (&ra.last_start, &rb.last_start) {
                    (None, None) => std::cmp::Ordering::Equal,
                    (None, Some(_)) => std::cmp::Ordering::Less,
                    (Some(_), None) => std::cmp::Ordering::Greater,
                    (Some(a), Some(b)) => a.cmp(b),
                })
                .then_with(|| ta.slug.cmp(&tb.slug))
        });
        Ok(rows
            .into_iter()
            .map(|(r, f, t)| {
                json!({
                    "source_id": r.source_id,
                    "from_page_id": r.from_page_id,
                    "to_page_id": r.to_page_id,
                    "link_type": r.link_type,
                    "valid_ranges": r.valid_ranges,
                    "last_start": r.last_start,
                    "recorded_at": iso(r.recorded_at_us),
                    "evidence_hash": r.evidence_hash,
                    "subject_slug": f.slug,
                    "subject_title": f.title,
                    "target_slug": t.slug,
                    "target_title": t.title,
                })
            })
            .collect())
    }

    /// `listKnownEdgeProposals(fromPageId, linkType, evidenceHashes)`: the subject's proposals of
    /// this link type whose evidence hash is listed, `recent` when touched in the last 24 hours.
    /// The SQL names no order; the store answers them in id order.
    pub fn list_known_edge_proposals(
        &self,
        from_page_id: f64,
        link_type: &str,
        evidence_hashes: &[String],
    ) -> Result<Vec<Value>> {
        let Some(from) = id_arg(from_page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let now = self.env.now_micros();
        let mut ids = Vec::new();
        for (_, id) in decode_under::<u64>(&*read, &subject_prefix(from), &mut |_| true)? {
            ids.push(id);
        }
        ids.sort_unstable();
        let mut out = Vec::new();
        for id in ids {
            let Some(r) = get_json::<ProposalRecord>(&*read, &proposal_key(id))? else {
                continue;
            };
            if r.link_type != link_type || !evidence_hashes.contains(&r.evidence_hash) {
                continue;
            }
            out.push(json!({
                "a": r.a_to_page_id,
                "b": r.b_to_page_id,
                "status": r.status,
                "detail": r.detail,
                "recent": r.updated_at_us > now - DAY_US,
            }));
        }
        Ok(out)
    }

    /// `recordEdgeProposal(proposal)`: inserts the proposal, or replaces the row of the same
    /// evidence while that row is an error row. Answers the row id, `None` when the existing row
    /// stood.
    pub fn record_edge_proposal(&self, p: &EdgeProposalInput) -> Result<Option<u64>> {
        const OP: &str = "recordEdgeProposal";
        no_nul(
            OP,
            &[
                ("source_id", &p.source_id),
                ("link_type", &p.link_type),
                ("evidence_hash", &p.evidence_hash),
                ("status", &p.status),
                ("model", p.model.as_deref().unwrap_or("")),
                ("generated_line", p.generated_line.as_deref().unwrap_or("")),
                ("detail", p.detail.as_deref().unwrap_or("")),
            ],
        )?;
        let from = page_id(OP, "from_page_id", p.from_page_id)?;
        let a = page_id(OP, "a_to_page_id", p.a_to_page_id)?;
        let b = page_id(OP, "b_to_page_id", p.b_to_page_id)?;
        let ending = p
            .ending_to_page_id
            .map(|e| page_id(OP, "ending_to_page_id", e))
            .transpose()?;
        if let Some(date) = &p.close_date
            && !is_date(date)
        {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                format!("{OP}: invalid input syntax for type date: \"{date}\""),
            ));
        }
        let confidence = match p.confidence {
            Some(c) if !c.is_finite() => {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    format!("{OP}: confidence must be a finite number"),
                ));
            }
            other => other.map(|c| c as f32),
        };
        check_status(&p.status)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let id = next_id(tx, PROPOSAL_ID)?;
            let index = evidence_key(from, a, b, &p.link_type, &p.evidence_hash);
            if let Some(existing) = get_json::<u64>(&*tx, &index)? {
                let Some(mut row) = get_json::<ProposalRecord>(&*tx, &proposal_key(existing))?
                else {
                    return Err(StoreError::new(
                        CONSTRAINT_VIOLATION,
                        format!("{OP}: the evidence index names a missing proposal"),
                    ));
                };
                if row.status != "error" {
                    return Ok(None);
                }
                if let Some(e) = ending {
                    check_page(&*tx, "ending_to_page_id", e)?;
                }
                row.status = p.status.clone();
                row.ending_to_page_id = ending;
                row.close_date = p.close_date.clone();
                row.born_closed = p.born_closed;
                row.model = p.model.clone();
                row.confidence = confidence;
                row.generated_line = p.generated_line.clone();
                row.detail = p.detail.clone();
                row.updated_at_us = now;
                put_json(tx, &proposal_key(existing), &row)?;
                return Ok(Some(existing));
            }
            check_page(&*tx, "from_page_id", from)?;
            check_page(&*tx, "a_to_page_id", a)?;
            check_page(&*tx, "b_to_page_id", b)?;
            if let Some(e) = ending {
                check_page(&*tx, "ending_to_page_id", e)?;
            }
            let row = ProposalRecord {
                id,
                source_id: p.source_id.clone(),
                from_page_id: from,
                a_to_page_id: a,
                b_to_page_id: b,
                link_type: p.link_type.clone(),
                evidence_hash: p.evidence_hash.clone(),
                status: p.status.clone(),
                ending_to_page_id: ending,
                close_date: p.close_date.clone(),
                born_closed: p.born_closed,
                model: p.model.clone(),
                confidence,
                generated_line: p.generated_line.clone(),
                detail: p.detail.clone(),
                created_at_us: now,
                updated_at_us: now,
            };
            put_json(tx, &proposal_key(id), &row)?;
            put_json(tx, &index, &id)?;
            Ok(Some(id))
        })
    }

    /// `readEdgeProposal(id)`: the proposal with its subject slug and its ending page's slug
    /// (`null` when it has no ending), `None` when there is no such proposal.
    pub fn read_edge_proposal(&self, id: f64) -> Result<Option<Value>> {
        let read = self.read()?;
        let Some(r) = read_proposal(&*read, id)? else {
            return Ok(None);
        };
        let Some(subject) = read_page_by_id(&*read, r.from_page_id)? else {
            return Ok(None);
        };
        let ending_slug = match r.ending_to_page_id {
            Some(e) => read_page_by_id(&*read, e)?.map(|p| p.slug),
            None => None,
        };
        Ok(Some(json!({
            "id": r.id,
            "source_id": r.source_id,
            "status": r.status,
            "from_page_id": r.from_page_id,
            "ending_to_page_id": r.ending_to_page_id,
            "link_type": r.link_type,
            "close_date": r.close_date,
            "generated_line": r.generated_line,
            "subject_slug": subject.slug,
            "ending_slug": ending_slug,
        })))
    }

    /// `edgeClosureLanded(fromPageId, endingToPageId, linkType, closeDate)`: whether a dream
    /// transition the subject owns ends this relationship on `closeDate`.
    pub fn edge_closure_landed(
        &self,
        from_page_id: f64,
        ending_to_page_id: Option<f64>,
        link_type: &str,
        close_date: Option<&str>,
    ) -> Result<bool> {
        let Some(from) = id_arg(from_page_id) else {
            return Ok(false);
        };
        let ending = match ending_to_page_id {
            Some(e) => match id_arg(e) {
                Some(e) => Some(e),
                None => return Ok(false),
            },
            None => None,
        };
        if let Some(date) = close_date
            && !is_date(date)
        {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                format!("edgeClosureLanded: invalid input syntax for type date: \"{date}\""),
            ));
        }
        closure_exists(&*self.read()?, from, ending, link_type, close_date)
    }

    /// `readEdgeProposalEvidence(id)`: the evidence hashes the proposal's two `all`-scope
    /// relationships carry now, `None` when the proposal or either relationship is gone.
    pub fn read_edge_proposal_evidence(&self, id: f64) -> Result<Option<Value>> {
        let read = self.read()?;
        let Some(r) = read_proposal(&*read, id)? else {
            return Ok(None);
        };
        let key = |to: u64| RelationshipKey {
            from_page_id: r.from_page_id,
            to_page_id: to,
            link_type: r.link_type.clone(),
        };
        let (Some(a), Some(b)) = (
            relationship(&*read, &key(r.a_to_page_id), "all")?,
            relationship(&*read, &key(r.b_to_page_id), "all")?,
        ) else {
            return Ok(None);
        };
        Ok(Some(json!({ "a": a.evidence_hash, "b": b.evidence_hash })))
    }

    /// `readEdgeProposalHash(id)`: `{ evidence_hash }` the proposal was judged on.
    pub fn read_edge_proposal_hash(&self, id: f64) -> Result<Option<Value>> {
        Ok(read_proposal(&*self.read()?, id)?.map(|r| json!({ "evidence_hash": r.evidence_hash })))
    }

    /// Sets the status of the proposal when `admit` takes its current status. True when a row
    /// changed.
    fn move_proposal(&self, id: f64, status: &str, admit: &[&str]) -> Result<bool> {
        let Some(id) = id_arg(id) else {
            return Ok(false);
        };
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut r) = get_json::<ProposalRecord>(&*tx, &proposal_key(id))? else {
                return Ok(false);
            };
            if !admit.is_empty() && !admit.contains(&r.status.as_str()) {
                return Ok(false);
            }
            check_status(status)?;
            r.status = status.to_string();
            r.updated_at_us = now;
            put_json(tx, &proposal_key(id), &r)?;
            Ok(true)
        })
    }

    /// `markEdgeProposalStale(id)`.
    pub fn mark_edge_proposal_stale(&self, id: f64) -> Result<()> {
        self.move_proposal(id, "stale", &[]).map(|_| ())
    }

    /// `setEdgeProposalStatus(id, status)`: a status outside the table's list is refused.
    pub fn set_edge_proposal_status(&self, id: f64, status: &str) -> Result<()> {
        no_nul("setEdgeProposalStatus", &[("status", status)])?;
        self.move_proposal(id, status, &[]).map(|_| ())
    }

    /// `rejectOpenEdgeProposal(id)`: rejects a proposal that is still open; true when it was.
    pub fn reject_open_edge_proposal(&self, id: f64) -> Result<bool> {
        self.move_proposal(id, "rejected", &OPEN)
    }

    /// `markEdgeProposalUndone(id)`.
    pub fn mark_edge_proposal_undone(&self, id: f64) -> Result<()> {
        self.move_proposal(id, "undone", &[]).map(|_| ())
    }

    /// `markRevertedEdgeProposals()`: applied proposals last touched before now whose closure
    /// transition is gone become `reverted_by_user`. Answers how many.
    pub fn mark_reverted_edge_proposals(&self) -> Result<u64> {
        let now = self.env.now_micros();
        self.write(|tx| {
            let mut count = 0;
            for mut r in all_proposals(&*tx)? {
                if r.status != "applied" || r.updated_at_us >= now {
                    continue;
                }
                if closure_exists(
                    &*tx,
                    r.from_page_id,
                    r.ending_to_page_id,
                    &r.link_type,
                    r.close_date.as_deref(),
                )? {
                    continue;
                }
                r.status = "reverted_by_user".to_string();
                r.updated_at_us = now;
                put_json(tx, &proposal_key(r.id), &r)?;
                count += 1;
            }
            Ok(count)
        })
    }
}
