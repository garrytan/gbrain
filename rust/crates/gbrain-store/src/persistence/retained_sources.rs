//! `readRetainedSources(sourceIds)` (`src/core/engine-sql/cli-reads-import.ts`): the listed sources
//! whose worktree holds a recovery record, the connector status's "retained" flag
//! (persistence/connector-status.ts). A source counts when its `persistence_source_bindings` row
//! names a worktree that some write request still carries a recovery for.

use super::worktree_rows::read_source_binding;
use super::write_claim_terms::worktree_of;
use super::{all_requests, extra_is_null};
use crate::Store;
use crate::error::Result;
use crate::sources::read_source;
use std::collections::BTreeSet;

impl Store {
    /// The listed ids that name a stored source whose binding's worktree holds a request with a
    /// recovery record, each once, by id in byte order (`ORDER BY id COLLATE "C"`). An empty list
    /// reads nothing.
    pub fn read_retained_sources(&self, source_ids: &[String]) -> Result<Vec<String>> {
        if source_ids.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let recovering: BTreeSet<String> = all_requests(&*read)?
            .iter()
            .filter(|r| !extra_is_null(r, "recovery"))
            .filter_map(worktree_of)
            .collect();
        let mut out = BTreeSet::new();
        for id in source_ids {
            if id.contains('\0') || read_source(&*read, id)?.is_none() {
                continue;
            }
            if read_source_binding(&*read, id)?
                .is_some_and(|binding| recovering.contains(&binding.worktree_id))
            {
                out.insert(id.clone());
            }
        }
        Ok(out.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn no_source_is_retained_without_a_recovery_and_an_empty_list_reads_nothing() {
        let s = crate::test_support::store();
        assert!(s.read_retained_sources(&[]).unwrap().is_empty());
        let named = ["default".to_string(), "no-such-source".to_string()];
        assert!(s.read_retained_sources(&named).unwrap().is_empty());
    }
}
