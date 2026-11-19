//! The entity resolver's page reads (`src/core/entities/resolve.ts`) that ran through `executeRaw`,
//! as `src/core/engine-sql/entity-reads.ts` sends them. Frontmatter values are read as PostgreSQL's
//! `->>` reads them (`cli_reads::reads::retired`).

use crate::Store;
use crate::error::Result;
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::pages::read_page;
use serde::Serialize;
use std::collections::BTreeSet;

/// One `readLivePageTypes` row: a live page's slug and type.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LivePageTypeRow {
    pub slug: String,
    #[serde(rename = "type")]
    pub page_type: String,
}

impl Store {
    /// `readLiveSlugs(sourceId, slugs, { limit? })`: the slugs among `slugs` at which a live page
    /// sits in the source, retired or not, each once (`slug = ANY(...)` is a filter), in list order;
    /// `limit` stops the read at that many.
    pub fn read_live_slugs(
        &self,
        source_id: &str,
        slugs: &[String],
        limit: Option<usize>,
    ) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for slug in slugs {
            if limit.is_some_and(|n| out.len() >= n) {
                break;
            }
            if !seen.insert(slug.as_str()) {
                continue;
            }
            if let Some(page) =
                read_page(&*read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
            {
                out.push(page.slug);
            }
        }
        Ok(out)
    }

    /// `readLivePageTypes(sourceId, slugs, policy)`: the live pages of the source among `slugs`,
    /// retired or not, with their types, that the page policy (when given) does not hide, each
    /// once, in list order (the SQL sets none).
    pub fn read_live_page_types(
        &self,
        source_id: &str,
        slugs: &[String],
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Vec<LivePageTypeRow>> {
        let read = self.read()?;
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for slug in slugs {
            if !seen.insert(slug.as_str()) {
                continue;
            }
            let Some(page) =
                read_page(&*read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
            else {
                continue;
            };
            if let Some(policy) = policy
                && page_hidden(&*read, &page, policy)?
            {
                continue;
            }
            out.push(LivePageTypeRow {
                slug: page.slug,
                page_type: page.page_type,
            });
        }
        Ok(out)
    }
}
