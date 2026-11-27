//! The deletes of a page purge's sweep that live with the facts: `deletePurgedPageFacts` (SQL in
//! src/core/engine-sql/page-purge-sweep.ts), every fact of the page (`PAGE_FACTS`: filed on it, or extracted from it and
//! filed on none) removed with its index entries; and `deletePurgedSlugStoreRows` (engine-sql/purge-slug-stores.ts), the
//! scrub of the stores keyed to a purged slug outside any foreign key. The fact tombstones a purge writes are
//! `purge_ledger.rs`'s.
//!
//! The store keeps no `core_edit_notices` (they answer 0) and no secret store (`secretStore` is false, so the caller has no
//! secret occurrences to purge); every other store of the scrub is kept and scrubbed here.

use super::page_purge_reads::page_facts;
use super::read_fact;
use crate::Store;
use crate::error::Result;
use crate::facts::delete_fact;
use crate::links::no_nul;
use crate::trust::WriteTrust;
use serde_json::{Value, json};
use std::collections::BTreeSet;

impl Store {
    /// `deletePurgedPageFacts(sourceId, slug)`: deletes the facts of the page, all of them (withdrawn and outcome markers
    /// included); how many. A fact another one names as its successor lets that one keep its row with `superseded_by` cleared
    /// (`ON DELETE SET NULL`), as `delete_fact` does; each row is read again before it goes, because that clearing rewrites
    /// the rows of the page it reaches.
    pub fn delete_purged_page_facts(&self, source_id: &str, slug: &str) -> Result<u64> {
        no_nul(
            "deletePurgedPageFacts",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let trust = WriteTrust::default();
        self.write(|tx| {
            let doomed = page_facts(&*tx, source_id, slug)?;
            for fact in &doomed {
                if let Some(current) = read_fact(&*tx, fact.id)? {
                    delete_fact(tx, &trust, &current)?;
                }
            }
            Ok(doomed.len() as u64)
        })
    }

    /// `deletePurgedSlugStoreRows(sourceId, slugs)`: deletes the rows of `slugs` in the source from the stores keyed to a page by
    /// source and slug: take proposals, open loops, (core edit notices: none kept), page aliases, the slug aliases that resolve to
    /// a slug and the rename rows that end at one. `{ removed, secretStore: false }`; `removed` is empty for no slugs.
    pub fn delete_purged_slug_store_rows(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<Value> {
        let op = "deletePurgedSlugStoreRows";
        no_nul(op, &[("sourceId", source_id)])?;
        for slug in slugs {
            no_nul(op, &[("slugs", slug)])?;
        }
        if slugs.is_empty() {
            return Ok(json!({ "removed": {}, "secretStore": false }));
        }
        let wanted: BTreeSet<&str> = slugs.iter().map(String::as_str).collect();
        self.write(|tx| {
            let take_proposals = crate::takes::proposals::remove_for_slugs(tx, source_id, &wanted)?;
            let open_loops = crate::facts::loops::remove_for_slugs(tx, source_id, &wanted)?;
            let aliases = crate::aliases::scrub_purged_slug_stores(tx, source_id, slugs)?;
            Ok(json!({
                "removed": {
                    "take_proposals": take_proposals,
                    "open_loops": open_loops,
                    "core_edit_notices": 0,
                    "page_aliases": aliases.page_aliases,
                    "slug_aliases": aliases.slug_aliases,
                    "slug_rename_history": aliases.slug_rename_history,
                },
                "secretStore": false,
            }))
        })
    }
}
