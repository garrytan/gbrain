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
use crate::page_body::{body_storage_columns, truth_lead};
use crate::pages::all_pages;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `left(coalesce(compiled_truth, truth_lead), BOUNDED_PREFIX_BYTES)` (page-window/bounded-lead.ts):
/// `left` counts code points.
const BOUNDED_PREFIX_CHARS: usize = 64 * 1024;

/// `countSegmentedCensusPages(sourceIds, checkedOutSourceIds)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentedCensusQuery {
    pub source_ids: Vec<String>,
    pub checked_out_source_ids: Vec<String>,
}

/// `left(text, n)`: the first `n` code points.
fn left(text: &str, n: usize) -> &str {
    text.char_indices()
        .nth(n)
        .map_or(text, |(at, _)| &text[..at])
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

    /// `listFactsPageBodies()`: `{ slug, source_id, segmented, body }` for every live page of type
    /// `facts`, by source id then slug in byte order.
    pub fn list_facts_page_bodies(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut pages: Vec<_> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && p.page_type == "facts")
            .collect();
        pages.sort_by(|a, b| {
            a.source_id
                .as_bytes()
                .cmp(b.source_id.as_bytes())
                .then(a.slug.as_bytes().cmp(b.slug.as_bytes()))
        });
        let mut out = Vec::with_capacity(pages.len());
        for page in pages {
            let segmented = body_storage_columns(&*read, page.id)?.0 == "segmented";
            let body = match page.compiled_truth.as_deref() {
                Some(text) => Some(left(text, BOUNDED_PREFIX_CHARS).to_string()),
                None => {
                    truth_lead(&*read, page.id)?.map(|t| left(&t, BOUNDED_PREFIX_CHARS).to_string())
                }
            };
            out.push(json!({
                "slug": page.slug,
                "source_id": page.source_id,
                "segmented": segmented,
                "body": body,
            }));
        }
        Ok(out)
    }

    /// `readFactTableCatalog()`: `{ facts: 'facts', attempts: 'fact_relink_attempts' }`.
    pub fn read_fact_table_catalog(&self) -> Result<Value> {
        // The open check: a closed store refuses, as every other read does.
        drop(self.read()?);
        Ok(json!({ "facts": "facts", "attempts": "fact_relink_attempts" }))
    }
}

#[cfg(test)]
mod tests {
    use super::left;

    #[test]
    fn left_counts_code_points() {
        assert_eq!(left("héllo", 2), "hé");
        assert_eq!(left("ab", 5), "ab");
    }
}
