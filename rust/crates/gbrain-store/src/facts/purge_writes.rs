//! The writes a fact purge (src/core/facts/purge.ts `submitPurgeFactMutation` and
//! `rewritePageBodies`) runs in its transaction, over the records the other families keep
//! (SQL twin: src/core/engine-sql/facts-purge.ts):
//!
//! - `deletePurgedTakes`, `deletePurgedFacts` and `deletePurgedChunks`: the purged takes (with
//!   their evidence and embeddings), facts (clearing `superseded_by` on the rows that named them)
//!   and the chunks of the pages they sat on, voiding the text seal that certified the chunks;
//! - `deletePurgeReviewQueue`, `deletePurgeReviewProposals` and `deletePurgeDecideProposals`: the
//!   decide tables' rows naming a purged fact or take (eval_capture/decide_proposals.rs);
//! - `deletePurgeTrustProposals` (trust/proposals.rs), `deletePurgeOpenLoops` (facts/loops.rs),
//!   `deletePurgeWriteGateHolds` and `deletePurgeWriteGateReceipts` (trust/write_gate.rs);
//! - `listPagesForPurgeRewrite` and `updatePageBodyForPurge`: an inline page's body with the
//!   purged fence rows dropped. A changed body takes a new knowledge revision (the Postgres revision
//!   trigger), and the text seal and embedding signature are cleared, as the statement does.
//!
//! Each call is one store write, so it commits or rolls back with the purge's transaction. A row
//! lock is skipped here while explicit transactions hold the writer (`serialized_transactions`). What the store does not keep and the
//! TypeScript members answer (src/core/rust-engine/store-members/facts-purge.ts):
//! `blankPurgeCoreEditNotices` blanks nothing, as no core edit notice is ever stored (the core
//! guard writes them through `executeRaw`, which this engine refuses).

use super::{delete_fact, read_fact};
use crate::Store;
use crate::chunks::{clear_chunks, read_chunks};
use crate::embeddings::signature_key;
use crate::error::Result;
use crate::links::no_nul;
use crate::pages::{read_page_by_id, write_page};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashSet};

/// The ids of a `bigint[]` / `integer[]` argument that can name a stored row (ids are positive).
fn row_ids(ids: &[i64]) -> BTreeSet<u64> {
    ids.iter()
        .filter_map(|id| u64::try_from(*id).ok())
        .collect()
}

impl Store {
    /// `deletePurgedTakes(takeIds)`: deletes the takes with these ids; how many.
    pub fn delete_purged_takes(&self, take_ids: &[i64]) -> Result<u64> {
        let ids = row_ids(take_ids);
        if ids.is_empty() {
            return Ok(0);
        }
        self.write(|tx| crate::takes::delete_takes_by_id(tx, &ids))
    }

    /// `deletePurgeReviewQueue(sourceId, refs)`: the source's review-queue rows naming a ref. A NUL
    /// byte in the source id or a ref is refused, as a Postgres `text` parameter refuses it.
    pub fn delete_purge_review_queue(&self, source_id: &str, refs: &[String]) -> Result<u64> {
        no_nul("deletePurgeReviewQueue", &[("sourceId", source_id)])?;
        for r in refs {
            no_nul("deletePurgeReviewQueue", &[("refs", r.as_str())])?;
        }
        let refs: HashSet<String> = refs.iter().cloned().collect();
        if refs.is_empty() {
            return Ok(0);
        }
        self.write(|tx| {
            crate::eval_capture::decide_proposals::purge_review_queue(tx, source_id, &refs)
        })
    }

    /// `deletePurgeReviewProposals(sourceId, refs)`: the source's review proposals naming a ref. A
    /// NUL byte in the source id or a ref is refused, as a Postgres `text` parameter refuses it.
    pub fn delete_purge_review_proposals(&self, source_id: &str, refs: &[String]) -> Result<u64> {
        no_nul("deletePurgeReviewProposals", &[("sourceId", source_id)])?;
        for r in refs {
            no_nul("deletePurgeReviewProposals", &[("refs", r.as_str())])?;
        }
        let refs: HashSet<String> = refs.iter().cloned().collect();
        if refs.is_empty() {
            return Ok(0);
        }
        self.write(|tx| {
            crate::eval_capture::decide_proposals::purge_review_proposals(tx, source_id, &refs)
        })
    }

