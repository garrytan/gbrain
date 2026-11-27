//! The take proposal queue: the `take_proposals` table of the PGLite engine. The propose_takes cycle
//! step fills it (`src/core/cycle/propose-takes.ts`, its failure ledger in
//! `propose-takes-failures.ts`) and `gbrain takes propose` lists, accepts and rejects it
//! (`src/core/take-proposals.ts`). SQL in `src/core/engine-sql/take-proposals.ts`.
//!
//! Members: listPendingTakeProposals, readTakeProposal, claimTakeProposal,
//! readStrandedTakeProposalClaim, releaseTakeProposalClaim, setTakeProposalPromotedRow,
//! rejectTakeProposal, takeProposalCached, listRejectedTakeProposalClaims, insertTakeProposal,
//! listTakeProposalTombstones, deleteTakeProposalTombstones, listProposeTakesCandidatePages.
//! (readOpCheckpointDoc and writeOpCheckpointDoc are in `persistence/op_checkpoint.rs`,
//! listWriteRequestsByRequestId in `persistence.rs`.)
//!
//! Keys:
//! - `A 0x08 <id u64 BE>` -> `ProposalRecord` (JSON). Id counter: `M next_take_proposal_id`, taken
//!   before the row's checks as the `BIGSERIAL` default is.
//! - `A 0x09 <source> 0x00 <slug> 0x00 <content hash> 0x00 <prompt> 0x00 <sha256 of the claim>` ->
//!   the id (u64 BE): the unique `take_proposals_idempotency_idx` (Postgres folds the claim in with
//!   `md5`). Its prefix up to the prompt is the propose_takes cache key of a page. A NUL byte in any
//!   of these texts is refused (Postgres text cannot hold one either).
//!
//! `weight` is a `REAL`: kept as `f32` and read back as the shortest decimal that names it.
//! `proposed_at` and `acted_at` are kept in microseconds and cross as ISO 8601; a tombstone list
//! reads `proposed_at::text` (Postgres's text form, in UTC). A deleted source deletes its rows
//! (`ON DELETE CASCADE`, [`remove_source_rows`]); deleting a proposal deletes its nudges
//! (`take_nudge_log_proposal_id_fkey ... ON DELETE CASCADE`).

use super::grades::{real, to_real};
use super::*;
use crate::cli_reads::pg_text::fm_text;
use crate::error::INVALID_ARGUMENT;
use crate::extraction::guest_sources;
use crate::pages::all_pages;
use crate::sources::read_source;
use crate::telemetry::{parse_timestamp, pg_timestamptz_text};
use sha2::{Digest, Sha256};

const PROPOSAL: u8 = 0x08;
const IDEMPOTENCY: u8 = 0x09;
const TABLE: &str = "take_proposals";
const NEXT_PROPOSAL_ID: &str = "next_take_proposal_id";
const DEFAULT_WAVE: &str = "v0.36.1.0";

/// `listPendingTakeProposals` input: one source or every source; `limit` is clamped to 1..500.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeProposalListSpec {
    #[serde(default)]
    pub source_id: Option<String>,
    pub limit: f64,
}

/// The propose_takes cache key of a page.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeProposalPageKey {
    pub source_id: String,
    pub page_slug: String,
    pub content_hash: String,
    pub prompt_version: String,
}

/// `insertTakeProposal` row: a pending claim, or a `rejected` tombstone.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeProposalInput {
    pub source_id: String,
    pub page_slug: String,
    pub content_hash: String,
    pub prompt_version: String,
    pub proposal_run_id: String,
    pub claim_text: String,
    pub kind: String,
    pub holder: String,
    pub weight: f64,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub dedup_against: Value,
    pub model_id: String,
    #[serde(default)]
    pub status: Option<String>,
}

/// `listProposeTakesCandidatePages` scope: `sourceIds` (when not empty) beats `sourceId`; `types`
/// null is every type, and an empty list matches no type (`type = ANY('{}')`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposeTakesCandidateScope {
    #[serde(default)]
    pub source_ids: Option<Vec<String>>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub types: Option<Vec<String>>,
    pub limit: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProposalRecord {
    id: u64,
    source_id: String,
    page_slug: String,
    content_hash: String,
    prompt_version: String,
    wave_version: String,
    proposed_at_us: i64,
    proposal_run_id: String,
    status: String,
    claim_text: String,
    kind: String,
    holder: String,
    weight: f32,
    domain: Option<String>,
    dedup_against_fence_rows: Value,
    model_id: String,
    acted_at_us: Option<i64>,
    acted_by: Option<String>,
    promoted_row_num: Option<i32>,
}

