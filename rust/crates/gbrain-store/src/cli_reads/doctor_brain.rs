//! Doctor brain reads: the typed members that replace the page, tag, fact and source raw SQL of the storage,
//! conversation-archive, backup and git-hold doctor checks (SQL in `src/core/engine-sql/doctor-brain.ts`, docs in
//! `rust/docs/store/cli-reads-doctor-brain.md`). Each read takes one snapshot and has no keys of its own.
//!
//! Text rules (rust/docs/store/cli-reads-ops.md, "Text semantics"): `left` and `length` are characters, `->>` is
//! `fm_text`, a `jsonb` column comes back in jsonb key order, and every order is bytewise, as PGLite's C.UTF-8
//! collation orders.

use super::pg_text::{fm_text, jsonb_value, pg_lower};
use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::pages::all_pages;
use crate::sources::all_sources;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The arguments of `listInterimStoredObjectCounts`: the page type, the shelf's source id, the slug prefix and the adoption tag.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterimQuery {
    #[serde(rename = "type")]
    pub page_type: String,
    pub shelf_source_id: String,
    pub prefix: String,
    pub adopted_tag: String,
}

impl Store {
    /// `listInterimStoredObjectCounts(...)`: live pages of `type` outside the shelf source whose slug starts with
    /// `prefix` (but is not `prefix` + `index`) and that carry no `adopted_tag`, counted per source in source order.
    /// Rows: `{source_id, n}`.
    pub fn list_interim_stored_object_counts(&self, q: &InterimQuery) -> Result<Vec<Value>> {
        let read = self.read()?;
        let index_slug = format!("{}index", q.prefix);
        let mut per_source: BTreeMap<String, u64> = BTreeMap::new();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some()
                || page.page_type != q.page_type
                || page.source_id == q.shelf_source_id
                || !page.slug.starts_with(&q.prefix)
                || page.slug == index_slug
                || page.tags.contains(&q.adopted_tag)
            {
                continue;
            }
            *per_source.entry(page.source_id).or_default() += 1;
        }
        Ok(per_source
            .into_iter()
            .map(|(source_id, n)| json!({ "source_id": source_id, "n": n }))
            .collect())
    }

    /// `readOldestSourceCreatedAt()`: the earliest source `created_at` as an ISO string, or null for a brain with no
    /// source row.
    pub fn read_oldest_source_created_at(&self) -> Result<Option<String>> {
        let read = self.read()?;
        Ok(all_sources(&*read)?
            .iter()
            .map(|s| s.created_at_us)
            .min()
            .map(iso))
    }

    /// `listVisibilityCandidatePages(sourceIds)`: live pages of non-archived sources (`sourceIds` narrows; null reads
    /// every source) whose frontmatter has a `visibility` key in any letter case and whose `visibility` text is not
    /// `private` (a missing or non-text exact key counts as not private). Rows: `{source_id, slug, frontmatter}`,
    /// ordered by source then slug.
    pub fn list_visibility_candidate_pages(
        &self,
        source_ids: Option<&[String]>,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let live_sources: Vec<String> = all_sources(&*read)?
            .into_iter()
            .filter(|s| !s.archived)
            .map(|s| s.id)
            .collect();
        let mut rows: Vec<(String, String, Value)> = Vec::new();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some()
                || !live_sources.contains(&page.source_id)
                || source_ids.is_some_and(|ids| !ids.contains(&page.source_id))
                || !page.frontmatter.keys().any(|k| pg_lower(k) == "visibility")
                || fm_text(&page.frontmatter, "visibility").as_deref() == Some("private")
            {
                continue;
            }
            rows.push((
                page.source_id,
                page.slug,
                jsonb_value(&Value::Object(page.frontmatter)),
            ));
        }
        rows.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
        Ok(rows
            .into_iter()
            .map(|(source_id, slug, frontmatter)| {
                json!({ "source_id": source_id, "slug": slug, "frontmatter": frontmatter })
            })
            .collect())
    }
}
