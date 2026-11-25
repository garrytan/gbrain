//! The statements a forget's withdrawal commits and the `fact_withdrawn` refusal reads
//! (src/core/engine-sql/trust-withdrawals.ts), over the fact, page, withdrawal ledger and review
//! queue records the other families write:
//!
//! - `lockFactForWithdrawal`: the claim `recordFactWithdrawal` (src/core/facts/withdrawal.ts)
//!   locks before it writes the ledger row. One store call reads under the store's own lock, so
//!   `FOR UPDATE` changes nothing here.
//! - `queueWithdrawalReview`: the overnight semantic review row (`decide_review_queue`, kind
//!   `withdraw`, `b_ref` `*`), queued once.
//! - `listSegmentedPagesBySlug`, `bumpWithdrawnPageRevisions` and `readPageRevisions`: the pages
//!   a withdrawal changes, and their new knowledge revision with the projection revision and the
//!   embedding signature cleared, for an inline page.
//! - `appendFactForgetReason`: `forgotten: <reason>` appended to the fact's context with ` | `.
//! - `readFactWithdrawnRow` and `readFactWithdrawnBacking`: the ledger row a `fact_withdrawn`
//!   refusal names (src/core/facts/single-prepare.ts), and, under the remote provenance floor,
//!   whether the caller sees a row it withdrew.
//!
//! The TypeScript members (src/core/rust-engine/store-members/withdrawal-commit.ts) refuse a fact id
//! that is not an integer and a remote provenance floor the store does not model, as
//! `memory_mutation_reads` does.

use super::fingerprint::{fact_fingerprint, fact_fingerprint_v1};
use super::withdrawals::{at, check_visibility};
use crate::Store;
use crate::embeddings::signature_key;
use crate::env::iso;
use crate::error::Result;
use crate::eval_capture::decide_proposals::ReviewQueueOp;
use crate::facts::purge::unbacked;
use crate::facts::{FactRecord, source_rows, write_fact};
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::memory_mutation_reads::{RemoteFloor, WithdrawalClaimQuery, floor_hides, source_fact};
use crate::pages::{read_page, read_page_by_id, write_page};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `ownedMemorySubjectSql`: the subject names a member page or the scope page.
fn owned_memory_subject(subject: &str) -> bool {
    subject.starts_with("memory/members/") || subject == "memory/scope"
}

/// `withdrawalReachedFactSql(w, f)`: a withdrawal under `subject` reached `row` when it was made:
/// every subject, the row's entity, an unbacked name key (unless the subject is an owned memory
/// page), or the owned memory page the row sits on.
fn reached(read: &dyn KvRead, row: &FactRecord, subject: &str) -> Result<bool> {
    Ok(subject == "*"
        || row.entity_slug.as_deref() == Some(subject)
        || (unbacked(read, row)? && !owned_memory_subject(subject))
        || (row.on_owned_memory_page() && row.source_markdown_slug.as_deref() == Some(subject)))
}

/// `factWithdrawalSubjectSql`: the ledger subject of a withdrawal of `row`.
fn withdrawal_subject(read: &dyn KvRead, row: &FactRecord) -> Result<String> {
    Ok(if row.on_owned_memory_page() {
        row.source_markdown_slug.clone().unwrap_or_default()
    } else if unbacked(read, row)? {
        "*".to_string()
    } else {
        row.entity_slug.clone().unwrap_or_else(|| "*".to_string())
    })
}

/// `readFactWithdrawnRow` and `readFactWithdrawnBacking`'s spec: a claim a save met a withdrawal
/// of, its entity, the owned memory page it is checked on, and the remote provenance floor (as
/// [`RemoteFloor`]) under `excludePrivate`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WithdrawnClaimQuery {
    pub source_id: String,
    pub visibility: String,
    pub fact: String,
    pub entity_slug: Option<String>,
    pub owned_page: Option<String>,
    pub remote_floor: Option<RemoteFloor>,
}

impl WithdrawnClaimQuery {
    fn check(&self, op: &str) -> Result<()> {
        no_nul(
            op,
            &[
                ("sourceId", &self.source_id),
                ("visibility", &self.visibility),
                ("fact", &self.fact),
                ("entitySlug", self.entity_slug.as_deref().unwrap_or("")),
                ("ownedPage", self.owned_page.as_deref().unwrap_or("")),
            ],
        )
    }

    /// The ledger subjects the claim meets: `*`, its entity and its owned page, once each.
    fn subjects(&self) -> Vec<&str> {
        let mut out: Vec<&str> = Vec::new();
        for s in std::iter::once("*")
            .chain(self.entity_slug.as_deref())
            .chain(self.owned_page.as_deref())
        {
            if !out.contains(&s) {
                out.push(s);
            }
        }
        out
    }

    /// `seen(param)`: the caller sees `row` under the floor, or it sits on the owned page.
    fn seen(&self, read: &dyn KvRead, row: &FactRecord, floor: &RemoteFloor) -> Result<bool> {
        Ok(!floor_hides(read, row, floor)?
            || (self.owned_page.is_some() && row.source_markdown_slug == self.owned_page))
    }
}

