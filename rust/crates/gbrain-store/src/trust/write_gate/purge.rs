//! The deletes of a page purge's sweep in the write gate (`deletePurgedPageHolds` and `deletePurgedPageGateReceipts`, SQL in
//! src/core/engine-sql/page-purge-sweep.ts): every hold of a slug in a source, and the receipts that name a page, its facts,
//! its takes or those holds. Neither table has a foreign key, so nothing else removes them with the page.

use super::{
    HOLD, HOLD_DEDUPE, HoldRecord, ReceiptRecord, all_holds, all_receipts, by_id, delete_receipt,
    read_id, tagged,
};
use crate::Store;
use crate::error::Result;
use crate::links::no_nul;
use std::collections::HashSet;

impl Store {
    /// `deletePurgedPageHolds(sourceId, slug)`: deletes every hold of the slug in the source, with its dedupe key; the ids as
    /// text in id order.
    pub fn delete_purged_page_holds(&self, source_id: &str, slug: &str) -> Result<Vec<String>> {
        no_nul(
            "deletePurgedPageHolds",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        self.write(|tx| {
            let mut holds: Vec<HoldRecord> = all_holds(&*tx)?
                .into_iter()
                .filter(|h| h.source_id == source_id && h.slug == slug)
                .collect();
            holds.sort_by_key(|h| h.id);
            for h in &holds {
                let version = h.detector_version.to_string();
                let index = tagged(
                    HOLD_DEDUPE,
                    &[&h.source_id, &h.slug, &h.fingerprint, &version],
                );
                if read_id(&*tx, &index)? == Some(h.id) {
                    tx.delete(&index)?;
                }
                tx.delete(&by_id(HOLD, h.id))?;
            }
            Ok(holds.into_iter().map(|h| h.id.to_string()).collect())
        })
    }

    /// `deletePurgedPageGateReceipts(pageId, factIds, takeIds, holdIds)`: deletes the receipts that name the page, one of the
    /// facts or takes, or one of the holds (ids as text, matched as text); how many.
    pub fn delete_purged_page_gate_receipts(
        &self,
        page_id: i64,
        fact_ids: &[i64],
        take_ids: &[i64],
        hold_ids: &[String],
    ) -> Result<u64> {
        for id in hold_ids {
            no_nul("deletePurgedPageGateReceipts", &[("holdIds", id)])?;
        }
        let page = page_id.to_string();
        let facts: HashSet<String> = fact_ids.iter().map(i64::to_string).collect();
        let takes: HashSet<String> = take_ids.iter().map(i64::to_string).collect();
        let holds: HashSet<&str> = hold_ids.iter().map(String::as_str).collect();
        self.write(|tx| {
            let doomed: Vec<ReceiptRecord> = all_receipts(&*tx)?
                .into_iter()
                .filter(|r| match r.target_table.as_str() {
                    "pages" => r.target_id == page,
                    "facts" => facts.contains(&r.target_id),
                    "takes" => takes.contains(&r.target_id),
                    "write_gate_holds" => holds.contains(r.target_id.as_str()),
                    _ => false,
                })
                .collect();
            for r in &doomed {
                delete_receipt(tx, r)?;
            }
            Ok(doomed.len() as u64)
        })
    }
}
