//! The delete of a page purge's sweep in the trust proposals (`deletePurgedPageTrustProposals`, SQL in
//! src/core/engine-sql/page-purge-sweep.ts): the source's proposals that name the page, one of its facts or one of its
//! takes as target or related row, removed with their index entries.

use super::{ProposalRecord, all_records, delete_record};
use crate::Store;
use crate::error::Result;
use crate::kv::KvRead;
use crate::links::no_nul;
use std::collections::HashSet;

impl ProposalRecord {
    /// Whether the proposal names any of `ids` of `table` as target or related row.
    fn names_any(&self, table: &str, ids: &HashSet<i64>) -> bool {
        (self.target_table == table && ids.contains(&self.target_id))
            || (self.related_table.as_deref() == Some(table)
                && self.related_id.is_some_and(|id| ids.contains(&id)))
    }
}

/// A page purge receipt's probe of the trust proposals (`countPurgeStoreProbe` on `trust_proposals`): how many proposals of
/// `source_id` name the page, or one of the facts, as target or related row.
pub(crate) fn count_naming(
    read: &dyn KvRead,
    source_id: &str,
    page_id: i64,
    fact_ids: &[i64],
) -> Result<usize> {
    let pages: HashSet<i64> = HashSet::from([page_id]);
    let facts: HashSet<i64> = fact_ids.iter().copied().collect();
    Ok(all_records(read)?
        .iter()
        .filter(|r| {
            r.source_id == source_id
                && (r.names_any("pages", &pages) || r.names_any("facts", &facts))
        })
        .count())
}

impl Store {
    /// `deletePurgedPageTrustProposals(sourceId, pageId, factIds, takeIds)`: deletes the source's proposals whose target or
    /// related row is the page, one of the facts or one of the takes; how many.
    pub fn delete_purged_page_trust_proposals(
        &self,
        source_id: &str,
        page_id: i64,
        fact_ids: &[i64],
        take_ids: &[i64],
    ) -> Result<u64> {
        no_nul("deletePurgedPageTrustProposals", &[("sourceId", source_id)])?;
        let pages: HashSet<i64> = HashSet::from([page_id]);
        let facts: HashSet<i64> = fact_ids.iter().copied().collect();
        let takes: HashSet<i64> = take_ids.iter().copied().collect();
        self.write(|tx| {
            let mut deleted = 0;
            for record in all_records(&*tx)? {
                if record.source_id == source_id
                    && (record.names_any("pages", &pages)
                        || record.names_any("facts", &facts)
                        || record.names_any("takes", &takes))
                {
                    delete_record(tx, &record)?;
                    deleted += 1;
                }
            }
            Ok(deleted)
        })
    }
}
