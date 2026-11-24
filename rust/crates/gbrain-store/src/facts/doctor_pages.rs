//! Group 5 facts reads, the three doctor-check page reads of src/core/engine-sql/facts-doctor.ts
//! (`gbrain doctor` checks fence-integrity.ts, facts-pages.ts and unlinked-facts.ts).
//!
//! - `countSegmentedCensusPages(sourceIds, checkedOutSourceIds)`: the live markdown pages of
//!   `sourceIds` stored in segments that the census walked no file for (no `source_path`, or a
//!   source outside `checkedOutSourceIds`).
//! - `listFactsPageBodies()`: every live `type: facts` page, by source id then slug in byte order
//!   (`COLLATE "C"`), with whether it is stored in segments and
//!   `left(coalesce(compiled_truth, truth_lead), 65536)`: the first 65536 code points of the inline
//!   body, or of a segmented page's published truth lead (NULL when no flip published one).
//! - `readFactTableCatalog()`: `{ facts, attempts }`, the names `to_regclass` answers. The store
//!   always keeps both record families, so both names are present.
//!
//! A page is stored in segments when its body state says `segmented` (page_body.rs), which is
//! exactly when its truth and timeline are NULL (`pages_body_storage_chk`).

use crate::Store;
use crate::error::Result;
use crate::links::no_nul;
use crate::page_body::body_storage_columns;
use crate::pages::all_pages;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `countSegmentedCensusPages(sourceIds, checkedOutSourceIds)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentedCensusQuery {
    pub source_ids: Vec<String>,
    pub checked_out_source_ids: Vec<String>,
}

impl Store {
    /// `countSegmentedCensusPages(sourceIds, checkedOutSourceIds)`: `{ n }`, the live markdown pages
    /// of `sourceIds` stored in segments that have no `source_path` or whose source is not in
    /// `checkedOutSourceIds`. The statement always answers one row.
    pub fn count_segmented_census_pages(&self, q: &SegmentedCensusQuery) -> Result<Value> {
        const OP: &str = "countSegmentedCensusPages";
        for id in q.source_ids.iter().chain(&q.checked_out_source_ids) {
            no_nul(OP, &[("sourceId", id)])?;
        }
        let sources: BTreeSet<&str> = q.source_ids.iter().map(String::as_str).collect();
        let walked: BTreeSet<&str> = q
            .checked_out_source_ids
            .iter()
            .map(String::as_str)
            .collect();
        let read = self.read()?;
        let mut n = 0u64;
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some()
                || page.page_kind != "markdown"
                || !sources.contains(page.source_id.as_str())
                || !(page.source_path.is_none() || !walked.contains(page.source_id.as_str()))
            {
                continue;
            }
            if body_storage_columns(&*read, page.id)?.0 == "segmented" {
                n += 1;
            }
        }
        Ok(json!({ "n": n }))
    }

    /// `readFactTableCatalog()`: `{ facts: 'facts', attempts: 'fact_relink_attempts' }`.
    pub fn read_fact_table_catalog(&self) -> Result<Value> {
        // The open check: a closed store refuses, as every other read does.
        drop(self.read()?);
        Ok(json!({ "facts": "facts", "attempts": "fact_relink_attempts" }))
    }
}