impl ProposalRecord {
    /// The queue row (`PROPOSAL_COLUMNS` of the SQL).
    fn to_row(&self) -> Value {
        json!({
            "id": self.id,
            "source_id": self.source_id,
            "page_slug": self.page_slug,
            "claim_text": self.claim_text,
            "kind": self.kind,
            "holder": self.holder,
            "weight": real(self.weight),
            "domain": self.domain,
            "status": self.status,
            "proposed_at": iso(self.proposed_at_us),
            "model_id": self.model_id,
            "promoted_row_num": self.promoted_row_num,
        })
    }

    fn claim(&self) -> Value {
        json!({ "id": self.id, "acted_at": self.acted_at_us.map(iso) })
    }

    /// A failure tombstone of `prefix`: rejected, never acted on, its claim starting with it.
    fn is_tombstone(&self, prefix: &str) -> bool {
        self.status == "rejected"
            && self.acted_at_us.is_none()
            && self.claim_text.starts_with(prefix)
    }
}

fn proposal_key(id: u64) -> Vec<u8> {
    let mut key = vec![keys::TAKE, PROPOSAL];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

/// `A 0x09 <source> 0 <slug> 0 <hash> 0 <prompt> 0`: the prefix of one page key's claims.
fn page_key_prefix(
    op: &str,
    source: &str,
    slug: &str,
    hash: &str,
    prompt: &str,
) -> Result<Vec<u8>> {
    no_nul(
        op,
        &[
            ("source_id", source),
            ("page_slug", slug),
            ("content_hash", hash),
            ("prompt_version", prompt),
        ],
    )?;
    let mut key = vec![keys::TAKE, IDEMPOTENCY];
    for part in [source, slug, hash, prompt] {
        key.extend_from_slice(part.as_bytes());
        key.push(0);
    }
    Ok(key)
}

fn idempotency_key(prefix: &[u8], claim: &str) -> Vec<u8> {
    let mut key = prefix.to_vec();
    key.extend_from_slice(&Sha256::digest(claim.as_bytes()));
    key
}

fn read_proposal(read: &dyn KvRead, id: i64) -> Result<Option<ProposalRecord>> {
    let Ok(id) = u64::try_from(id) else {
        return Ok(None);
    };
    get_json(read, &proposal_key(id))
}

fn all_proposals(read: &dyn KvRead) -> Result<Vec<ProposalRecord>> {
    let mut raw = Vec::new();
    scan_prefix(read, &[keys::TAKE, PROPOSAL], false, &mut |_, v| {
        raw.push(v.to_vec());
        true
    })?;
    raw.iter()
        .map(|v| serde_json::from_slice(v).map_err(StoreError::from))
        .collect()
}

/// Calls `f` with the source and claim text of each take proposal, in id order, until it returns false: the scan stops there, so
/// a bounded count leaves the later rows unread.
pub(crate) fn for_each_claim(
    read: &dyn KvRead,
    f: &mut dyn FnMut(&str, &str) -> bool,
) -> Result<()> {
    let mut failure = None;
    scan_prefix(
        read,
        &[keys::TAKE, PROPOSAL],
        false,
        &mut |_, v| match serde_json::from_slice::<ProposalRecord>(v) {
            Ok(r) => f(&r.source_id, &r.claim_text),
            Err(e) => {
                failure = Some(StoreError::from(e));
                false
            }
        },
    )?;
    failure.map_or(Ok(()), Err)
}

/// Deletes a proposal with its idempotency entry and its nudges.
fn delete_proposal(tx: &mut dyn KvWrite, r: &ProposalRecord) -> Result<()> {
    let prefix = page_key_prefix(
        "deleteTakeProposal",
        &r.source_id,
        &r.page_slug,
        &r.content_hash,
        &r.prompt_version,
    )?;
    tx.delete(&idempotency_key(&prefix, &r.claim_text))?;
    tx.delete(&proposal_key(r.id))?;
    nudges::remove_proposal_rows(tx, r.id as i64)
}

/// Whether a proposal with this id exists: the `take_nudge_log_proposal_id_fkey` check.
pub(super) fn proposal_exists(read: &dyn KvRead, id: i64) -> Result<bool> {
    Ok(read_proposal(read, id)?.is_some())
}

/// A source delete's cascade (`take_proposals_source_id_fkey ... ON DELETE CASCADE`): deletes every
/// proposal of `source_id`, with its idempotency entry and its nudges.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    for record in all_proposals(&*tx)? {
        if record.source_id == source_id {
            delete_proposal(tx, &record)?;
        }
    }
    Ok(())
}

