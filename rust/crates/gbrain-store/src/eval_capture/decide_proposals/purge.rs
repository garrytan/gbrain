//! The deletes a purge makes in the decide tables: the review queue rows and review proposals that name a purged claim by
//! ref, and the supersede proposals that name a purged fact by id (`submitPurgeFactMutation` and a page purge's sweep;
//! SQL in src/core/engine-sql/facts-purge.ts).
//!
//! Members: `deletePurgeReviewQueue`, `deletePurgeReviewProposals`, `deletePurgeDecideProposals`. Each removes the
//! row with every key that points at it (a review queue row is one key; a review proposal has its unique key; a supersede
//! proposal its sweep slot and, for a claim-conflict sweep, its fact-pair key) and answers how many rows went.

use super::{
    PROPOSAL, ProposalRecord, QueueRecord, REVIEW_PROPOSAL, REVIEW_QUEUE, ReviewProposalRecord,
    claim_pair_key, id_key, queue_key, read_all, review_key, sweep_slot_key, tagged,
};
use crate::Store;
use crate::error::Result;
use crate::facts::like;
use crate::links::no_nul;
use std::collections::HashSet;

/// `refs` as a set, refused when one holds a NUL (Postgres text cannot).
fn ref_set<'a>(op: &str, source_id: &str, refs: &'a [String]) -> Result<HashSet<&'a str>> {
    no_nul(op, &[("sourceId", source_id)])?;
    for r in refs {
        no_nul(op, &[("refs", r)])?;
    }
    Ok(refs.iter().map(String::as_str).collect())
}

impl Store {
    /// `deletePurgeReviewQueue(sourceId, refs)`: deletes the source's review queue rows whose `a_ref` or `b_ref` is one of
    /// `refs`; how many.
    pub fn delete_purge_review_queue(&self, source_id: &str, refs: &[String]) -> Result<u64> {
        let wanted = ref_set("deletePurgeReviewQueue", source_id, refs)?;
        self.write(|tx| {
            let rows: Vec<QueueRecord> = read_all(&*tx, &tagged(REVIEW_QUEUE))?;
            let mut deleted = 0;
            for r in rows.iter().filter(|r| {
                r.source_id == source_id
                    && (wanted.contains(r.a_ref.as_str()) || wanted.contains(r.b_ref.as_str()))
            }) {
                tx.delete(&queue_key(&r.kind, &r.source_id, &r.a_ref, &r.b_ref))?;
                deleted += 1;
            }
            Ok(deleted)
        })
    }

    /// `deletePurgeReviewProposals(sourceId, refs)`: deletes the source's review proposals whose `a_ref` or `b_ref` is one of
    /// `refs`; how many.
    pub fn delete_purge_review_proposals(&self, source_id: &str, refs: &[String]) -> Result<u64> {
        let wanted = ref_set("deletePurgeReviewProposals", source_id, refs)?;
        self.write(|tx| {
            let rows: Vec<ReviewProposalRecord> = read_all(&*tx, &tagged(REVIEW_PROPOSAL))?;
            let mut deleted = 0;
            for r in rows.iter().filter(|r| {
                r.source_id == source_id
                    && (wanted.contains(r.a_ref.as_str()) || wanted.contains(r.b_ref.as_str()))
            }) {
                tx.delete(&id_key(REVIEW_PROPOSAL, r.id))?;
                tx.delete(&review_key(
                    &r.kind,
                    &r.source_id,
                    &r.a_ref,
                    &r.b_ref,
                    &r.subject,
                ))?;
                deleted += 1;
            }
            Ok(deleted)
        })
    }

    /// `deletePurgeDecideProposals(sourceId, factIds)`: deletes the source's supersede proposals whose new or old fact is one of
    /// `fact_ids`; how many.
    pub fn delete_purge_decide_proposals(&self, source_id: &str, fact_ids: &[i64]) -> Result<u64> {
        no_nul("deletePurgeDecideProposals", &[("sourceId", source_id)])?;
        let wanted: HashSet<i64> = fact_ids.iter().copied().collect();
        self.write(|tx| {
            let rows: Vec<ProposalRecord> = read_all(&*tx, &tagged(PROPOSAL))?;
            let mut deleted = 0;
            for r in rows.iter().filter(|r| {
                r.source_id == source_id
                    && (wanted.contains(&r.new_fact_id) || wanted.contains(&r.old_fact_id))
            }) {
                tx.delete(&id_key(PROPOSAL, r.id))?;
                tx.delete(&sweep_slot_key(&r.sweep_id, r.pair_index))?;
                if like(&r.sweep_id, "claim_conflicts:%", false)? {
                    let pair = claim_pair_key(&r.source_id, r.new_fact_id, r.old_fact_id);
                    if tx.get(&pair)?.as_deref() == Some(&r.id.to_be_bytes()[..]) {
                        tx.delete(&pair)?;
                    }
                }
                deleted += 1;
            }
            Ok(deleted)
        })
    }
}
