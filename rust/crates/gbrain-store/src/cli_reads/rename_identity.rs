//! The held-rename identity read of `sync-rename-identity.ts`: `readPageIdentity` (SQL in
//! `src/core/engine-sql/sources.ts`). The source-wide rename reads (`readRenameIdentityRows`,
//! `readLiveIdentityHolders`) are in `sources.rs`. The store never refuses a value it holds, so the
//! SQL engines' 22021/22P05 retry path never runs here.

use crate::Store;
use crate::cli_reads::pg_text::fm_text;
use crate::error::Result;
use crate::pages::read_page_by_id;
use serde::Serialize;

/// The row of `readPageIdentity`: `PageIdentityRow`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageIdentityRow {
    pub fm_id: Option<String>,
    pub title: Option<String>,
}

impl Store {
    /// `readPageIdentity(pageId)`: the frontmatter `id` and title of a live page; `None` for a
    /// missing or soft-deleted page.
    pub fn read_page_identity(&self, page_id: u64) -> Result<Option<PageIdentityRow>> {
        let read = self.read()?;
        Ok(read_page_by_id(&*read, page_id)?
            .filter(|page| page.deleted_at_us.is_none())
            .map(|page| PageIdentityRow {
                fm_id: fm_text(&page.frontmatter, "id"),
                title: Some(page.title),
            }))
    }
}
