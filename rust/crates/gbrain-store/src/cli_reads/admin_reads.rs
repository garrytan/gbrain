//! The two reads of the admin operations (`src/core/ops/admin.ts`) served from the store (SQL in
//! `src/core/engine-sql/admin-reads.ts`, docs in `rust/docs/store/admin-reads.md`): which of the
//! `most_connected` slugs a caller may see, and the pages the version history of a page belongs to.

use crate::Store;
use crate::error::Result;
use crate::facts::{OwnerOnlySources, PrivacyPolicy, page_hidden_with};
use crate::pages::{read_page, read_page_by_id};
use crate::sources::all_sources;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// One row of `readPagesForVersionHistory`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VersionPageRow {
    pub id: u64,
    pub slug: String,
    pub source_id: String,
    pub frontmatter: Map<String, Value>,
}

impl Store {
    /// `listVisiblePageSlugs(slugs, sourceIds, policy)`: the distinct slugs among `slugs` that name
    /// a live page (no `deleted_at`) in one of `source_ids` (every source when `None`) that
    /// `policy` does not hide. A `None` policy hides nothing. The slugs come back in byte order;
    /// the SQL (`SELECT DISTINCT`) names no order.
    pub fn list_visible_page_slugs(
        &self,
        slugs: &[String],
        source_ids: Option<&[String]>,
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Vec<String>> {
        let read = self.read()?;
        let sources: Vec<String> = match source_ids {
            Some(ids) => ids.to_vec(),
            None => all_sources(&*read)?.into_iter().map(|s| s.id).collect(),
        };
        let owner_only = match policy {
            Some(_) => Some(OwnerOnlySources::read(&*read)?),
            None => None,
        };
        let wanted: BTreeSet<&String> = slugs.iter().collect();
        let mut out = BTreeSet::new();
        for slug in wanted {
            for source in &sources {
                let Some(page) = read_page(&*read, source, slug)? else {
                    continue;
                };
                if page.deleted_at_us.is_some() {
                    continue;
                }
                if let (Some(policy), Some(owner_only)) = (policy, owner_only.as_ref())
                    && page_hidden_with(&*read, &page, policy, owner_only)?
                {
                    continue;
                }
                out.insert(slug.clone());
                break;
            }
        }
        Ok(out.into_iter().collect())
    }

    /// `readPagesForVersionHistory(pageIds)`: the id, slug, source and frontmatter of each page
    /// with one of these ids, in id order. Like the SQL (`WHERE id = ANY($1)`), a soft-deleted page
    /// is read too, a repeated id is read once, and an id no page has reads nothing.
    pub fn read_pages_for_version_history(&self, page_ids: &[i64]) -> Result<Vec<VersionPageRow>> {
        let read = self.read()?;
        let ids: BTreeSet<u64> = page_ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let mut rows = Vec::new();
        for id in ids {
            if let Some(page) = read_page_by_id(&*read, id)? {
                rows.push(VersionPageRow {
                    id: page.id,
                    slug: page.slug,
                    source_id: page.source_id,
                    frontmatter: page.frontmatter,
                });
            }
        }
        Ok(rows)
    }
}