/// A page purge's scrub of the proposal queue (`deletePurgedSlugStoreRows` on `take_proposals`): deletes the proposals of
/// `source_id` filed under one of `slugs`, each with its idempotency entry and its nudges; how many.
pub(crate) fn remove_for_slugs(
    tx: &mut dyn KvWrite,
    source_id: &str,
    slugs: &std::collections::BTreeSet<&str>,
) -> Result<u64> {
    let mut removed = 0;
    for record in all_proposals(&*tx)? {
        if record.source_id == source_id && slugs.contains(record.page_slug.as_str()) {
            delete_proposal(tx, &record)?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// A fact purge's delete of the proposal queue (`deletePurgeTakeProposals`): deletes the proposals of `source_id` whose
/// `gbrain_fact_fingerprint(claim_text)` is `fact_hash`, each with its idempotency entry and its nudges; how many.
pub(crate) fn remove_for_fingerprint(
    tx: &mut dyn KvWrite,
    source_id: &str,
    fact_hash: &str,
) -> Result<u64> {
    let mut removed = 0;
    for record in all_proposals(&*tx)? {
        if record.source_id == source_id
            && crate::facts::fact_fingerprint(&record.claim_text) == fact_hash
        {
            delete_proposal(tx, &record)?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// A page purge receipt's probe of the proposal queue (`countPurgeStoreProbe` on `take_proposals`): how many proposals of
/// `source_id` are filed under `slug`.
pub(crate) fn count_for_slug(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<usize> {
    Ok(all_proposals(read)?
        .iter()
        .filter(|r| r.source_id == source_id && r.page_slug == slug)
        .count())
}

/// Updates a proposal when `pick` accepts it; the updated record, or `None`.
fn update_proposal(
    tx: &mut dyn KvWrite,
    id: i64,
    pick: impl Fn(&ProposalRecord) -> bool,
    change: impl Fn(&mut ProposalRecord),
) -> Result<Option<ProposalRecord>> {
    let Some(mut record) = read_proposal(&*tx, id)? else {
        return Ok(None);
    };
    if !pick(&record) {
        return Ok(None);
    }
    change(&mut record);
    put_json(tx, &proposal_key(record.id), &record)?;
    Ok(Some(record))
}

/// `value LIKE 'lead%'` for a `lead` with no `%` or backslash: each `_` matches any one character.
fn like_prefix(value: &str, lead: &str) -> bool {
    let mut chars = value.chars();
    lead.chars()
        .all(|l| chars.next().is_some_and(|c| l == '_' || c == l))
}

impl Store {
    /// `listPendingTakeProposals({ sourceId?, limit })`: pending proposals, newest first
    /// (`proposed_at DESC, id DESC`); `limit` is truncated and clamped to 1..500.
    pub fn list_pending_take_proposals(&self, spec: &TakeProposalListSpec) -> Result<Vec<Value>> {
        let limit = spec.limit.trunc().clamp(1.0, 500.0) as usize;
        // An empty source id is no source scope, as the SQL's `if (opts.sourceId)`.
        let source = spec.source_id.as_deref().filter(|s| !s.is_empty());
        let mut rows: Vec<ProposalRecord> = all_proposals(&*self.read()?)?
            .into_iter()
            .filter(|r| r.status == "pending" && source.is_none_or(|s| r.source_id == s))
            .collect();
        rows.sort_by(|a, b| {
            b.proposed_at_us
                .cmp(&a.proposed_at_us)
                .then(b.id.cmp(&a.id))
        });
        Ok(rows
            .iter()
            .take(limit)
            .map(ProposalRecord::to_row)
            .collect())
    }

    /// `readTakeProposal(id, sourceId?)`: the proposal whatever its status, or `None`; with a source,
    /// a proposal of another source reads as `None`.
    pub fn read_take_proposal(&self, id: i64, source_id: Option<&str>) -> Result<Option<Value>> {
        let source = source_id.filter(|s| !s.is_empty());
        Ok(read_proposal(&*self.read()?, id)?
            .filter(|r| source.is_none_or(|s| r.source_id == s))
            .map(|r| r.to_row()))
    }

    /// `claimTakeProposal(id, actedBy)`: a pending proposal becomes `accepted`, acted now by
    /// `actedBy`; `{ id, acted_at }`, or `None` when it is not pending.
    pub fn claim_take_proposal(&self, id: i64, acted_by: &str) -> Result<Option<Value>> {
        no_nul("claimTakeProposal", &[("acted_by", acted_by)])?;
        let now = self.env.now_micros();
        self.write(|tx| {
            Ok(update_proposal(
                tx,
                id,
                |r| r.status == "pending",
                |r| {
                    r.status = "accepted".into();
                    r.acted_at_us = Some(now);
                    r.acted_by = Some(acted_by.to_string());
                },
            )?
            .map(|r| r.claim()))
        })
    }

    /// `readStrandedTakeProposalClaim(id)`: the claim of an accepted proposal with no take recorded.
    pub fn read_stranded_take_proposal_claim(&self, id: i64) -> Result<Option<Value>> {
        Ok(read_proposal(&*self.read()?, id)?
            .filter(|r| r.status == "accepted" && r.promoted_row_num.is_none())
            .map(|r| r.claim()))
    }

    /// `releaseTakeProposalClaim(id, claimedAt)`: back to pending while it is still that claim:
    /// accepted, no take recorded, and claimed at `claimedAt` to the millisecond (`date_trunc`); a
    /// null `claimedAt` matches a claim with no time.
    pub fn release_take_proposal_claim(&self, id: i64, claimed_at: Option<&str>) -> Result<()> {
        const OP: &str = "releaseTakeProposalClaim";
        let claimed = claimed_at.map(|t| parse_timestamp(OP, t)).transpose()?;
        // `date_trunc('milliseconds', acted_at) IS NOT DISTINCT FROM $2::timestamptz`.
        let truncated = |us: i64| us.div_euclid(1000) * 1000;
        self.write(|tx| {
            update_proposal(
                tx,
                id,
                |r| {
                    r.status == "accepted"
                        && r.promoted_row_num.is_none()
                        && r.acted_at_us.map(truncated) == claimed
                },
                |r| {
                    r.status = "pending".into();
                    r.acted_at_us = None;
                    r.acted_by = None;
                    r.promoted_row_num = None;
                },
            )?;
            Ok(())
        })
    }

    /// `setTakeProposalPromotedRow(id, rowNum)`: records the take row the proposal became.
    pub fn set_take_proposal_promoted_row(&self, id: i64, row_num: i64) -> Result<()> {
        let row_num = i32::try_from(row_num).map_err(|_| {
            StoreError::new(
                INVALID_ARGUMENT,
                "setTakeProposalPromotedRow: integer out of range",
            )
        })?;
        self.write(|tx| {
            update_proposal(tx, id, |_| true, |r| r.promoted_row_num = Some(row_num))?;
            Ok(())
        })
    }

    /// `rejectTakeProposal(id, actedBy)`: a pending proposal becomes `rejected`, acted now; false
    /// when it is not pending.
    pub fn reject_take_proposal(&self, id: i64, acted_by: &str) -> Result<bool> {
        no_nul("rejectTakeProposal", &[("acted_by", acted_by)])?;
        let now = self.env.now_micros();
        self.write(|tx| {
            Ok(update_proposal(
                tx,
                id,
                |r| r.status == "pending",
                |r| {
                    r.status = "rejected".into();
                    r.acted_at_us = Some(now);
                    r.acted_by = Some(acted_by.to_string());
                },
            )?
            .is_some())
        })
    }

    /// `takeProposalCached(key)`: whether any proposal, tombstone included, is under the page key.
    pub fn take_proposal_cached(&self, key: &TakeProposalPageKey) -> Result<bool> {
        let prefix = page_key_prefix(
            "takeProposalCached",
            &key.source_id,
            &key.page_slug,
            &key.content_hash,
            &key.prompt_version,
        )?;
        let mut found = false;
        scan_prefix(&*self.read()?, &prefix, false, &mut |_, _| {
            found = true;
            false
        })?;
        Ok(found)
    }

    /// `listRejectedTakeProposalClaims(sourceId, pageSlug)`: the claims an operator rejected on the
    /// page, at any content (acted on, so never a tombstone), in id order.
    pub fn list_rejected_take_proposal_claims(
        &self,
        source_id: &str,
        page_slug: &str,
    ) -> Result<Vec<String>> {
        Ok(all_proposals(&*self.read()?)?
            .into_iter()
            .filter(|r| {
                r.source_id == source_id
                    && r.page_slug == page_slug
                    && r.status == "rejected"
                    && r.acted_at_us.is_some()
            })
            .map(|r| r.claim_text)
            .collect())
    }

    /// `insertTakeProposal(p)`: stores the proposal unless its claim is already under its page key
    /// (`ON CONFLICT ... DO NOTHING`); the new id, or `None`.
    pub fn insert_take_proposal(&self, p: &TakeProposalInput) -> Result<Option<u64>> {
        const OP: &str = "insertTakeProposal";
        let prefix = page_key_prefix(
            OP,
            &p.source_id,
            &p.page_slug,
            &p.content_hash,
            &p.prompt_version,
        )?;
        let mut texts = vec![
            ("proposal_run_id", p.proposal_run_id.as_str()),
            ("claim_text", p.claim_text.as_str()),
            ("kind", p.kind.as_str()),
            ("holder", p.holder.as_str()),
            ("model_id", p.model_id.as_str()),
        ];
        if let Some(d) = &p.domain {
            texts.push(("domain", d));
        }
        if let Some(s) = &p.status {
            texts.push(("status", s));
        }
        no_nul(OP, &texts)?;
        let status = p.status.clone().unwrap_or_else(|| "pending".to_string());
        let weight = to_real(OP, p.weight)?;
        let key = idempotency_key(&prefix, &p.claim_text);
        let now = self.env.now_micros();
        self.write(|tx| {
            let id = next_id(tx, NEXT_PROPOSAL_ID)?;
            if !["pending", "accepted", "rejected", "superseded"].contains(&status.as_str()) {
                return Err(check_failed(TABLE, "take_proposals_status_check"));
            }
            if read_source(&*tx, &p.source_id)?.is_none() {
                return Err(fk_failed(TABLE, "take_proposals_source_id_fkey"));
            }
            if tx.get(&key)?.is_some() {
                return Ok(None);
            }
            let record = ProposalRecord {
                id,
                source_id: p.source_id.clone(),
                page_slug: p.page_slug.clone(),
                content_hash: p.content_hash.clone(),
                prompt_version: p.prompt_version.clone(),
                wave_version: DEFAULT_WAVE.to_string(),
                proposed_at_us: now,
                proposal_run_id: p.proposal_run_id.clone(),
                status: status.clone(),
                claim_text: p.claim_text.clone(),
                kind: p.kind.clone(),
                holder: p.holder.clone(),
                weight,
                domain: p.domain.clone(),
                dedup_against_fence_rows: p.dedup_against.clone(),
                model_id: p.model_id.clone(),
                acted_at_us: None,
                acted_by: None,
                promoted_row_num: None,
            };
            put_json(tx, &proposal_key(id), &record)?;
            tx.put(&key, &id.to_be_bytes())?;
            Ok(Some(id))
        })
    }

    /// `listTakeProposalTombstones(sourceId, prefix)`: the source's failure tombstones, by page slug
    /// then id; `proposed_at` is Postgres text.
    pub fn list_take_proposal_tombstones(
        &self,
        source_id: &str,
        prefix: &str,
    ) -> Result<Vec<Value>> {
        let mut rows: Vec<ProposalRecord> = all_proposals(&*self.read()?)?
            .into_iter()
            .filter(|r| r.source_id == source_id && r.is_tombstone(prefix))
            .collect();
        rows.sort_by(|a, b| {
            a.page_slug
                .as_bytes()
                .cmp(b.page_slug.as_bytes())
                .then(a.id.cmp(&b.id))
        });
        Ok(rows
            .into_iter()
            .map(|r| {
                json!({
                    "id": r.id,
                    "slug": r.page_slug,
                    "claim_text": r.claim_text,
                    "prompt_version": r.prompt_version,
                    "proposed_at": pg_timestamptz_text(r.proposed_at_us),
                })
            })
            .collect())
    }

    /// `deleteTakeProposalTombstones(sourceId, prefix, slug?)`: deletes the source's failure
    /// tombstones, of one page or every page, with their nudges; the pages released, sorted, each
    /// once.
    pub fn delete_take_proposal_tombstones(
        &self,
        source_id: &str,
        prefix: &str,
        slug: Option<&str>,
    ) -> Result<Vec<String>> {
        self.write(|tx| {
            let mut released = BTreeSet::new();
            for r in all_proposals(&*tx)? {
                if r.source_id == source_id
                    && r.is_tombstone(prefix)
                    && slug.is_none_or(|s| r.page_slug == s)
                {
                    delete_proposal(tx, &r)?;
                    released.insert(r.page_slug);
                }
            }
            Ok(released.into_iter().collect())
        })
    }

    /// `listProposeTakesCandidatePages(scope)`: `{ slug, source_id, compiled_truth }` of the live
    /// pages propose_takes reads: not an extract receipt or an atom, not written by the dream cycle,
    /// the atom extractor or the concept synthesizer, not in a guest source, in scope and of a listed
    /// type; newest first (`updated_at DESC, id DESC`), at most `limit`.
    pub fn list_propose_takes_candidate_pages(
        &self,
        scope: &ProposeTakesCandidateScope,
    ) -> Result<Vec<Value>> {
        const OP: &str = "listProposeTakesCandidatePages";
        if scope.limit < 0 {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                format!("{OP}: LIMIT must not be negative"),
            ));
        }
        let read = self.read()?;
        let sources: Option<Vec<&str>> = match (&scope.source_ids, &scope.source_id) {
            (Some(ids), _) if !ids.is_empty() => Some(ids.iter().map(String::as_str).collect()),
            (_, Some(id)) if !id.is_empty() => Some(vec![id.as_str()]),
            _ => None,
        };
        let not_like = |page: &PageRecord, key: &str, lead: &str| {
            !fm_text(&page.frontmatter, key).is_some_and(|v| like_prefix(&v, lead))
        };
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                p.deleted_at_us.is_none()
                    && p.page_type != "extract_receipt"
                    && p.page_type != "atom"
                    && fm_text(&p.frontmatter, "dream_generated").as_deref() != Some("true")
                    && not_like(p, "extracted_by", "extract_atoms")
                    && not_like(p, "synthesized_by", "synthesize_concepts")
                    && sources
                        .as_ref()
                        .is_none_or(|s| s.contains(&p.source_id.as_str()))
                    && scope
                        .types
                        .as_ref()
                        .is_none_or(|t| t.contains(&p.page_type))
            })
            .collect();
        let guests = guest_sources(&*read, &pages)?;
        pages.retain(|p| !guests.contains(&p.source_id));
        pages.sort_by(|a, b| b.updated_at_us.cmp(&a.updated_at_us).then(b.id.cmp(&a.id)));
        Ok(pages
            .into_iter()
            .take(usize::try_from(scope.limit).unwrap_or(usize::MAX))
            .map(|p| {
                json!({
                    "slug": p.slug,
                    "source_id": p.source_id,
                    "compiled_truth": p.compiled_truth.as_deref(),
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::takes::TakeNudgeInput;
    use crate::test_support::store as open_store;

    const TOMB: &str = "__propose_takes_failed__";

    fn input(slug: &str, claim: &str, status: Option<&str>) -> TakeProposalInput {
        TakeProposalInput {
            source_id: "default".into(),
            page_slug: slug.into(),
            content_hash: "h1".into(),
            prompt_version: "p1".into(),
            proposal_run_id: "run".into(),
            claim_text: claim.into(),
            kind: "take".into(),
            holder: "world".into(),
            weight: 0.35,
            domain: None,
            dedup_against: json!([]),
            model_id: "m".into(),
            status: status.map(str::to_string),
        }
    }

    fn key(slug: &str) -> TakeProposalPageKey {
        TakeProposalPageKey {
            source_id: "default".into(),
            page_slug: slug.into(),
            content_hash: "h1".into(),
            prompt_version: "p1".into(),
        }
    }

    fn nudge_at(proposal: i64) -> TakeNudgeInput {
        TakeNudgeInput {
            source_id: "default".into(),
            take_id: None,
            proposal_id: Some(proposal),
            nudge_pattern: "p".into(),
            channel: None,
            wave_version: None,
            fired_at: None,
        }
    }

    fn page(store: &Store, slug: &str, kind: &str, frontmatter: Value) {
        let input: PageInput = serde_json::from_value(
            json!({"type": kind, "title": slug, "compiled_truth": "body", "frontmatter": frontmatter}),
        )
        .unwrap();
        let options: PutPageOptions =
            serde_json::from_value(json!({"sourceId": "default"})).unwrap();
        store.put_page(slug, &input, &options).unwrap();
    }

    #[test]
    fn a_fact_purge_deletes_the_proposals_whose_claim_has_the_fingerprint_with_their_nudges() {
        let store = open_store();
        let hash = crate::facts::fact_fingerprint("The harbor will reopen");
        let a = store
            .insert_take_proposal(&input("a", "The harbor will reopen", None))
            .unwrap()
            .unwrap();
        store
            .insert_take_proposal(&input("b", "The  HARBOR will reopen ", None))
            .unwrap()
            .unwrap();
        let kept = store
            .insert_take_proposal(&input("b", "Something else", None))
            .unwrap()
            .unwrap();
        store.insert_take_nudge(&nudge_at(a as i64)).unwrap();
        assert_eq!(
            store.delete_purge_take_proposals("default", &hash).unwrap(),
            2
        );
        assert_eq!(
            store.delete_purge_take_proposals("default", &hash).unwrap(),
            0
        );
        assert_eq!(
            store.delete_purge_take_proposals("other", &hash).unwrap(),
            0
        );
        let read = store.read().unwrap();
        let left: Vec<u64> = all_proposals(&*read)
            .unwrap()
            .iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(left, vec![kept]);
        assert!(!proposal_exists(&*read, a as i64).unwrap());
        drop(read);
        // The idempotency entry went with the proposal: the same claim on the same page key is stored again.
        assert!(
            store
                .insert_take_proposal(&input("a", "The harbor will reopen", None))
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .delete_purge_take_proposals("default\0", &hash)
                .is_err()
        );
    }

    #[test]
    fn a_claim_is_stored_once_under_its_page_key_and_the_key_is_the_cache() {
        let store = open_store();
        assert!(!store.take_proposal_cached(&key("a")).unwrap());
        let id = store
            .insert_take_proposal(&input("a", "x", None))
            .unwrap()
            .unwrap();
        assert_eq!(
            store.insert_take_proposal(&input("a", "x", None)).unwrap(),
            None
        );
        assert!(store.take_proposal_cached(&key("a")).unwrap());
        let row = store.read_take_proposal(id as i64, None).unwrap().unwrap();
        assert_eq!(row["weight"], json!(0.35));
        assert_eq!(row["status"], json!("pending"));
        assert_eq!(row.as_object().unwrap().len(), 12);
        assert_eq!(
            store.read_take_proposal(id as i64, Some("other")).unwrap(),
            None
        );
        assert_eq!(store.read_take_proposal(-1, None).unwrap(), None);
        let bad = store
            .insert_take_proposal(&input("a", "y", Some("maybe")))
            .unwrap_err();
        assert!(bad.message.contains("take_proposals_status_check"));
        let mut other = input("a", "z", None);
        other.source_id = "nope".into();
        let fk = store.insert_take_proposal(&other).unwrap_err();
        assert!(fk.message.contains("take_proposals_source_id_fkey"));
        let spec = TakeProposalListSpec {
            source_id: None,
            limit: 0.0,
        };
        assert_eq!(store.list_pending_take_proposals(&spec).unwrap().len(), 1);
    }

    #[test]
    fn a_claim_is_taken_once_released_only_while_it_is_the_same_claim_and_promoted() {
        let store = open_store();
        let id = store
            .insert_take_proposal(&input("a", "x", None))
            .unwrap()
            .unwrap() as i64;
        let claim = store.claim_take_proposal(id, "cli").unwrap().unwrap();
        assert_eq!(store.claim_take_proposal(id, "cli").unwrap(), None);
        assert_eq!(
            store.read_stranded_take_proposal_claim(id).unwrap(),
            Some(claim.clone())
        );
        store
            .release_take_proposal_claim(id, Some("2001-01-01T00:00:00.000Z"))
            .unwrap();
        assert!(
            store
                .read_stranded_take_proposal_claim(id)
                .unwrap()
                .is_some()
        );
        // The caller sends the claim back as a JS Date's ISO text: milliseconds, as the SQL's
        // `date_trunc('milliseconds', acted_at)` compares it.
        let at = claim["acted_at"].as_str().unwrap();
        let at = format!("{}Z", &at[..23]);
        store.release_take_proposal_claim(id, Some(&at)).unwrap();
        let row = store.read_take_proposal(id, None).unwrap().unwrap();
        assert_eq!(row["status"], json!("pending"));
        store.claim_take_proposal(id, "cli").unwrap().unwrap();
        store.set_take_proposal_promoted_row(id, 3).unwrap();
        assert_eq!(store.read_stranded_take_proposal_claim(id).unwrap(), None);
        let row = store.read_take_proposal(id, None).unwrap().unwrap();
        assert_eq!(row["promoted_row_num"], json!(3));
        let range = store
            .set_take_proposal_promoted_row(id, i64::from(i32::MAX) + 1)
            .unwrap_err();
        assert_eq!(range.code, INVALID_ARGUMENT);
        assert!(!store.reject_take_proposal(id, "cli").unwrap());
        let other = store
            .insert_take_proposal(&input("a", "y", None))
            .unwrap()
            .unwrap() as i64;
        assert!(store.reject_take_proposal(other, "cli").unwrap());
        assert_eq!(
            store
                .list_rejected_take_proposal_claims("default", "a")
                .unwrap(),
            vec!["y".to_string()]
        );
    }

    #[test]
    fn tombstones_list_and_release_with_their_nudges_and_a_source_delete_takes_every_row() {
        let store = open_store();
        let fail = format!("{TOMB} boom");
        let b = store
            .insert_take_proposal(&input("b", &fail, Some("rejected")))
            .unwrap()
            .unwrap() as i64;
        store
            .insert_take_proposal(&input("a", &fail, Some("rejected")))
            .unwrap()
            .unwrap();
        let live = store
            .insert_take_proposal(&input("a", "x", None))
            .unwrap()
            .unwrap() as i64;
        let listed = store
            .list_take_proposal_tombstones("default", TOMB)
            .unwrap();
        let slugs: Vec<&str> = listed.iter().map(|r| r["slug"].as_str().unwrap()).collect();
        assert_eq!(slugs, ["a", "b"]);
        assert!(listed[0]["proposed_at"].as_str().unwrap().ends_with("+00"));
        store.insert_take_nudge(&nudge_at(b)).unwrap();
        assert_eq!(
            store
                .delete_take_proposal_tombstones("default", TOMB, Some("b"))
                .unwrap(),
            ["b"]
        );
        assert!(!proposal_exists(&*store.read().unwrap(), b).unwrap());
        let gone = store.insert_take_nudge(&nudge_at(b)).unwrap_err();
        assert!(gone.message.contains("take_nudge_log_proposal_id_fkey"));
        assert_eq!(
            store
                .delete_take_proposal_tombstones("default", TOMB, None)
                .unwrap(),
            ["a"]
        );
        store.insert_take_nudge(&nudge_at(live)).unwrap();
        store
            .write(|tx| crate::cascade::remove_source_rows(tx, "default"))
            .unwrap();
        let read = store.read().unwrap();
        assert!(all_proposals(&*read).unwrap().is_empty());
        let mut index = 0;
        scan_prefix(&*read, &[keys::TAKE, IDEMPOTENCY], false, &mut |_, _| {
            index += 1;
            true
        })
        .unwrap();
        assert_eq!(index, 0);
    }

    #[test]
    fn candidate_pages_skip_receipts_atoms_and_generated_pages_and_an_empty_type_list_matches_none()
    {
        let store = open_store();
        page(&store, "keep", "note", json!({}));
        page(&store, "receipt", "extract_receipt", json!({}));
        page(&store, "atom", "atom", json!({}));
        page(&store, "dream", "note", json!({"dream_generated": true}));
        page(
            &store,
            "atoms",
            "note",
            json!({"extracted_by": "extract_atoms:v2"}),
        );
        page(
            &store,
            "concept",
            "note",
            json!({"synthesized_by": "synthesize-concepts"}),
        );
        let scope = |types: Option<Vec<String>>, limit| ProposeTakesCandidateScope {
            source_ids: None,
            source_id: Some("default".into()),
            types,
            limit,
        };
        let rows = store
            .list_propose_takes_candidate_pages(&scope(None, 10))
            .unwrap();
        let slugs: Vec<&str> = rows.iter().map(|r| r["slug"].as_str().unwrap()).collect();
        assert_eq!(slugs, ["keep"]);
        assert!(
            store
                .list_propose_takes_candidate_pages(&scope(Some(vec![]), 10))
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .list_propose_takes_candidate_pages(&scope(None, -1))
                .is_err()
        );
    }
}
