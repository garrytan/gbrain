//! The read of the admin operations (`src/core/ops/admin.ts`) served from the store (SQL in
//! `src/core/engine-sql/admin-reads.ts`, docs in `rust/docs/store/admin-reads.md`): which of the
//! `most_connected` slugs a caller may see. The pages a version history belongs to are `tail_reads.rs`.

use crate::Store;
use crate::error::Result;
use crate::facts::{OwnerOnlySources, PrivacyPolicy, page_hidden_with};
use crate::pages::read_page;
use crate::sources::all_sources;
use std::collections::BTreeSet;

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
}
