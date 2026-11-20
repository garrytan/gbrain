//! The page reads of the schema-pack conversions that ordered by slug in byte order
//! (`src/core/engine-sql/collate-type-page-reads.ts`).
//!
//! Members: listTypePageBodies, listSourceTypePageBodies, countRetypeCandidates, listRetypeSampleSlugs.
//!
//! Keys: none. Each read scans the page records (`pages::all_pages`). Text sorts in byte order,
//! which is what `COLLATE "C"` gives on Postgres and PGLite; a Rust `String` compares by byte.

use crate::Store;
use crate::error::{Result, StoreError};
use crate::links::no_nul;
use crate::page_ops::like;
use crate::pages::{PageRecord, all_pages};
use serde::Deserialize;
use serde_json::{Value, json};

/// `listTypePageBodies({ type, sourceId, limit })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TypePageQuery {
    #[serde(rename = "type")]
    pub page_type: String,
    #[serde(default)]
    pub source_id: Option<String>,
    pub limit: i64,
}

/// The filters of `countRetypeCandidates` and `listRetypeSampleSlugs`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetypeProbe {
    pub from_type: String,
    #[serde(default)]
    pub path_filter: Option<String>,
    #[serde(default)]
    pub slug_filter: Option<String>,
    #[serde(default)]
    pub source_id: Option<String>,
}

fn body_row(page: &PageRecord) -> Value {
    json!({
        "slug": page.slug,
        "compiled_truth": page.compiled_truth.as_deref(),
        "frontmatter": Value::Object(page.frontmatter.clone()),
    })
}

/// A non-empty filter, as the caller's `if (filter)` reads it (an empty string is no filter).
fn present(filter: &Option<String>) -> Option<&str> {
    filter.as_deref().filter(|f| !f.is_empty())
}

impl Store {
    fn type_pages(&self, member: &str, query: &TypePageQuery, by_id: bool) -> Result<Vec<Value>> {
        let mut parts = vec![("type", query.page_type.as_str())];
        if let Some(id) = &query.source_id {
            parts.push(("sourceId", id));
        }
        no_nul(member, &parts)?;
        let limit = usize::try_from(query.limit)
            .map_err(|_| StoreError::invalid(format!("{member}: limit must not be negative")))?;
        let source = present(&query.source_id);
        let read = self.read()?;
        let mut rows: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && p.page_type == query.page_type)
            .filter(|p| source.is_none_or(|id| p.source_id == id))
            .collect();
        rows.sort_by(|a, b| {
            let order = a.slug.cmp(&b.slug);
            if by_id {
                order.then(a.id.cmp(&b.id))
            } else {
                order
            }
        });
        Ok(rows.iter().take(limit).map(body_row).collect())
    }

    /// `listTypePageBodies(query)`: `{ slug, compiled_truth, frontmatter }` of the live pages of
    /// one type (in one source when given), by slug then id in byte order, up to `limit`.
    pub fn list_type_page_bodies(&self, query: &TypePageQuery) -> Result<Vec<Value>> {
        self.type_pages("listTypePageBodies", query, true)
    }

    /// `listSourceTypePageBodies(query)`: the same rows for one source, by slug in byte order.
    pub fn list_source_type_page_bodies(&self, query: &TypePageQuery) -> Result<Vec<Value>> {
        if query.source_id.is_none() {
            return Err(StoreError::invalid(
                "listSourceTypePageBodies: sourceId is required",
            ));
        }
        self.type_pages("listSourceTypePageBodies", query, false)
    }

    /// The live pages of `from_type` that match the `LIKE` filters on source path and slug and the
    /// source, as slugs.
    fn retype_slugs(&self, member: &str, probe: &RetypeProbe) -> Result<Vec<String>> {
        let mut parts = vec![("fromType", probe.from_type.as_str())];
        for (name, v) in [
            ("pathFilter", &probe.path_filter),
            ("slugFilter", &probe.slug_filter),
            ("sourceId", &probe.source_id),
        ] {
            if let Some(v) = v {
                parts.push((name, v));
            }
        }
        no_nul(member, &parts)?;
        let (path, slug, source) = (
            present(&probe.path_filter),
            present(&probe.slug_filter),
            present(&probe.source_id),
        );
        let read = self.read()?;
        Ok(all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && p.page_type == probe.from_type)
            .filter(|p| {
                path.is_none_or(|pat| {
                    p.source_path
                        .as_deref()
                        .is_some_and(|sp| like(sp, pat, false))
                })
            })
            .filter(|p| slug.is_none_or(|pat| like(&p.slug, pat, false)))
            .filter(|p| source.is_none_or(|id| p.source_id == id))
            .map(|p| p.slug)
            .collect())
    }

    /// `countRetypeCandidates(probe)`: how many live pages of the rule's type match its filters.
    pub fn count_retype_candidates(&self, probe: &RetypeProbe) -> Result<usize> {
        Ok(self.retype_slugs("countRetypeCandidates", probe)?.len())
    }

    /// `listRetypeSampleSlugs(probe)`: the first ten matching slugs in byte order.
    pub fn list_retype_sample_slugs(&self, probe: &RetypeProbe) -> Result<Vec<String>> {
        let mut slugs = self.retype_slugs("listRetypeSampleSlugs", probe)?;
        slugs.sort();
        slugs.truncate(10);
        Ok(slugs)
    }
}
