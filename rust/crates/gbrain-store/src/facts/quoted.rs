//! The slot-history read of a fact recall (`engine-sql/facts-recall.ts`): `listReadablePageSlugs`, of `slugs` in
//! source `sourceId`, the pages `pageReadFilter(.., live = true)` admits under `scope` (chunk_queries
//! `PageReadPolicy`), at most `limit`, in ask order. The quote reads (`listFactsFromQuotedPages`,
//! `listOwnerTierFacts`) are `quote.rs`.
//!
//! The quote reads (`listFactsFromQuotedPages`, `listOwnerTierFacts`) are `facts/quote.rs`.
//!
//! See rust/docs/store/facts.md, "Slot-history reads".

use std::collections::BTreeSet;

use serde::Deserialize;

use crate::Store;
use crate::chunk_queries::{ChunkReadScope, PageReadPolicy};
use crate::error::Result;
use crate::links::no_nul;
use crate::pages::read_page;

/// `listReadablePageSlugs` input.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadablePageSlugsQuery {
    pub source_id: String,
    pub slugs: Vec<String>,
    pub scope: ChunkReadScope,
    pub limit: u32,
}

impl Store {
    /// `listReadablePageSlugs`: the admitted slugs, in ask order, at most `limit`.
    pub fn list_readable_page_slugs(&self, q: &ReadablePageSlugsQuery) -> Result<Vec<String>> {
        no_nul("listReadablePageSlugs", &[("sourceId", &q.source_id)])?;
        let read = self.read()?;
        // The SQL drops the scope's sources (`sourceId` / `sourceIds`): the page's source is `sourceId` alone. It
        // does not read `requireSafeChunks` either (`pageReadFilter` has no safe-chunk clause).
        let scope = ChunkReadScope {
            source_id: None,
            source_ids: None,
            require_safe_chunks: false,
            ..q.scope.clone()
        };
        let mut policy = PageReadPolicy::new(&*read);
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for slug in &q.slugs {
            if out.len() >= q.limit as usize {
                break;
            }
            if !seen.insert(slug.as_str()) {
                continue;
            }
            let Some(page) = read_page(&*read, &q.source_id, slug)? else {
                continue;
            };
            if policy.passes(&page, &scope)? {
                out.push(page.slug);
            }
        }
        Ok(out)
    }
}
