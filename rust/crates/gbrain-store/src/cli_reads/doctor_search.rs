//! Doctor search-and-knowledge reads: the typed members that replace the raw SQL of the `gbrain doctor` checks
//! dangling_aliases, type_proliferation, person_title_duplicates, markdown_body_completeness,
//! link_resolution_opportunity, hidden_by_search_policy, image_embedding_coverage, text_projection_readiness and
//! extract_atoms_backlog (SQL in `src/core/engine-sql/doctor-search.ts`, docs in
//! `rust/docs/store/cli-reads-doctor-search.md`). Each read takes one snapshot and has no keys of its own.
//!
//! Text rules (rust/docs/store/cli-reads-ops.md, "Text semantics"): `length` is characters, `octet_length` bytes,
//! a key test (`?`) is key presence even for a JSON null, `->>` is `fm_text`, and every order is bytewise, as
//! PGLite's C.UTF-8 collation orders.

use crate::Store;
use crate::aliases::alias_row_targets;
use crate::error::Result;
use crate::kv::KvRead;
use crate::pages::{PageRecord, all_pages, read_page};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn live_pages(read: &dyn KvRead) -> Result<Vec<PageRecord>> {
    Ok(all_pages(read)?
        .into_iter()
        .filter(|p| p.deleted_at_us.is_none())
        .collect())
}

impl Store {
    /// `listOrphanedAliasCounts()`: per source, the `slug_aliases` rows whose canonical page row is absent and the
    /// `page_aliases` rows whose page row is absent, in source order (a source with none is not listed). Rows:
    /// `{source_id, slug_redirects, page_aliases}`.
    pub fn list_orphaned_alias_counts(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let (slug_aliases, page_aliases) = alias_row_targets(&*read)?;
        let mut per_source: BTreeMap<String, (u64, u64)> = BTreeMap::new();
        for (source, slug) in slug_aliases {
            if read_page(&*read, &source, &slug)?.is_none() {
                per_source.entry(source).or_default().0 += 1;
            }
        }
        for (source, slug) in page_aliases {
            if read_page(&*read, &source, &slug)?.is_none() {
                per_source.entry(source).or_default().1 += 1;
            }
        }
        Ok(per_source
            .into_iter()
            .map(|(source_id, (slug_redirects, page_aliases))| {
                json!({ "source_id": source_id, "slug_redirects": slug_redirects, "page_aliases": page_aliases })
            })
            .collect())
    }

    /// `readSoftDeletedAliasCounts()`: the alias rows (each table) whose page row is soft-deleted. Row:
    /// `{slug_redirects, page_aliases}`.
    pub fn read_soft_deleted_alias_counts(&self) -> Result<Value> {
        let read = self.read()?;
        let (slug_aliases, page_aliases) = alias_row_targets(&*read)?;
        let count = |rows: Vec<(String, String)>| -> Result<u64> {
            let mut n = 0;
            for (source, slug) in rows {
                if read_page(&*read, &source, &slug)?.is_some_and(|p| p.deleted_at_us.is_some()) {
                    n += 1;
                }
            }
            Ok(n)
        };
        let slug_redirects = count(slug_aliases)?;
        let page_aliases = count(page_aliases)?;
        Ok(json!({ "slug_redirects": slug_redirects, "page_aliases": page_aliases }))
    }

    /// `listPageTypePairs()`: every distinct `(source_id, type)` of the live typed pages, in source then type order.
    /// Rows: `{source_id, type}`.
    pub fn list_page_type_pairs(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let pairs: BTreeSet<(String, String)> = live_pages(&*read)?
            .into_iter()
            .map(|p| (p.source_id, p.page_type))
            .collect();
        Ok(pairs
            .into_iter()
            .map(|(source_id, ty)| json!({ "source_id": source_id, "type": ty }))
            .collect())
    }
}
