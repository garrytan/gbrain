//! The page reads two commands made through raw SQL (`src/core/engine-sql/collate-command-reads.ts`):
//! the who-can-read page rows (`readPageAccessRows`) and the reconcile-links markdown walk
//! (`listMarkdownPageSlugs`).
//! PGLite and Postgres run the SQL; this answers the same questions from the store's page records.
//! Every list is in byte order of its text keys, as the statements' `COLLATE "C"` orders them.
//! What each member answers: rust/docs/store/collate-command-reads.md.
//!
//! Keys: none of its own. It reads the page records and the folder-rule stamps.

use crate::Store;
use crate::access_policy::kept_rule_ids;
use crate::error::Result;
use crate::pages::{all_pages, read_page};
use serde::Serialize;
use serde_json::{Map, Value};

/// What who-can-read reads of a page (`PageAccessRow`): `folder_rule_ids` is `null` when no rule is stamped.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageAccessRow {
    pub slug: String,
    pub source_id: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub frontmatter: Map<String, Value>,
    pub folder_rule_ids: Option<Vec<String>>,
}

impl Store {
    /// The pages named `slug`, soft-deleted ones too: the one in `source_id` when given (`source_id`
    /// is not empty), else one per source by source id bytes.
    pub fn read_page_access_rows(
        &self,
        slug: &str,
        source_id: Option<&str>,
    ) -> Result<Vec<PageAccessRow>> {
        let read = self.read()?;
        let pages = match source_id.filter(|s| !s.is_empty()) {
            Some(source) => read_page(&*read, source, slug)?.into_iter().collect(),
            None => all_pages(&*read)?
                .into_iter()
                .filter(|p| p.slug == slug)
                .collect::<Vec<_>>(),
        };
        let mut rows = Vec::with_capacity(pages.len());
        for p in pages {
            let folder_rule_ids = kept_rule_ids(&*read, &p.source_id, p.id)?;
            rows.push(PageAccessRow {
                slug: p.slug,
                source_id: p.source_id,
                page_type: p.page_type,
                frontmatter: p.frontmatter,
                folder_rule_ids,
            });
        }
        rows.sort_by(|a, b| a.source_id.cmp(&b.source_id));
        Ok(rows)
    }

    /// The slugs of `source_id`'s markdown pages, soft-deleted ones too, by byte.
    pub fn list_markdown_page_slugs(&self, source_id: &str) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut slugs: Vec<String> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id && p.page_kind == "markdown")
            .map(|p| p.slug)
            .collect();
        slugs.sort();
        Ok(slugs)
    }
}
