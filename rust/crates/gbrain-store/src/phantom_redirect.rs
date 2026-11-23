//! The root-page walk of the phantom-redirect pass, which ran raw SQL
//! (`listRootPageSlugsAfter`, src/core/engine-sql/facts-cycle.ts). PGLite and Postgres run the
//! SQL; this answers the same question from the store's page records. What it answers:
//! rust/docs/store/phantom-redirect.md.
//!
//! Keys: none of its own. It reads page records.

use crate::Store;
use crate::error::Result;
use crate::links::no_nul;
use crate::pages::all_pages;
use serde_json::{Value, json};

impl Store {
    /// Up to `limit` live root-page slugs (no `/`) of `source_id` after `after`, leaving out the
    /// `exclude` slugs, in slug byte order, as `[{ slug }]`.
    pub fn list_root_page_slugs_after(
        &self,
        source_id: &str,
        limit: usize,
        exclude: &[String],
        after: &str,
    ) -> Result<Vec<Value>> {
        no_nul(
            "listRootPageSlugsAfter",
            &[("sourceId", source_id), ("after", after)],
        )?;
        let read = self.read()?;
        let mut slugs: Vec<String> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id && p.deleted_at_us.is_none())
            .map(|p| p.slug)
            .filter(|s| !s.contains('/') && s.as_bytes() > after.as_bytes() && !exclude.contains(s))
            .collect();
        slugs.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
        slugs.truncate(limit);
        Ok(slugs
            .into_iter()
            .map(|slug| json!({ "slug": slug }))
            .collect())
    }
}
