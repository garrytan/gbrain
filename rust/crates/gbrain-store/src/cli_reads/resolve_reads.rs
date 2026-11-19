//! The entity resolver's page reads (`src/core/entities/resolve.ts`) that ran through `executeRaw`,
//! as `src/core/engine-sql/entity-reads.ts` sends them. Frontmatter values are read as PostgreSQL's
//! `->>` reads them (`cli_reads::reads::retired`).

use crate::Store;
use crate::error::Result;
use crate::pages::read_page;
use std::collections::BTreeSet;

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
}