    /// `deletePurgeDecideProposals(sourceId, factIds)`: the source's supersede proposals whose new
    /// or old fact is one of the ids.
    pub fn delete_purge_decide_proposals(&self, source_id: &str, fact_ids: &[i64]) -> Result<u64> {
        no_nul("deletePurgeDecideProposals", &[("sourceId", source_id)])?;
        let ids: HashSet<i64> = fact_ids.iter().copied().collect();
        if ids.is_empty() {
            return Ok(0);
        }
        self.write(|tx| {
            crate::eval_capture::decide_proposals::purge_decide_proposals(tx, source_id, &ids)
        })
    }

    /// `deletePurgeTrustProposals(sourceId, factIds, takeIds)`: the source's trust proposals whose
    /// target or related row is one of the facts or takes.
    pub fn delete_purge_trust_proposals(
        &self,
        source_id: &str,
        fact_ids: &[i64],
        take_ids: &[i64],
    ) -> Result<u64> {
        no_nul("deletePurgeTrustProposals", &[("sourceId", source_id)])?;
        let facts: HashSet<i64> = fact_ids.iter().copied().collect();
        let takes: HashSet<i64> = take_ids.iter().copied().collect();
        if facts.is_empty() && takes.is_empty() {
            return Ok(0);
        }
        self.write(|tx| crate::trust::proposals::purge_rows(tx, source_id, &facts, &takes))
    }

    /// `deletePurgeTakeProposals(sourceId, factHash)`: the source's take proposals whose claim has the
    /// purged fingerprint; how many.
    pub fn delete_purge_take_proposals(&self, source_id: &str, fact_hash: &str) -> Result<u64> {
        no_nul(
            "deletePurgeTakeProposals",
            &[("sourceId", source_id), ("factHash", fact_hash)],
        )?;
        self.write(|tx| crate::takes::proposals::remove_for_fingerprint(tx, source_id, fact_hash))
    }

    /// `deletePurgeOpenLoops(sourceId, factIds)`: the source's open loops on one of the facts.
    pub fn delete_purge_open_loops(&self, source_id: &str, fact_ids: &[i64]) -> Result<u64> {
        no_nul("deletePurgeOpenLoops", &[("sourceId", source_id)])?;
        let ids: HashSet<i64> = fact_ids.iter().copied().collect();
        if ids.is_empty() {
            return Ok(0);
        }
        self.write(|tx| super::loops::purge_rows(tx, source_id, &ids))
    }

    /// `deletePurgeWriteGateHolds(sourceId, factHash)`: the source's held writes whose fact or
    /// claim text has the fingerprint; the ids deleted, as text.
    pub fn delete_purge_write_gate_holds(
        &self,
        source_id: &str,
        fact_hash: &str,
    ) -> Result<Vec<String>> {
        no_nul(
            "deletePurgeWriteGateHolds",
            &[("sourceId", source_id), ("factHash", fact_hash)],
        )?;
        self.write(|tx| crate::trust::write_gate::purge_holds(tx, source_id, fact_hash))
    }

    /// `deletePurgeWriteGateReceipts(factIds, takeIds, holdIds)`: the gate receipts naming one of
    /// the facts, takes or held writes (ids as text).
    pub fn delete_purge_write_gate_receipts(
        &self,
        fact_ids: &[String],
        take_ids: &[String],
        hold_ids: &[String],
    ) -> Result<u64> {
        let set = |ids: &[String]| ids.iter().cloned().collect::<HashSet<String>>();
        let (facts, takes, holds) = (set(fact_ids), set(take_ids), set(hold_ids));
        if facts.is_empty() && takes.is_empty() && holds.is_empty() {
            return Ok(0);
        }
        self.write(|tx| crate::trust::write_gate::purge_receipts(tx, &facts, &takes, &holds))
    }