/// The two fingerprints of `text` (`gbrain_fact_fingerprint`, `gbrain_fact_fingerprint_v1`), once each.
fn prints(text: &str) -> Vec<String> {
    let (a, b) = (fact_fingerprint(text), fact_fingerprint_v1(text));
    if a == b { vec![a] } else { vec![a, b] }
}

/// The expired facts of the claim's source and visibility whose claim has the fingerprint `hash`
/// (either form) and that a withdrawal under `subject` reached: the `LEFT JOIN facts f` rows.
fn reached_rows(
    read: &dyn KvRead,
    q: &WithdrawnClaimQuery,
    subject: &str,
    hash: &str,
) -> Result<Vec<FactRecord>> {
    let mut out = Vec::new();
    for f in source_rows(read, &q.source_id)? {
        if f.visibility != q.visibility
            || f.expired_at_us.is_none()
            || !prints(&f.fact).iter().any(|p| p == hash)
            || !reached(read, &f, subject)?
        {
            continue;
        }
        out.push(f);
    }
    Ok(out)
}

impl Store {
    /// `lockFactForWithdrawal(spec)`: fact `id` of `source_id`'s visibility, text and withdrawal
    /// subject when the withdrawal admits it (`worldOnly`: a world fact or a private one on
    /// `memberPage`; `remoteFloor`: the floor admits it). An extraction outcome marker answers too.
    pub fn lock_fact_for_withdrawal(&self, q: &WithdrawalClaimQuery) -> Result<Option<Value>> {
        self.assert_serialized_transactions("lockFactForWithdrawal")?;
        const OP: &str = "lockFactForWithdrawal";
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        if let Some(page) = &q.member_page {
            no_nul(OP, &[("memberPage", page)])?;
        }
        let read = self.read()?;
        let Some(row) = source_fact(&*read, q.id, &q.source_id)? else {
            return Ok(None);
        };
        let admitted = !q.world_only
            || row.visibility == "world"
            || (row.visibility == "private"
                && q.member_page.is_some()
                && row.source_markdown_slug == q.member_page);
        if !admitted {
            return Ok(None);
        }
        if let Some(floor) = &q.remote_floor
            && floor_hides(&*read, &row, floor)?
        {
            return Ok(None);
        }
        let subject = withdrawal_subject(&*read, &row)?;
        Ok(Some(json!({
            "visibility": row.visibility,
            "fact": row.fact,
            "subject": subject,
        })))
    }

    /// `queueWithdrawalReview(sourceId, factRef)`: the `withdraw` review row of the fact, subject
    /// `*`, queued unless it is already queued.
    pub fn queue_withdrawal_review(&self, source_id: &str, fact_ref: &str) -> Result<()> {
        self.apply_decide_review_queue(&ReviewQueueOp::Enqueue {
            kind: "withdraw".into(),
            source_id: source_id.into(),
            a_ref: fact_ref.into(),
            b_ref: "*".into(),
            evidence: None,
        })
        .map(|_| ())
    }