    /// `deletePurgedFacts(factIds, sourceId)`: deletes the source's facts with these ids; how many.
    pub fn delete_purged_facts(&self, fact_ids: &[i64], source_id: &str) -> Result<u64> {
        no_nul("deletePurgedFacts", &[("sourceId", source_id)])?;
        let ids = row_ids(fact_ids);
        if ids.is_empty() {
            return Ok(0);
        }
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let mut deleted = 0;
            for id in &ids {
                if let Some(row) = read_fact(&*tx, *id)?
                    && row.source_id == source_id
                {
                    delete_fact(tx, trust, &row)?;
                    deleted += 1;
                }
            }
            Ok(deleted)
        })
    }

    /// `deletePurgedChunks(pageIds)`: deletes the chunks of these pages and clears the text seal
    /// of each page that had any; how many chunk rows were deleted.
    pub fn delete_purged_chunks(&self, page_ids: &[i64]) -> Result<u64> {
        let ids = row_ids(page_ids);
        if ids.is_empty() {
            return Ok(0);
        }
        self.write(|tx| {
            let mut deleted = 0;
            for id in &ids {
                let count = read_chunks(&*tx, *id)?.len() as u64;
                if count == 0 {
                    continue;
                }
                clear_chunks(tx, *id)?;
                deleted += count;
                if let Some(mut page) = read_page_by_id(&*tx, *id)?
                    && page.text_projection_revision.is_some()
                {
                    page.text_projection_revision = None;
                    write_page(tx, &page)?;
                }
            }
            Ok(deleted)
        })
    }

    /// `listPagesForPurgeRewrite(sourceId, pageIds)`: the source's pages with these ids, deleted or
    /// not, each as `getPage` gives it with its `body_storage` and its tags in byte order as
    /// `purge_tags`, in slug order (byte order).
    pub fn list_pages_for_purge_rewrite(
        &self,
        source_id: &str,
        page_ids: &[i64],
    ) -> Result<Vec<Value>> {
        no_nul("listPagesForPurgeRewrite", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let mut pages = Vec::new();
        for id in row_ids(page_ids) {
            if let Some(page) = read_page_by_id(&*read, id)?
                && page.source_id == source_id
            {
                pages.push(page);
            }
        }
        pages.sort_by(|a, b| a.slug.as_bytes().cmp(b.slug.as_bytes()));
        pages
            .into_iter()
            .map(|page| {
                let segmented = page.compiled_truth.is_null() && page.timeline.is_null();
                let mut tags = page.tags.clone();
                tags.sort();
                let mut row = page.to_page_with_columns(&*read)?;
                row["body_storage"] = json!(if segmented { "segmented" } else { "inline" });
                row["purge_tags"] = json!(tags);
                Ok(row)
            })
            .collect()
    }

    /// `updatePageBodyForPurge(sourceId, pageId, compiled, timeline, hash)`: stores an inline
    /// page's body with the purged fence rows dropped and its content hash, with its text seal and
    /// embedding signature cleared; a changed body takes a new knowledge revision. A page of another source, or
    /// none, is left alone.
    pub fn update_page_body_for_purge(
        &self,
        source_id: &str,
        page_id: i64,
        compiled: &str,
        timeline: &str,
        hash: &str,
    ) -> Result<()> {
        no_nul(
            "updatePageBodyForPurge",
            &[("sourceId", source_id), ("hash", hash)],
        )?;
        let Ok(id) = u64::try_from(page_id) else {
            return Ok(());
        };
        let env = self.env.clone();
        self.write(|tx| {
            let Some(mut page) = read_page_by_id(&*tx, id)? else {
                return Ok(());
            };
            if page.source_id != source_id {
                return Ok(());
            }
            // The revision trigger: a changed body column takes a new knowledge revision.
            if page.compiled_truth != compiled || page.timeline != timeline {
                page.knowledge_revision = env.new_uuid();
            }
            page.compiled_truth = compiled.into();
            page.timeline = timeline.into();
            page.content_hash = Some(hash.to_string());
            page.updated_at_us = env.now_micros();
            page.text_projection_revision = None;
            write_page(tx, &page)?;
            tx.delete(&signature_key(page.id))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::test_support::store;
    use crate::trust::write_gate::HoldInput;

    fn hold(s: &Store, slug: &str, payload: Value) -> u64 {
        let input: HoldInput = serde_json::from_value(json!({
            "kind": "fact", "source_id": "default", "slug": slug, "fingerprint": format!("fp-{slug}"),
            "detector_version": 1, "tier": "agent_written", "reason_families": [], "reasons": [],
            "detector_error": false, "payload": payload, "write_origin": null, "request_id": null,
        }))
        .unwrap();
        s.upsert_write_gate_hold(input).unwrap()
    }

    #[test]
    fn a_hold_is_purged_by_the_fingerprint_of_its_fact_or_else_its_claim() {
        let s = store();
        let hash = crate::facts::fact_fingerprint("Alice likes tea");
        let by_fact = hold(
            &s,
            "a",
            json!({ "fact": "alice  LIKES tea", "claim": "other" }),
        );
        let by_claim = hold(&s, "b", json!({ "fact": null, "claim": "Alice likes tea" }));
        hold(
            &s,
            "c",
            json!({ "fact": "Alice likes coffee", "claim": "Alice likes tea" }),
        );
        hold(&s, "d", json!({}));
        let deleted = s.delete_purge_write_gate_holds("default", &hash).unwrap();
        assert_eq!(deleted, vec![by_fact.to_string(), by_claim.to_string()]);
        assert!(
            s.delete_purge_write_gate_holds("default", &hash)
                .unwrap()
                .is_empty()
        );
        // `COALESCE(..., '')`: a hold with neither field matches the fingerprint of the empty text.
        let empty = crate::facts::fact_fingerprint("");
        assert_eq!(
            s.delete_purge_write_gate_holds("default", &empty)
                .unwrap()
                .len(),
            1
        );
    }

    fn page(s: &Store, slug: &str, body: &str) -> u64 {
        let input = PageInput {
            page_type: "note".into(),
            title: "T".into(),
            compiled_truth: body.into(),
            ..PageInput::default()
        };
        s.put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        crate::pages::read_page(&*s.read().unwrap(), "default", slug)
            .unwrap()
            .unwrap()
            .id
    }

    #[test]
    fn a_purged_body_takes_a_new_revision_only_when_it_changed() {
        let s = store();
        let id = page(&s, "notes/a", "Tea and milk") as i64;
        let revision = |s: &Store| {
            crate::pages::read_page(&*s.read().unwrap(), "default", "notes/a")
                .unwrap()
                .unwrap()
                .knowledge_revision
        };
        let first = revision(&s);
        s.update_page_body_for_purge("default", id, "Tea and milk", "", "h1")
            .unwrap();
        assert_eq!(revision(&s), first);
        s.update_page_body_for_purge("default", id, "Milk", "", "h2")
            .unwrap();
        let moved = revision(&s);
        assert_ne!(moved, first);
        // Another source's id is left alone.
        s.update_page_body_for_purge("other", id, "Gone", "", "h3")
            .unwrap();
        let p = crate::pages::read_page(&*s.read().unwrap(), "default", "notes/a")
            .unwrap()
            .unwrap();
        assert_eq!(
            (&*p.compiled_truth, p.content_hash.as_deref()),
            ("Milk", Some("h2"))
        );
        assert_eq!(p.knowledge_revision, moved);
    }

    #[test]
    fn empty_and_unknown_ids_delete_nothing() {
        let s = store();
        assert_eq!(s.delete_purged_takes(&[]).unwrap(), 0);
        assert_eq!(s.delete_purged_takes(&[-1, 7]).unwrap(), 0);
        assert_eq!(s.delete_purged_facts(&[1, 2], "default").unwrap(), 0);
        assert_eq!(s.delete_purged_chunks(&[1]).unwrap(), 0);
        assert_eq!(s.delete_purge_review_queue("default", &[]).unwrap(), 0);
        assert_eq!(
            s.delete_purge_trust_proposals("default", &[1], &[2])
                .unwrap(),
            0
        );
        assert_eq!(
            s.delete_purge_write_gate_receipts(&["1".into()], &[], &[])
                .unwrap(),
            0
        );
        assert!(
            s.list_pages_for_purge_rewrite("default", &[1])
                .unwrap()
                .is_empty()
        );
    }
}