    /// `listSegmentedPagesBySlug(sourceId, slugs)`: `{ id, slug }` of each segmented page of the
    /// source among the slugs (deleted ones too), by id.
    pub fn list_segmented_pages_by_slug(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<Vec<Value>> {
        no_nul("listSegmentedPagesBySlug", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let mut out = Vec::new();
        for slug in slugs.iter().collect::<BTreeSet<_>>() {
            if let Some(page) = read_page(&*read, source_id, slug)?
                && page.compiled_truth.is_null()
                && page.timeline.is_null()
            {
                out.push((page.id, page.slug));
            }
        }
        out.sort();
        Ok(out
            .into_iter()
            .map(|(id, slug)| json!({ "id": id, "slug": slug }))
            .collect())
    }

    /// `bumpWithdrawnPageRevisions(sourceId, slugs)`: a new knowledge revision for each inline page
    /// of the source among the slugs (deleted ones too), its projection revision and embedding
    /// signature cleared; `{ id, slug, knowledge_revision }` of each, by id.
    pub fn bump_withdrawn_page_revisions(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<Vec<Value>> {
        no_nul("bumpWithdrawnPageRevisions", &[("sourceId", source_id)])?;
        let slugs: BTreeSet<&String> = slugs.iter().collect();
        let env = self.env.clone();
        self.write(|tx| {
            let mut out = Vec::new();
            for slug in &slugs {
                let Some(mut page) = read_page(&*tx, source_id, slug)? else {
                    continue;
                };
                if page.compiled_truth.is_null() && page.timeline.is_null() {
                    continue;
                }
                page.knowledge_revision = env.new_uuid();
                page.text_projection_revision = None;
                write_page(tx, &page)?;
                tx.delete(&signature_key(page.id))?;
                out.push((page.id, page.slug, page.knowledge_revision));
            }
            out.sort();
            Ok(out
                .into_iter()
                .map(|(id, slug, rev)| json!({ "id": id, "slug": slug, "knowledge_revision": rev }))
                .collect())
        })
    }

    /// `readPageRevisions(ids)`: `{ id, slug, knowledge_revision }` of each page among the ids, by id.
    pub fn read_page_revisions(&self, ids: &[i64]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let ids: BTreeSet<u64> = ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let mut out = Vec::new();
        for id in ids {
            if let Some(page) = read_page_by_id(&*read, id)? {
                out.push(json!({ "id": page.id, "slug": page.slug, "knowledge_revision": page.knowledge_revision }));
            }
        }
        Ok(out)
    }

    /// `appendFactForgetReason(id, sourceId, note)`: `concat_ws(' | ', NULLIF(context, ''), note)`
    /// into fact `id`'s context when it belongs to the source.
    pub fn append_fact_forget_reason(&self, id: i64, source_id: &str, note: &str) -> Result<()> {
        no_nul(
            "appendFactForgetReason",
            &[("sourceId", source_id), ("note", note)],
        )?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let Some(old) = source_fact(&*tx, id, source_id)? else {
                return Ok(());
            };
            let mut new = old.clone();
            new.context = Some(match old.context.as_deref() {
                None | Some("") => note.to_string(),
                Some(context) => format!("{context} | {note}"),
            });
            write_fact(tx, trust, Some(&old), &new)
        })
    }

    /// `readFactWithdrawnRow(spec)`: `{ subject, visibility, withdrawn_at }` (ISO text) of the
    /// withdrawal of the claim (either fingerprint; subject `*`, the entity or the owned page) a
    /// `fact_withdrawn` refusal names: the most specific subject first, then the newest. Under the
    /// floor only a withdrawal some row of which the caller sees, or that no row backs.
    pub fn read_fact_withdrawn_row(&self, q: &WithdrawnClaimQuery) -> Result<Option<Value>> {
        const OP: &str = "readFactWithdrawnRow";
        q.check(OP)?;
        check_visibility(OP, &q.visibility)?;
        let read = self.read()?;
        // GROUP BY (subject, visibility, withdrawn_at): rows of either fingerprint with one time share a group.
        let mut groups: Vec<(String, i64, bool, bool)> = Vec::new();
        for subject in q.subjects() {
            for hash in prints(&q.fact) {
                let Some(when) = at(&*read, &[&q.source_id, &q.visibility, subject, &hash])? else {
                    continue;
                };
                let (mut seen, mut backed) = (false, false);
                if let Some(floor) = &q.remote_floor {
                    for f in reached_rows(&*read, q, subject, &hash)? {
                        backed = true;
                        seen = seen || q.seen(&*read, &f, floor)?;
                    }
                }
                match groups.iter_mut().find(|g| g.0 == subject && g.1 == when) {
                    Some(g) => {
                        g.2 |= seen;
                        g.3 |= backed;
                    }
                    None => groups.push((subject.to_string(), when, seen, backed)),
                }
            }
        }
        groups.retain(|g| q.remote_floor.is_none() || g.2 || !g.3);
        groups.sort_by_key(|g| std::cmp::Reverse((g.0 != "*", g.1)));
        Ok(groups.into_iter().next().map(|(subject, when, ..)| {
            json!({ "subject": subject, "visibility": q.visibility, "withdrawn_at": iso(when) })
        }))
    }

    /// `readFactWithdrawnBacking(spec)`: whether, among the expired rows of the claim a withdrawal
    /// of subject `*`, the entity or the owned page reached, the caller sees one (`visible`) and
    /// fails to see one (`hidden`) under the remote provenance floor.
    pub fn read_fact_withdrawn_backing(&self, q: &WithdrawnClaimQuery) -> Result<Value> {
        const OP: &str = "readFactWithdrawnBacking";
        q.check(OP)?;
        let Some(floor) = &q.remote_floor else {
            return Err(crate::error::StoreError::invalid(format!(
                "{OP}: the remote provenance floor is required"
            )));
        };
        let read = self.read()?;
        let print = fact_fingerprint(&q.fact);
        let (mut visible, mut hidden) = (false, false);
        for f in source_rows(&*read, &q.source_id)? {
            if f.visibility != q.visibility
                || f.expired_at_us.is_none()
                || fact_fingerprint(&f.fact) != print
            {
                continue;
            }
            let mut joined = false;
            'w: for subject in q.subjects() {
                for hash in prints(&f.fact) {
                    if at(&*read, &[&q.source_id, &f.visibility, subject, &hash])?.is_some()
                        && reached(&*read, &f, subject)?
                    {
                        joined = true;
                        break 'w;
                    }
                }
            }
            if joined {
                if q.seen(&*read, &f, floor)? {
                    visible = true;
                } else {
                    hidden = true;
                }
            }
        }
        Ok(json!({ "visible": visible, "hidden": hidden }))
    }
}
